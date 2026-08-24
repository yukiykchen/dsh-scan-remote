import http, { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { Store } from "./store.js";
import {
  resolveJwtSecret,
  signToken,
  verifyToken,
} from "./auth.js";
import { accessClientInfo } from "./access-info.js";
import {
  BodyTooLargeError,
  clientAddress,
  envInteger,
  FixedWindowRateLimiter,
  readBody,
  readJsonBody,
} from "./limits.js";
import { isWebAsset, serveWeb } from "./web.js";

type Envelope = {
  v: 1;
  type: string;
  channel?: string;
  id: string;
  ts: number;
  payload: any;
};
type PendingHttp = {
  res: ServerResponse;
  timer: NodeJS.Timeout;
  deviceId: string;
  started: boolean;
  responseBytes: number;
};
type PendingWs = {
  socket: WebSocket;
  deviceId: string;
  timer?: NodeJS.Timeout;
};
type SecureRoute = {
  socket: WebSocket;
  deviceId: string;
  accessSessionId: string;
  handshakeTimer?: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  bytes: number;
};

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const dbPath = process.env.DATABASE_PATH ?? "./data/relay.sqlite";
const secret = resolveJwtSecret();
const adminUsername = process.env.ADMIN_USERNAME?.trim() ?? "";
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
if (
  process.env.NODE_ENV === "production" &&
  ((adminUsername && !adminPassword) ||
    (!adminUsername && adminPassword) ||
    (adminPassword && adminPassword.length < 12))
) {
  throw new Error(
    "ADMIN_USERNAME and ADMIN_PASSWORD (at least 12 characters) must be configured together",
  );
}
const apiBodyLimit = envInteger("MAX_API_BODY_BYTES", 64 * 1024);
const tunnelBodyLimit = envInteger("MAX_TUNNEL_BODY_BYTES", 2 * 1024 * 1024);
const tunnelResponseLimit = envInteger(
  "MAX_TUNNEL_RESPONSE_BYTES",
  64 * 1024 * 1024,
);
const wsPayloadLimit = envInteger("MAX_WS_PAYLOAD_BYTES", 4 * 1024 * 1024);
const httpGlobalLimit = envInteger("MAX_PENDING_HTTP_GLOBAL", 512);
const httpDeviceLimit = envInteger("MAX_PENDING_HTTP_PER_DEVICE", 32);
const wsGlobalLimit = envInteger("MAX_TUNNEL_WS_GLOBAL", 256);
const wsDeviceLimit = envInteger("MAX_TUNNEL_WS_PER_DEVICE", 16);
const wsConnectionLimit = envInteger("MAX_WS_CONNECTIONS", 1_000);
const apiRateLimit = envInteger("API_RATE_LIMIT_PER_MINUTE", 300);
const authRateLimit = envInteger("AUTH_RATE_LIMIT_PER_MINUTE", 20);
const pairRateLimit = envInteger("PAIR_RATE_LIMIT_PER_MINUTE", 30);
const tunnelRateLimit = envInteger("TUNNEL_RATE_LIMIT_PER_MINUTE", 600);
const upgradeRateLimit = envInteger("WS_UPGRADE_RATE_LIMIT_PER_MINUTE", 120);
const eventPayloadLimit = envInteger("MAX_EVENT_PAYLOAD_BYTES", 64 * 1024);
const secureGlobalLimit = envInteger("MAX_SECURE_TUNNELS_GLOBAL", 512);
const secureDeviceLimit = envInteger("MAX_SECURE_TUNNELS_PER_DEVICE", 8);
const secureSessionByteLimit = envInteger(
  "MAX_SECURE_TUNNEL_BYTES",
  512 * 1024 * 1024,
);
const secureFrameRateLimit = envInteger(
  "SECURE_FRAME_RATE_LIMIT_PER_MINUTE",
  2_400,
);
const secureIdleTimeoutMs = envInteger(
  "SECURE_TUNNEL_IDLE_TIMEOUT_MS",
  5 * 60_000,
);
const secureHandshakeTimeoutMs = envInteger(
  "SECURE_HANDSHAKE_TIMEOUT_MS",
  10_000,
);
const allowLegacyWebProxy = ["1", "true"].includes(
  (process.env.ALLOW_LEGACY_WEB_PROXY ?? "").toLowerCase(),
);
const trustProxy = ["1", "true"].includes(
  (process.env.TRUST_PROXY ?? "").toLowerCase(),
);
mkdirSync(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);
const deviceConnections = new Map<string, WebSocket>();
const deviceCapabilities = new Map<string, Set<string>>();
const pendingHttp = new Map<string, PendingHttp>();
const pendingWs = new Map<string, PendingWs>();
const secureRoutes = new Map<string, SecureRoute>();
const secureUpgradeAuth = new WeakMap<
  IncomingMessage,
  { deviceId: string; accessSessionId: string }
>();
const consumedTickets = new Set<string>();
const rateLimiter = new FixedWindowRateLimiter();
const maintenanceTimer = setInterval(() => {
  rateLimiter.sweep();
  store.cleanupExpired();
}, 15 * 60_000);
maintenanceTimer.unref();

function httpTimeout(channel: string, res: ServerResponse) {
  return setTimeout(() => {
    pendingHttp.delete(channel);
    if (!res.headersSent) json(res, 504, { reason: "tunnel_timeout" });
    else res.destroy(new Error("tunnel timeout"));
  }, 60_000);
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}
function rateLimited(
  req: IncomingMessage,
  res: ServerResponse,
  bucket: string,
  maximum: number,
): boolean {
  const retryAfter = rateLimiter.take(
    `${bucket}:${clientAddress(req, trustProxy)}`,
    maximum,
    60_000,
  );
  if (!retryAfter) return false;
  json(
    res,
    429,
    { error: "rate_limited", retryAfter },
    { "retry-after": String(retryAfter) },
  );
  return true;
}

function apiRateLimited(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname === "/health") return false;
  if (rateLimited(req, res, "api", apiRateLimit)) return true;
  if (pathname.startsWith("/auth/"))
    return rateLimited(req, res, "auth", authRateLimit);
  if (pathname.startsWith("/web-auth/") || pathname === "/admin/api/login")
    return rateLimited(req, res, "browser-auth", authRateLimit);
  if (pathname.startsWith("/pair/"))
    return rateLimited(req, res, "pair", pairRateLimit);
  return false;
}

