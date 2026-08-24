import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Store } from "../src/store.js";

function claimToken() {
  return randomBytes(32).toString("base64url");
}

function claimHash(token: string) {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

test("expired pairing sessions are removed", () => {
  const store = new Store(":memory:");
  const token = claimToken();
  const pair = store.createPairSession(claimHash(token), "Test Mac");
  store.db
    .prepare("UPDATE pair_sessions SET expires_at = 1 WHERE id = ?")
    .run(pair.pairId);
  const removed = store.cleanupExpired(2);
  assert.equal(removed.pairSessions, 1);
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) count FROM pair_sessions").get() as any)
      .count,
    0,
  );
  store.close();
});

test("admin statistics aggregate metadata without tunnel content", () => {
  const store = new Store(":memory:");
  const now = Date.UTC(2026, 7, 17, 12);
  const token = claimToken();
  const pair = store.createPairSession(claimHash(token), "Stats Mac");
  const claimed = store.claimPair(pair.pairId, token, {
    deviceLabel: "Pixel",
    platform: "android",
    osVersion: "15",
  });
  assert.ok(typeof claimed === "object");
  store.db
    .prepare("UPDATE hosts SET created_at = ?, last_seen_at = ?, dsh_status = 'online' WHERE id = ?")
    .run(now - 7200_000, now, claimed.hostId);
  store.createAccessSession(
    claimed.hostId,
    null,
    { deviceLabel: "Pixel", platform: "android", osVersion: "15" },
    now + 3600_000,
    "access_stats",
  );
  store.db
    .prepare(
      "UPDATE access_sessions SET started_at = ?, last_seen_at = ? WHERE id = ?",
    )
    .run(now - 1800_000, now, "access_stats");

  const stats = store.adminStats(now);
  assert.equal(stats.hosts.total, 1);
  assert.equal(stats.hosts.dshOnline, 1);
  assert.equal(stats.sessions.active, 1);
  assert.equal(stats.daily.length, 30);
  assert.equal(stats.recentSessions[0].hostName, "Stats Mac");
  assert.doesNotMatch(JSON.stringify(stats), /password|token|payload|prompt/i);

  store.endAccessSession("access_stats", "client closed");
  const ended = store.adminStats(now + 1);
  assert.equal(ended.sessions.active, 0);
  assert.equal(ended.recentSessions[0].status, "ended");
  store.close();
});

test("claim is single-use and confirm stays pending until claimed", () => {
  const store = new Store(":memory:");
  const token = claimToken();
  const pair = store.createPairSession(claimHash(token), "Test Mac");
  assert.equal(store.confirmPair(pair.pairId, pair.confirmSecret), "pending");
  const claimed = store.claimPair(pair.pairId, token, {
    deviceLabel: "Pixel",
    platform: "android",
    osVersion: "15",
  });
  assert.ok(typeof claimed === "object");
  assert.equal(
    store.claimPair(pair.pairId, token, {
      deviceLabel: "Pixel",
      platform: "android",
      osVersion: "15",
    }),
    "used",
  );
  const confirmed = store.confirmPair(pair.pairId, pair.confirmSecret);
  assert.ok(confirmed && typeof confirmed === "object");
  assert.equal(confirmed.hostId, claimed.hostId);
  assert.ok(store.findHostByToken(confirmed.hostId, confirmed.hostToken));
  store.close();
});
