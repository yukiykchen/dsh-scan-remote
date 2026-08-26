# dsh-relay

[English](README.md) | [简体中文](README.zh-CN.md)

> **DeepSeek Harness 插件基础设施：** 本 Relay 为 DSH Mobile 插件提供远程连接能力；该插件已向 DeepSeek Harness 官方插件仓库提交，并已发布到官方社区的插件展示区。

用于 DSH 手机遥控 MVP 的云端 Relay。

本 fork 的手机接入是**无账号扫码**：电脑装仓库根目录的插件，二维码 origin 用 `PUBLIC_RELAY_URL`。完整步骤见 [../README.zh-CN.md](../README.zh-CN.md)。下文部分内容仍沿用上游账号版 Relay 的部署说明，和当前 App 扫码流程不是同一条产品路径。

公共生产地址：`https://relay.dshmobile.online`。0.1.9 默认只路由端到端加密的 sealed tunnel，不接收 DSH 业务明文。

## 浏览器访问

直接访问 Relay 根地址会跳转到 `/app/`。该页面支持账号登录、注册、配对、设备列表，以及在 Safari 中打开原有 DSH Web UI。浏览器使用 Web Crypto 实现 `sealed-tunnel-v1`，密钥只保存在本机 IndexedDB 与当前 Service Worker 内存中。Relay 仍然只能看到账号与设备关系、连接时间、密文长度和流量时序。

Companion 生成的二维码是 `https://<relay>/app/#/pair?code=...&key=...`。iPhone 相机可以直接打开；`#` 后的配对码与密钥不会发送到 Relay。已配对电脑还可以在 DSH 设置页生成浏览器访问码 `#/web-pair?device=...&key=...`，手机和多个浏览器可以分别保存同一台电脑的 E2EE 密钥并同时使用，不会互相解绑。旧版 JSON 二维码仍可由移动 App 解析，但新 Companion 默认生成浏览器链接。

远程页面依赖 HTTPS、Service Worker、Web Crypto 与 WebSocket。生产部署必须设置 `PUBLIC_RELAY_URL=https://实际域名`，并保持 `ALLOW_LEGACY_WEB_PROXY=0`。

## 管理后台

后台地址是 `/admin/`。只有同时设置以下两个部署 Secret 时才启用：

```bash
ADMIN_USERNAME=relay-admin
ADMIN_PASSWORD=使用密码管理器生成的独立强密码
```

管理会话使用独立的 HttpOnly、SameSite=Strict Cookie，不与普通用户会话复用。后台显示用户总数、新增用户、近 30 天活跃用户、已绑定与在线设备、访问会话趋势和最近访问记录。它不显示或保存 DSH 请求路径、任务文本、模型输出、HTTP 正文、WebSocket Frame、IP、token 或 E2EE 密钥。

## 本地运行

```bash
cp .env.example .env
npm install
npm run build
npm start
```

默认监听地址是 `http://127.0.0.1:8787`。生产环境必须将 `DATABASE_PATH` 设置到持久化存储。任何公网部署都应提供 HTTPS/WSS；Relay 不会持有或记录隧道业务明文。

## 版本发布

每个 Pull Request 和分支 Push 都会由 GitHub Actions 使用 lockfile 安装依赖，并执行构建、测试和生产依赖审计。推送与 `package.json`、`package-lock.json` 中版本完全一致的标签（例如 `v0.1.9`）后，GitHub Release 会自动创建。

每个 Release 提供包含预编译 `dist/`、部署文件和生产依赖清单的 `.tar.gz` 与 `.zip`，并附带 `SHA256SUMS`。本仓库面向本机或私有 `npm start` / `relay/compose.yml` 部署，不发布上游 `ghcr.io/april-jk/dsh-relay` 镜像。解压后先运行 `npm ci --omit=dev`，再运行 `npm start`；原生依赖会针对目标平台安装，而不是打包 CI 环境中的二进制。

## Railway

从本目录创建 Railway Service，将 `JWT_SECRET` 设置为至少 32 字节的随机值，并挂载持久卷到 `/data`。生产环境缺少该 Secret、长度不足或仍使用文档占位值时，Relay 会拒绝启动。设置 `DATABASE_PATH=/data/relay.sqlite`。添加 HTTPS 自定义域名，例如 `relay.dshmobile.online`，然后在移动应用和 Companion 中使用该地址。Companion 会自动把 `https://` Relay URL 转换为设备连接所需的 `wss://`。

