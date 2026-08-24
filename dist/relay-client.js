import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { PLUGIN_VERSION } from "./version.js";
import { acceptClientHello, E2eeError, } from "./e2ee.js";
const MAX_HTTP_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_CHANNELS = 32;
const MAX_WS_CHANNELS = 16;
const HEALTH_FAILURE_THRESHOLD = 3;
export class HealthStatusTracker {
    current;
    failureThreshold;
    failures = 0;
    constructor(current = false, failureThreshold = HEALTH_FAILURE_THRESHOLD) {
        this.current = current;
        this.failureThreshold = failureThreshold;
    }
    update(reachable) {
        if (reachable) {
            this.failures = 0;
            this.current = true;
        }
        else if (!this.current || ++this.failures >= this.failureThreshold) {
            this.current = false;
        }
        return this.current;
    }
}
function message(type, payload, channel) {
    return { v: 1, type, channel, id: randomUUID(), ts: Date.now(), payload };
}
function isEnvelope(value) {
    if (!value || typeof value !== "object")
        return false;
    const msg = value;
    return (msg.v === 1 &&
        typeof msg.type === "string" &&
        typeof msg.id === "string" &&
        typeof msg.ts === "number" &&
        typeof msg.payload === "object" &&
        msg.payload !== null);
}
export function normalizeCloseCode(code) {
    if (typeof code !== "number")
        return undefined;
    if (code === 1000 || code === 1001 || code === 1002 || code === 1003)
        return code;
    if (code >= 1007 && code <= 1014)
        return code;
    if (code >= 3000 && code <= 4999)
        return code;
    return undefined;
}
export function localPath(value) {
    if (typeof value !== "string" ||
        !value.startsWith("/") ||
        value.startsWith("//") ||
        /[\u0000-\u001f\u007f]/.test(value))
        throw new E2eeError("invalid local path");
    return value;
}
function closeSocket(socket, code, reason) {
    const normalized = normalizeCloseCode(code);
    if (normalized === undefined)
        socket.close();
    else
        socket.close(normalized, String(reason ?? "").slice(0, 100));
}
export class RelayClient {
    config;
    ws;
    stopped = false;
    authenticated = false;
    health = false;
    healthCheckInFlight = false;
    healthTracker = new HealthStatusTracker();
    retry = 0;
    heartbeat;
    healthTimer;
    secureSessions = new Map();
    localSockets = new Map();
    localRequests = new Map();
    constructor(config) {
        this.config = config;
    }
    status() {
        return { connected: this.authenticated, dsh: this.health };
    }
    async start() {
        this.stopped = false;
        await this.checkHealth();
        this.healthTimer = setInterval(() => void this.checkHealth(), 5000);
        this.connect();
    }
    stop() {
        this.stopped = true;
        clearInterval(this.heartbeat);
        clearInterval(this.healthTimer);
        this.ws?.close();
        this.closeAllSessions();
    }
    relayWsUrl() {
        const url = new URL(this.config.relay);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = "/device";
        return url.toString();
    }
    connect() {
        if (this.stopped)
            return;
        const ws = new WebSocket(this.relayWsUrl());
        this.ws = ws;
        ws.on("open", () => ws.send(JSON.stringify(message("auth", {
            hostId: this.config.hostId,
            hostToken: this.config.hostToken,
            capabilities: this.config.e2eeMasterKey
                ? ["sealed-tunnel-v1"]
                : [],
            version: PLUGIN_VERSION,
        }))));
        ws.on("message", (raw) => {
            let value;
            try {
                value = JSON.parse(raw.toString());
            }
            catch {
                ws.close(4000, "invalid json");
                return;
            }
            if (isEnvelope(value))
                this.handle(value);
            else
                ws.close(4000, "invalid envelope");
        });
        ws.on("close", () => {
            this.authenticated = false;
            clearInterval(this.heartbeat);
            this.closeAllSessions();
            if (!this.stopped) {
                const schedule = [1000, 2000, 5000, 10000, 30000];
                const delay = schedule[Math.min(this.retry++, schedule.length - 1)];
                console.log(`Relay disconnected; retrying in ${delay / 1000}s`);
                setTimeout(() => this.connect(), delay);
            }
        });
        ws.on("error", () => undefined);
    }
    sendOuter(type, payload) {
        if (this.ws?.readyState !== WebSocket.OPEN)
            return false;
        this.ws.send(JSON.stringify(message(type, payload)));
        return true;
    }
    sendInner(accessSessionId, type, payload, channel) {
        const cipher = this.secureSessions.get(accessSessionId);
        if (!cipher)
            return false;
        const sealed = cipher.seal(message(type, payload, channel));
        return this.sendOuter("sealed", { accessSessionId, ...sealed });
    }
    upstreamHeaders(input) {
        const authority = `127.0.0.1:${this.config.dshPort}`;
        const headers = { ...input, host: authority };
        if (headers.origin)
            headers.origin = `http://${authority}`;
        if (headers.referer)
            headers.referer = `http://${authority}/`;
        delete headers.forwarded;
        delete headers["x-forwarded-for"];
        delete headers["x-forwarded-host"];
        delete headers["x-forwarded-proto"];
        delete headers["x-dsh-mobile-remote"];
        delete headers["x-dsh-scan-remote"];
        headers["x-dsh-scan-remote"] = "1";
        return headers;
    }
    async checkHealth() {
        if (this.healthCheckInFlight)
            return;
        this.healthCheckInFlight = true;
        const before = this.health;
        let reachable = false;
        try {
            const response = await fetch(`http://127.0.0.1:${this.config.dshPort}/`, {
                signal: AbortSignal.timeout(3500),
            });
            reachable = response.status < 500;
        }
        catch {
            reachable = false;
        }
        finally {
            this.healthCheckInFlight = false;
        }
        this.health = this.healthTracker.update(reachable);
        if (before !== this.health || this.authenticated)
            this.sendOuter("status", { dsh: this.health ? "online" : "offline" });
    }
    handle(msg) {
        if (msg.type === "auth_ok") {
            this.authenticated = true;
            this.retry = 0;
            console.log(`Connected to Relay; DSH is ${this.health ? "online" : "offline"}`);
            this.sendOuter("status", { dsh: this.health ? "online" : "offline" });
            this.heartbeat = setInterval(() => this.sendOuter("ping", {}), 25000);
            return;
        }
        if (msg.type === "client_hello")
            return this.acceptSession(msg.payload);
        if (msg.type === "sealed")
            return this.openSealed(msg.payload);
        if (msg.type === "client_close") {
            const sessionId = msg.payload?.accessSessionId;
            if (typeof sessionId === "string")
                this.closeSession(sessionId, false);
        }
    }
    acceptSession(payload) {
        const hello = payload;
        const sessionId = hello?.accessSessionId;
        if (typeof sessionId !== "string" || !this.config.e2eeMasterKey) {
            if (typeof sessionId === "string")
                this.sendOuter("device_close", {
                    accessSessionId: sessionId,
                    reason: "e2ee_required",
                });
            return;
        }
        try {
            this.closeSession(sessionId, false);
            const accepted = acceptClientHello(this.config.e2eeMasterKey, hello);
            this.secureSessions.set(sessionId, accepted.cipher);
            this.sendOuter("server_hello", accepted.hello);
        }
        catch {
            this.sendOuter("device_close", {
                accessSessionId: sessionId,
                reason: "e2ee_handshake_failed",
            });
            this.closeSession(sessionId, false);
        }
    }
    openSealed(payload) {
        const data = payload;
        const sessionId = data?.accessSessionId;
        if (typeof sessionId !== "string")
            return;
        const cipher = this.secureSessions.get(sessionId);
        if (!cipher ||
            typeof data.seq !== "string" ||
            typeof data.ciphertextB64 !== "string") {
            if (typeof sessionId === "string")
                this.closeSession(sessionId, true);
            return;
        }
        try {
            const inner = cipher.open({
                seq: data.seq,
                ciphertextB64: data.ciphertextB64,
            });
            if (!isEnvelope(inner))
                throw new E2eeError("invalid inner envelope");
            this.handleInner(sessionId, inner);
        }
        catch {
            this.closeSession(sessionId, true);
        }
    }
    handleInner(sessionId, msg) {
        if (msg.type === "http_req")
            return this.http(sessionId, msg);
        if (msg.type === "http_close") {
            const entry = this.localRequests.get(this.channelKey(sessionId, msg.channel));
            entry?.request.destroy();
            this.localRequests.delete(this.channelKey(sessionId, msg.channel));
            return;
        }
        if (msg.type === "ws_open")
            return this.openWs(sessionId, msg);
        if (msg.type === "ws_frame") {
            const entry = this.localSockets.get(this.channelKey(sessionId, msg.channel));
            if (entry?.socket.readyState === WebSocket.OPEN)
                entry.socket.send(Buffer.from(msg.payload.dataB64 ?? "", "base64"), {
                    binary: msg.payload.opcode === 2,
                });
            return;
        }
        if (msg.type === "ws_close") {
            const key = this.channelKey(sessionId, msg.channel);
            const entry = this.localSockets.get(key);
            if (entry)
                closeSocket(entry.socket, msg.payload.code, msg.payload.reason);
            this.localSockets.delete(key);
            return;
        }
        throw new E2eeError("unsupported inner type");
    }
    channelKey(sessionId, channel) {
        if (typeof channel !== "string" || !channel)
            throw new E2eeError("missing channel");
        return `${sessionId}:${channel}`;
    }
    sessionRequestCount(sessionId) {
        let count = 0;
        for (const entry of this.localRequests.values())
            if (entry.sessionId === sessionId)
                count += 1;
        return count;
    }
    sessionSocketCount(sessionId) {
        let count = 0;
        for (const entry of this.localSockets.values())
            if (entry.sessionId === sessionId)
                count += 1;
        return count;
    }
    http(sessionId, msg) {
        const channel = msg.channel ?? "";
        const key = this.channelKey(sessionId, channel);
        if (this.sessionRequestCount(sessionId) >= MAX_HTTP_CHANNELS) {
            this.sendInner(sessionId, "http_res", {
                status: 429,
                headers: { "content-type": "application/json" },
                bodyB64: Buffer.from('{"reason":"too_many_tunnels"}').toString("base64"),
                seq: 0,
                final: true,
            }, channel);
            return;
        }
        const path = localPath(msg.payload.path);
        const body = Buffer.from(msg.payload.bodyB64 ?? "", "base64");
        if (body.length > MAX_HTTP_REQUEST_BYTES)
            throw new E2eeError("request too large");
        const headers = this.upstreamHeaders(msg.payload.headers ?? {});
        delete headers["content-length"];
        const req = http.request({
            hostname: "127.0.0.1",
            port: this.config.dshPort,
            method: msg.payload.method,
            path,
            headers,
        }, (res) => {
            let seq = 0;
            const responseHeaders = { ...res.headers };
            delete responseHeaders["content-length"];
            delete responseHeaders["transfer-encoding"];
            this.sendInner(sessionId, "http_res", {
                status: res.statusCode ?? 502,
                headers: responseHeaders,
                bodyB64: "",
                seq: seq++,
                final: false,
            }, channel);
            res.on("data", (chunk) => {
                const entry = this.localRequests.get(key);
                if (!entry)
                    return;
                entry.responseBytes += Buffer.byteLength(chunk);
                if (entry.responseBytes > MAX_HTTP_RESPONSE_BYTES) {
                    entry.request.destroy();
                    this.localRequests.delete(key);
                    this.sendInner(sessionId, "http_res", {
                        status: 502,
                        headers: { "content-type": "application/json" },
                        bodyB64: Buffer.from('{"reason":"response_too_large"}').toString("base64"),
                        seq: seq++,
                        final: true,
                    }, channel);
                    return;
                }
                this.sendInner(sessionId, "http_res", {
                    bodyB64: Buffer.from(chunk).toString("base64"),
                    seq: seq++,
                    final: false,
                }, channel);
            });
            res.on("end", () => {
                if (!this.localRequests.has(key))
                    return;
                this.sendInner(sessionId, "http_res", { bodyB64: "", seq: seq++, final: true }, channel);
                this.localRequests.delete(key);
            });
        });
        this.localRequests.set(key, { sessionId, request: req, responseBytes: 0 });
        req.on("error", () => {
            if (!this.localRequests.delete(key))
                return;
            this.sendInner(sessionId, "http_res", {
                status: 502,
                headers: { "content-type": "application/json" },
                bodyB64: Buffer.from(JSON.stringify({ reason: "dsh_unreachable" })).toString("base64"),
                seq: 0,
                final: true,
            }, channel);
        });
        if (body.length)
            req.write(body);
        req.end();
    }
    openWs(sessionId, msg) {
        const channel = msg.channel ?? "";
        if (this.sessionSocketCount(sessionId) >= MAX_WS_CHANNELS) {
            this.sendInner(sessionId, "ws_close", { code: 1013, reason: "too many tunnels" }, channel);
            return;
        }
        const key = this.channelKey(sessionId, channel);
        const path = localPath(msg.payload.path);
        const url = `ws://127.0.0.1:${this.config.dshPort}${path}`;
        const headers = this.upstreamHeaders(msg.payload.headers ?? {});
        const socket = new WebSocket(url, { headers });
        this.localSockets.set(key, { sessionId, socket });
        socket.on("open", () => this.sendInner(sessionId, "ws_open_ok", {}, channel));
        socket.on("message", (data, binary) => this.sendInner(sessionId, "ws_frame", {
            dataB64: Buffer.from(data).toString("base64"),
            opcode: binary ? 2 : 1,
        }, channel));
        socket.on("close", (code, reason) => {
            this.localSockets.delete(key);
            this.sendInner(sessionId, "ws_close", { code, reason: reason.toString() }, channel);
        });
        socket.on("error", () => undefined);
    }
    closeSession(sessionId, notify) {
        this.secureSessions.delete(sessionId);
        for (const [key, entry] of this.localRequests) {
            if (entry.sessionId !== sessionId)
                continue;
            entry.request.destroy();
            this.localRequests.delete(key);
        }
        for (const [key, entry] of this.localSockets) {
            if (entry.sessionId !== sessionId)
                continue;
            entry.socket.close(1008, "secure session closed");
            this.localSockets.delete(key);
        }
        if (notify)
            this.sendOuter("device_close", {
                accessSessionId: sessionId,
                reason: "e2ee_auth_failed",
            });
    }
    closeAllSessions() {
        for (const sessionId of [...this.secureSessions.keys()])
            this.closeSession(sessionId, false);
    }
}
