import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EXPECTED_DSH_VERSION } from "./version.js";

export type DshCompatibility = {
  expectedVersion: string;
  detectedVersion: string | null;
  compatible: boolean;
  message: string | null;
};

export function detectDshVersion(cwd = process.cwd()): string | null {
  const candidates = [
    join(cwd, "node_modules/@deepseek-ai/dsh/package.json"),
    join(cwd, "node_modules/@deepseek-ai/dsh/package.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      continue;
    }
  }
  try {
    const require = createRequire(join(cwd, "package.json"));
    const pkg = require("@deepseek-ai/dsh/package.json") as { version?: string };
    return pkg.version ?? null;
  } catch {
    return process.env.DSH_VERSION ?? null;
  }
}

export function dshCompatibility(cwd = process.cwd()): DshCompatibility {
  const detectedVersion = detectDshVersion(cwd);
  const compatible = detectedVersion === EXPECTED_DSH_VERSION;
  return {
    expectedVersion: EXPECTED_DSH_VERSION,
    detectedVersion,
    compatible: detectedVersion == null ? true : compatible,
    message:
      detectedVersion && !compatible
        ? `This plugin is tested against DSH ${EXPECTED_DSH_VERSION}. Detected ${detectedVersion}. Upgrade DSH or this plugin before pairing.`
        : null,
  };
}
