import qrcode from "qrcode-terminal";
import { saveConfig } from "./config.js";
import { deriveClaimToken, generateMasterKey, hashClaimToken } from "./e2ee.js";
import { pairingLink, publicRelayOrigin } from "./pair-link.js";
async function post(url, data) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
    });
    return { status: response.status, data: (await response.json()) };
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
    while (Date.now() < expiresAt) {
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
        if (confirmed.status !== 202)
            throw new Error(`Pairing failed (${confirmed.status})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Pairing QR expired");
}
