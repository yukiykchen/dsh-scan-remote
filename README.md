# dsh-scan-remote

Scan a computer QR code from the Kuikly Android app and talk to local DeepSeek Harness through an outbound-only Relay.

This is an MIT fork of [april-jk/dsh-mobile-plugin](https://github.com/april-jk/dsh-mobile-plugin) v0.1.8 and [april-jk/dsh-relay](https://github.com/april-jk/dsh-relay) v0.1.9. See [ATTRIBUTION.md](ATTRIBUTION.md).

[简体中文](README.zh-CN.md)

## What this plugin is for

The Android app has three connection modes. **This repository only implements Scan / Relay.**

| Mode | Where the agent runs | How the phone reaches Host | When to use it |
| --- | --- | --- | --- |
| Phone local | Embedded Harness on the phone | App talks to `127.0.0.1:3080` on device | No computer needed |
| Scan / Relay (this plugin) | DSH on the computer | Scan Settings QR, sealed tunnel via Relay | Same LAN, or a Relay both sides can reach |
| SSH | DSH on the computer | App opens an SSH local port forward | You already have SSH keys |

Session caches are isolated per mode. In Scan / Relay, the DeepSeek API key lives on the **computer** Host, not in the phone-local engine.

## How it fits together

```text
Computer                          Phone
DSH web :3080  (loopback only)
   ^
   | localhost
plugin --outbound WSS--> Relay :8787 <--outbound HTTPS/WSS-- App scan
                          ^
                          |
                 publicRelayUrl in the QR
                 must be reachable from the phone
```

Do not mix these two URLs:

- `relay` / `DSH_RELAY`: how the plugin reaches Relay. `http://127.0.0.1:8787` when Relay is on the computer; the server origin when Relay is remote.
- `publicRelayUrl` / `PUBLIC_RELAY_URL`: the origin written into the QR. On a LAN this is the computer IP, for example `http://192.168.1.10:8787`. For a remote Relay it must be the **same** public origin as `DSH_RELAY`.

The app never ships a public domain; it always uses the origin from the QR fragment.

## Quick start

Put the phone and the computer on the **same Wi-Fi or the same hotspot**.

### 1. Start a local Relay

```bash
cd relay
cp .env.example .env
npm ci
npm run build
HOST=127.0.0.1 PORT=8787 npm start
```

Or `docker compose -f relay/compose.yml up --build`.

Check `http://127.0.0.1:8787/health`.

### 2. Install the plugin and start DSH

```bash
npx @deepseek-ai/dsh plugin --profile web add "github:yukiykchen/dsh-scan-remote#v0.0.1"
```

Find the computer address the phone can actually reach:

```bash
ipconfig getifaddr en0    # macOS Wi-Fi
```

Start Host with that address in the QR:

```bash
export PUBLIC_RELAY_URL=http://192.168.1.10:8787   # your computer LAN IP
npx @deepseek-ai/dsh web
```

If the plugin has already created `~/.dsh-scan-remote/config.json`, you can edit `publicRelayUrl` there and restart DSH instead.

Open DSH in the browser: **Settings > Remote Access**. You should see a QR code, countdown, and computer name.

### 3. Scan from the phone

1. Open the Android app and choose **扫码连接** (Scan).
2. Tap **扫描电脑二维码** and scan the Settings QR.
3. After pairing, tap **连接已配对电脑** to enter chat.

The first release stores one computer. To switch hosts, tap「移除这台电脑」in the app and scan again.

## Why switching networks breaks the connection

The QR bakes in the IP that was current when it was generated. After the computer moves to another Wi-Fi, a phone hotspot, or a different subnet, the old origin (for example `30.x`) is unreachable and the phone times out:

```text
failed to connect to /30.27.141.67 (port 8787)
```

Whenever the computer IP changes:

1. Set `publicRelayUrl` in `~/.dsh-scan-remote/config.json` to the **current** computer address, or export `PUBLIC_RELAY_URL` again.
2. Restart DSH (stop whatever is holding port `3080`, then `npx @deepseek-ai/dsh web`).
3. Open **Settings > Remote Access** and scan the **new** QR.

Typical origins:

| Computer network | `publicRelayUrl` is usually |
| --- | --- |
| Home / office Wi-Fi | `http://192.168.x.x:8787` |
| Phone hotspot (computer joined it) | `http://172.20.10.x:8787` |
| Android emulator to host Relay | `http://10.0.2.2:8787` |
| Corporate LAN the phone cannot reach | Do not use that IP; move both devices onto a shared network, or host Relay on a public server |
| Relay on a remote server | `http://<server-ip>:8787` (set `DSH_RELAY` to the same origin) |

When Relay still runs on the computer, leave `relay` as `http://127.0.0.1:8787`. When Relay has moved, see the next section.

## Point DSH at a remote Relay

LAN scan assumes Relay and DSH are **on the same machine**. If the office Wi-Fi isolates clients, the phone hotspot cannot reach the computer, or you are off-LAN, put Relay on a server both sides can open. Both ends still connect outbound. **Do not** publish computer port `3080`.

The server process must listen on `0.0.0.0:8787` (compose already does; for `npm start` set `HOST=0.0.0.0`). Open TCP `8787` on the cloud security group / firewall, then:

```bash
curl http://<server-ip>:8787/health
```

Expect `{"ok":true}`.

On the computer, set **both** URLs to that server. Changing only the QR origin is not enough:

```bash
export DSH_RELAY=http://<server-ip>:8787
export PUBLIC_RELAY_URL=http://<server-ip>:8787
npx @deepseek-ai/dsh web
```

If `~/.dsh-scan-remote/config.json` already exists, set `relay` and `publicRelayUrl` to the same origin. Still export `DSH_RELAY` when you start: the plugin writes `relay` from that env (default `http://127.0.0.1:8787`), so a json-only edit is overwritten on a bare restart.

A new Relay will not accept the old `hostId` / `hostToken`. Create a fresh QR in Settings (or delete those fields) and **rescan**.

Public production should put HTTPS in front of `8787` and use `https://your-domain`. Plain `http://IP:8787` is enough to try on Android; iOS ATS often blocks public HTTP. Keep `ALLOW_LEGACY_WEB_PROXY=0`. Server details: [relay/README.md](relay/README.md).

## Restart DSH

```bash
lsof -iTCP:3080 -sTCP:LISTEN
export DSH_RELAY=http://<server-ip>:8787          # skip if Relay is local
export PUBLIC_RELAY_URL=http://<server-ip>:8787   # or the computer LAN IP
npx @deepseek-ai/dsh web
```

A local Harness checkout can use `pnpm dsh web` instead. Restart after every `publicRelayUrl` or `DSH_RELAY` change, or Settings will keep showing the old QR.

## Config

Credentials live in `~/.dsh-scan-remote/config.json` (mode `0600`), not `~/.dsh-remote`.

| Field / env | Meaning |
| --- | --- |
| `relay` / `DSH_RELAY` | Plugin-to-Relay URL. Local Relay: `http://127.0.0.1:8787`. Remote Relay: the server origin |
| `publicRelayUrl` / `PUBLIC_RELAY_URL` | QR origin, must be reachable from the phone; same as `DSH_RELAY` when Relay is remote |
| `dshPort` / `DSH_PORT` | Local Harness port, default `3080` |
| `hostName` / `DSH_DEVICE_NAME` | Computer name in Settings |
| `DSH_SCAN_REMOTE_CONFIG` | Custom config path |

Do not commit `hostToken` or `e2eeMasterKey`.

## Pairing

1. Host generates a 32-byte master key and HKDF-derives `claimToken` (`dsh-claim-v1`).
2. Host `POST /pair/session` with `SHA-256(claimToken)` only.
3. QR fragment: `{PUBLIC_RELAY_URL}/app/#/pair?id={pairId}&key={masterKey}`.
4. App claims with `/pair/claim-device`; Host confirms with `/pair/confirm`.
5. App `POST /access-ticket` then `WSS /client-tunnel` (ticket in the Authorization header).

v1 uses `sealed-tunnel-v1` (QR PSK, no forward secrecy). Noise IK / WebRTC is v2.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Phone times out to an old `30.x` IP | `publicRelayUrl` is stale; edit, restart, rescan |
| Phone reaches the public Relay, computer does not | Only `publicRelayUrl` changed; `DSH_RELAY` is still `127.0.0.1`. Set both to the same origin, restart, rescan |
| `EADDRINUSE 127.0.0.1:3080` | Another DSH web is already running |
| No Remote Access in Settings | Plugin is not installed on the `web` profile |
| Pair works but chat does not | Relay still listening on `8787`; firewall; same L2 network |
| Office LAN cannot talk phone-to-computer | Use a hotspot or another network both sides can reach |

Relay operations: [`relay/README.md`](relay/README.md).

## Layout

| Path | Role |
| --- | --- |
| repository root | DSH Host plugin (`@yukiykchen/dsh-scan-remote`) |
| [`relay/`](relay/) | Passwordless WSS Relay |
| [`vectors/`](vectors/) | Shared `sealed-tunnel-v1` test vectors |