function pendingForDevice<T extends { deviceId: string }>(
  entries: Map<string, T>,
  deviceId: string,
): number {
  let count = 0;
  for (const pending of entries.values())
    if (pending.deviceId === deviceId) count += 1;
  return count;
}

function closeDeviceTunnels(deviceId: string) {
  for (const [channel, pending] of pendingHttp) {
    if (pending.deviceId !== deviceId) continue;
    clearTimeout(pending.timer);
    pendingHttp.delete(channel);
    if (!pending.res.headersSent)
      json(pending.res, 503, { reason: "device_offline" });
    else pending.res.destroy(new Error("device disconnected"));
  }
  for (const [channel, pending] of pendingWs) {
    if (pending.deviceId !== deviceId) continue;
    if (pending.timer) clearTimeout(pending.timer);
    pendingWs.delete(channel);
    pending.socket.close(1013, "device disconnected");
  }
  for (const [accessSessionId, route] of secureRoutes) {
    if (route.deviceId !== deviceId) continue;
    closeSecureRoute(accessSessionId, 1013, "device disconnected", false);
  }
}

function resetSecureIdle(route: SecureRoute) {
  clearTimeout(route.idleTimer);
  route.idleTimer = setTimeout(
    () =>
      closeSecureRoute(
        route.accessSessionId,
        1001,
        "secure tunnel idle",
        true,
      ),
    secureIdleTimeoutMs,
  );
  route.idleTimer.unref();
}

function closeSecureRoute(
  accessSessionId: string,
  code: number,
  reason: string,
  notifyDevice: boolean,
) {
  const route = secureRoutes.get(accessSessionId);
  if (!route) return;
  secureRoutes.delete(accessSessionId);
  store.endAccessSession(accessSessionId, reason);
  if (route.handshakeTimer) clearTimeout(route.handshakeTimer);
  clearTimeout(route.idleTimer);
  if (notifyDevice)
    send(
      route.deviceId,
      envelope("client_close", { accessSessionId, reason }),
    );
  if (
    route.socket.readyState === WebSocket.OPEN ||
    route.socket.readyState === WebSocket.CONNECTING
  )
    route.socket.close(code, reason.slice(0, 100));
}

function closeHostTunnels(hostId: string, reason: string) {
  deviceConnections.get(hostId)?.close(4003, reason);
  for (const [accessSessionId, route] of [...secureRoutes]) {
    if (route.deviceId === hostId) {
      closeSecureRoute(accessSessionId, 4003, reason, false);
    }
  }
}

function secureCountForDevice(deviceId: string) {
  let count = 0;
  for (const route of secureRoutes.values())
    if (route.deviceId === deviceId) count += 1;
  return count;
}

