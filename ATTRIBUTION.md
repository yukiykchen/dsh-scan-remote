# Attribution

This repository is an independent MIT-licensed derivative of community DSH Mobile Remote projects.

| Upstream | Tag | License | Use |
| --- | --- | --- | --- |
| [april-jk/dsh-mobile-plugin](https://github.com/april-jk/dsh-mobile-plugin) | v0.1.8 | MIT | Host plugin, sealed-tunnel-v1, Settings UI |
| [april-jk/dsh-relay](https://github.com/april-jk/dsh-relay) | v0.1.9 | MIT | Relay store, WSS forwarding, rate limits |
| [april-jk/dsh-mobile](https://github.com/april-jk/dsh-mobile) | main | MIT | Protocol and test-vector reference only; Flutter UI is not included |

Original copyright: Copyright (c) 2026 dsh-mobile contributors.

Modifications in this fork:

- Passwordless QR pairing (no Relay accounts)
- Isolated package name, plugin id, and `~/.dsh-scan-remote` config directory
- Directory-picker patch, Home file browser, and self-update removed
- Default local Relay at `http://127.0.0.1:8787`
