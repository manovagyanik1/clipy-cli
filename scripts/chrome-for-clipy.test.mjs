#!/usr/bin/env node
/**
 * `clipy chrome`: the Chrome for Clipy automation browser.
 *
 * Guards the invariants the live flow depends on: the capture marker must stay
 * regex-safe (Chrome may treat the auto-select flag as a pattern), the launch
 * args must carry every capability the e2e flow assumes, and state handling
 * must degrade to "not running" on garbage instead of throwing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const {
  APP_NAME,
  appBundlePath,
  chromeForClipyDir,
  DEFAULT_CDP_PORT,
  installApp,
  launchArgs,
  ownershipProbeStatus,
  readState,
  resolveChromeBinary,
  TAB_CAPTURE_TITLE_MARKER,
  startChrome,
  stopChrome,
  chromeStatus,
  windowsChromeCandidates,
  createTabStealGuard,
  trackAgentTabs,
} = await import("../dist/chromeForClipy.js");
const { parseNetstatListener, processExists, splitWindowsCommandLine } = await import("../dist/processProbe.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("capture marker is regex-safe: a metacharacter would silently match wrong tabs", () => {
  assert.match(TAB_CAPTURE_TITLE_MARKER, /^[a-zA-Z0-9_-]+$/);
});

test("launch args carry CDP, auto-select capture, and all three throttling disables", () => {
  const args = launchArgs("/home/x", DEFAULT_CDP_PORT);
  assert.ok(args.some((a) => a === `--remote-debugging-port=${DEFAULT_CDP_PORT}`));
  assert.ok(args.some((a) => a === `--auto-select-tab-capture-source-by-title=${TAB_CAPTURE_TITLE_MARKER}`));
  for (const flag of [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  const dataDir = args.find((a) => a.startsWith("--user-data-dir="));
  assert.ok(dataDir?.includes(chromeForClipyDir("/home/x")), "profile must live under the clipy config dir");
});

test("readState: absent, garbage, and valid files", () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  assert.equal(readState(home), null);
  mkdirSync(chromeForClipyDir(home), { recursive: true });
  writeFileSync(join(chromeForClipyDir(home), "state.json"), "{ not json");
  assert.equal(readState(home), null);
  writeFileSync(
    join(chromeForClipyDir(home), "state.json"),
    JSON.stringify({ pid: 123, port: 9333, startedAt: "x", binary: "/b" }),
  );
  assert.deepEqual(readState(home)?.pid, 123);
});

test("resolveChromeBinary honors CLIPY_CHROME_BINARY only when it exists", () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const fake = join(home, "chrome");
  writeFileSync(fake, "");
  assert.equal(resolveChromeBinary({ CLIPY_CHROME_BINARY: fake }, "darwin", home), fake);
  assert.equal(resolveChromeBinary({ CLIPY_CHROME_BINARY: join(home, "missing") }, "darwin", home), null);
});

test("installApp writes a named launcher bundle with embedded flags and icon slot", () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const fake = join(home, "chrome");
  writeFileSync(fake, "");
  const result = installApp(home, { CLIPY_CHROME_BINARY: fake }, "darwin", DEFAULT_CDP_PORT);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.path, appBundlePath(home));
  const plist = readFileSync(join(result.path, "Contents", "Info.plist"), "utf8");
  assert.ok(plist.includes(`<string>${APP_NAME}</string>`));
  assert.ok(plist.includes("online.clipy.chrome-for-clipy"));
  const script = readFileSync(join(result.path, "Contents", "MacOS", "chrome-for-clipy"), "utf8");
  assert.ok(script.startsWith("#!/bin/sh"));
  assert.ok(script.includes("--auto-select-tab-capture-source-by-title"));
  assert.ok(script.includes(fake), "launcher must exec the resolved Chrome binary");
});

test("resolveChromeBinary finds the standard Windows install locations", () => {
  const root = mkdtempSync(join(tmpdir(), "clipy-chrome-win-"));
  const perUser = join(root, "Local", "Google", "Chrome", "Application", "chrome.exe");
  mkdirSync(dirname(perUser), { recursive: true });
  writeFileSync(perUser, "");
  // Keys spelled as a copied env object would have them: lookups must ignore case.
  const env = { programfiles: join(root, "PF"), "ProgramFiles(x86)": join(root, "PF86"), LocalAppData: join(root, "Local") };
  const candidates = windowsChromeCandidates(env, "linux");
  assert.deepEqual(candidates.slice(0, 3), [
    join(root, "PF", "Google", "Chrome", "Application", "chrome.exe"),
    join(root, "PF86", "Google", "Chrome", "Application", "chrome.exe"),
    perUser,
  ]);
  if (process.platform !== "win32") {
    // On a real Windows host the registry may name the machine's own Chrome first.
    assert.equal(resolveChromeBinary(env, "win32"), perUser);
  }
});

test("Windows command lines split back into the exact argv Node spawned", () => {
  const argv = splitWindowsCommandLine(
    String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" "--user-data-dir=C:\Users\First Last\.config\clipy\chrome-for-clipy\profile" --remote-debugging-port=9333 --x="a \"q\" b" C:\trail\ "end\\"`,
  );
  assert.deepEqual(argv, [
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`--user-data-dir=C:\Users\First Last\.config\clipy\chrome-for-clipy\profile`,
    "--remote-debugging-port=9333",
    `--x=a "q" b`,
    String.raw`C:\trail\ `.trim(),
    String.raw`end\ `.trim(),
  ]);
});

test("netstat listeners are found by row shape, whatever the locale's state word", () => {
  const output = [
    "",
    "Aktive Verbindungen",
    "",
    "  Proto  Lokale Adresse         Remoteadresse          Status           PID",
    "  TCP    127.0.0.1:9333         127.0.0.1:51000        HERGESTELLT      4444",
    "  TCP    0.0.0.0:19333          0.0.0.0:0              ABHÖREN          5555",
    "  TCP    127.0.0.1:9333         0.0.0.0:0              ABHÖREN          1234",
    "  TCP    [::1]:9333             [::]:0                 ABHÖREN          1234",
    "  UDP    0.0.0.0:9333           *:*                                     7777",
  ].join("\r\n");
  assert.equal(parseNetstatListener(output, 9333), 1234);
  assert.equal(parseNetstatListener(output, 9334), null);
  assert.equal(parseNetstatListener("  TCP    [::1]:9444    [::]:0    LISTENING    88\n", 9444), 88);
});

test("a live process owned by another user still counts as running (EPERM)", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  // pid 1 (launchd/init) exists, and signalling it as a normal user is EPERM.
  assert.equal(processExists(1), true);
  assert.equal(processExists(2 ** 22 + 12345), false);
});

test("this host can run the ownership probes (the check that was always false on Windows)", () => {
  assert.deepEqual(ownershipProbeStatus(), { ok: true });
});

test("installApp refuses non-macOS instead of writing a broken bundle", () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const result = installApp(home, {}, "linux", DEFAULT_CDP_PORT);
  assert.equal(result.ok, false);
});

test("stale state cannot adopt or terminate an unrelated live process", async () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    mkdirSync(chromeForClipyDir(home), { recursive: true });
    writeFileSync(join(chromeForClipyDir(home), "state.json"), JSON.stringify({
      pid: child.pid, port: 1, binary: process.execPath, startedAt: "x",
    }));
    assert.equal((await chromeStatus(home, "darwin")).running, false);
    const started = await startChrome(home, { CLIPY_CHROME_BINARY: "/does/not/exist" }, "darwin", 1);
    assert.equal(started.ok, false, "a live PID alone is not a Chrome instance");
    assert.equal((await stopChrome(home)).stopped, false);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    child.kill();
    await once(child, "exit");
  }
});

test("a foreign CDP listener is neither adopted nor stopped", async () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const server = createServer((_req, res) => res.end(JSON.stringify({ Browser: "Chrome/150" })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address().port;
    const result = await startChrome(home, {}, "darwin", port);
    assert.equal(result.ok, false, "must not adopt another browser's debugging port");
    assert.match(result.error, /in use|another|owned/i);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("invalid PID values never become process-group signals", () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  mkdirSync(chromeForClipyDir(home), { recursive: true });
  for (const pid of [0, -1, -123]) {
    writeFileSync(join(chromeForClipyDir(home), "state.json"), JSON.stringify({ pid, port: 9333 }));
    assert.equal(readState(home), null);
  }
});

test("a live owned process cannot vouch for a foreign listener on its saved port", async () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const server = createServer((_req, res) => res.end(JSON.stringify({ Browser: "Chrome/150" })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...launchArgs(home, port)], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    mkdirSync(chromeForClipyDir(home), { recursive: true });
    writeFileSync(join(chromeForClipyDir(home), "state.json"), JSON.stringify({
      pid: child.pid, port, binary: process.execPath, startedAt: "x",
    }));
    const status = await chromeStatus(home, "darwin");
    assert.equal(status.running, true);
    assert.equal(status.cdpReady, false, "a foreign endpoint must not be advertised as ready");
    assert.equal(status.cdpUrl, null);
    const result = await startChrome(home, {}, "darwin", port);
    assert.equal(result.ok, false, "must reject the saved port when another process owns it");
  } finally {
    child.kill();
    await once(child, "exit");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Chrome sessions reject ignored authentication flags before launching a browser", () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  for (const [flag, value] of [
    ["--storage-state", "missing.json"], ["--init-script", "missing.js"],
    ["--cookie", "auth=1"], ["--local-storage", "auth=1"],
  ]) {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      "session", "start", "--source", "chrome-for-clipy", "--url", "http://127.0.0.1:1", flag, value,
    ], { encoding: "utf8", env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, CLIPY_API_KEY: "", CLIPY_DISABLE_CDP: "1" } });
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.match(result.stderr, /auth-capture flags don't apply/, flag);
  }
});

test("a non-executable Chrome override returns an error without an unhandled spawn event", async () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const binary = join(home, "chrome");
  writeFileSync(binary, "not executable");
  const result = await startChrome(home, { CLIPY_CHROME_BINARY: binary }, "darwin", 1);
  assert.equal(result.ok, false);
});

test("CLIPY_DISABLE_CDP=1 refuses to start Chrome for Clipy before spawning anything", async () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const result = await startChrome(home, { CLIPY_DISABLE_CDP: "1", CLIPY_CHROME_BINARY: process.execPath }, "linux", 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /CLIPY_DISABLE_CDP=1/);
  assert.equal(readState(home), null, "no state file may be written when CDP is disabled");
});

test("the guide describes --with-browser as Chrome for Clipy only, with no extension bridge", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../dist/index.js", import.meta.url)), "guide", "--json",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const guide = JSON.parse(result.stdout);
  const setup = guide.commands.find((c) => c.name === "setup");
  const chrome = guide.commands.find((c) => c.name === "chrome");
  assert.ok(setup && chrome, "setup and chrome must both be in the guide");
  const text = JSON.stringify([setup, chrome]);
  assert.match(text, /--with-browser/);
  assert.match(text, /Chrome for Clipy/);
  assert.doesNotMatch(text, /open-browser-use|\bobu\b|native messaging|allowed_origins/i);
});

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function writePendingState(home, port, startedAt) {
  mkdirSync(chromeForClipyDir(home), { recursive: true });
  writeFileSync(
    join(chromeForClipyDir(home), "state.json"),
    JSON.stringify({ pid: 0, port, startedAt, binary: "/b" }),
  );
}

test("a background launch with no pid yet is readable state (port kept for status/stop)", () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  writePendingState(home, 9555, new Date().toISOString());
  assert.equal(readState(home)?.port, 9555);
  assert.equal(readState(home)?.pid, 0);
});

test("start refuses to launch a duplicate while a background launch is still starting", async () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const port = await freePort();
  writePendingState(home, port, new Date().toISOString());
  const result = await startChrome(home, {}, process.platform, port);
  assert.equal(result.ok, false);
  assert.match(result.error, /still starting/);
});

test("stop keeps a still-starting launch's state instead of forgetting its port", async () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const port = await freePort();
  writePendingState(home, port, new Date().toISOString());
  const result = await stopChrome(home);
  assert.equal(result.ok, false);
  assert.match(result.error, /still starting/);
  assert.equal(readState(home)?.port, port, "pending state must survive the stop");
});

test("stop forgets a launch that never came up within the pending window", async () => {
  const home = mkdtempSync(join(tmpdir(), "clipy-chrome-"));
  const port = await freePort();
  writePendingState(home, port, new Date(Date.now() - 5 * 60_000).toISOString());
  assert.deepEqual(await stopChrome(home), { ok: true, stopped: false });
  assert.equal(readState(home), null);
});

test("tab focus guard: undoes a steal after a new tab, back to the app Chrome displaced", () => {
  let t = 0;
  const activated = [];
  const g = createTabStealGuard(100, (pid) => activated.push(pid), () => t);
  g.frontChanged(200); // user in an editor
  t = 5000;
  g.frontChanged(300); // user switched to a terminal just before the tab
  t = 5050;
  g.tabOpened();
  t = 5400;
  g.frontChanged(100); // Chrome steals focus
  assert.deepEqual(activated, [300], "must return to the app actually displaced, not an earlier sample");
});

test("tab focus guard: a tab reported late still undoes a steal that came after its creation", () => {
  let t = 0;
  const activated = [];
  const g = createTabStealGuard(100, (pid) => activated.push(pid), () => t);
  g.frontChanged(200);
  t = 1000;
  g.frontChanged(100); // Chrome comes forward 50ms after the tab was created
  t = 1300;
  g.tabOpened(950); // reported late, with its creation time
  assert.deepEqual(activated, [200]);
});

test("tab focus guard: Chrome brought forward just before a tab is the user's, not a steal", () => {
  let t = 0;
  const activated = [];
  const g = createTabStealGuard(100, (pid) => activated.push(pid), () => t);
  g.frontChanged(200);
  t = 1000;
  g.frontChanged(100); // user clicks into Chrome
  t = 1300;
  g.tabOpened(1300); // agent opens a tab 300ms later
  assert.deepEqual(activated, []);
});

test("tab focus guard: the user bringing Chrome forward to watch is left alone", () => {
  let t = 0;
  const activated = [];
  const g = createTabStealGuard(100, (pid) => activated.push(pid), () => t);
  g.frontChanged(200);
  t = 1000;
  g.frontChanged(100); // user clicks into Chrome, no tab
  t = 4000;
  g.tabOpened(); // agent opens a tab while the user is already watching
  t = 4300;
  g.frontChanged(100);
  assert.deepEqual(activated, []);
  t = 9000;
  g.frontChanged(200);
  g.frontChanged(100); // a later switch with no new tab
  assert.deepEqual(activated, []);
});

test("tab tracking: Clipy's own background tabs never count as agent tabs", async () => {
  const pages = [{ id: "existing" }];
  const context = { pages: () => pages };
  let agentTabs = 0;
  const tracker = trackAgentTabs(context, () => agentTabs++, 10);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // Our tab appears while it is still being resolved, alongside an agent tab.
    const own = { id: "ours" };
    const opened = tracker.ownTab(async () => {
      pages.push(own);
      await wait(40);
      pages.push({ id: "agent" });
      await wait(40);
      return own;
    });
    await wait(30);
    assert.equal(agentTabs, 0, "nothing is judged while our tab is being opened");
    assert.equal(await opened, own);
    await wait(40);
    assert.equal(agentTabs, 1, "only the agent's tab arms the guard");
    pages.push({ id: "agent-2" });
    await wait(40);
    assert.equal(agentTabs, 2);
  } finally {
    tracker.stop();
  }
});

test("tab tracking: uses the page event when the context has one, with the tab's own time", async () => {
  const pages = [];
  let listener = null;
  const context = {
    pages: () => pages,
    on: (_e, fn) => { listener = fn; },
    off: () => { listener = null; },
  };
  const times = [];
  const tracker = trackAgentTabs(context, (at) => times.push(at));
  const before = Date.now();
  const tab = {};
  pages.push(tab);
  listener(tab);
  assert.equal(times.length, 1);
  assert.ok(times[0] >= before && times[0] <= Date.now());
  tracker.stop();
  assert.equal(listener, null, "stop removes the listener");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`  ✗ ${name}\n    ${e.message}\n`);
  }
}
process.stdout.write(failed ? `\n${failed} failing\n` : `\n${tests.length} passing\n`);
process.exit(failed ? 1 : 0);
