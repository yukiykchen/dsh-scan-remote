/* global DshCrypto */
"use strict";

importScripts("/app/crypto.js");

const tunnels = new Map();
const remoteClients = new Map();
const reconnects = new Map();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sessionDatabase = new Promise((resolve, reject) => {
  const request = indexedDB.open("dsh-remote-web", 2);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains("device-keys"))
      request.result.createObjectStore("device-keys");
    if (!request.result.objectStoreNames.contains("tunnel-sessions"))
      request.result.createObjectStore("tunnel-sessions", { keyPath: "deviceId" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function sessionTransaction(mode, action) {
  return sessionDatabase.then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction("tunnel-sessions", mode);
    const request = action(transaction.objectStore("tunnel-sessions"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function readSession(deviceId) {
  return sessionTransaction("readonly", (store) => store.get(deviceId));
}

function writeSession(session) {
  return sessionTransaction("readwrite", (store) => store.put(session));
}

function readMasterKey(deviceId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("dsh-remote-web", 2);
    request.onsuccess = () => {
      const transaction = request.result.transaction("device-keys", "readonly");
      const keyRequest = transaction.objectStore("device-keys").get(deviceId);
      keyRequest.onsuccess = () => resolve(keyRequest.result || null);
      keyRequest.onerror = () => reject(keyRequest.error);
    };
    request.onerror = () => reject(request.error);
  });
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function envelope(type, payload, channel) {
  return { v: 1, type, channel, id: crypto.randomUUID(), ts: Date.now(), payload };
}

function bytesToBase64(value) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value || "");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function remoteShim() {
  let nextChannel = 0;
  const sockets = new Map();

  class DshWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = new URL(url, location.href).href;
      this.readyState = DshWebSocket.CONNECTING;
      this.bufferedAmount = 0;
      this.extensions = "";
      this.protocol = "";
      this.binaryType = "blob";
      this.pendingSends = [];
      this.channel = `browser_ws_${Date.now()}_${nextChannel++}`;
      sockets.set(this.channel, this);
      navigator.serviceWorker.controller.postMessage({
        type: "remote-ws-open",
        channel: this.channel,
        url: this.url,
        protocols: Array.isArray(protocols) ? protocols : protocols ? [protocols] : [],
      });
    }

    send(data) {
      if (this.readyState === DshWebSocket.CONNECTING) {
        this.pendingSends.push(data);
        return;
      }
      if (this.readyState !== DshWebSocket.OPEN) return;
      this.transmit(data);
    }

    transmit(data) {
      if (typeof data === "string") {
        navigator.serviceWorker.controller.postMessage({ type: "remote-ws-send", channel: this.channel, text: data });
        return;
      }
      Promise.resolve(data instanceof Blob ? data.arrayBuffer() : data.buffer || data)
        .then((buffer) => navigator.serviceWorker.controller.postMessage(
          { type: "remote-ws-send", channel: this.channel, buffer },
          [buffer],
        ));
    }

    close(code, reason) {
      if (this.readyState >= DshWebSocket.CLOSING) return;
      this.readyState = DshWebSocket.CLOSING;
      navigator.serviceWorker.controller.postMessage({ type: "remote-ws-close", channel: this.channel, code, reason });
    }

    dispatchNamed(name, event) {
      this.dispatchEvent(event);
      const handler = this[`on${name}`];
      if (typeof handler === "function") handler.call(this, event);
    }
  }

  DshWebSocket.CONNECTING = 0;
  DshWebSocket.OPEN = 1;
  DshWebSocket.CLOSING = 2;
  DshWebSocket.CLOSED = 3;
  Object.assign(DshWebSocket.prototype, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type !== "dsh-remote-ws") return;
    const socket = sockets.get(message.channel);
    if (!socket) return;
    if (message.event === "open") {
      socket.readyState = DshWebSocket.OPEN;
      socket.protocol = message.protocol || "";
      socket.dispatchNamed("open", new Event("open"));
      for (const data of socket.pendingSends.splice(0)) socket.transmit(data);
    } else if (message.event === "message") {
      let data = message.text;
      if (message.buffer) data = socket.binaryType === "arraybuffer" ? message.buffer : new Blob([message.buffer]);
      socket.dispatchNamed("message", new MessageEvent("message", { data }));
    } else if (message.event === "close") {
      socket.readyState = DshWebSocket.CLOSED;
      sockets.delete(message.channel);
      socket.dispatchNamed("close", new CloseEvent("close", { code: message.code || 1000, reason: message.reason || "", wasClean: message.wasClean !== false }));
    } else if (message.event === "error") {
      socket.dispatchNamed("error", new Event("error"));
    }
  });

  window.WebSocket = DshWebSocket;
}