function rejectUpgrade(
  socket: Duplex,
  status: 401 | 426 | 429 | 503,
  reason:
    | "invalid_web_ticket"
    | "e2ee_required"
    | "rate_limited"
    | "capacity_reached"
    | "secure_tunnel_capacity",
  retryAfter = 1,
) {
  const text =
    status === 401
      ? "Unauthorized"
      : status === 426
        ? "Upgrade Required"
        : status === 429
          ? "Too Many Requests"
          : "Service Unavailable";
  const payload = JSON.stringify({ reason });
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      `Retry-After: ${retryAfter}\r\n\r\n${payload}`,
  );
}
function bearer(req: IncomingMessage) {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}
function account(req: IncomingMessage) {
  const access = verifyToken(bearer(req), secret);
  if (access?.kind === "access") return String(access.sub);
  const web = verifyToken(cookies(req).dsh_web_auth, secret);
  return web?.kind === "web-access" ? String(web.sub) : null;
}
function webSession(req: IncomingMessage): {
  deviceId: string;
  accessSessionId: string;
} | null {
  const session = verifyToken(cookies(req).dsh_session, secret);
  return session?.kind === "web-session" &&
    typeof session.deviceId === "string" &&
    typeof session.accessSessionId === "string"
    ? {
        deviceId: session.deviceId,
        accessSessionId: session.accessSessionId,
      }
    : null;
}
function isRelayApi(pathname: string) {
  return (
    pathname === "/health" ||
    pathname === "/app/version" ||
    pathname === "/devices" ||
    pathname === "/web-ticket" ||
    pathname.startsWith("/web-auth/") ||
    pathname.startsWith("/admin/api/") ||
    pathname === "/access-ticket" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/pair/") ||
    pathname.startsWith("/host-management/") ||
    pathname.startsWith("/device-management/") ||
    pathname.startsWith("/devices/")
  );
}
function cookies(req: IncomingMessage) {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf("=");
        return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1))];
      }),
  );
}
function upstreamCookie(value: string | undefined) {
  const kept = (value ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("dsh_session="));
  return kept.length ? kept.join("; ") : undefined;
}
function send(deviceId: string, message: Envelope): boolean {
  const ws = deviceConnections.get(deviceId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}
function envelope(type: string, payload: any, channel?: string): Envelope {
  return { v: 1, type, channel, id: randomUUID(), ts: Date.now(), payload };
}
function normalizeCloseCode(code: unknown): number | undefined {
  if (typeof code !== "number") return undefined;
  if (code === 1000 || code === 1001 || code === 1002 || code === 1003)
    return code;
  if (code >= 1007 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return undefined;
}
function closeSocket(socket: WebSocket, code: unknown, reason: unknown) {
  const normalized = normalizeCloseCode(code);
  if (normalized === undefined) socket.close();
  else socket.close(normalized, String(reason ?? "").slice(0, 100));
}
function routeMatch(path: string, pattern: RegExp) {
  return pattern.exec(path);
}
function configured(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function requestOrigin(req: IncomingMessage): string {
  const configuredOrigin = configured("PUBLIC_RELAY_URL");
  if (configuredOrigin) return new URL(configuredOrigin).origin;
  const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${protocol}://${req.headers.host ?? "localhost"}`;
}

function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  return !origin || origin === requestOrigin(req);
}

function cookieSecure(req: IncomingMessage): string {
  return requestOrigin(req).startsWith("https://") ? "; Secure" : "";
}

function setWebAuthCookie(req: IncomingMessage, res: ServerResponse, accountId: string) {
  const token = signToken(
    { kind: "web-access", sub: accountId },
    secret,
    12 * 3600_000,
  );
  res.setHeader(
    "set-cookie",
    `dsh_web_auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${cookieSecure(req)}`,
  );
}

function clearCookie(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  path = "/",
) {
  res.setHeader(
    "set-cookie",
    `${name}=; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=0${cookieSecure(req)}`,
  );
}

function adminEnabled(): boolean {
  return Boolean(adminUsername && adminPassword);
}

function sameValue(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function adminAuthenticated(req: IncomingMessage): boolean {
  const token = verifyToken(cookies(req).dsh_admin, secret);
  return token?.kind === "admin-session" && token.sub === adminUsername;
}

function requireBrowserMutation(req: IncomingMessage, res: ServerResponse): boolean {
  if (bearer(req) || sameOrigin(req)) return true;
  json(res, 403, { error: "invalid_origin" });
  return false;
}

function secureTunnelUrl(req: IncomingMessage): string {
  const configuredOrigin = configured("PUBLIC_RELAY_URL");
  const origin = configuredOrigin
    ? new URL(configuredOrigin)
    : new URL(
        `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host ?? "localhost"}`,
      );
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = "/client-tunnel";
  origin.search = "";
  return origin.toString();
}

function webTicketAuthorization(req: IncomingMessage) {
  const value = req.headers.authorization;
  if (value?.startsWith("WebTicket ")) return value.slice(10);
  const protocols = (req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((protocol) => protocol.trim());
  const encoded = protocols
    .find((protocol) => protocol.startsWith("dsh-ticket."))
    ?.slice("dsh-ticket.".length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function consumeSecureWebTicket(req: IncomingMessage): {
  deviceId: string;
  accessSessionId: string;
} | null {
  const raw = bearer(req) || webTicketAuthorization(req);
  const ticket = verifyToken(raw, secret);
  if (
    ticket?.kind !== "access-ticket" ||
    typeof ticket.hostId !== "string" ||
    typeof ticket.accessSessionId !== "string" ||
    typeof ticket.nonce !== "string" ||
    consumedTickets.has(ticket.nonce)
  )
    return null;
  if (
    !deviceConnections.has(ticket.hostId) ||
    !deviceCapabilities.get(ticket.hostId)?.has("sealed-tunnel-v1")
  )
    return null;
  consumedTickets.add(ticket.nonce);
  setTimeout(() => consumedTickets.delete(ticket.nonce), 65_000).unref();
  store.createAccessSession(
    ticket.hostId,
    typeof ticket.clientId === "string" ? ticket.clientId : null,
    accessClientInfo(req.headers["user-agent"]),
    Date.now() + 2 * 3600_000,
    ticket.accessSessionId,
  );
  return {
    deviceId: ticket.hostId,
    accessSessionId: ticket.accessSessionId,
  };
}

async function api(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  if (apiRateLimited(req, res, url.pathname)) return;
  let input: any = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      input = await readJsonBody(req, apiBodyLimit);
    } catch (error) {
      if (error instanceof BodyTooLargeError)
        return json(res, 413, {
          error: "request_too_large",
          limit: apiBodyLimit,
        });
      throw error;
    }
  }
  if (req.method === "GET" && url.pathname === "/health")
    return json(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/app/version") {
    const platform = url.searchParams.get("platform");
    if (platform !== "android" && platform !== "ios")
      return json(res, 400, { error: "unsupported_platform" });
    const prefix = platform === "android" ? "ANDROID" : "IOS";
    return json(
      res,
      200,
      {
        platform,
        latestVersion: configured(`APP_${prefix}_LATEST_VERSION`) ?? "0.1.5",
        minimumVersion:
          configured(`APP_${prefix}_MINIMUM_VERSION`) ?? "0.1.3",
        downloadUrl: configured(`APP_${prefix}_DOWNLOAD_URL`),
        releaseNotes: configured(`APP_${prefix}_RELEASE_NOTES`),
      },
      { "cache-control": "public, max-age=300" },
    );
  }
  if (url.pathname.startsWith("/web-auth/")) {
    return json(res, 410, { error: "accounts_removed" });
  }
  if (req.method === "GET" && url.pathname === "/admin/api/session") {
    return json(res, 200, {
      enabled: adminEnabled(),
      authenticated: adminAuthenticated(req),
    });
  }
  if (req.method === "POST" && url.pathname === "/admin/api/login") {
    if (!sameOrigin(req)) return json(res, 403, { error: "invalid_origin" });
    const username = adminUsername;
    const password = adminPassword;
    if (
      !username ||
      !password ||
      typeof input?.username !== "string" ||
      typeof input?.password !== "string" ||
      !sameValue(username, input.username) ||
      !sameValue(password, input.password)
    )
      return json(res, 401, { error: "invalid_credentials" });
    const token = signToken(
      { kind: "admin-session", sub: username },
      secret,
      8 * 3600_000,
    );
    res.setHeader(
      "set-cookie",
      `dsh_admin=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=28800${cookieSecure(req)}`,
    );
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/admin/api/logout") {
    if (!sameOrigin(req)) return json(res, 403, { error: "invalid_origin" });
    clearCookie(req, res, "dsh_admin", "/admin");
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/admin/api/stats") {
    return adminAuthenticated(req)
      ? json(res, 200, store.adminStats())
      : json(res, 401, { error: "unauthorized" });
  }
  if (req.method === "POST" && url.pathname === "/auth/register") {
    return json(res, 410, { error: "accounts_removed" });
  }
  if (req.method === "POST" && url.pathname === "/auth/login") {
    return json(res, 410, { error: "accounts_removed" });
  }
  if (req.method === "POST" && url.pathname === "/auth/refresh") {
    return json(res, 410, { error: "accounts_removed" });
  }
  if (req.method === "POST" && url.pathname === "/pair/session") {
    try {
      const created = store.createPairSession(
        String(input?.claimTokenHash ?? ""),
        String(input?.hostName ?? "DSH Computer"),
      );
      return json(res, 201, created);
    } catch {
      return json(res, 400, { error: "invalid_claim_hash" });
    }
  }
  if (req.method === "POST" && url.pathname === "/pair/claim-device") {
    const claimed = store.claimPair(
      String(input?.pairId ?? ""),
      String(input?.claimToken ?? ""),
      {
        ...accessClientInfo(req.headers["user-agent"]),
        ...(typeof input?.deviceLabel === "string"
          ? { deviceLabel: input.deviceLabel.slice(0, 80) }
          : {}),
        ...(input?.platform === "android" ||
        input?.platform === "ios" ||
        input?.platform === "other"
          ? { platform: input.platform }
          : {}),
      },
    );
    if (claimed === "expired") return json(res, 410, { error: "expired" });
    if (claimed === "used") return json(res, 409, { error: "already_claimed" });
    if (claimed === "mismatch") return json(res, 403, { error: "invalid_claim" });
    if (claimed === "invalid") return json(res, 404, { error: "not_found" });
    return json(res, 200, claimed);
  }
  if (req.method === "POST" && url.pathname === "/pair/confirm") {
    const result = store.confirmPair(
      String(input?.pairId ?? ""),
      String(input?.confirmSecret ?? ""),
    );
    if (result === "pending") return json(res, 202, { status: "pending" });
    if (result === "expired") return json(res, 410, { error: "expired" });
    return result
      ? json(res, 200, result)
      : json(res, 401, { error: "invalid_pair_session" });
  }
  if (req.method === "POST" && url.pathname === "/access-ticket") {
    const token = bearer(req);
    const client = token ? store.findClientByToken(token) : null;
    if (!client) return json(res, 401, { error: "invalid_client_token" });
    if (!deviceConnections.has(client.hostId))
      return json(res, 503, { reason: "host_offline" });
    const secure = deviceCapabilities
      .get(client.hostId)
      ?.has("sealed-tunnel-v1");
    if (!secure)
      return json(res, 426, { reason: "e2ee_required" });
    const expiresIn = Number(process.env.WEB_TICKET_TTL_SECONDS ?? 60);
    const accessSessionId = `access_${randomUUID()}`;
    const ticket = signToken(
      {
        kind: "access-ticket",
        hostId: client.hostId,
        clientId: client.id,
        accessSessionId,
        nonce: randomUUID(),
      },
      secret,
      expiresIn * 1000,
    );
    return json(res, 200, {
      ticket,
      expiresIn,
      accessSessionId,
      hostId: client.hostId,
      tunnelUrl: secureTunnelUrl(req),
    });
  }
  if (req.method === "GET" && url.pathname === "/devices") {
    return json(res, 410, { error: "accounts_removed" });
  }
  if (req.method === "POST" && url.pathname === "/web-ticket") {
    return json(res, 410, { error: "use_access_ticket" });
  }
  const accessSessionsRoute = routeMatch(
    url.pathname,
    /^\/(?:host|device)-management\/([^/]+)\/access-sessions$/,
  );
  if (accessSessionsRoute && req.method === "GET") {
    const hostToken = req.headers.authorization?.startsWith("Host ")
      ? req.headers.authorization.slice(5)
      : req.headers.authorization?.startsWith("Device ")
        ? req.headers.authorization.slice(7)
        : undefined;
    if (
      !hostToken ||
      !store.findHostByToken(accessSessionsRoute[1], hostToken)
    )
      return json(res, 401, { error: "invalid_host_token" });
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
      : 50;
    return json(res, 200, {
      sessions: store.listAccessSessions(accessSessionsRoute[1], limit),
    });
  }
  const deviceUnbindRoute = routeMatch(
    url.pathname,
    /^\/(?:host|device)-management\/([^/]+)\/unbind$/,
  );
  if (deviceUnbindRoute && req.method === "POST") {
    const hostToken = req.headers.authorization?.startsWith("Host ")
      ? req.headers.authorization.slice(5)
      : req.headers.authorization?.startsWith("Device ")
        ? req.headers.authorization.slice(7)
        : undefined;
    const hostId = deviceUnbindRoute[1];
    if (!hostToken || !store.unbind(hostId, hostToken))
      return json(res, 401, { error: "invalid_host_token" });
    closeHostTunnels(hostId, "unbound");
    return json(res, 200, { ok: true });
  }
  const deviceRoute = routeMatch(url.pathname, /^\/devices\/([^/]+)$/);
  if (deviceRoute)
    return json(res, 410, { error: "accounts_removed" });
  return json(res, 404, { error: "not_found" });
}

function authorizeWeb(
  req: IncomingMessage,
  deviceId: string,
  url: URL,
): { ok: boolean; setCookie?: string; accessSessionId?: string } {
  const session = verifyToken(cookies(req).dsh_session, secret);
  if (
    session?.kind === "web-session" &&
    session.deviceId === deviceId &&
    typeof session.accessSessionId === "string"
  ) {
    store.touchAccessSession(session.accessSessionId, deviceId);
    return { ok: true, accessSessionId: session.accessSessionId };
  }
  const rawTicket = url.searchParams.get("ticket") ?? undefined;
  const ticket = verifyToken(rawTicket, secret);
  if (
    ticket?.kind !== "web-ticket" ||
    ticket.deviceId !== deviceId ||
    !ticket.nonce ||
    consumedTickets.has(ticket.nonce)
  )
    return { ok: false };
  consumedTickets.add(ticket.nonce);
  setTimeout(() => consumedTickets.delete(ticket.nonce), 65_000).unref();
  const accessSessionId =
    typeof ticket.accessSessionId === "string"
      ? ticket.accessSessionId
      : `access_${randomUUID()}`;
  store.createAccessSession(
    deviceId,
    String(ticket.sub),
    accessClientInfo(req.headers["user-agent"]),
    Date.now() + 2 * 3600_000,
    accessSessionId,
  );
  const sessionToken = signToken(
    { kind: "web-session", sub: ticket.sub, deviceId, accessSessionId },
    secret,
    2 * 3600_000,
  );
  url.searchParams.delete("ticket");
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return {
    ok: true,
    accessSessionId,
    setCookie: `dsh_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7200${secure}`,
  };
}

async function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deviceId: string,
  path: string,
  setCookie?: string,
) {
  const device = store.host(deviceId);
  if (!deviceConnections.has(deviceId))
    return json(res, 503, { reason: "device_offline" });
  if (device?.dsh_status !== "online")
    return json(res, 503, { reason: "dsh_offline" });
  if (rateLimited(req, res, "tunnel", tunnelRateLimit)) return;
  if (
    pendingHttp.size >= httpGlobalLimit ||
    pendingForDevice(pendingHttp, deviceId) >= httpDeviceLimit
  )
    return json(
      res,
      429,
      { reason: "too_many_tunnels" },
      { "retry-after": "1" },
    );
  const channel = `ch_${randomUUID()}`;
  const timer = httpTimeout(channel, res);
  pendingHttp.set(channel, {
    res,
    timer,
    deviceId,
    started: false,
    responseBytes: 0,
  });
  res.on("close", () => {
    const pending = pendingHttp.get(channel);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingHttp.delete(channel);
    send(deviceId, envelope("http_close", {}, channel));
  });
  let requestBody: Buffer;
  try {
    requestBody = await readBody(req, tunnelBodyLimit);
  } catch (error) {
    clearTimeout(timer);
    pendingHttp.delete(channel);
    if (error instanceof BodyTooLargeError)
      return json(res, 413, {
        reason: "request_too_large",
        limit: tunnelBodyLimit,
      });
    throw error;
  }
  const headers = {
    ...req.headers,
    cookie: upstreamCookie(req.headers.cookie),
  };
  delete headers.host;
  if (!headers.cookie) delete headers.cookie;
  if (
    !send(
      deviceId,
      envelope(
        "http_req",
        {
          method: req.method,
          path,
          headers,
          bodyB64: requestBody.toString("base64"),
        },
        channel,
      ),
    )
  ) {
    clearTimeout(timer);
    pendingHttp.delete(channel);
    json(res, 503, { reason: "device_offline" });
  } else if (setCookie) res.setHeader("set-cookie", setCookie);
}

const server = http.createServer(
  {
    maxHeaderSize: envInteger("MAX_HTTP_HEADER_BYTES", 32 * 1024),
    headersTimeout: envInteger("HTTP_HEADERS_TIMEOUT_MS", 15_000),
    requestTimeout: envInteger("HTTP_REQUEST_TIMEOUT_MS", 65_000),
    keepAliveTimeout: envInteger("HTTP_KEEP_ALIVE_TIMEOUT_MS", 5_000),
  },
  async (req, res) => {
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      if (isWebAsset(url.pathname) && serveWeb(req, res, url.pathname)) return;
      const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (match) {
        if (!allowLegacyWebProxy)
          return json(res, 426, { reason: "e2ee_required" });
        const auth = authorizeWeb(req, match[1], url);
        if (!auth.ok) return json(res, 401, { error: "invalid_web_session" });
        return proxyHttp(
          req,
          res,
          match[1],
          `${match[2] ?? "/"}${url.search}`,
          auth.setCookie,
        );
      }
      if (!isRelayApi(url.pathname)) {
        if (!allowLegacyWebProxy)
          return json(res, 426, { reason: "e2ee_required" });
        const session = webSession(req);
        if (!session) return json(res, 401, { error: "invalid_web_session" });
        store.touchAccessSession(session.accessSessionId, session.deviceId);
        return proxyHttp(
          req,
          res,
          session.deviceId,
          `${url.pathname}${url.search}`,
        );
      }
      return await api(req, res);
    } catch (error) {
      console.error(
        "request failed",
        error instanceof Error ? error.message : "unknown",
      );
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
    }
  },
);
server.maxRequestsPerSocket = envInteger("MAX_REQUESTS_PER_SOCKET", 1_000);

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: wsPayloadLimit,
  perMessageDeflate: false,
  handleProtocols(protocols) {
    return protocols.has("dsh-e2ee-v1") ? "dsh-e2ee-v1" : false;
  },
});