同时设置 `PUBLIC_RELAY_URL` 为完整 HTTPS Origin。需要后台时，再通过 Railway Secret 单独设置 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD`；不要把真实值写入 `.env.example`、Git 或部署日志。

在 Railway 中设置 `TRUST_PROXY=1`，让限流使用 Railway 可信代理提供的第一个地址。直接暴露 Node 进程时应保持禁用。

MVP 有意采用单实例架构。在引入共享存储前，必须使用 SQLite 持久卷，并且只能运行一个 Relay 副本。

## 使用 Docker 私有部署

```bash
cp .env.example .env
```

设置一个至少 32 字节的随机 `JWT_SECRET`，然后启动单实例 Relay：

```bash
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

在 `8787` 端口前配置 HTTPS 反向代理。除非该代理会覆盖客户端转发请求头，否则保持 `TRUST_PROXY=0`。`relay-data` Volume 保存 SQLite 状态，必须备份。

电脑侧要把 `DSH_RELAY` 和 `PUBLIC_RELAY_URL` **都**改成这台服务器的 origin（HTTPS 域名或 `http://<服务器IP>:8787`），再重启 DSH 并重新扫码。只改二维码、插件仍连 `127.0.0.1:8787` 会对不上。完整步骤见 [../README.zh-CN.md](../README.zh-CN.md) 的「Relay 部署到远程服务器」。

## 资源限制

Relay 会限制 sealed session 数量、密文字节、Frame 速率、握手时间与空闲时间。默认值适用于 MVP 部署，可以通过环境变量调整：

| 环境变量 | 默认值 | 限制范围 |
| --- | ---: | --- |
| `MAX_API_BODY_BYTES` | 65,536 | JSON API 请求体 |
| `MAX_WS_PAYLOAD_BYTES` | 4,194,304 | 单个入站 WebSocket Frame |
| `API_RATE_LIMIT_PER_MINUTE` | 300 | 每个客户端地址的 API 请求 |
| `AUTH_RATE_LIMIT_PER_MINUTE` | 20 | 每个客户端地址的额外鉴权限制 |
| `PAIR_RATE_LIMIT_PER_MINUTE` | 30 | 每个客户端地址的额外配对限制 |
| `WS_UPGRADE_RATE_LIMIT_PER_MINUTE` | 120 | 每个客户端地址的 WebSocket Upgrade |
| `MAX_SECURE_TUNNELS_GLOBAL` | 512 | 单个 Relay 实例的并发 sealed session |
| `MAX_SECURE_TUNNELS_PER_DEVICE` | 8 | 每台电脑的并发 sealed session |
| `MAX_SECURE_TUNNEL_BYTES` | 536,870,912 | 每个 sealed session 的累计密文字节 |
| `SECURE_FRAME_RATE_LIMIT_PER_MINUTE` | 2,400 | 每个访问会话的 sealed frame |
| `SECURE_TUNNEL_IDLE_TIMEOUT_MS` | 300,000 | sealed session 空闲超时 |
| `SECURE_HANDSHAKE_TIMEOUT_MS` | 10,000 | E2EE 握手超时 |

以下限制只在显式设置 `ALLOW_LEGACY_WEB_PROXY=1`、启用已弃用明文代理时生效：

| 环境变量 | 默认值 | 限制范围 |
| --- | ---: | --- |
| `TUNNEL_RATE_LIMIT_PER_MINUTE` | 600 | 每个客户端地址的转发 HTTP 请求 |
| `MAX_TUNNEL_BODY_BYTES` | 2,097,152 | 单个 legacy HTTP 请求 |
| `MAX_TUNNEL_RESPONSE_BYTES` | 33,554,432 | 单个 legacy HTTP 响应 |
| `MAX_PENDING_HTTP_PER_DEVICE` | 32 | 每台电脑的 legacy 并发 HTTP 隧道 |
| `MAX_TUNNEL_WS_PER_DEVICE` | 16 | 每台电脑的 legacy 并发 WebSocket 隧道 |
| `MAX_PENDING_HTTP_GLOBAL` | 512 | 单实例 legacy 并发 HTTP 隧道 |
| `MAX_TUNNEL_WS_GLOBAL` | 256 | 单实例 legacy 并发 WebSocket 隧道 |

限流计数有意保存在实例本地，与 MVP 单实例架构保持一致。过期的 Refresh Token、配对会话、访问会话和事件会在启动时清理，此后每 15 分钟清理一次。

## 移动版本策略

公开接口 `GET /app/version?platform=android|ios` 用于驱动移动应用的更新提示。每个平台可以独立配置：

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

提高 `LATEST_VERSION` 会显示可关闭的更新提示。只有必须阻止旧版使用时才提高 `MINIMUM_VERSION`。提高任一版本前，必须先配置有效的平台下载地址。

## 许可证

[MIT](LICENSE)
