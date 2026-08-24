import test from "node:test";
import assert from "node:assert/strict";
import { FixedWindowRateLimiter, envInteger } from "../src/limits.js";

test("fixed-window limiter returns a retry delay and resets", () => {
  const limiter = new FixedWindowRateLimiter();
  assert.equal(limiter.take("login:127.0.0.1", 2, 60_000, 1_000), 0);
  assert.equal(limiter.take("login:127.0.0.1", 2, 60_000, 2_000), 0);
  assert.equal(limiter.take("login:127.0.0.1", 2, 60_000, 3_000), 58);
  assert.equal(limiter.take("login:127.0.0.1", 2, 60_000, 61_000), 0);
});

test("environment integer parsing rejects invalid limits", () => {
  const previous = process.env.TEST_RESOURCE_LIMIT;
  process.env.TEST_RESOURCE_LIMIT = "not-a-number";
  assert.equal(envInteger("TEST_RESOURCE_LIMIT", 64), 64);
  process.env.TEST_RESOURCE_LIMIT = "128";
  assert.equal(envInteger("TEST_RESOURCE_LIMIT", 64), 128);
  if (previous === undefined) delete process.env.TEST_RESOURCE_LIMIT;
  else process.env.TEST_RESOURCE_LIMIT = previous;
});
