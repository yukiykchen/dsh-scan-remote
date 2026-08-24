import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCloseCode } from "../src/relay-client.js";

test("publishes an installable DSH bundle manifest", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const patch = await readFile(
    new URL("../cordis.patch.yml", import.meta.url),
    "utf8",
  );
  assert.equal(manifest.name, "@yukiykchen/dsh-scan-remote");
  assert.equal(manifest.version, "0.0.1");
  assert.deepEqual(manifest.bin, { "dsh-scan-remote": "dist/cli.js" });
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.exports["./client"], "./client.js");
  assert.equal(manifest.dsh.client.platform, "web");
  assert.equal(manifest.scripts.prepack, "npm run build");
  assert.equal(manifest.license, "MIT");
  assert.equal(
    manifest.repository.url,
    "git+https://github.com/yukiykchen/dsh-scan-remote.git",
  );
  const client = await readFile(
    new URL("../client.js", import.meta.url),
    "utf8",
  );
  assert.match(client, /id: "@yukiykchen\/dsh-scan-remote"/);
  assert.match(client, /settings\.section/);
  assert.match(client, /dsh-scan-remote\/api\/state/);
  assert.match(client, /dsh-scan-remote\/api\/access-sessions/);
  assert.match(client, /访问时间线/);
  assert.match(client, /移除配对/);
  assert.doesNotMatch(client, /dsh-mobile\/api\/update/);
  assert.doesNotMatch(client, /生成浏览器访问码/);
  assert.doesNotMatch(client, /远程文件/);
  assert.match(patch, /name: '@yukiykchen\/dsh-scan-remote'/);
  assert.match(patch, /inject: \[webStartup, webServer\]/);
  assert.match(patch, /127\.0\.0\.1:8787/);
  assert.doesNotMatch(patch, /directory-picker/);
});

test("rejects WebSocket close codes reserved by the protocol", () => {
  assert.equal(normalizeCloseCode(1000), 1000);
  assert.equal(normalizeCloseCode(1005), undefined);
  assert.equal(normalizeCloseCode(1006), undefined);
  assert.equal(normalizeCloseCode(4001), 4001);
});

test("documents a path-free official DSH install command", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  assert.match(
    readme,
    /npx @deepseek-ai\/dsh plugin --profile web add "github:yukiykchen\/dsh-scan-remote#v0\.0\.1"/,
  );
  assert.doesNotMatch(readme, /\/absolute\/path/);
});

test("keeps GitHub Release assets immutable across reruns", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /sha256sum "\$package_file" > SHA256SUMS/);
  assert.match(workflow, /release_assets=.*\.assets\[\]\.name/);
  assert.match(workflow, /cmp "\$PACKAGE_FILE"/);
  assert.match(workflow, /cmp SHA256SUMS/);
  assert.doesNotMatch(workflow, /--clobber/);
});
