import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Store } from "../src/store.js";

async function rejectedProductionStartup(
  jwtSecret?: string,
  extra: Record<string, string> = {},
) {
  const environment = { ...process.env, NODE_ENV: "production", ...extra };
  if (jwtSecret === undefined) delete environment.JWT_SECRET;
  else environment.JWT_SECRET = jwtSecret;
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "exit");
  return { code, stderr };
}

test("production startup rejects missing, short, and default JWT secrets", async () => {
  for (const candidate of [
    undefined,
    "short-secret",
    "local-development-secret-change-me",
    "replace-this-in-production",
  ]) {
    const result = await rejectedProductionStartup(candidate);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /JWT_SECRET/);
  }
});

test("production rejects partial or weak admin credentials", async () => {
  for (const extra of [
    { ADMIN_USERNAME: "relay-admin", ADMIN_PASSWORD: "" },
    { ADMIN_USERNAME: "", ADMIN_PASSWORD: "short-password" },
    { ADMIN_USERNAME: "relay-admin", ADMIN_PASSWORD: "too-short" },
  ]) {
    const result = await rejectedProductionStartup(
      "secure-default-test-secret-value",
      extra,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ADMIN_USERNAME|ADMIN_PASSWORD/);
  }
});

test("stores event metadata without the Companion payload", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-relay-event-metadata-"));
  const store = new Store(join(dir, "relay.sqlite"));
  t.after(() => store.close());

  store.addEvent("host_test", "task.changed");
  const event = store.db
    .prepare(
      "SELECT kind, payload_json payloadJson FROM events WHERE host_id = ?",
    )
    .get("host_test") as { kind: string; payloadJson: string };

  assert.deepEqual(event, { kind: "task.changed", payloadJson: "{}" });
});

test("fails closed when legacy proxy or a web ticket is unavailable", async (t) => {
  const port = 21000 + Math.floor(Math.random() * 1000);
  const dir = await mkdtemp(join(tmpdir(), "dsh-relay-secure-defaults-"));
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: "secure-default-test-secret",
      ALLOW_LEGACY_WEB_PROXY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const version = await fetch(`${base}/app/version?platform=android`);
  assert.equal(version.status, 200);
  assert.deepEqual(await version.json(), {
    platform: "android",
    latestVersion: "0.1.5",
    minimumVersion: "0.1.3",
    downloadUrl: null,
    releaseNotes: null,
  });

  const legacy = await fetch(`${base}/s/dev_unknown/`);
  assert.equal(legacy.status, 426);
  assert.deepEqual(await legacy.json(), { reason: "e2ee_required" });

  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/client-tunnel`);
      socket.once("open", () => resolve());
      socket.once("error", reject);
    }),
  );
});
