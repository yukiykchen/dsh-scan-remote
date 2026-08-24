import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../src/config.js";
import { RemoteAccessManager } from "../src/remote-access.js";

const config: Config = {
  hostName: "Test Mac",
  relay: "https://relay.test",
  dshPort: 3080,
};

test("starts unpaired without opening a Relay pairing session", async () => {
  let requests = 0;
  let clients = 0;
  const manager = new RemoteAccessManager(config, {
    request: async () => { requests += 1; throw new Error("unexpected"); },
    createClient: () => { clients += 1; throw new Error("unexpected"); },
    probeDsh: async () => true,
  });
  await manager.initialize();
  const state = await manager.state();
  assert.equal(state.phase, "unpaired");
  assert.equal(state.dsh, "online");
  assert.equal(requests, 0);
  assert.equal(clients, 0);
  manager.dispose();
});

test("creates pairing state immediately and never exposes credentials", async () => {
  let confirms = 0;
  const manager = new RemoteAccessManager(config, {
    request: async (url) => {
      if (url.endsWith("/pair/session")) return {
        status: 201,
        data: {
          pairId: "pair_private",
          confirmSecret: "secret_private",
          expiresAt: Date.now() + 60_000,
        },
      };
      confirms += 1;
      return { status: 202, data: { status: "pending" } };
    },
    probeDsh: async () => true,
    pollIntervalMs: 50,
  });
  const state = await manager.startPairing();
  assert.equal(state.phase, "pairing");
  assert.match(state.pairing?.qrSvg ?? "", /^<svg/);
  const qr = new URL(state.pairing?.qrPayload ?? "https://invalid.test");
  assert.equal(qr.origin, "https://relay.test");
  assert.equal(qr.pathname, "/app/");
  const params = new URLSearchParams(qr.hash.split("?")[1]);
  assert.equal(params.get("id"), "pair_private");
  assert.equal(Buffer.from(params.get("key") ?? "", "base64url").length, 32);
  assert.doesNotMatch(JSON.stringify(state), /secret_private/);
  assert.equal(confirms, 0);
  manager.dispose();
});

test("cancels pairing before confirmation polling", async () => {
  let confirms = 0;
  const manager = new RemoteAccessManager(config, {
    request: async (url) => {
      if (url.endsWith("/pair/session")) return {
        status: 201,
        data: {
          pairId: "pair_cancel",
          confirmSecret: "secret_cancel",
          expiresAt: Date.now() + 60_000,
        },
      };
      confirms += 1;
      return { status: 202, data: {} };
    },
    probeDsh: async () => true,
    pollIntervalMs: 20,
  });
  await manager.startPairing();
  manager.cancelPairing();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(confirms, 0);
  assert.equal((await manager.state()).phase, "unpaired");
  manager.dispose();
});

test("reads access sessions with Host-held credentials", async () => {
  let seenToken: string | undefined;
  const manager = new RemoteAccessManager({
    ...config,
    hostId: "host_test",
    hostToken: "token_private",
  }, {
    createClient: () => ({
      start: async () => undefined,
      stop: () => undefined,
      status: () => ({ connected: true, dsh: true }),
    }),
    requestAccessSessions: async (received) => {
      seenToken = received.hostToken;
      return [{
        id: "access_1",
        deviceLabel: "Pixel",
        platform: "android",
        osVersion: "15",
        startedAt: 1,
        lastSeenAt: 2,
        expiresAt: 3,
        status: "expired",
      }];
    },
  });
  await manager.initialize();
  const sessions = await manager.accessSessions();
  assert.equal(seenToken, "token_private");
  assert.equal(sessions[0].deviceLabel, "Pixel");
  assert.doesNotMatch(JSON.stringify(sessions), /token_private/);
  manager.dispose();
});

test("revokes the Relay credential before clearing local pairing", async () => {
  let stopped = 0;
  let requestedToken: string | undefined;
  let saved: Config | undefined;
  const manager = new RemoteAccessManager({
    ...config,
    hostId: "host_test",
    hostToken: "token_private",
    e2eeMasterKey: "e2ee_private",
  }, {
    createClient: () => ({
      start: async () => undefined,
      stop: () => { stopped += 1; },
      status: () => ({ connected: true, dsh: true }),
    }),
    requestUnbind: async (received) => {
      requestedToken = received.hostToken;
      return { status: 200, data: { ok: true } };
    },
    save: async (received) => { saved = received; },
  });
  await manager.initialize();

  const state = await manager.removePairing();

  assert.equal(requestedToken, "token_private");
  assert.equal(stopped, 1);
  assert.equal(state.phase, "unpaired");
  assert.equal(state.hostId, null);
  assert.equal(saved?.hostId, undefined);
  assert.equal(saved?.hostToken, undefined);
  assert.equal(saved?.e2eeMasterKey, undefined);
  manager.dispose();
});

test("does not overwrite an existing Host Token until confirm succeeds", async () => {
  let saved: Config | undefined;
  const manager = new RemoteAccessManager({
    ...config,
    hostId: "host_old",
    hostToken: "token_old",
    e2eeMasterKey: "key_old",
  }, {
    request: async (url) => {
      if (url.endsWith("/pair/session")) {
        return {
          status: 201,
          data: {
            pairId: "pair_new",
            confirmSecret: "secret_new",
            expiresAt: Date.now() + 60_000,
          },
        };
      }
      return { status: 202, data: { status: "pending" } };
    },
    save: async (received) => {
      saved = received;
    },
    createClient: () => ({
      start: async () => undefined,
      stop: () => undefined,
      status: () => ({ connected: true, dsh: true }),
    }),
    probeDsh: async () => true,
    pollIntervalMs: 20,
  });
  await manager.initialize();
  await manager.startPairing();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const state = await manager.state();
  assert.equal(state.phase, "pairing");
  assert.equal(state.hostId, "host_old");
  assert.equal(saved, undefined);
  manager.dispose();
});

test("keeps local pairing when Relay unbind fails", async () => {
  let stopped = 0;
  let saves = 0;
  const manager = new RemoteAccessManager({
    ...config,
    hostId: "host_test",
    hostToken: "token_private",
  }, {
    createClient: () => ({
      start: async () => undefined,
      stop: () => { stopped += 1; },
      status: () => ({ connected: true, dsh: true }),
    }),
    requestUnbind: async () => ({ status: 503, data: {} }),
    save: async () => { saves += 1; },
  });
  await manager.initialize();

  await assert.rejects(
    manager.removePairing(),
    /Relay rejected unbind request \(503\)/,
  );

  assert.equal(stopped, 0);
  assert.equal(saves, 0);
  assert.equal((await manager.state()).phase, "paired");
  manager.dispose();
});
