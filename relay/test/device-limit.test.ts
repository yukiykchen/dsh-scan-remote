import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import type { AccessClientInfo } from "../src/access-info.js";

function claimToken(): string {
  return randomBytes(32).toString("base64url");
}

function claimHash(token: string): string {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

const info: AccessClientInfo = {
  platform: "android",
  deviceLabel: "Test phone",
  osVersion: "34",
};

test("one host accepts at most 10 phones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-device-limit-"));
  const store = new Store(join(dir, "relay.sqlite"));
  try {
    const firstToken = claimToken();
    const first = store.createPairSession(claimHash(firstToken), "Limit Host");
    const firstClaim = store.claimPair(first.pairId, firstToken, info);
    assert.notEqual(typeof firstClaim, "string");
    const confirmed = store.confirmPair(first.pairId, first.confirmSecret);
    assert.notEqual(typeof confirmed, "string");
    const hostId = (confirmed as { hostId: string }).hostId;
    const hostToken = (confirmed as { hostToken: string }).hostToken;

    for (let index = 2; index <= 10; index += 1) {
      const token = claimToken();
      const session = store.createPairSession(claimHash(token), "Limit Host", hostId);
      const claimed = store.claimPair(session.pairId, token, info);
      assert.equal(typeof claimed, "object", `phone ${index} should join`);
      const done = store.confirmPair(session.pairId, session.confirmSecret);
      assert.deepEqual(done, { hostId, hostToken: null, added: true });
    }
    assert.equal(store.activeClientCount(hostId), 10);

    const eleventhToken = claimToken();
    const eleventh = store.createPairSession(
      claimHash(eleventhToken),
      "Limit Host",
      hostId,
    );
    assert.equal(store.claimPair(eleventh.pairId, eleventhToken, info), "limit");

    store.revokeDevice(hostId, store.listDevices(hostId)[0].id);
    assert.equal(store.activeClientCount(hostId), 9);
  } finally {
    store.close();
  }
});
