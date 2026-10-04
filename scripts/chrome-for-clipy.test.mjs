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
import { join } from "node:path";
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
  readState,
  resolveChromeBinary,
  TAB_CAPTURE_TITLE_MARKER,
  startChrome,
  stopChrome,
  chromeStatus,
} = await import("../dist/chromeForClipy.js");

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
    assert.equal(stopChrome(home).stopped, false);
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
