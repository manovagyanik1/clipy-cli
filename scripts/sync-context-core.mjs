#!/usr/bin/env node
/**
 * Copies lib/context-core into cli/src so the CLI can publish standalone.
 * The source is the single point of truth; cli/src/context-core is generated
 * (gitignored) and rewritten on every build.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "lib", "context-core");
const dest = join(here, "..", "src", "context-core");

const HEADER = "// GENERATED from lib/context-core — do not edit here\n";

let files;
try {
  files = readdirSync(src).filter((f) => f.endsWith(".ts"));
} catch {
  // Publishing from the standalone mirror repo: lib/ isn't there, but the
  // generated copy in src/ is. Nothing to sync.
  process.stderr.write("[sync-context-core] lib/context-core not found — keeping existing copy\n");
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

for (const file of files) {
  const body = readFileSync(join(src, file), "utf8")
    // NodeNext ESM needs explicit extensions; the Next.js build does not.
    .replace(/(from\s+['"]\.\/[^'"]+)(['"])/g, (_m, path, quote) =>
      path.endsWith(".js") ? `${path}${quote}` : `${path}.js${quote}`,
    );
  writeFileSync(join(dest, file), HEADER + body);
}

process.stdout.write(`[sync-context-core] copied ${files.length} files\n`);