const shimSource = `;(${remoteShim.toString()})();`;

class Tunnel {
  constructor(options) {
    this.deviceId = options.deviceId;
    this.accessSessionId = options.accessSessionId;
    this.masterKey = options.masterKey;
    this.tunnelUrl = options.tunnelUrl;
    this.ticket = options.ticket;
    this.pendingHttp = new Map();
    this.virtualSockets = new Map();
    this.cookieJar = new Map();
    this.sendQueue = Promise.resolve();
    this.receiveQueue = Promise.resolve();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const encodedTicket = DshCrypto.base64Url(encoder.encode(this.ticket));
      const socket = new WebSocket(this.tunnelUrl, ["dsh-e2ee-v1", `dsh-ticket.${encodedTicket}`]);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error("加密握手超时")), 10000);
      socket.addEventListener("open", async () => {
        try {
          const hello = await DshCrypto.clientHello(this.masterKey, this.accessSessionId);
          this.clientRandomB64 = hello.clientRandomB64;
          socket.send(JSON.stringify(envelope("client_hello", hello.payload)));
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.addEventListener("message", (event) => {
        this.receiveQueue = this.receiveQueue.then(async () => {
          const message = JSON.parse(event.data);
          if (message.type === "server_hello" && !this.cipher) {
            this.cipher = await DshCrypto.acceptServerHello(
              this.masterKey,
              this.accessSessionId,
              this.clientRandomB64,
              message.payload,
            );
            clearTimeout(timer);
            resolve();
            return;
          }
          if (message.type === "sealed" && this.cipher) {
            const inner = await this.cipher.open(message.payload);
            await this.handleInner(inner);
            return;
          }
          if (message.type === "device_close") this.close(1011, message.payload?.reason || "device closed");
        }).catch((error) => this.fail(error));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("无法连接加密隧道"));
      });
      socket.addEventListener("close", () => this.fail(new Error("加密隧道已断开")));
    });
  }

  close(code = 1000, reason = "client closed") {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(envelope("client_close", { accessSessionId: this.accessSessionId, reason })));
      this.socket.close(code, reason);
    }
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    if (tunnels.get(this.deviceId) === this) tunnels.delete(this.deviceId);
    for (const pending of this.pendingHttp.values()) pending.reject(error);
    this.pendingHttp.clear();
    for (const entry of this.virtualSockets.values()) this.postSocket(entry.clientId, entry.channel, "close", { code: 1011, reason: "secure tunnel failed", wasClean: false });
    this.virtualSockets.clear();
  }

  sendInner(type, payload, channel) {
    this.sendQueue = this.sendQueue.then(async () => {
      if (!this.cipher || this.socket.readyState !== WebSocket.OPEN) throw new Error("secure tunnel unavailable");
      const sealed = await this.cipher.seal(envelope(type, payload, channel));
      this.socket.send(JSON.stringify(envelope("sealed", { accessSessionId: this.accessSessionId, ...sealed })));
    });
    return this.sendQueue;
  }

  request(path, request) {
    return new Promise(async (resolve, reject) => {
      const channel = id("http");
      const headers = Object.fromEntries(request.headers.entries());
      if (this.cookieJar.size) headers.cookie = [...this.cookieJar].map(([name, value]) => `${name}=${value}`).join("; ");
      delete headers.host;
      const body = request.method === "GET" || request.method === "HEAD" ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
      this.pendingHttp.set(channel, { resolve, reject, chunks: [], responseStarted: false });
      try {
        await this.sendInner("http_req", { method: request.method, path, headers, bodyB64: bytesToBase64(body) }, channel);
      } catch (error) {
        this.pendingHttp.delete(channel);
        reject(error);
      }
    });
  }

  responseHeaders(raw) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(raw || {})) {
      const lower = name.toLowerCase();
      if (["content-length", "content-security-policy", "transfer-encoding", "connection", "set-cookie"].includes(lower)) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        let output = String(item);
        if (lower === "location") {
          try {
            const location = new URL(output);
            if (["127.0.0.1", "localhost"].includes(location.hostname))
              output = `${self.location.origin}${location.pathname}${location.search}${location.hash}`;
          } catch {}
        }
        headers.append(name, output);
      }
    }
    return headers;
  }

  rememberCookies(raw) {
    const values = raw?.["set-cookie"] || raw?.["Set-Cookie"];
    for (const value of Array.isArray(values) ? values : values ? [values] : []) {
      const pair = String(value).split(";", 1)[0];
      const split = pair.indexOf("=");
      if (split > 0) this.cookieJar.set(pair.slice(0, split).trim(), pair.slice(split + 1));
    }
  }

  async handleHttpResponse(message) {
    const pending = this.pendingHttp.get(message.channel);
    if (!pending) return;
    const payload = message.payload || {};
    if (payload.status !== undefined && !pending.responseStarted) {
      pending.responseStarted = true;
      pending.status = Number(payload.status) || 502;
      pending.headers = this.responseHeaders(payload.headers);
      this.rememberCookies(payload.headers);
      pending.streaming = pending.headers.get("content-type")?.includes("text/event-stream");
      if (pending.streaming) {
        const stream = new TransformStream();
        pending.writer = stream.writable.getWriter();
        pending.resolve(new Response(stream.readable, { status: pending.status, headers: pending.headers }));
      }
    }
    const chunk = base64ToBytes(payload.bodyB64);
    if (pending.streaming) {
      if (chunk.length) await pending.writer.write(chunk);
      if (payload.final !== false) {
        await pending.writer.close();
        this.pendingHttp.delete(message.channel);
      }
      return;
    }
    if (chunk.length) pending.chunks.push(chunk);
    if (payload.final === false) return;
    this.pendingHttp.delete(message.channel);
    const length = pending.chunks.reduce((sum, value) => sum + value.length, 0);
    const body = new Uint8Array(length);
    let offset = 0;
    for (const value of pending.chunks) {
      body.set(value, offset);
      offset += value.length;
    }
    let output = body;
    if (pending.headers?.get("content-type")?.includes("text/html")) {
      const html = decoder
        .decode(body)
        .replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "");
      const injected = html.includes("<head")
        ? html.replace(/<head([^>]*)>/i, `<head$1><script>${shimSource}<\/script>`)
        : `<script>${shimSource}<\/script>${html}`;
      output = encoder.encode(injected);
    }
    pending.resolve(new Response(output, { status: pending.status || 200, headers: pending.headers }));
  }

  async handleInner(message) {
    if (message.type === "http_res") return this.handleHttpResponse(message);
    const entry = this.virtualSockets.get(message.channel);
    if (!entry) return;
    if (message.type === "ws_open_ok") {
      this.postSocket(entry.clientId, entry.channel, "open", { protocol: message.payload?.protocol });
      return;
    }
    if (message.type === "ws_frame") {
      const data = base64ToBytes(message.payload?.dataB64);
      if (message.payload?.opcode === 1) this.postSocket(entry.clientId, entry.channel, "message", { text: decoder.decode(data) });
      else this.postSocket(entry.clientId, entry.channel, "message", { buffer: data.buffer }, [data.buffer]);
      return;
    }
    if (message.type === "ws_close") {
      this.virtualSockets.delete(message.channel);
      this.postSocket(entry.clientId, entry.channel, "close", { code: message.payload?.code, reason: message.payload?.reason, wasClean: true });
    }
  }

  async postSocket(clientId, channel, event, data, transfer = []) {
    const client = await clients.get(clientId);
    client?.postMessage({ type: "dsh-remote-ws", channel, event, ...data }, transfer);
  }

  openVirtualSocket(clientId, message) {
    const url = new URL(message.url);
    if (
      url.origin !== self.location.origin &&
      !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      return this.postSocket(clientId, message.channel, "error", {});
    this.virtualSockets.set(message.channel, { clientId, channel: message.channel });
    const headers = message.protocols?.length ? { "sec-websocket-protocol": message.protocols.join(", ") } : {};
    return this.sendInner("ws_open", { path: `${url.pathname}${url.search}`, headers }, message.channel);
  }
}

