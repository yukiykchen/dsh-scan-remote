# dsh-scan-remote

通过扫描电脑二维码，从 Kuikly Android 应用访问本机 DeepSeek Harness。手机只出站连接 Relay，电脑上的 Harness 仍监听 `127.0.0.1`。

本仓库是 [april-jk/dsh-mobile-plugin](https://github.com/april-jk/dsh-mobile-plugin) v0.1.8 与 [april-jk/dsh-relay](https://github.com/april-jk/dsh-relay) v0.1.9 的 MIT 衍生。详见 [ATTRIBUTION.md](ATTRIBUTION.md)。

[English](README.md)

## 这个插件解决什么问题

Android App 有三种连接方式。**本仓库只负责其中的「扫码连接 / Relay」**。


| 模式        | 谁在跑 Agent      | 手机怎么连上 Host                   | 适用场景                  |
| --------- | -------------- | ----------------------------- | --------------------- |
| 手机本地      | 手机里的内嵌 Harness | App 直连本机 `127.0.0.1:3080`     | 不依赖电脑，但要解压本地 Runtime  |
| 扫码连接（本插件） | 电脑上的 DSH       | 扫 Settings 二维码，经 Relay 做端到端隧道 | 同一局域网，或双方都能访问的远程 Relay |
| SSH       | 电脑上的 DSH       | App 建 SSH 本地端口转发              | 已有 SSH 密钥，或不方便跑 Relay |


三种模式的会话缓存互相隔离。扫码连接时，API Key 配在**电脑**上的 DSH，不配在手机本地内核里。

## 接入总览

```text
电脑                              手机
DSH web :3080  (只监听 127.0.0.1)
   ^
   | 本机回环
本插件 --出站 WSS--> Relay :8787 <--出站 HTTPS/WSS-- App 扫码
                         ^
                         |
              二维码里的 publicRelayUrl
              必须是手机能访问到的地址
```

两件容易混的事：

- `relay` / `DSH_RELAY`：插件连 Relay 用的地址。Relay 跑在电脑本机时是 `http://127.0.0.1:8787`；Relay 在远程服务器上时，改成那台服务器的 origin。
- `publicRelayUrl` / `PUBLIC_RELAY_URL`：写进二维码、给手机用的地址。局域网是电脑 LAN IP，例如 `http://192.168.1.10:8787`；远程部署则与 `DSH_RELAY` **同一份**公网 origin。

手机**不会**内置公网域名，一律读二维码 fragment 里的 origin。

## 快速开始

电脑和手机先连到**同一个 Wi-Fi 或同一个热点**。

### 1. 启动本地 Relay

```bash
cd relay
cp .env.example .env
npm ci
npm run build
HOST=127.0.0.1 PORT=8787 npm start
```

或 `docker compose -f relay/compose.yml up --build`。

确认 `http://127.0.0.1:8787/health` 可访问。

### 2. 安装插件并启动 DSH

```bash
npx @deepseek-ai/dsh plugin --profile web add "github:yukiykchen/dsh-scan-remote#v0.0.1"
```

看电脑当前局域网 IP（手机必须能 ping 通这一台）：

```bash
ipconfig getifaddr en0    # macOS Wi-Fi
# 或 ifconfig / ip addr
```

把手机能访问的地址写进配置后启动 Host：

```bash
export PUBLIC_RELAY_URL=http://192.168.1.10:8787   # 换成你的电脑 LAN IP
npx @deepseek-ai/dsh web
```

如果已经用过插件，也可以直接改 `~/.dsh-scan-remote/config.json` 里的 `publicRelayUrl`，再重启 DSH。

打开浏览器里的 DSH：**Settings > Remote Access**，应看到二维码、倒计时和电脑名。

### 3. 手机扫码

1. 打开 Android App，首页选 **扫码连接**。
2. 点 **扫描电脑二维码**，对准 Settings 页的码。
3. 配对成功后点 **连接已配对电脑** 进入聊天。

首版只保存一台电脑。要换电脑，先在 App 里点「移除这台电脑」，再扫新码。

## 换网络以后为什么连不上

二维码里的 IP 是生成当时写死的。电脑换 Wi-Fi、改连手机热点、或从公司网切到热点后，旧码里的地址（例如 `30.x`）对当前网段无效，手机会超时：

```text
failed to connect to /30.27.141.67 (port 8787)
```

每次电脑 IP 变了，都要：

1. 改 `~/.dsh-scan-remote/config.json` 的 `publicRelayUrl` 为**当前**电脑地址，或重新 `export PUBLIC_RELAY_URL=...`。
2. 重启 DSH（先停掉占用 `3080` 的旧进程，再 `npx @deepseek-ai/dsh web`）。
3. 打开 **Settings > Remote Access**，用手机**重新扫新码**。

常见地址：


| 电脑所在网络                | `publicRelayUrl` 通常是                    |
| --------------------- | --------------------------------------- |
| 家里 / 办公室 Wi-Fi        | `http://192.168.x.x:8787`               |
| 手机热点（电脑加入热点）          | `http://172.20.10.x:8787`（以电脑在热点上的地址为准） |
| Android 模拟器访问电脑 Relay | `http://10.0.2.2:8787`                  |
| 公司网段手机访问不到            | 不要用这个 IP，改连双方都能互通的网络，或把 Relay 放到公网 |
| Relay 在远程服务器            | `http://<服务器IP>:8787`（`DSH_RELAY` 也要改成同一地址） |


Relay 仍在电脑本机时，`relay` 保持 `http://127.0.0.1:8787`。Relay 已经部署到别的机器时，见下一节。

## Relay 部署到远程服务器

局域网扫码默认假设 Relay 和 DSH **同机**。公司网隔离终端、手机热点反向打不进电脑、或出门跨网段时，把 Relay 放到一台双方都能访问的服务器。协议仍是两端出站会合，**不要**把电脑的 `3080` 映射出去。

服务器上 Relay 要听 `0.0.0.0:8787`（compose 已如此；`npm start` 则设 `HOST=0.0.0.0`），安全组 / 防火墙放行 TCP `8787`。确认：

```bash
curl http://<服务器IP>:8787/health
```

应返回 `{"ok":true}`。

然后电脑上**两个地址都改成这台服务器**，不能只改二维码：

```bash
export DSH_RELAY=http://<服务器IP>:8787
export PUBLIC_RELAY_URL=http://<服务器IP>:8787
npx @deepseek-ai/dsh web
```

已经有 `~/.dsh-scan-remote/config.json` 时，把里面的 `relay` 和 `publicRelayUrl` 都改成上面这个 origin。启动时仍要带 `DSH_RELAY`：插件会按环境变量（缺省则 `http://127.0.0.1:8787`）写回 `relay`，只改 json 再裸启动会变回本机。

换到一台新的 Relay 后，旧的 `hostId` / `hostToken` 作废。在 Settings 里重新生成二维码（或删掉 json 里那两项），用手机**扫新码**。

公网生产环境应在 `8787` 前加 HTTPS 反代，origin 写成 `https://你的域名`。明文 `http://IP:8787` 给 Android 试可以；iOS ATS 很容易拦住公网 HTTP。不要打开 `ALLOW_LEGACY_WEB_PROXY`。服务器部署细节见 [relay/README.zh-CN.md](relay/README.zh-CN.md)。

## 重启 DSH

```bash
# 查看并结束旧的 web Host（端口 3080 被占用时必须先停）
lsof -iTCP:3080 -sTCP:LISTEN
# 然后重新启动（远程 Relay 时带上两个地址）
export DSH_RELAY=http://<服务器IP>:8787          # Relay 在本机可省略
export PUBLIC_RELAY_URL=http://<服务器IP>:8787   # 或电脑当前 LAN IP
npx @deepseek-ai/dsh web
```

本机如果是从 DeepSeek Harness 仓库开发，也可以用仓库里的 `pnpm dsh web`，效果相同。改完 `publicRelayUrl` 或 `DSH_RELAY` 后一定要重启，否则 Settings 里仍是旧码。

## 配置

凭据保存在 `~/.dsh-scan-remote/config.json`（权限 `0600`），与上游 `~/.dsh-remote` 隔离。可用环境变量覆盖默认值：


| 字段 / 环境变量                             | 含义                                        |
| ------------------------------------- | ----------------------------------------- |
| `relay` / `DSH_RELAY`                 | 插件连接 Relay 的地址。本机 Relay 用默认 `http://127.0.0.1:8787`；远程 Relay 改成服务器 origin |
| `publicRelayUrl` / `PUBLIC_RELAY_URL` | 二维码 origin，必须是手机能访问的地址；远程部署时与 `DSH_RELAY` 相同 |
| `dshPort` / `DSH_PORT`                | 本机 Harness 端口，默认 `3080`                   |
| `hostName` / `DSH_DEVICE_NAME`        | Settings 里显示的电脑名                          |
| `DSH_SCAN_REMOTE_CONFIG`              | 自定义配置文件路径                                 |


不要把 `hostToken`、`e2eeMasterKey` 提交到 Git 或发到聊天里。

## 配对协议

1. Host 生成 32 字节主密钥，并用 HKDF 派生 `claimToken`（info：`dsh-claim-v1`）。
2. Host `POST /pair/session`，只提交 `SHA-256(claimToken)`。
3. 二维码 fragment：`{PUBLIC_RELAY_URL}/app/#/pair?id={pairId}&key={masterKey}`。
4. 应用 `POST /pair/claim-device`；Host `POST /pair/confirm`。
5. 应用 `POST /access-ticket`，再 `WSS /client-tunnel`（ticket 只走 Authorization 头）。

v1 使用 `sealed-tunnel-v1`（二维码 PSK，无前向保密）。Noise IK / WebRTC 放到 v2。

## 故障排查


| 现象                          | 先查                                              |
| --------------------------- | ----------------------------------------------- |
| 手机超时连不上 `30.x` / 旧 IP       | `publicRelayUrl` 不是当前网段，改配置、重启、扫新码              |
| 手机能打开公网 Relay，电脑连不上         | 只改了 `publicRelayUrl`，`DSH_RELAY` 仍是 `127.0.0.1`；两边改成同一 origin，重启、扫新码 |
| `EADDRINUSE 127.0.0.1:3080` | 已有 DSH web 在跑，先停再启动                             |
| Settings 没有 Remote Access   | 插件没装到 `web` profile，或 Host 不是用装过插件的 profile 启动  |
| 扫码成功但聊天连不上                  | Relay 是否仍在 `8787` 监听；电脑防火墙是否放行该端口；手机和电脑是否同一二层网络 |
| 公司网能开电脑但不能对话                | 部分企业网隔离客户端互通，改用热点或双方都能访问的网段                     |


Relay 部署细节见 `[relay/README.zh-CN.md](relay/README.zh-CN.md)`。

## 布局


| 路径                     | 作用                                         |
| ---------------------- | ------------------------------------------ |
| 仓库根目录                  | DSH Host 插件（`@yukiykchen/dsh-scan-remote`） |
| `[relay/](relay/)`     | 无账号 WSS Relay                              |
| `[vectors/](vectors/)` | 共享 `sealed-tunnel-v1` 测试向量                 |