function setupSecureClient(
  ws: WebSocket,
  auth: { deviceId: string; accessSessionId: string },
) {
  const { deviceId, accessSessionId } = auth;
  const route: SecureRoute = {
    socket: ws,
    deviceId,
    accessSessionId,
    bytes: 0,
    idleTimer: setTimeout(
      () => closeSecureRoute(accessSessionId, 1001, "secure tunnel idle", true),
      secureIdleTimeoutMs,
    ),
  };
  route.idleTimer.unref();
  route.handshakeTimer = setTimeout(
    () =>
      closeSecureRoute(
        accessSessionId,
        1008,
        "e2ee handshake timeout",
        true,
      ),
    secureHandshakeTimeoutMs,
  );
  route.handshakeTimer.unref();
  secureRoutes.set(accessSessionId, route);
  store.touchAccessSession(accessSessionId, deviceId);

  ws.on("error", () => {
    // Protocol and payload errors are scoped to this secure client.
  });
  ws.on("message", (raw) => {
    const current = secureRoutes.get(accessSessionId);
    if (current !== route) return;
    const retryAfter = rateLimiter.take(
      `secure-frame:${accessSessionId}`,
      secureFrameRateLimit,
      60_000,
    );
    if (retryAfter)
      return closeSecureRoute(accessSessionId, 1008, "rate limited", true);
    route.bytes += Buffer.byteLength(raw as any);
    if (route.bytes > secureSessionByteLimit)
      return closeSecureRoute(accessSessionId, 1009, "secure byte limit", true);
    let msg: Envelope;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return closeSecureRoute(accessSessionId, 1008, "invalid envelope", true);
    }
    if (
      msg?.v !== 1 ||
      !["client_hello", "sealed", "client_close"].includes(msg.type) ||
      msg.payload?.accessSessionId !== accessSessionId ||
      (msg.type === "sealed" && route.handshakeTimer)
    )
      return closeSecureRoute(accessSessionId, 1008, "invalid envelope", true);
    resetSecureIdle(route);
    if (!send(deviceId, msg))
      return closeSecureRoute(accessSessionId, 1013, "device offline", false);
    if (msg.type === "client_close")
      closeSecureRoute(accessSessionId, 1000, "client closed", false);
  });
  ws.on("close", () => {
    if (secureRoutes.get(accessSessionId) !== route) return;
    closeSecureRoute(accessSessionId, 1000, "client disconnected", true);
  });
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const retryAfter = rateLimiter.take(
    `ws-upgrade:${clientAddress(req, trustProxy)}`,
    upgradeRateLimit,
    60_000,
  );
  if (retryAfter)
    return rejectUpgrade(socket, 429, "rate_limited", retryAfter);
  if (wss.clients.size >= wsConnectionLimit)
    return rejectUpgrade(socket, 503, "capacity_reached");
  if (url.pathname === "/device")
    return wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  if (url.pathname === "/client-tunnel") {
    const auth = consumeSecureWebTicket(req);
    if (!auth) return rejectUpgrade(socket, 401, "invalid_web_ticket");
    if (
      secureRoutes.size >= secureGlobalLimit ||
      secureCountForDevice(auth.deviceId) >= secureDeviceLimit ||
      secureRoutes.has(auth.accessSessionId)
    )
      return rejectUpgrade(socket, 503, "secure_tunnel_capacity");
    secureUpgradeAuth.set(req, auth);
    return wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  }
  if (!allowLegacyWebProxy) return socket.destroy();
  const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const session = match ? null : webSession(req);
  const deviceId = match ? match[1] : session?.deviceId;
  if (match && !authorizeWeb(req, deviceId!, url).ok) return socket.destroy();
  if (session) store.touchAccessSession(session.accessSessionId, session.deviceId);
  if (!deviceId || !deviceConnections.has(deviceId)) return socket.destroy();
  if (
    pendingWs.size >= wsGlobalLimit ||
    pendingForDevice(pendingWs, deviceId) >= wsDeviceLimit
  )
    return rejectUpgrade(socket, 429, "capacity_reached");
  const upstreamPath = match
    ? `${match[2] ?? "/"}${url.search}`
    : `${url.pathname}${url.search}`;
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("error", () => {
      // Protocol and payload errors are scoped to this browser connection.
    });
    const channel = `ch_${randomUUID()}`;
    pendingWs.set(channel, {
      socket: ws,
      deviceId,
      timer: setTimeout(() => ws.close(1013, "tunnel timeout"), 10_000),
    });
    const headers = {
      ...req.headers,
      cookie: upstreamCookie(req.headers.cookie),
    };
    if (!headers.cookie) delete headers.cookie;
    send(
      deviceId,
      envelope("ws_open", { path: upstreamPath, headers }, channel),
    );
    ws.on("message", (data, binary) =>
      send(
        deviceId,
        envelope(
          "ws_frame",
          {
            dataB64: Buffer.from(data as any).toString("base64"),
            opcode: binary ? 2 : 1,
          },
          channel,
        ),
      ),
    );
    ws.on("close", (code, reason) => {
      const pending = pendingWs.get(channel);
      if (pending?.timer) clearTimeout(pending.timer);
      pendingWs.delete(channel);
      send(
        deviceId,
        envelope("ws_close", { code, reason: reason.toString() }, channel),
      );
    });
  });
});

