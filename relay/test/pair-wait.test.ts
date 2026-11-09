import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

function claimToken() {
  return randomBytes(32).toString("base64url");
}
function claimHash(token: string) {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : {},
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

async function newSession(hostName: string) {
  const token = claimToken();
  const created = await request("/pair/session", {
    claimTokenHash: claimHash(token),
    hostName,
  });
  assert.equal(created.response.status, 201);
  return { token, ...created.data };
}

test("pair wait long poll: auth, timeout, wake on claim, waiter cap", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-relay-wait-"));
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: "test-secret-value-at-least-32-bytes",
      PAIR_RATE_LIMIT_PER_MINUTE: "300",
      PAIR_WAIT_PER_PAIR: "4",
      PAIR_WAIT_MAX_MS: "25000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForRelay();

  const session = await newSession("Wait Mac");

  const badSecret = await request("/pair/wait", {
    pairId: session.pairId,
    confirmSecret: "wrong",
    timeoutMs: 1000,
  });
  assert.equal(badSecret.response.status, 401);

  const started = Date.now();
  const timedOut = await request("/pair/wait", {
    pairId: session.pairId,
    confirmSecret: session.confirmSecret,
    timeoutMs: 1000,
  });
  assert.equal(timedOut.response.status, 200);
  assert.equal(timedOut.data.status, "pending");
  assert.ok(Date.now() - started >= 900, "wait should hold until timeout");

  const waiting = request("/pair/wait", {
    pairId: session.pairId,
    confirmSecret: session.confirmSecret,
    timeoutMs: 15000,
  });
  const claimed = await request("/pair/claim-device", {
    pairId: session.pairId,
    claimToken: session.token,
    deviceLabel: "Pixel",
    platform: "android",
  });
  assert.equal(claimed.response.status, 200);
  const woken = await waiting;
  assert.equal(woken.response.status, 200);
  assert.equal(woken.data.status, "claimed");

  const confirmed = await request("/pair/confirm", {
    pairId: session.pairId,
    confirmSecret: session.confirmSecret,
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.data.hostId, claimed.data.hostId);
  assert.equal(typeof confirmed.data.hostToken, "string");

  const used = await request("/pair/wait", {
    pairId: session.pairId,
    confirmSecret: session.confirmSecret,
    timeoutMs: 1000,
  });
  assert.equal(used.response.status, 409);

  const capped = await newSession("Cap Mac");
  const holders = Array.from({ length: 4 }, () =>
    request("/pair/wait", {
      pairId: capped.pairId,
      confirmSecret: capped.confirmSecret,
      timeoutMs: 5000,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const fifth = await request("/pair/wait", {
    pairId: capped.pairId,
    confirmSecret: capped.confirmSecret,
    timeoutMs: 1000,
  });
  assert.equal(fifth.response.status, 429);
  await Promise.all(holders);
});