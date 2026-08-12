/**
 * Regression test for the Windows login bug: `cmd.exe` split the authorize URL
 * at the first `&`, so the browser opened `…?challenge=…` with no state/port/
 * name/scopes and the approval page rendered "This authorization link is
 * invalid". Reported by a Windows user on 2026-08-12.
 */

import assert from "node:assert/strict";
import { planOpenUrl } from "../dist/openUrl.js";

const AUTHORIZE_URL =
  "https://clipy.online/cli/authorize?challenge=8cacoY4kPUbZHdutLpEcNQZyn-cw0g4PPvNFwabGLMc" +
  "&state=Ab12&port=51234&name=Clipy%20CLI%20%E2%80%94%20DESKTOP-1&scopes=recordings%3Aread%2Cingest";

// --- win32: the URL must bypass cmd.exe parsing entirely ---
{
  const plan = planOpenUrl(AUTHORIZE_URL, "win32");
  assert.equal(plan.cmd, "powershell.exe");
  assert.equal(plan.verbatim, false);
  assert.deepEqual(plan.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);

  const script = Buffer.from(plan.args[3], "base64").toString("utf16le");
  assert.equal(script, `Start-Process '${AUTHORIZE_URL}'`);
  assert.ok(script.includes("%E2%80%94"), "percent-encoded client name must survive unchanged");
  assert.ok(script.includes("%3Aread%2Cingest"), "percent-encoded scopes must survive unchanged");
}

// --- posix: URL passed through untouched, argv-safe with no shell ---
for (const [platform, opener] of [
  ["darwin", "open"],
  ["linux", "xdg-open"],
]) {
  const plan = planOpenUrl(AUTHORIZE_URL, platform);
  assert.equal(plan.cmd, opener);
  assert.deepEqual(plan.args, [AUTHORIZE_URL], `${platform} must not mangle the URL`);
  assert.equal(plan.verbatim, false);
}

console.log("✓ open-url: authorize URL bypasses cmd.exe on Windows and is untouched on posix");