wss.on("connection", (ws, req) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/client-tunnel") {
    const auth = secureUpgradeAuth.get(req);
    if (!auth) return ws.close(4003, "invalid web ticket");
    secureUpgradeAuth.delete(req);
    setupSecureClient(ws, auth);
    return;
  }
  if (pathname !== "/device") return;
  ws.on("error", () => {
    // Invalid Companion frames must not terminate the Relay process.
  });
  let deviceId: string | null = null;
  const authTimer = setTimeout(() => ws.close(4001, "auth timeout"), 5_000);
  ws.on("message", (raw) => {
    let msg: Envelope;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.close(4000, "invalid json");
    }
    if (!deviceId) {
      const hostId = String(msg.payload?.hostId ?? msg.payload?.deviceId ?? "");
      const hostToken = String(
        msg.payload?.hostToken ?? msg.payload?.deviceToken ?? "",
      );
      if (msg.type !== "auth" || !store.findHostByToken(hostId, hostToken))
        return ws.close(4003, "auth failed");
      const authenticatedId = hostId;
      deviceId = authenticatedId;
      clearTimeout(authTimer);
      deviceConnections.get(authenticatedId)?.close(4002, "replaced");
      deviceConnections.set(authenticatedId, ws);
      deviceCapabilities.set(
        authenticatedId,
        new Set(
          Array.isArray(msg.payload?.capabilities)
            ? msg.payload.capabilities.filter(
                (value: unknown): value is string => typeof value === "string",
              )
            : [],
        ),
      );
      store.updateStatus(authenticatedId, "online", "offline");
      return ws.send(JSON.stringify(envelope("auth_ok", {})));
    }
    if (msg.type === "ping")
      return ws.send(JSON.stringify(envelope("pong", {})));
    if (msg.type === "status")
      return store.updateStatus(
        deviceId as string,
        "online",
        msg.payload?.dsh === "online" ? "online" : "offline",
      );
    if (msg.type === "event") {
      if (Buffer.byteLength(JSON.stringify(msg.payload ?? null)) > eventPayloadLimit)
        return ws.close(1009, "event payload too large");
      const payload = msg.payload;
      if (
        !payload ||
        typeof payload !== "object" ||
        Object.keys(payload).some((key) => key !== "kind") ||
        typeof payload.kind !== "string" ||
        payload.kind.length > 128
      )
        return ws.close(1008, "event metadata only");
      return store.addEvent(deviceId as string, payload.kind);
    }
    if (
      ["server_hello", "sealed", "device_close"].includes(msg.type) &&
      typeof msg.payload?.accessSessionId === "string"
    ) {
      const accessSessionId = msg.payload.accessSessionId;
      const route = secureRoutes.get(accessSessionId);
      if (!route || route.deviceId !== deviceId) return;
      route.bytes += Buffer.byteLength(JSON.stringify(msg));
      if (route.bytes > secureSessionByteLimit)
        return closeSecureRoute(
          accessSessionId,
          1009,
          "secure byte limit",
          true,
        );
      if (msg.type === "server_hello") {
        if (!route.handshakeTimer) return;
        clearTimeout(route.handshakeTimer);
        delete route.handshakeTimer;
      } else if (msg.type === "sealed" && route.handshakeTimer) {
        return closeSecureRoute(
          accessSessionId,
          1008,
          "handshake incomplete",
          true,
        );
      }
      resetSecureIdle(route);
      if (route.socket.readyState === WebSocket.OPEN)
        route.socket.send(JSON.stringify(msg));
      if (msg.type === "device_close")
        closeSecureRoute(
          accessSessionId,
          1008,
          String(msg.payload?.reason ?? "device closed"),
          false,
        );
      return;
    }
    if (msg.type === "http_res" && msg.channel) {
      const pending = pendingHttp.get(msg.channel);
      if (!pending || pending.deviceId !== deviceId) return;
      clearTimeout(pending.timer);
      const chunk = Buffer.from(msg.payload?.bodyB64 ?? "", "base64");
      pending.responseBytes += chunk.length;
      if (pending.responseBytes > tunnelResponseLimit) {
        pendingHttp.delete(msg.channel);
        send(deviceId, envelope("http_close", {}, msg.channel));
        if (!pending.res.headersSent)
          json(pending.res, 502, { reason: "response_too_large" });
        else pending.res.destroy(new Error("tunnel response too large"));
        return;
      }
      if (!pending.started) {
        const headers = { ...(msg.payload?.headers ?? {}) };
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        const relayCookie = pending.res.getHeader("set-cookie");
        if (relayCookie && headers["set-cookie"])
          headers["set-cookie"] = [relayCookie, headers["set-cookie"]].flat();
        pending.res.writeHead(msg.payload?.status ?? 502, headers);
        pending.started = true;
      }
      if (chunk.length) pending.res.write(chunk);
      const final = msg.payload?.final !== false;
      if (final) {
        pendingHttp.delete(msg.channel);
        pending.res.end();
      } else {
        pending.timer = httpTimeout(msg.channel, pending.res);
      }
    }
    if (msg.type === "ws_open_ok" && msg.channel) {
      const pending = pendingWs.get(msg.channel);
      if (pending?.deviceId === deviceId && pending.timer) {
        clearTimeout(pending.timer);
        delete pending.timer;
      }
    }
    if (msg.type === "ws_frame" && msg.channel) {
      const pending = pendingWs.get(msg.channel);
      if (
        pending?.deviceId === deviceId &&
        pending.socket.readyState === WebSocket.OPEN
      )
        pending.socket.send(Buffer.from(msg.payload?.dataB64 ?? "", "base64"), {
          binary: msg.payload?.opcode === 2,
        });
    }
    if (msg.type === "ws_close" && msg.channel) {
      const pending = pendingWs.get(msg.channel);
      if (pending?.deviceId !== deviceId) return;
      const socket = pending.socket;
      if (socket) closeSocket(socket, msg.payload?.code, msg.payload?.reason);
      pendingWs.delete(msg.channel);
    }
  });
  ws.on("close", () => {
    clearTimeout(authTimer);
    if (deviceId && deviceConnections.get(deviceId) === ws) {
      deviceConnections.delete(deviceId);
      deviceCapabilities.delete(deviceId);
      closeDeviceTunnels(deviceId);
      store.updateStatus(deviceId, "offline", "offline");
    }
  });
});

server.listen(port, host, () =>
  console.log(`DSH Relay listening on http://${host}:${port}`),
);
process.on("SIGTERM", () =>
  server.close(() => {
    clearInterval(maintenanceTimer);
    store.close();
    process.exit(0);
  }),
);
