import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  resolveJwtSecret,
  signToken,
  verifyToken,
} from "../src/auth.js";

const secret = "unit-test-secret";

function tokenForBody(body: string): string {
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

test("production requires a strong non-default JWT secret", () => {
  assert.throws(
    () => resolveJwtSecret({ NODE_ENV: "production" }),
    /JWT_SECRET is required/,
  );
  assert.throws(
    () =>
      resolveJwtSecret({ NODE_ENV: "production", JWT_SECRET: "too-short" }),
    /at least 32 bytes/,
  );
  assert.throws(
    () =>
      resolveJwtSecret({
        NODE_ENV: "production",
        JWT_SECRET: "local-development-secret-change-me",
      }),
    /known insecure default/,
  );
  assert.throws(
    () =>
      resolveJwtSecret({
        NODE_ENV: "production",
        JWT_SECRET: "replace-this-in-production",
      }),
    /known insecure default/,
  );
  assert.equal(
    resolveJwtSecret({
      NODE_ENV: "production",
      JWT_SECRET: "0123456789abcdef0123456789abcdef",
    }),
    "0123456789abcdef0123456789abcdef",
  );
});

test("development keeps the local JWT secret fallback", () => {
  assert.equal(
    resolveJwtSecret({ NODE_ENV: "development" }),
    "local-development-secret-change-me",
  );
  assert.equal(resolveJwtSecret({ JWT_SECRET: "test-secret" }), "test-secret");
});

test("token verification accepts a valid signed token", () => {
  const token = signToken({ kind: "access", sub: "account" }, secret, 60_000);
  const verified = verifyToken(token, secret);
  assert.equal(verified?.kind, "access");
  assert.equal(verified?.sub, "account");
  assert.equal(typeof verified?.exp, "number");
});

test("token verification rejects malformed or mismatched signatures", () => {
  const token = signToken({ kind: "access" }, secret, 60_000);
  const [body, signature] = token.split(".");
  const changed = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

  for (const candidate of [
    undefined,
    "",
    body,
    `${body}.${signature}.extra`,
    `${body}.AA`,
    `${body}.${signature}A`,
    `${body}.not+base64url`,
    `${body}.${changed}`,
  ]) {
    assert.doesNotThrow(() => verifyToken(candidate, secret));
    assert.equal(verifyToken(candidate, secret), null);
  }
});

test("token verification rejects invalid encoded payloads without throwing", () => {
  const invalidBase64Body = "not+base64url";
  const invalidJsonBody = Buffer.from("not json").toString("base64url");
  const missingExpiryBody = Buffer.from(
    JSON.stringify({ kind: "access" }),
  ).toString("base64url");

  for (const body of [invalidBase64Body, invalidJsonBody, missingExpiryBody]) {
    const token = tokenForBody(body);
    assert.doesNotThrow(() => verifyToken(token, secret));
    assert.equal(verifyToken(token, secret), null);
  }
});
