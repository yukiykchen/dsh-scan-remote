import qrcode from "qrcode-terminal";
import { saveConfig } from "./config.js";
import { deriveClaimToken, generateMasterKey, hashClaimToken } from "./e2ee.js";
import { pairingLink, publicRelayOrigin } from "./pair-link.js";
async function post(url, data, signal) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
        signal,
    });
    return { status: response.status, data: (await response.json()) };
}
const waitTimeoutMs = 25_000;
const retryDelayMs = 3000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function pair(config) {
    const masterKey = generateMasterKey();
    const claimToken = deriveClaimToken(masterKey);
    const created = await post(`${config.relay}/pair/session`, {
        claimTokenHash: hashClaimToken(claimToken),
        hostName: config.hostName,
    });
    if (created.status !== 201)
        throw new Error(`Relay rejected pairing session (${created.status})`);
    const { pairId, confirmSecret, expiresAt } = created.data;
    const origin = publicRelayOrigin(config.relay, config.publicRelayUrl);
    const qr = pairingLink(origin, pairId, masterKey);
    console.log(`\nPairing QR expires ${new Date(expiresAt).toLocaleTimeString()}\n`);
    qrcode.generate(qr, { small: true }, (output) => console.log(output));
    console.log(qr);
    console.log("Waiting for the mobile app to claim this QR...");
    let legacy = false;
    while (Date.now() < expiresAt) {
        if (!legacy) {
            let waiting;
            try {
                waiting = await post(`${config.relay}/pair/wait`, { pairId, confirmSecret, timeoutMs: waitTimeoutMs }, AbortSignal.timeout(waitTimeoutMs + 5000));
            }
            catch {
                await sleep(retryDelayMs);
                continue;
            }
            if (waiting.status === 404) {
                legacy = true;
                continue;
            }
            if (waiting.status === 410)
                throw new Error("Pairing QR expired");
            if (waiting.status === 429) {
                await sleep(retryDelayMs);
                continue;
            }
            if (waiting.status !== 200)
                throw new Error(`Pairing failed (${waiting.status})`);
            if (waiting.data?.status !== "claimed")
                continue;
        }
        const confirmed = await post(`${config.relay}/pair/confirm`, {
            pairId,
            confirmSecret,
        });
        if (confirmed.status === 200) {
            const next = {
                ...config,
                hostId: confirmed.data.hostId,
                hostToken: confirmed.data.hostToken,
                e2eeMasterKey: masterKey,
            };
            await saveConfig(next);
            console.log(`Paired as ${config.hostName}`);
            return next;
        }
        if (confirmed.status === 410)
            throw new Error("Pairing QR expired");
        if (confirmed.status === 429) {
            await sleep(retryDelayMs);
            continue;
        }
        if (confirmed.status !== 202)
            throw new Error(`Pairing failed (${confirmed.status})`);
        if (legacy)
            await sleep(2000);
    }
    throw new Error("Pairing QR expired");
}
