export function pairingLink(
  origin: string,
  pairId: string,
  masterKey: string,
): string {
  const url = new URL(origin.includes("://") ? origin : `http://${origin}`);
  url.pathname = "/app/";
  url.search = "";
  url.hash = `/pair?id=${encodeURIComponent(pairId)}&key=${encodeURIComponent(masterKey)}`;
  return url.toString();
}

export function publicRelayOrigin(
  relay: string,
  publicRelayUrl?: string,
): string {
  return (publicRelayUrl || relay).replace(/\/$/, "");
}
