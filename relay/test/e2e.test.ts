import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { WebSocket } from "ws";

const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;

function claimToken() {
  return randomBytes(32).toString("base64url");
}
function claimHash(token: string) {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  headerName = "Bearer",
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `${headerName} ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, data: (await response.json()) as any };
}

async function waitForRelay() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("relay did not start");
}

function open(url: string, options?: any): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
function next(ws: WebSocket): Promise<any> {
  return new Promise((resolve) =>
    ws.once("message", (data) => resolve(JSON.parse(data.toString()))),
  );
}
function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

async function chunkedOversizedRequest(path: string) {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method: "POST" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }),
      );
    });
    req.on("error", reject);
    req.write("x".repeat(800));
    req.write("x".repeat(800));
    req.end();
  });
}

test("passwordless pairing, tickets, sealed forwarding, and revoke", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-relay-test-"));
  const adminPassword = randomBytes(24).toString("base64url");
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: "test-secret-value-at-least-32-bytes",
      PAIR_RATE_LIMIT_PER_MINUTE: "30",
      MAX_API_BODY_BYTES: "1024",
      ALLOW_LEGACY_WEB_PROXY: "0",
      ADMIN_USERNAME: "relay-admin",
      ADMIN_PASSWORD: adminPassword,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForRelay();

  const root = await fetch(base, { redirect: "manual" });
  assert.equal(root.status, 302);

  const accountsGone = await request("/auth/register", "POST", {
    email: "test@example.com",
    password: "correct-horse",
  });
  assert.equal(accountsGone.response.status, 410);

  const token = claimToken();
  const session = await request("/pair/session", "POST", {
    claimTokenHash: claimHash(token),
    hostName: "Test Mac",
  });
  assert.equal(session.response.status, 201);
  assert.match(session.data.pairId, /^pair_/);
  assert.equal(typeof session.data.confirmSecret, "string");

  const pending = await request("/pair/confirm", "POST", {
    pairId: session.data.pairId,
    confirmSecret: session.data.confirmSecret,
  });
  assert.equal(pending.response.status, 202);

  const badClaim = await request("/pair/claim-device", "POST", {
    pairId: session.data.pairId,
    claimToken: claimToken(),
  });
  assert.equal(badClaim.response.status, 403);

  const claimed = await request("/pair/claim-device", "POST", {
    pairId: session.data.pairId,
    claimToken: token,
    deviceLabel: "Pixel",
    platform: "android",
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(typeof claimed.data.clientToken, "string");

  const reusedClaim = await request("/pair/claim-device", "POST", {
    pairId: session.data.pairId,
    claimToken: token,
  });
  assert.equal(reusedClaim.response.status, 409);

  const confirmed = await request("/pair/confirm", "POST", {
    pairId: session.data.pairId,
    confirmSecret: session.data.confirmSecret,
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.data.hostId, claimed.data.hostId);

  const expired = await request("/pair/session", "POST", {
    claimTokenHash: claimHash(claimToken()),
    hostName: "Other",
  });
  assert.equal(expired.response.status, 201);

  const oversizedApi = await fetch(`${base}/pair/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(2_000) }),
  });
  assert.equal(oversizedApi.status, 413);
  const chunkedOversizedApi = await chunkedOversizedRequest("/pair/session");
  assert.equal(chunkedOversizedApi.status, 413);

  const host = await open(`${wsBase}/device`);
  host.send(
    JSON.stringify({
      v: 1,
      type: "auth",
      id: "auth",
      ts: Date.now(),
      payload: {
        hostId: confirmed.data.hostId,
        hostToken: confirmed.data.hostToken,
        capabilities: ["sealed-tunnel-v1"],
      },
    }),
  );
  assert.equal((await next(host)).type, "auth_ok");
  host.send(
    JSON.stringify({
      v: 1,
      type: "status",
      id: "status",
      ts: Date.now(),
      payload: { dsh: "online" },
    }),
  );
  host.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "client_hello")
      host.send(
        JSON.stringify({
          v: 1,
          type: "server_hello",
          id: "server-hello",
          ts: 0,
          payload: {
            accessSessionId: msg.payload.accessSessionId,
            serverRandomB64: "opaque-random",
            serverProofB64: "opaque-proof",
          },
        }),
      );
    else if (msg.type === "sealed")
      host.send(
        JSON.stringify({
          ...msg,
          id: "sealed-response",
          payload: {
            ...msg.payload,
            ciphertextB64: "cmVsYXktY2Fubm90LWRlY3J5cHQ",
          },
        }),
      );
  });

  const ticket = await request(
    "/access-ticket",
    "POST",
    {},
    claimed.data.clientToken,
  );
  assert.equal(ticket.response.status, 200);
  assert.equal(ticket.data.tunnelUrl, `${wsBase}/client-tunnel`);
  assert.doesNotMatch(ticket.response.url, /ticket=/);

  const client = await open(`${wsBase}/client-tunnel`, {
    headers: { authorization: `Bearer ${ticket.data.ticket}` },
  });
  client.send(
    JSON.stringify({
      v: 1,
      type: "client_hello",
      id: "client-hello",
      ts: 0,
      payload: {
        accessSessionId: ticket.data.accessSessionId,
        clientRandomB64: "opaque-random",
        clientProofB64: "opaque-proof",
      },
    }),
  );
  assert.equal((await next(client)).type, "server_hello");
  client.send(
    JSON.stringify({
      v: 1,
      type: "sealed",
      id: "sealed-request",
      ts: 0,
      payload: {
        accessSessionId: ticket.data.accessSessionId,
        seq: "0",
        ciphertextB64: "b3BhcXVl",
      },
    }),
  );
  const sealedResponse = await next(client);
  assert.equal(sealedResponse.type, "sealed");
  assert.equal(
    sealedResponse.payload.ciphertextB64,
    "cmVsYXktY2Fubm90LWRlY3J5cHQ",
  );

  await assert.rejects(
    open(`${wsBase}/client-tunnel`, {
      headers: { authorization: `Bearer ${ticket.data.ticket}` },
    }),
  );

  const queryTicket = new URL(`${wsBase}/client-tunnel`);
  queryTicket.searchParams.set("ticket", ticket.data.ticket);
  await assert.rejects(open(queryTicket.toString()));

  const logs: string[] = [];
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
  assert.doesNotMatch(logs.join(""), /\/api\/|Authorization|prompt|model/i);

  const adminLogin = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      username: "relay-admin",
      password: adminPassword,
    }),
  });
  assert.equal(adminLogin.status, 200);
  const stats = await fetch(`${base}/admin/api/stats`, {
    headers: { cookie: adminLogin.headers.get("set-cookie") ?? "" },
  });
  assert.equal(stats.status, 200);
  const body = await stats.json();
  assert.doesNotMatch(JSON.stringify(body), /clientToken|hostToken|claimToken|prompt/i);

  const accessLog = await fetch(
    `${base}/host-management/${confirmed.data.hostId}/access-sessions`,
    { headers: { authorization: `Host ${confirmed.data.hostToken}` } },
  );
  assert.equal(accessLog.status, 200);

  const revoked = closed(host);
  const unbound = await fetch(
    `${base}/host-management/${confirmed.data.hostId}/unbind`,
    {
      method: "POST",
      headers: { authorization: `Host ${confirmed.data.hostToken}` },
    },
  );
  assert.equal(unbound.status, 200);
  assert.equal(await revoked, 4003);

  const afterUnbind = await request(
    "/access-ticket",
    "POST",
    {},
    claimed.data.clientToken,
  );
  assert.equal(afterUnbind.response.status, 401);
});

