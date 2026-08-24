# dsh-scan-remote

Scan a computer QR code from the Kuikly Android app and talk to local DeepSeek Harness through an outbound-only Relay.

This is an MIT fork of [april-jk/dsh-mobile-plugin](https://github.com/april-jk/dsh-mobile-plugin) v0.1.8 and [april-jk/dsh-relay](https://github.com/april-jk/dsh-relay) v0.1.9. See [ATTRIBUTION.md](ATTRIBUTION.md).

## Layout

| Path | Role |
| --- | --- |
| repository root | DSH Host plugin (`@yukiykchen/dsh-scan-remote`) |
| [`relay/`](relay/) | Passwordless WSS Relay |
| [`vectors/`](vectors/) | Shared `sealed-tunnel-v1` test vectors |

## Install the plugin

```bash
npx @deepseek-ai/dsh plugin --profile web add "github:yukiykchen/dsh-scan-remote#v0.1.0"
npx @deepseek-ai/dsh web
```

Open **Settings > Remote Access** and scan the QR code.

## Local Relay (first release)

```bash
cd relay
cp .env.example .env
npm ci
npm run build
HOST=127.0.0.1 PORT=8787 npm start
```

Or `docker compose -f relay/compose.yml up --build`.

Plugin default: `DSH_RELAY=http://127.0.0.1:8787`.

QR origin (what the phone can reach):

```bash
PUBLIC_RELAY_URL=http://10.0.2.2:8787   # Android emulator
PUBLIC_RELAY_URL=http://192.168.1.10:8787  # physical phone on LAN
```

The app never ships a public domain; it always uses the origin from the QR fragment.

## Pairing

1. Host generates a 32-byte master key and HKDF-derives `claimToken` (`dsh-claim-v1`).
2. Host `POST /pair/session` with `SHA-256(claimToken)` only.
3. QR fragment: `{PUBLIC_RELAY_URL}/app/#/pair?id={pairId}&key={masterKey}`.
4. App claims with `/pair/claim-device`; Host confirms with `/pair/confirm`.
5. App `POST /access-ticket` then `WSS /client-tunnel` (ticket in the Authorization header).

v1 uses `sealed-tunnel-v1` (QR PSK, no forward secrecy). Noise IK / WebRTC is v2.

## Config

Credentials live in `~/.dsh-scan-remote/config.json` (mode `0600`), not `~/.dsh-remote`.
