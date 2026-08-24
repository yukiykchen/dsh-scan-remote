import test from "node:test";
import assert from "node:assert/strict";
import { accessClientInfo } from "../src/access-info.js";

test("extracts only bounded mobile metadata from WebView user agents", () => {
  assert.deepEqual(
    accessClientInfo(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    ),
    { platform: "ios", deviceLabel: "iPhone", osVersion: "18.6" },
  );
  assert.deepEqual(
    accessClientInfo(
      "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro Build/AP3A.241105.007; wv) AppleWebKit/537.36",
    ),
    { platform: "android", deviceLabel: "Pixel 9 Pro", osVersion: "15" },
  );
});
