import z from "@deepseek-ai/schemastery";
import { loadConfig, saveConfig } from "./config.js";
import { registerManagementRoutes } from "./management.js";
import { RemoteAccessManager } from "./remote-access.js";
export const name = "dsh-scan-remote";
export const Config = z.object({
    relay: z.string().required(),
    dshPort: z.natural().max(65535).required(),
});
export function apply(ctx, pluginConfig) {
    ctx.effect(() => {
        let disposed = false;
        let manager;
        let unregister;
        void (async () => {
            try {
                const config = {
                    ...(await loadConfig()),
                    relay: pluginConfig.relay,
                    dshPort: pluginConfig.dshPort,
                };
                await saveConfig(config);
                if (disposed)
                    return;
                manager = new RemoteAccessManager(config);
                unregister = registerManagementRoutes(ctx.webServer, manager);
                await manager.initialize();
                ctx.logger.info(config.hostToken
                    ? `dsh-scan-remote connecting through ${config.relay}`
                    : "dsh-scan-remote is ready to show a pairing QR in Settings > Remote Access");
            }
            catch (error) {
                ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
            }
        })();
        return () => {
            disposed = true;
            unregister?.();
            manager?.dispose();
        };
    }, "dsh-scan-remote.lifecycle");
}
