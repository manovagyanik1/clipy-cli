/**
 * `clipy context read <bundle-path>` — prints a local bundle's recording.md.
 * Output is for agents: plain, unpaged, uncoloured.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function cmdContextRead(target: string): void {
  let dir = resolve(target);
  // Accept either the bundle directory or one of the files inside it.
  if (existsSync(dir) && statSync(dir).isFile()) dir = resolve(dir, "..");

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${dir} is not a Clipy context bundle (no manifest.json).`);
  }

  let manifest: { bundleVersion?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    throw new Error(`${manifestPath} is not valid JSON.`);
  }
  if (manifest.bundleVersion !== 1) {
    throw new Error(
      `unsupported bundle version ${String(manifest.bundleVersion)} — this CLI reads bundleVersion 1. Upgrade with \`npm i -g @clipy/cli\`.`,
    );
  }

  const doc = join(dir, "recording.md");
  if (!existsSync(doc)) throw new Error(`${dir} has a manifest but no recording.md.`);
  process.stdout.write(readFileSync(doc, "utf8"));
}
