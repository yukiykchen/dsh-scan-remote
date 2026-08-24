import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { Config } from "../src/config.js";
import { RelayClient } from "../src/relay-client.js";

async function listen(): Promise<{
  port: number;
  authCount: () => number;
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0 });
  let current: import("ws").WebSocket | undefined;
  let authCount = 0;
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type?: string };
      if (msg.type !== "auth") return;
      current?.close(4002, "replaced");
      current = socket;
      authCount += 1;
      socket.send(
        JSON.stringify({
          v: 1,
          type: "auth_ok",
          id: `auth-${authCount}`,
          ts: Date.now(),
          payload: {},
        }),
      );
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.once("listening", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return {
    port,
    authCount: () => authCount,
    close: () =>
      new Promise((resolve) => {
        current?.terminate();
        server.close(() => resolve());
      }),
  };
}

function config(port: number): Config {
  return {
    hostName: "Test Mac",
    relay: `http://127.0.0.1:${port}`,
    dshPort: 1,
    hostId: "host_overlap",
    hostToken: "token_overlap",
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a second client for the same host stops the first instead of flapping", async () => {
  const relay = await listen();
  const first = new RelayClient(config(relay.port));
  const second = new RelayClient(config(relay.port));
  try {
    await first.start();
    await delay(150);
    assert.equal(relay.authCount(), 1);
    await second.start();
    await delay(200);
    assert.equal(first.status().connected, false);
    assert.equal(second.status().connected, true);
    assert.equal(relay.authCount(), 2);
    await delay(1500);
    assert.equal(relay.authCount(), 2);
  } finally {
    first.stop();
    second.stop();
    await relay.close();
  }
});
