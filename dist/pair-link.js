export function pairingLink(origin, pairId, masterKey) {
    const url = new URL(origin.includes("://") ? origin : `http://${origin}`);
    url.pathname = "/app/";
    url.search = "";
    url.hash = `/pair?id=${encodeURIComponent(pairId)}&key=${encodeURIComponent(masterKey)}`;
    return url.toString();
}
export function publicRelayOrigin(relay, publicRelayUrl) {
    return (publicRelayUrl || relay).replace(/\/$/, "");
}
