import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual, } from "node:crypto";
const KEY_BYTES = 32;
const RANDOM_BYTES = 32;
const NONCE_PREFIX_BYTES = 4;
const TAG_BYTES = 16;
export class E2eeError extends Error {
}
function canonical(parts) {
    return Buffer.from(JSON.stringify(parts));
}
export function encodeBase64Url(value) {
    return Buffer.from(value).toString("base64url");
}
export function decodeBase64Url(value, bytes) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value))
        throw new E2eeError("invalid base64url");
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value)
        throw new E2eeError("non-canonical base64url");
    if (bytes !== undefined && decoded.length !== bytes)
        throw new E2eeError("invalid binary length");
    return decoded;
}
export const CLAIM_INFO = "dsh-claim-v1";
export function generateMasterKey() {
    return encodeBase64Url(randomBytes(KEY_BYTES));
}
export function deriveClaimToken(masterKeyB64) {
    const key = decodeBase64Url(masterKeyB64, KEY_BYTES);
    return encodeBase64Url(Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from(CLAIM_INFO), KEY_BYTES)));
}
export function hashClaimToken(claimTokenB64) {
    return createHash("sha256")
        .update(decodeBase64Url(claimTokenB64, KEY_BYTES))
        .digest("hex");
}
export function clientProof(masterKeyB64, accessSessionId, clientRandomB64) {
    const key = decodeBase64Url(masterKeyB64, KEY_BYTES);
    decodeBase64Url(clientRandomB64, RANDOM_BYTES);
    return encodeBase64Url(createHmac("sha256", key)
        .update(canonical([
        "dsh-e2ee-client",
        1,
        accessSessionId,
        clientRandomB64,
    ]))
        .digest());
}
export function serverProof(masterKeyB64, accessSessionId, clientRandomB64, serverRandomB64) {
    const key = decodeBase64Url(masterKeyB64, KEY_BYTES);
    decodeBase64Url(clientRandomB64, RANDOM_BYTES);
    decodeBase64Url(serverRandomB64, RANDOM_BYTES);
    return encodeBase64Url(createHmac("sha256", key)
        .update(canonical([
        "dsh-e2ee-server",
        1,
        accessSessionId,
        clientRandomB64,
        serverRandomB64,
    ]))
        .digest());
}
function sameSecret(left, right) {
    if (typeof right !== "string")
        return false;
    let a;
    let b;
    try {
        a = decodeBase64Url(left);
        b = decodeBase64Url(right);
    }
    catch {
        return false;
    }
    return a.length === b.length && timingSafeEqual(a, b);
}
export function deriveMaterial(masterKeyB64, accessSessionId, clientRandomB64, serverRandomB64) {
    const key = decodeBase64Url(masterKeyB64, KEY_BYTES);
    decodeBase64Url(clientRandomB64, RANDOM_BYTES);
    decodeBase64Url(serverRandomB64, RANDOM_BYTES);
    const salt = createHash("sha256")
        .update(canonical([
        "dsh-e2ee-salt",
        1,
        accessSessionId,
        clientRandomB64,
        serverRandomB64,
    ]))
        .digest();
    const expand = (info, length) => Buffer.from(hkdfSync("sha256", key, salt, Buffer.from(info), length));
    return {
        c2dKey: expand("dsh-e2ee-v1:c2d:key", KEY_BYTES),
        d2cKey: expand("dsh-e2ee-v1:d2c:key", KEY_BYTES),
        c2dNonceBase: expand("dsh-e2ee-v1:c2d:nonce", NONCE_PREFIX_BYTES),
        d2cNonceBase: expand("dsh-e2ee-v1:d2c:nonce", NONCE_PREFIX_BYTES),
    };
}
function nonce(prefix, sequence) {
    if (sequence < 0n || sequence > 0xffffffffffffffffn)
        throw new E2eeError("sequence exhausted");
    const value = Buffer.alloc(12);
    prefix.copy(value, 0);
    value.writeBigUInt64BE(sequence, NONCE_PREFIX_BYTES);
    return value;
}
function aad(accessSessionId, direction, sequence) {
    return canonical([
        "dsh-e2ee",
        1,
        accessSessionId,
        direction,
        sequence.toString(),
    ]);
}
export class SecureCipher {
    accessSessionId;
    sendDirection;
    sendKey;
    sendNonceBase;
    receiveDirection;
    receiveKey;
    receiveNonceBase;
    sendSequence = 0n;
    receiveSequence = 0n;
    constructor(accessSessionId, sendDirection, sendKey, sendNonceBase, receiveDirection, receiveKey, receiveNonceBase) {
        this.accessSessionId = accessSessionId;
        this.sendDirection = sendDirection;
        this.sendKey = sendKey;
        this.sendNonceBase = sendNonceBase;
        this.receiveDirection = receiveDirection;
        this.receiveKey = receiveKey;
        this.receiveNonceBase = receiveNonceBase;
    }
    seal(value) {
        const sequence = this.sendSequence;
        const cipher = createCipheriv("aes-256-gcm", this.sendKey, nonce(this.sendNonceBase, sequence));
        cipher.setAAD(aad(this.accessSessionId, this.sendDirection, sequence));
        const ciphertext = Buffer.concat([
            cipher.update(Buffer.from(JSON.stringify(value))),
            cipher.final(),
            cipher.getAuthTag(),
        ]);
        this.sendSequence += 1n;
        return {
            seq: sequence.toString(),
            ciphertextB64: encodeBase64Url(ciphertext),
        };
    }
    open(payload) {
        if (!/^(0|[1-9][0-9]*)$/.test(payload.seq))
            throw new E2eeError("invalid sequence");
        const sequence = BigInt(payload.seq);
        if (sequence !== this.receiveSequence)
            throw new E2eeError("unexpected sequence");
        const sealed = decodeBase64Url(payload.ciphertextB64);
        if (sealed.length < TAG_BYTES)
            throw new E2eeError("truncated ciphertext");
        const ciphertext = sealed.subarray(0, -TAG_BYTES);
        const tag = sealed.subarray(-TAG_BYTES);
        try {
            const decipher = createDecipheriv("aes-256-gcm", this.receiveKey, nonce(this.receiveNonceBase, sequence));
            decipher.setAAD(aad(this.accessSessionId, this.receiveDirection, sequence));
            decipher.setAuthTag(tag);
            const plaintext = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]);
            const value = JSON.parse(plaintext.toString("utf8"));
            this.receiveSequence += 1n;
            return value;
        }
        catch {
            throw new E2eeError("ciphertext authentication failed");
        }
    }
}
export function acceptClientHello(masterKeyB64, hello, serverRandom = randomBytes(RANDOM_BYTES)) {
    const expected = clientProof(masterKeyB64, hello.accessSessionId, hello.clientRandomB64);
    if (!sameSecret(expected, hello.clientProofB64))
        throw new E2eeError("client proof failed");
    if (serverRandom.length !== RANDOM_BYTES)
        throw new E2eeError("invalid server random");
    const serverRandomB64 = encodeBase64Url(serverRandom);
    const proof = serverProof(masterKeyB64, hello.accessSessionId, hello.clientRandomB64, serverRandomB64);
    const material = deriveMaterial(masterKeyB64, hello.accessSessionId, hello.clientRandomB64, serverRandomB64);
    return {
        hello: {
            accessSessionId: hello.accessSessionId,
            serverRandomB64,
            serverProofB64: proof,
        },
        cipher: new SecureCipher(hello.accessSessionId, "d2c", material.d2cKey, material.d2cNonceBase, "c2d", material.c2dKey, material.c2dNonceBase),
    };
}
export function createClientCipher(masterKeyB64, accessSessionId, clientRandomB64, hello) {
    if (hello.accessSessionId !== accessSessionId)
        throw new E2eeError("session mismatch");
    const expected = serverProof(masterKeyB64, accessSessionId, clientRandomB64, hello.serverRandomB64);
    if (!sameSecret(expected, hello.serverProofB64))
        throw new E2eeError("server proof failed");
    const material = deriveMaterial(masterKeyB64, accessSessionId, clientRandomB64, hello.serverRandomB64);
    return new SecureCipher(accessSessionId, "c2d", material.c2dKey, material.c2dNonceBase, "d2c", material.d2cKey, material.d2cNonceBase);
}
