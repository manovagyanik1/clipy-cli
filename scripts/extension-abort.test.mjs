/**
 * `clipy session abort` on a chrome-extension session whose extension cannot be
 * reached: the session is cleared only when Chrome for Clipy is verifiably not
 * running. When ownership cannot be checked (lsof/ps missing from PATH, or ps
 * failing for a live listener), the recording may still be live, so the
 * session must be kept.
 *
 * Run (after `pnpm run build`): node scripts/extension-abort.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_INDEX = fileURLToPath(new URL("../dist/index.js", import.meta.url));

if (process.platform === "win32") {
  // The Windows probes use absolute System32 paths, so PATH cannot hide them.
  console.log("skipped: the probe-unavailable case is simulated by hiding lsof/ps from PATH");
  process.exit(0);
}

function abort(pathDirs) {
  const home = mkdtempSync(join(tmpdir(), "clipy-ext-abort-"));
  const file = join(home, "session.json");
  // An unused port: the extension cannot be reached to cancel.
  writeFileSync(file, JSON.stringify({ kind: "chrome-extension", pid: 0, chromePort: 1, extensionRecordingId: "r1" }));
  const result = spawnSync(process.execPath, [DIST_INDEX, "session", "abort", "--json"], {
    encoding: "utf8",
    env: { HOME: home, PATH: pathDirs, CLIPY_SESSION_FILE: file, NO_COLOR: "1" },
  });
  return { code: result.status, out: JSON.parse(result.stdout), kept: existsSync(file) };
}

const nodeOnly = mkdtempSync(join(tmpdir(), "clipy-node-only-"));
symlinkSync(process.execPath, join(nodeOnly, "node"));

const unverifiable = abort(nodeOnly);
assert.equal(unverifiable.out.state, "recording", JSON.stringify(unverifiable.out));
assert.match(unverifiable.out.error, /cannot verify/);
assert.equal(unverifiable.code, 1);
assert.ok(unverifiable.kept, "an unverifiable Chrome state must keep the session for a retry");

// ps present but failing while the listener is alive (inspection blocked).
const blockedPs = mkdtempSync(join(tmpdir(), "clipy-blocked-ps-"));
symlinkSync(process.execPath, join(blockedPs, "node"));
writeFileSync(join(blockedPs, "lsof"), `#!/bin/sh\necho ${process.pid}\n`);
writeFileSync(join(blockedPs, "ps"), "#!/bin/sh\nexit 1\n");
chmodSync(join(blockedPs, "lsof"), 0o755);
chmodSync(join(blockedPs, "ps"), 0o755);

const psFailing = abort(blockedPs);
assert.equal(psFailing.out.state, "recording", JSON.stringify(psFailing.out));
assert.match(psFailing.out.error, /is running but ps exited/);
assert.ok(psFailing.kept, "a live listener whose command line cannot be read must keep the session");

// lsof present but failing (exit 1 with a real diagnostic, not "no match").
function stubDir(prefix, lsofScript) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(process.execPath, join(dir, "node"));
  writeFileSync(join(dir, "lsof"), lsofScript);
  chmodSync(join(dir, "lsof"), 0o755);
  return dir;
}

const lsofError = abort(stubDir("clipy-lsof-err-", "#!/bin/sh\necho 'lsof: can not read kernel name list: Permission denied' >&2\nexit 1\n"));
assert.equal(lsofError.out.state, "recording", JSON.stringify(lsofError.out));
assert.match(lsofError.out.error, /lsof exited with status 1: lsof: can not read/);
assert.ok(lsofError.kept, "an lsof error must not read as \"nothing listening\"");

// Routine warnings about unrelated mounts are still a clean "no match".
const lsofWarning = abort(stubDir("clipy-lsof-warn-", "#!/bin/sh\necho 'lsof: WARNING: can not stat() fuse file system /run/user/1000/gvfs' >&2\nexit 1\n"));
assert.equal(lsofWarning.out.state, "cleared", JSON.stringify(lsofWarning.out));
assert.ok(!lsofWarning.kept);

const notRunning = abort(process.env.PATH ?? "");
assert.equal(notRunning.out.state, "cleared", JSON.stringify(notRunning.out));
assert.equal(notRunning.code, 0);
assert.ok(!notRunning.kept, "a verifiably stopped Chrome clears the session");

console.log("PASS: extension abort keeps the session when Chrome for Clipy's state is unverifiable");
