import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptClientHello,
  clientProof,
  createClientCipher,
  deriveClaimToken,
  encodeBase64Url,
  E2eeError,
  hashClaimToken,
} from "../src/e2ee.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HealthStatusTracker, localPath } from "../src/relay-client.js";

const masterKey = encodeBase64Url(Buffer.from([...Array(32).keys()]));
const clientRandom = encodeBase64Url(
  Buffer.from([...Array(32).keys()].map((value) => value + 32)),
);
const serverRandom = Buffer.from(
  [...Array(32).keys()].map((value) => value + 64),
);
const accessSessionId = "access_test_vector";

function pair() {
  const accepted = acceptClientHello(
    masterKey,
    {
      accessSessionId,
      clientRandomB64: clientRandom,
      clientProofB64: clientProof(masterKey, accessSessionId, clientRandom),
    },
    serverRandom,
  );
  const client = createClientCipher(
    masterKey,
    accessSessionId,
    clientRandom,
    accepted.hello,
  );
  return { device: accepted.cipher, client, hello: accepted.hello };
}

test("derives matching directional keys and seals both directions", () => {
  assert.equal(
    clientProof(masterKey, accessSessionId, clientRandom),
    "F3mAmAuR30RnLXq7TMUeMNWZquo8GPHVyCxWycTDW80",
  );
  const { client, device, hello } = pair();
  assert.equal(
    hello.serverRandomB64,
    "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
  );
  assert.equal(
    hello.serverProofB64,
    "IXvvgrKVbAjjW-M2rLOmf-blsUwmbgLa6y79lEj1vNA",
  );
  const request = {
    v: 1,
    type: "http_req",
    channel: "ch_test",
    id: "request_1",
    ts: 0,
    payload: { method: "POST", path: "/canary", bodyB64: "c2VjcmV0" },
  };
  const sealedRequest = client.seal(request);
  assert.equal(sealedRequest.seq, "0");
  assert.equal(
    sealedRequest.ciphertextB64,
    "voqHzLsUCWC__C-NBr-s0t1AshPpTEwNwSoOrhx_ihApnwkPlwKxr7EX28kmqOjoVQus161QnjXyzjxDil_WXgnkvu0pgQfiGV27QIgL97KPe2X0nv9vlzLUmwMll0ipeUo2IZKgM-Rt_WRa_-TyyL9SEkozijz1Z6HBxk1hfLiwQEb602fzHVGQP4Wh3Q2B41mrL_-AGQ",
  );
  assert.deepEqual(device.open(sealedRequest), request);

  const response = {
    v: 1,
    type: "http_res",
    channel: "ch_test",
    id: "response_1",
    ts: 0,
    payload: { status: 200, bodyB64: "b2s=", seq: 0, final: true },
  };
  assert.deepEqual(client.open(device.seal(response)), response);
});

test("accepts only origin-form local paths", () => {
  assert.equal(localPath("/api/tasks?q=1"), "/api/tasks?q=1");
  for (const value of ["", "api/tasks", "//example.com/path", "/bad\npath"]) {
    assert.throws(() => localPath(value), E2eeError);
  }
});

test("keeps DSH online through transient probe failures", () => {
  const health = new HealthStatusTracker(false, 3);
  assert.equal(health.update(true), true);
  assert.equal(health.update(false), true);
  assert.equal(health.update(false), true);
  assert.equal(health.update(true), true);
  assert.equal(health.update(false), true);
  assert.equal(health.update(false), true);
  assert.equal(health.update(false), false);
  assert.equal(health.update(true), true);
});

test("matches shared sealed-tunnel-v1 vectors", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const vectors = JSON.parse(
    readFileSync(join(root, "../vectors/sealed-tunnel-v1.json"), "utf8"),
  );
  assert.equal(deriveClaimToken(vectors.masterKeyB64), vectors.claimTokenB64);
  assert.equal(hashClaimToken(vectors.claimTokenB64), vectors.claimTokenHashHex);
  assert.equal(
    clientProof(vectors.masterKeyB64, vectors.accessSessionId, vectors.clientRandomB64),
    vectors.clientProofB64,
  );
  const client = createClientCipher(
    vectors.masterKeyB64,
    vectors.accessSessionId,
    vectors.clientRandomB64,
    {
      accessSessionId: vectors.accessSessionId,
      serverRandomB64: vectors.serverRandomB64,
      serverProofB64: vectors.serverProofB64,
    },
  );
  assert.equal(
    client.seal(vectors.httpReq).ciphertextB64,
    vectors.httpReqCiphertextB64,
  );
});

test("rejects an invalid handshake proof", () => {
  assert.throws(
    () =>
      acceptClientHello(masterKey, {
        accessSessionId,
        clientRandomB64: clientRandom,
        clientProofB64: encodeBase64Url(Buffer.alloc(32)),
      }),
    E2eeError,
  );
});

test("rejects tampering, replay, and wrong sessions", () => {
  const first = pair();
  const sealed = first.client.seal({ canary: "private" });
  const changed = Buffer.from(sealed.ciphertextB64, "base64url");
  changed[0] ^= 1;
  assert.throws(
    () =>
      first.device.open({
        ...sealed,
        ciphertextB64: changed.toString("base64url"),
      }),
    E2eeError,
  );
  assert.deepEqual(first.device.open(sealed), { canary: "private" });
  assert.throws(() => first.device.open(sealed), E2eeError);

  const second = pair();
  const otherSession = acceptClientHello(
    masterKey,
    {
      accessSessionId: "access_other",
      clientRandomB64: clientRandom,
      clientProofB64: clientProof(masterKey, "access_other", clientRandom),
    },
    serverRandom,
  ).cipher;
  assert.throws(() => otherSession.open(second.client.seal({ ok: true })), E2eeError);
});
