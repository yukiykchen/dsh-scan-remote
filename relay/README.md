# dsh-relay

[English](README.md) | [简体中文](README.zh-CN.md)

> **DeepSeek Harness plugin infrastructure:** this Relay supports the DSH Mobile plugin submitted to the official DeepSeek Harness plugin repository and published in the official community plugin showcase.

Cloud Relay for the DSH mobile remote-control MVP.

This fork's phone path is **passwordless QR pairing**: install the plugin at the repository root and put a phone-reachable origin in `PUBLIC_RELAY_URL`. See [../README.md](../README.md). Sections below still describe the upstream account-based Relay and are not the App scan flow.

Public production endpoint: `https://relay.dshmobile.online`

## Browser access

The Relay root redirects to `/app/`, a mobile-first web client for account access, pairing, device selection, and the original DSH Web UI. It implements `sealed-tunnel-v1` with Web Crypto. Device keys remain in the browser's IndexedDB and active Service Worker memory; the Relay still sees only routing metadata, ciphertext sizes, and timing.

New Companion QR codes are HTTPS links shaped as `https://<relay>/app/#/pair?code=...&key=...`. iPhone Camera can open them directly, and URL fragments are not sent to the Relay. Production requires HTTPS and `PUBLIC_RELAY_URL=https://your-relay.example` with `ALLOW_LEGACY_WEB_PROXY=0`.

## Administration

`/admin/` is disabled until both credentials are configured as deployment secrets:

```bash
ADMIN_USERNAME=relay-admin
ADMIN_PASSWORD=a-unique-password-from-your-password-manager
```

The isolated HttpOnly admin session exposes account, device, and access-session aggregates only. It never exposes DSH paths, task content, HTTP bodies, WebSocket frames, IP addresses, tokens, or encryption keys.

## Local

```bash
cp .env.example .env
npm install
npm run build
npm start
```

The default listener is `http://127.0.0.1:8787`. Set `DATABASE_PATH` to a persistent location in production. The Relay expects HTTPS/WSS in any public deployment and routes 0.1.9 sealed tunnel frames without receiving DSH plaintext.

## Releases

Every pull request and branch push installs locked dependencies, builds, tests, and audits the Relay in GitHub Actions. A tag that exactly matches the version in both `package.json` and `package-lock.json` (for example, `v0.1.9`) creates a GitHub Release automatically.

Each release contains `.tar.gz` and `.zip` archives with the compiled `dist/` output, deployment files, and production dependency manifests, plus `SHA256SUMS`. This fork is intended for local or private `npm start` / `relay/compose.yml` deployments; it does not publish the upstream `ghcr.io/april-jk/dsh-relay` images. After extracting an archive, run `npm ci --omit=dev` before `npm start`; native dependencies are installed for the target platform instead of being bundled from CI.

## Railway

Create a Railway service from this directory, set `JWT_SECRET` to a random value of at least 32 bytes, and attach a persistent volume mounted at `/data`. Production startup fails when this secret is missing, too short, or still set to a documented placeholder. Set `DATABASE_PATH=/data/relay.sqlite`. Add an HTTPS custom domain such as `relay.dshmobile.online` and use it as the Relay base URL in the mobile app and Companion. The Companion automatically converts an `https://` Relay URL to `wss://` for its device connection.

Set `TRUST_PROXY=1` on Railway so rate limiting uses the first address supplied by Railway's trusted proxy. Leave it disabled when exposing the Node process directly.

Set `PUBLIC_RELAY_URL=https://relay.dshmobile.online` so ticket responses return the canonical `wss://` client tunnel. Keep `ALLOW_LEGACY_WEB_PROXY=0` in production; enabling it re-opens the deprecated plaintext `/s` proxy for local migration tests only.

The MVP is intentionally single-instance. SQLite volume persistence and a single Relay replica are required until a shared store is introduced.

## Private deployment with Docker

```bash
cp .env.example .env
```

Set a random `JWT_SECRET` of at least 32 bytes, then start the single-instance Relay:

