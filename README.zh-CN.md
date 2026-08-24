# dsh-scan-remote

通过扫描电脑二维码，从 Kuikly Android 应用访问本机 DeepSeek Harness。手机只出站连接 Relay，电脑 Harness 仍监听 `127.0.0.1`。

本仓库是 [april-jk/dsh-mobile-plugin](https://github.com/april-jk/dsh-mobile-plugin) v0.1.8 与 [april-jk/dsh-relay](https://github.com/april-jk/dsh-relay) v0.1.9 的 MIT 衍生。详见 [ATTRIBUTION.md](ATTRIBUTION.md)。

## 布局

| 路径 | 作用 |
| --- | --- |
| 仓库根目录 | DSH Host 插件（`@yukiykchen/dsh-scan-remote`） |
| [`relay/`](relay/) | 无账号 WSS Relay |
| [`vectors/`](vectors/) | 共享 `sealed-tunnel-v1` 测试向量 |

## 安装插件

```bash
npx @deepseek-ai/dsh plugin --profile web add "github:yukiykchen/dsh-scan-remote#v0.1.0"
npx @deepseek-ai/dsh web
```

打开 **Settings > Remote Access**，扫描二维码。

## 本地 Relay（首版）

```bash
cd relay
cp .env.example .env
npm ci
npm run build
HOST=127.0.0.1 PORT=8787 npm start
```

或 `docker compose -f relay/compose.yml up --build`。

插件默认：`DSH_RELAY=http://127.0.0.1:8787`。

二维码里的 origin（手机必须能访问）：

```bash
PUBLIC_RELAY_URL=http://10.0.2.2:8787      # Android 模拟器
PUBLIC_RELAY_URL=http://192.168.1.10:8787  # 同一局域网真机
```

应用不内置公网域名，一律读取二维码 fragment 中的 origin。

## 配对

1. Host 生成 32 字节主密钥，并用 HKDF 派生 `claimToken`（info：`dsh-claim-v1`）。
2. Host `POST /pair/session`，只提交 `SHA-256(claimToken)`。
3. 二维码 fragment：`{PUBLIC_RELAY_URL}/app/#/pair?id={pairId}&key={masterKey}`。
4. 应用 `POST /pair/claim-device`；Host `POST /pair/confirm`。
5. 应用 `POST /access-ticket`，再 `WSS /client-tunnel`（ticket 只走 Authorization 头）。

v1 使用 `sealed-tunnel-v1`（二维码 PSK，无前向保密）。Noise IK / WebRTC 放到 v2。

## 配置

凭据保存在 `~/.dsh-scan-remote/config.json`（权限 `0600`），与上游 `~/.dsh-remote` 隔离。
