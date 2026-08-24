import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("browser E2EE reproduces the shared sealed-frame vector", () => {
  const script = `
    globalThis.self = globalThis;
    await import('./web/app/crypto.js');
    const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const access = 'access_test_vector';
    const random = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
    const cipher = await DshCrypto.acceptServerHello(key, access, random, {
      accessSessionId: access,
      serverRandomB64: 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8',
      serverProofB64: 'IXvvgrKVbAjjW-M2rLOmf-blsUwmbgLa6y79lEj1vNA'
    });
    const sealed = await cipher.seal({
      v: 1,
      type: 'http_req',
      channel: 'ch_test',
      id: 'request_1',
      ts: 0,
      payload: { method: 'POST', path: '/canary', bodyB64: 'c2VjcmV0' }
    });
    process.stdout.write(sealed.ciphertextB64);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "voqHzLsUCWC__C-NBr-s0t1AshPpTEwNwSoOrhx_ihApnwkPlwKxr7EX28kmqOjoVQus161QnjXyzjxDil_WXgnkvu0pgQfiGV27QIgL97KPe2X0nv9vlzLUmwMll0ipeUo2IZKgM-Rt_WRa_-TyyL9SEkozijz1Z6HBxk1hfLiwQEb602fzHVGQP4Wh3Q2B41mrL_-AGQ",
  );
});

test("container and release archives include browser assets", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  const browserApp = readFileSync("web/app/app.js", "utf8");
  assert.match(dockerfile, /COPY --from=build \/app\/web \.\/web/);
  assert.match(release, /cp -R web/);
  assert.doesNotMatch(browserApp, /hasCamera\(/);
  assert.match(browserApp, /权限请求超时/);
  assert.match(browserApp, /parseBrowserPairValue/);
  assert.match(browserApp, /enrollBrowserPair/);
  assert.match(browserApp, /parsePairInput/);
  assert.match(browserApp, /parsed\.kind === "browser"/);
  const serviceWorker = readFileSync("web/app/sw.js", "utf8");
  assert.match(serviceWorker, /resumeTunnel/);
  assert.match(serviceWorker, /freshTicket/);
  assert.match(serviceWorker, /tunnel-sessions/);
  assert.doesNotMatch(serviceWorker, /throw new DOMException/);
  assert.match(serviceWorker, /pendingSends/);
  assert.match(serviceWorker, /remoteDeviceFromUrl/);
  assert.match(serviceWorker, /["GET", "HEAD"]/);
  const keyStore = readFileSync("web/app/key-store.js", "utf8");
  assert.match(keyStore, /indexedDB.open\("dsh-remote-web", 2\)/);
  const enrollmentStart = browserApp.indexOf(
    "async function enrollBrowserPair",
  );
  const clearFragment = browserApp.indexOf(
    'history.replaceState(null, "", "/app/")',
    enrollmentStart,
  );
  const authorizeDevice = browserApp.indexOf(
    'await api("/devices")',
    enrollmentStart,
  );
  assert.ok(clearFragment > 0 && clearFragment < authorizeDevice);
  assert.match(
    readFileSync("web/app/index.html", "utf8"),
    /app\.js\?v=0\.1\.9/,
  );
  assert.match(
    readFileSync("web/app/index.html", "utf8"),
    /key-store\.js\?v=0\.1\.9/,
  );
  assert.match(browserApp, /sw\.js\?v=0\.1\.9/);
  for (const file of [
    "web/app/index.html",
    "web/app/app.js",
    "web/app/sw.js",
    "web/app/qr-scanner.umd.min.js",
    "web/app/qr-scanner-worker.min.js",
    "web/app/qr-scanner.LICENSE",
    "web/admin/index.html",
    "web/admin/admin.js",
  ]) {
    assert.doesNotThrow(() => readFileSync(file));
  }
});
