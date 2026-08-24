(function (scope) {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const subtle = scope.crypto.subtle;

  function bytes(value) {
    return encoder.encode(value);
  }

  function base64Url(value) {
    let binary = "";
    for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }

  function fromBase64Url(value, length) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value))
      throw new Error("invalid base64url");
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const result = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (base64Url(result) !== value || (length !== undefined && result.length !== length))
      throw new Error("invalid base64url");
    return result;
  }

  function canonical(parts) {
    return bytes(JSON.stringify(parts));
  }

  async function hmac(keyBytes, value) {
    const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await subtle.sign("HMAC", key, value));
  }

  async function proof(masterKey, label, parts) {
    return base64Url(await hmac(fromBase64Url(masterKey, 32), canonical([label, 1, ...parts])));
  }

  async function derive(masterKey, accessSessionId, clientRandomB64, serverRandomB64) {
    const rawKey = fromBase64Url(masterKey, 32);
    fromBase64Url(clientRandomB64, 32);
    fromBase64Url(serverRandomB64, 32);
    const salt = await subtle.digest(
      "SHA-256",
      canonical(["dsh-e2ee-salt", 1, accessSessionId, clientRandomB64, serverRandomB64]),
    );
    const hkdfKey = await subtle.importKey("raw", rawKey, "HKDF", false, ["deriveBits"]);
    async function expand(info, size) {
      return new Uint8Array(
        await subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt, info: bytes(info) },
          hkdfKey,
          size * 8,
        ),
      );
    }
    return {
      c2dKey: await expand("dsh-e2ee-v1:c2d:key", 32),
      d2cKey: await expand("dsh-e2ee-v1:d2c:key", 32),
      c2dNonce: await expand("dsh-e2ee-v1:c2d:nonce", 4),
      d2cNonce: await expand("dsh-e2ee-v1:d2c:nonce", 4),
    };
  }

  function nonce(prefix, sequence) {
    const result = new Uint8Array(12);
    result.set(prefix, 0);
    new DataView(result.buffer).setBigUint64(4, sequence, false);
    return result;
  }

  function aad(accessSessionId, direction, sequence) {
    return canonical(["dsh-e2ee", 1, accessSessionId, direction, sequence.toString()]);
  }

  class Cipher {
    constructor(accessSessionId, material) {
      this.accessSessionId = accessSessionId;
      this.material = material;
      this.sendSequence = 0n;
      this.receiveSequence = 0n;
    }

    async seal(value) {
      const sequence = this.sendSequence;
      const key = await subtle.importKey("raw", this.material.c2dKey, "AES-GCM", false, ["encrypt"]);
      const ciphertext = await subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce(this.material.c2dNonce, sequence),
          additionalData: aad(this.accessSessionId, "c2d", sequence),
          tagLength: 128,
        },
        key,
        bytes(JSON.stringify(value)),
      );
      this.sendSequence += 1n;
      return { seq: sequence.toString(), ciphertextB64: base64Url(ciphertext) };
    }

    async open(payload) {
      if (!/^(0|[1-9][0-9]*)$/.test(payload.seq)) throw new Error("invalid sequence");
      const sequence = BigInt(payload.seq);
      if (sequence !== this.receiveSequence) throw new Error("unexpected sequence");
      const key = await subtle.importKey("raw", this.material.d2cKey, "AES-GCM", false, ["decrypt"]);
      const plaintext = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce(this.material.d2cNonce, sequence),
          additionalData: aad(this.accessSessionId, "d2c", sequence),
          tagLength: 128,
        },
        key,
        fromBase64Url(payload.ciphertextB64),
      );
      this.receiveSequence += 1n;
      return JSON.parse(decoder.decode(plaintext));
    }
  }

  async function clientHello(masterKey, accessSessionId) {
    const clientRandom = scope.crypto.getRandomValues(new Uint8Array(32));
    const clientRandomB64 = base64Url(clientRandom);
    return {
      clientRandomB64,
      payload: {
        accessSessionId,
        clientRandomB64,
        clientProofB64: await proof(masterKey, "dsh-e2ee-client", [accessSessionId, clientRandomB64]),
      },
    };
  }

  async function acceptServerHello(masterKey, accessSessionId, clientRandomB64, hello) {
    if (hello.accessSessionId !== accessSessionId) throw new Error("session mismatch");
    const expected = await proof(masterKey, "dsh-e2ee-server", [
      accessSessionId,
      clientRandomB64,
      hello.serverRandomB64,
    ]);
    if (expected !== hello.serverProofB64) throw new Error("server proof failed");
    return new Cipher(
      accessSessionId,
      await derive(masterKey, accessSessionId, clientRandomB64, hello.serverRandomB64),
    );
  }

  scope.DshCrypto = { acceptServerHello, base64Url, clientHello, fromBase64Url };
})(self);