```bash
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

Put an HTTPS reverse proxy in front of port `8787`. Keep `TRUST_PROXY=0` unless that proxy overwrites client forwarding headers. The `relay-data` volume contains SQLite state and must be backed up. In the mobile app, choose **Relay 服务器** and enter the public HTTPS origin; start DSH with the same origin in `DSH_RELAY`.

## Resource limits

The Relay bounds secure-session count, ciphertext bytes, frame rate, handshake time, and idle time. Defaults are suitable for an MVP deployment and can be adjusted through environment variables:

| Variable | Default | Scope |
| --- | ---: | --- |
| `MAX_API_BODY_BYTES` | 65,536 | JSON API request body |
| `MAX_WS_PAYLOAD_BYTES` | 4,194,304 | One incoming WebSocket frame |
| `API_RATE_LIMIT_PER_MINUTE` | 300 | API requests per client address |
| `AUTH_RATE_LIMIT_PER_MINUTE` | 20 | Additional authentication limit per client address |
| `PAIR_RATE_LIMIT_PER_MINUTE` | 30 | Additional pairing limit per client address |
| `WS_UPGRADE_RATE_LIMIT_PER_MINUTE` | 120 | WebSocket upgrades per client address |
| `MAX_SECURE_TUNNELS_GLOBAL` | 512 | Concurrent sealed sessions per Relay instance |
| `MAX_SECURE_TUNNELS_PER_DEVICE` | 8 | Concurrent sealed sessions per computer |
| `MAX_SECURE_TUNNEL_BYTES` | 536,870,912 | Total ciphertext bytes per sealed session |
| `SECURE_FRAME_RATE_LIMIT_PER_MINUTE` | 2,400 | Sealed frames per access session |
| `SECURE_TUNNEL_IDLE_TIMEOUT_MS` | 300,000 | Sealed-session idle timeout |
| `SECURE_HANDSHAKE_TIMEOUT_MS` | 10,000 | E2EE handshake timeout |

The following limits apply only when the deprecated plaintext proxy is explicitly enabled with `ALLOW_LEGACY_WEB_PROXY=1`:

| Variable | Default | Scope |
| --- | ---: | --- |
| `TUNNEL_RATE_LIMIT_PER_MINUTE` | 600 | Forwarded HTTP requests per client address |
| `MAX_TUNNEL_BODY_BYTES` | 2,097,152 | One legacy HTTP request |
| `MAX_TUNNEL_RESPONSE_BYTES` | 33,554,432 | One legacy HTTP response |
| `MAX_PENDING_HTTP_PER_DEVICE` | 32 | Legacy concurrent HTTP tunnels per computer |
| `MAX_TUNNEL_WS_PER_DEVICE` | 16 | Legacy concurrent WebSocket tunnels per computer |
| `MAX_PENDING_HTTP_GLOBAL` | 512 | Legacy concurrent HTTP tunnels per Relay instance |
| `MAX_TUNNEL_WS_GLOBAL` | 256 | Legacy concurrent WebSocket tunnels per Relay instance |

Rate counters are intentionally instance-local, matching the single-instance MVP architecture. Expired refresh tokens, pairing sessions, access sessions, and events are cleaned at startup and every 15 minutes.

## Mobile release policy

The public `GET /app/version?platform=android|ios` endpoint drives update prompts in the mobile app. Configure each platform independently:

```bash
APP_ANDROID_LATEST_VERSION=0.2.0
APP_ANDROID_MINIMUM_VERSION=0.1.3
APP_ANDROID_DOWNLOAD_URL=https://play.google.com/store/apps/details?id=io.github.apriljk.dshremote
APP_ANDROID_RELEASE_NOTES=Improved remote session stability.
APP_IOS_LATEST_VERSION=0.2.0
APP_IOS_MINIMUM_VERSION=0.1.3
APP_IOS_DOWNLOAD_URL=https://apps.apple.com/app/id0000000000
APP_IOS_RELEASE_NOTES=Improved remote session stability.
```

Raise `LATEST_VERSION` for a dismissible prompt. Raise `MINIMUM_VERSION` only when older builds must be blocked. Always configure a valid platform download URL before raising either version.

## License

[MIT](LICENSE)