test("rejects an expired pairing QR", async (t) => {
  const expirePort = 20000 + Math.floor(Math.random() * 1000);
  const expireBase = `http://127.0.0.1:${expirePort}`;
  const dir = await mkdtemp(join(tmpdir(), "dsh-relay-expire-"));
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(expirePort),
      HOST: "127.0.0.1",
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: "test-secret-value-at-least-32-bytes",
      PAIR_TTL_MS: "30",
      PAIR_RATE_LIMIT_PER_MINUTE: "30",
      MAX_API_BODY_BYTES: "1024",
      ALLOW_LEGACY_WEB_PROXY: "0",
      ADMIN_USERNAME: "relay-admin",
      ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${expireBase}/health`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (i === 49) throw new Error("expired-QR relay did not start");
  }
  const token = claimToken();
  const session = await fetch(`${expireBase}/pair/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      claimTokenHash: claimHash(token),
      hostName: "Expired",
    }),
  });
  assert.equal(session.status, 201);
  const created = (await session.json()) as { pairId: string };
  await new Promise((resolve) => setTimeout(resolve, 80));
  const claimed = await fetch(`${expireBase}/pair/claim-device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairId: created.pairId, claimToken: token }),
  });
  assert.equal(claimed.status, 410);
  assert.equal(((await claimed.json()) as { error?: string }).error, "expired");
});
