# DSH | dsh-scan-remote | Scan a computer QR from the phone

Passwordless QR remote access for DeepSeek Harness. The Host plugin sits at the repository root so DSH can install it with `plugin add`.

Project: https://github.com/yukiykchen/dsh-scan-remote

Plugin source: https://github.com/yukiykchen/dsh-scan-remote

This is an MIT fork of april-jk/dsh-mobile-plugin v0.1.8 and april-jk/dsh-relay v0.1.9. Directory pickers, file management, and self-update from the upstream plugin are removed.

## DSH integration

- Exports a Cordis `apply(ctx)` plugin and declares `webStartup` plus `webServer` injection.
- Ships a DSH bundle patch through `dsh.bundle.patch`.
- Registers a **Settings > Remote Access** client that shows a two-minute QR, expiry countdown, computer name, and revoke.
- Keeps DSH on `127.0.0.1`; the plugin opens only an outbound WSS connection to a local Relay (`DSH_RELAY`, default `http://127.0.0.1:8787`).
- Pairing uses `pairId` + fragment `key`; claim and confirm are separate so the phone cannot steal the Host Token.
- Tested against `@deepseek-ai/dsh@0.1.0-rc.6`. If handshake discovers another DSH version, Settings shows an upgrade hint.

## Install

```bash
npx @deepseek-ai/dsh plugin --profile web add "github:yukiykchen/dsh-scan-remote#v0.1.0"
npx @deepseek-ai/dsh web
```

Open **Settings > Remote Access** and scan the QR with the Kuikly Android app.

## MVP security scope

v1 is `sealed-tunnel-v1`: QR-provisioned PSK, AES-256-GCM inner envelopes, no forward secrecy. Noise IK / WebRTC is v2. Access tickets travel in the Authorization header, never in the query string. Revoking the Client Token closes that host's tunnels immediately.
