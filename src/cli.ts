#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, saveConfig } from "./config.js";
import { pair } from "./pairing.js";
import { RelayClient } from "./relay-client.js";
import { RemoteAccessManager } from "./remote-access.js";
import { PLUGIN_VERSION } from "./version.js";

const program = new Command()
  .name("dsh-scan-remote")
  .description("QR remote companion for DeepSeek Harness")
  .version(PLUGIN_VERSION);

program
  .command("pair")
  .description("Show a pairing QR and wait for the mobile app")
  .action(async () => {
    const config = await loadConfig();
    await pair(config);
  });

program
  .command("start")
  .description("Connect DSH to the Relay")
  .option("--dsh-port <port>", "DSH port", Number)
  .option("--relay <url>", "Relay base URL")
  .action(async (opts) => {
    let config = await loadConfig();
    config = {
      ...config,
      ...(opts.relay ? { relay: opts.relay } : {}),
      ...(opts.dshPort ? { dshPort: opts.dshPort } : {}),
    };
    await saveConfig(config);
    if (!config.hostToken) config = await pair(config);
    const client = new RelayClient(config);
    await client.start();
    const stop = () => {
      client.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program
  .command("status")
  .description("Show local configuration and connectivity")
  .action(async () => {
    const config = await loadConfig();
    let dsh = false;
    try {
      dsh =
        (
          await fetch(`http://127.0.0.1:${config.dshPort}/`, {
            signal: AbortSignal.timeout(1500),
          })
        ).status < 500;
    } catch {
      dsh = false;
    }
    console.log(
      JSON.stringify(
        {
          paired: Boolean(config.hostToken),
          hostId: config.hostId ?? null,
          hostName: config.hostName,
          relay: config.relay,
          dshPort: config.dshPort,
          dsh: dsh ? "online" : "offline",
        },
        null,
        2,
      ),
    );
  });

program
  .command("unpair")
  .description("Remove this computer's pairing and revoke its credential")
  .action(async () => {
    const config = await loadConfig();
    const manager = new RemoteAccessManager(config);
    try {
      await manager.removePairing();
      console.log("Pairing removed and host credential revoked.");
    } finally {
      manager.dispose();
    }
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