async function freshTicket(deviceId) {
  const response = await fetch("/web-ticket", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-dsh-sw-resume": "1" },
    body: JSON.stringify({ deviceId }),
  });
  if (!response.ok) throw new Error("web_ticket_failed");
  return response.json();
}

async function resumeTunnel(deviceId) {
  const session = await readSession(deviceId);
  const masterKey = await readMasterKey(deviceId);
  if (!session || !masterKey) return null;
  const connect = async (ticketData) => {
    const options = {
      deviceId,
      masterKey,
      ticket: ticketData.ticket,
      accessSessionId: ticketData.accessSessionId,
      tunnelUrl: ticketData.tunnelUrl,
    };
    const tunnel = new Tunnel(options);
    await tunnel.connect();
    tunnels.set(deviceId, tunnel);
    await writeSession({ ...session, ...options, masterKey: undefined });
    return tunnel;
  };
  try {
    return await connect(session);
  } catch {
    try {
      return await connect(await freshTicket(deviceId));
    } catch {
      return null;
    }
  }
}

function remoteDeviceFromUrl(value) {
  try {
    const match = /^\/remote\/([^/]+)/.exec(new URL(value).pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function deviceForClient(clientId) {
  if (!clientId) return null;
  const known = remoteClients.get(clientId);
  if (known) return known;
  const client = await clients.get(clientId);
  const deviceId = remoteDeviceFromUrl(client?.url);
  if (deviceId) remoteClients.set(clientId, deviceId);
  return deviceId;
}

async function reconnectTunnel(deviceId) {
  if (!reconnects.has(deviceId)) {
    reconnects.set(deviceId, (async () => {
      const current = tunnels.get(deviceId);
      tunnels.delete(deviceId);
      current?.close(1012, "reconnecting");
      return resumeTunnel(deviceId);
    })().finally(() => reconnects.delete(deviceId)));
  }
  return reconnects.get(deviceId);
}

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const message = event.data || {};
  const respond = (value) => event.ports[0]?.postMessage(value);
  if (message.type === "init-tunnel") {
    event.waitUntil((async () => {
      try {
        tunnels.get(message.deviceId)?.close();
        const tunnel = new Tunnel(message);
        await tunnel.connect();
        tunnels.set(message.deviceId, tunnel);
        await writeSession({
          deviceId: message.deviceId,
          ticket: message.ticket,
          accessSessionId: message.accessSessionId,
          tunnelUrl: message.tunnelUrl,
        });
        respond({ ok: true });
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : "无法建立加密隧道" });
      }
    })());
    return;
  }
  const clientId = event.source?.id;
  if (!clientId || typeof message.type !== "string" || !message.type.startsWith("remote-ws-")) return;
  event.waitUntil((async () => {
    const deviceId = await deviceForClient(clientId);
    const tunnel = deviceId && (tunnels.get(deviceId) || await resumeTunnel(deviceId));
    if (!tunnel) {
      const client = await clients.get(clientId);
      client?.postMessage({ type: "dsh-remote-ws", channel: message.channel, event: "close", code: 1013, reason: "secure tunnel unavailable", wasClean: false });
      return;
    }
    if (message.type === "remote-ws-open") await tunnel.openVirtualSocket(clientId, message);
    if (message.type === "remote-ws-send") {
      const data = message.text !== undefined ? encoder.encode(message.text) : new Uint8Array(message.buffer);
      await tunnel.sendInner("ws_frame", { dataB64: bytesToBase64(data), opcode: message.text !== undefined ? 1 : 2 }, message.channel);
    }
    if (message.type === "remote-ws-close") {
      tunnel.virtualSockets.delete(message.channel);
      await tunnel.sendInner("ws_close", { code: message.code, reason: message.reason }, message.channel);
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.headers.get("x-dsh-sw-resume") === "1") return;
  const launch = /^\/remote\/([^/]+)(\/.*)?$/.exec(url.pathname);
  let deviceId = event.clientId ? remoteClients.get(event.clientId) : undefined;
  if (launch) {
    deviceId = decodeURIComponent(launch[1]);
    const resultingId = event.resultingClientId || event.clientId;
    if (resultingId) remoteClients.set(resultingId, deviceId);
  }
  deviceId ||= remoteDeviceFromUrl(event.request.referrer);
  if (deviceId && event.clientId) remoteClients.set(event.clientId, deviceId);
  if (!deviceId) return;
  const path = launch ? `${launch[2] || "/"}${url.search}` : `${url.pathname}${url.search}`;
  event.respondWith((async () => {
    const tunnel = tunnels.get(deviceId) || await resumeTunnel(deviceId);
    if (!tunnel) {
      if (event.clientId) remoteClients.delete(event.clientId);
      if (event.resultingClientId) remoteClients.delete(event.resultingClientId);
      return fetch("/remote/unavailable.html");
    }
    try {
      return await tunnel.request(path, event.request);
    } catch {
      if (!["GET", "HEAD"].includes(event.request.method))
        return new Response("Secure tunnel failed", { status: 502 });
      const recovered = await reconnectTunnel(deviceId);
      if (!recovered) return new Response("Secure tunnel failed", { status: 502 });
      return recovered.request(path, event.request).catch(() => new Response("Secure tunnel failed", { status: 502 }));
    }
  })());
});
