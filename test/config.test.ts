import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, loadConfig, saveConfig } from "../src/config.js";

test("uses the local Relay by default", () => {
  assert.equal(defaults().relay, "http://127.0.0.1:8787");
});

test("persists credentials with owner-only permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-config-test-"));
  const path = join(dir, "nested", "config.json");
  process.env.DSH_SCAN_REMOTE_CONFIG = path;
  await saveConfig({
    hostId: "host_test",
    hostToken: "secret",
    e2eeMasterKey: "master-key",
    hostName: "Test Mac",
    relay: "http://127.0.0.1:8787",
    dshPort: 3080,
  });
  const loaded = await loadConfig();
  assert.equal(loaded.hostToken, "secret");
  assert.equal(loaded.e2eeMasterKey, "master-key");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  delete process.env.DSH_SCAN_REMOTE_CONFIG;
});
