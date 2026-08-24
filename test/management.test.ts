import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createManagementHandler } from "../src/management.js";
import { RemoteAccessManager } from "../src/remote-access.js";

test("management mutations are local-only while state remains readable", async () => {
  let pairingRequests = 0;
  const manager = new RemoteAccessManager({
    hostName: "Test Mac",
    relay: "https://relay.test",
    dshPort: 3080,
  }, {
    request: async () => { pairingRequests += 1; throw new Error("unexpected"); },
    probeDsh: async () => true,
  });
  const server = createServer(createManagementHandler(manager));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const state = await fetch(`${base}/dsh-scan-remote/api/state`, {
      headers: { "x-dsh-scan-remote": "1" },
    });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).localActionsAllowed, false);

    const pairing = await fetch(`${base}/dsh-scan-remote/api/pairing`, {
      method: "POST",
      headers: { "x-dsh-scan-remote": "1" },
    });
    assert.equal(pairing.status, 403);
    assert.equal((await pairing.json()).reason, "local_management_required");
    assert.equal(pairingRequests, 0);
  } finally {
    manager.dispose();
    server.close();
    await once(server, "close");
  }
});

test("local management can remove an active pairing", async () => {
  let revokedToken: string | undefined;
  let savedToken: string | undefined = "not-saved";
  const manager = new RemoteAccessManager({
    hostId: "host_test",
    hostToken: "token_private",
    hostName: "Test Mac",
    relay: "https://relay.test",
    dshPort: 3080,
  }, {
    requestUnbind: async (config) => {
      revokedToken = config.hostToken;
      return { status: 200, data: { ok: true } };
    },
    save: async (config) => { savedToken = config.hostToken; },
    probeDsh: async () => true,
  });
  const server = createServer(createManagementHandler(manager));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/dsh-scan-remote/api/pairing`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).phase, "unpaired");
    assert.equal(revokedToken, "token_private");
    assert.equal(savedToken, undefined);
  } finally {
    manager.dispose();
    server.close();
    await once(server, "close");
  }
});

test("file manager and self-update routes are gone", async () => {
  const manager = new RemoteAccessManager({
    hostName: "Test Mac",
    relay: "https://relay.test",
    dshPort: 3080,
  }, { probeDsh: async () => true });
  const server = createServer(createManagementHandler(manager));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/dsh-scan-remote/files`)).status, 404);
    assert.equal((await fetch(`${base}/dsh-scan-remote/api/files`)).status, 404);
    assert.equal((await fetch(`${base}/dsh-scan-remote/api/update`)).status, 404);
    assert.equal((await fetch(`${base}/dsh-mobile/api/state`)).status, 404);
  } finally {
    manager.dispose();
    server.close();
    await once(server, "close");
  }
});
