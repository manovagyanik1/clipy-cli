#!/usr/bin/env node
/**
 * The silent-failure regression test. No test framework, no deps.
 *
 * An agent records a logged-in SPA. If the auth flags don't take effect BEFORE
 * the first navigation, the app's route guard bounces the headless browser to a
 * login page and Clipy silently captures a logged-out recording that reads as if
 * it were the real thing. This suite proves the guard fires without auth, and
 * that every auth flag (--storage-state / --local-storage / --init-script) seeds
 * the session early enough to land authenticated.
 *
 * The recorded target is a local "protected" SPA: /app runs an inline guard
 * BEFORE anything else — `if (!localStorage.auth) location.replace('/?return_url=…')`
 * — and otherwise renders <h1 id="dash">Dashboard</h1>. Recordings never hit
 * clipy.online: CLIPY_API_URL points at a local mock of the ingest API, and we
 * read the captured `complete` payload to see what actually got recorded (the
 * daemon adds an `[auto] navigated to …?return_url=…` mark when the guard fired).
 *
 * Playwright + chromium exist only globally on this machine, so the CLI is run
 * with NODE_PATH set to the global node_modules. When Playwright can't be
 * resolved even so (a bare environment / the mirror-repo publish CI), the whole
 * suite SKIPS with exit 0 rather than failing.
 *
 * Run: npm run test:session   (or, after `npm run build`, `node scripts/auth-guard.test.mjs`)
 */

import { createServer } from "node:http";
import { spawnSync, spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const DIST_INDEX = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const API_KEY = "clipy_sk_test";

// --- Skip gracefully when the build or Playwright isn't available -----------

if (!existsSync(DIST_INDEX)) {
  console.log("skipped: dist/index.js missing — run `npm run build` first");
  process.exit(0);
}

// Playwright is global-only here; give the CLI (and its detached daemon, which
// inherits this env) a NODE_PATH that can resolve it.
let NODE_PATH = "";
try {
  NODE_PATH = execSync("npm root -g", { encoding: "utf8" }).trim();
} catch {
  NODE_PATH = "";
}

// The authoritative "can this machine actually record?" probe: the CLI's own
// resolver. If it can't find Playwright, no recording test can run.
const pw = spawnSync(process.execPath, [DIST_INDEX, "playwright-path"], {
  env: { ...process.env, NODE_PATH, NO_COLOR: "1" },
  encoding: "utf8",
});
if (pw.status !== 0) {
  console.log("skipped: playwright not resolvable (no headless browser available)");
  process.exit(0);
}

// --- The protected SPA being recorded ---------------------------------------

const appServer = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const body = u.pathname.startsWith("/app")
    ? // Guard runs BEFORE anything renders: logged out ⇒ replace() to the login
      // page with a return_url; logged in ⇒ the dashboard.
      `<!doctype html><html><head><script>
         if (!localStorage.getItem('auth')) {
           location.replace('/?return_url=' + encodeURIComponent(location.pathname));
         }
       </script></head><body><h1 id="dash">Dashboard</h1></body></html>`
    : `<!doctype html><html><body><h1 id="login">Please sign in</h1></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html" }).end(body);
});
await new Promise((r) => appServer.listen(0, "127.0.0.1", r));
const appBase = `http://127.0.0.1:${appServer.address().port}`;
const appOrigin = appBase; // no path ⇒ origin

// --- Mock of Clipy's raw-upload ingest API (never clipy.online) -------------

let lastComplete = null; // the JSON body of the most recent /complete call

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const ingestServer = createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const json = { "Content-Type": "application/json" };
  if (u.pathname === "/api/videos/raw-upload/initiate") {
    await readBody(req);
    res.writeHead(200, json).end(JSON.stringify({ uploadToken: "t", publicId: "testid" }));
    return;
  }
  if (u.pathname === "/api/videos/raw-upload/complete") {
    lastComplete = JSON.parse((await readBody(req)).toString() || "{}");
    res.writeHead(200, json).end("{}");
    return;
  }
  // chunk (multipart), finalize, abort — accept and ack.
  if (u.pathname.startsWith("/api/videos/raw-upload/")) {
    await readBody(req);
    res.writeHead(200, json).end("{}");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
});
await new Promise((r) => ingestServer.listen(0, "127.0.0.1", r));
const apiBase = `http://127.0.0.1:${ingestServer.address().port}`;

// --- Harness ----------------------------------------------------------------

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${e && e.message ? e.message : e}`);
  }
}

/** A fresh, isolated workspace: session state files are keyed by cwd AND live
 *  under XDG_CONFIG_HOME, so a per-test temp of each keeps parallel/leftover
 *  sessions from colliding. */
function freshWorkspace() {
  const configHome = mkdtempSync(join(tmpdir(), "clipy-guard-cfg-"));
  const cwd = mkdtempSync(join(tmpdir(), "clipy-guard-cwd-"));
  return {
    cwd,
    env: {
      CLIPY_API_KEY: API_KEY,
      CLIPY_API_URL: apiBase,
      XDG_CONFIG_HOME: configHome,
      NODE_PATH,
      NO_COLOR: "1",
    },
    configHome,
  };
}

function runCli(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_INDEX, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function sessionNotes() {
  return lastComplete?.narration?.notes ?? [];
}
function hasReturnUrlMark() {
  return sessionNotes().some((n) => typeof n.text === "string" && n.text.includes("return_url"));
}

/** Write a Playwright storageState JSON that seeds localStorage.auth for the app
 *  origin (the shape you'd get from context.storageState()). */
function storageStateFile() {
  const f = join(mkdtempSync(join(tmpdir(), "clipy-guard-auth-")), "auth.json");
  writeFileSync(
    f,
    JSON.stringify({
      cookies: [],
      origins: [{ origin: appOrigin, localStorage: [{ name: "auth", value: "1" }] }],
    }),
  );
  return f;
}

/**
 * Run a full session against the protected app with the given auth flags:
 * start → one assertion mark for #dash=Dashboard → stop (uploads). Returns the
 * mark's stdout and the captured complete payload's notes. Always aborts in a
 * finally so a stuck session never leaks into the next test.
 */
async function recordSessionWithAuth(authArgs) {
  const ws = freshWorkspace();
  lastComplete = null;
  try {
    const start = await runCli(
      ["session", "start", "--url", `${appBase}/app`, "--max", "30", ...authArgs, "--json"],
      ws,
    );
    assert.equal(start.code, 0, `session start failed (${start.code}): ${start.stderr}`);

    const mark = await runCli(
      ["mark", "on the dashboard", "--assert-selector", "#dash", "--assert-text", "Dashboard"],
      ws,
    );

    const stop = await runCli(["session", "stop", "--json"], ws);
    assert.equal(stop.code, 0, `session stop failed (${stop.code}): ${stop.stderr}`);
    return { mark, notes: sessionNotes() };
  } finally {
    await runCli(["session", "abort"], ws).catch(() => {});
  }
}

// --- Tests ------------------------------------------------------------------

await test("a: guard fires without auth — #dash assertion FAILS and a return_url capture is recorded silently", async () => {
  const ws = freshWorkspace();
  lastComplete = null;
  try {
    const start = await runCli(
      ["session", "start", "--url", `${appBase}/app`, "--max", "30", "--json"],
      ws,
    );
    assert.equal(start.code, 0, `session start failed: ${start.stderr}`);

    const mark = await runCli(["mark", "logged in?", "--assert-selector", "#dash"], ws);
    // A plain assertion fail (default --fail-mode warn) is exit 0 with a ✗ line.
    assert.equal(mark.code, 0, `mark exited ${mark.code}: ${mark.stderr}`);
    assert.match(mark.stdout, /✗/, "the #dash assertion should FAIL (guard redirected away)");

    const stop = await runCli(["session", "stop", "--json"], ws);
    assert.equal(stop.code, 0, `session stop failed: ${stop.stderr}`);

    // The smoking gun: the daemon recorded a navigation to the login page's
    // return_url — a logged-out capture happened with no auth flags and no error.
    assert.ok(
      hasReturnUrlMark(),
      `expected an [auto] navigated …return_url… mark; got:\n${JSON.stringify(sessionNotes(), null, 2)}`,
    );
  } finally {
    await runCli(["session", "abort"], ws).catch(() => {});
  }
});

await test("b: --storage-state lands authenticated — #dash=Dashboard PASSES, no return_url", async () => {
  const { mark, notes } = await recordSessionWithAuth(["--storage-state", storageStateFile()]);
  assert.equal(mark.code, 0, `mark exited ${mark.code}: ${mark.stderr}`);
  assert.match(mark.stdout, /✓/, "the #dash=Dashboard assertion should PASS under --storage-state");
  assert.ok(!hasReturnUrlMark(), `authenticated capture must not redirect; got ${JSON.stringify(notes)}`);
});

await test("c: --local-storage 'auth=1' lands authenticated — #dash=Dashboard PASSES, no return_url", async () => {
  const { mark } = await recordSessionWithAuth(["--local-storage", "auth=1"]);
  assert.equal(mark.code, 0, `mark exited ${mark.code}: ${mark.stderr}`);
  assert.match(mark.stdout, /✓/, "the #dash=Dashboard assertion should PASS under --local-storage");
  assert.ok(!hasReturnUrlMark(), "authenticated capture must not redirect");
});

await test("d: --init-script lands authenticated — #dash=Dashboard PASSES, no return_url", async () => {
  const scriptFile = join(mkdtempSync(join(tmpdir(), "clipy-guard-init-")), "seed.js");
  writeFileSync(scriptFile, "localStorage.setItem('auth', '1');\n");
  const { mark } = await recordSessionWithAuth(["--init-script", scriptFile]);
  assert.equal(mark.code, 0, `mark exited ${mark.code}: ${mark.stderr}`);
  assert.match(mark.stdout, /✓/, "the #dash=Dashboard assertion should PASS under --init-script");
  assert.ok(!hasReturnUrlMark(), "authenticated capture must not redirect");
});

await test("e: `record` (one-shot) with --storage-state completes and uploads through the ingest pipeline", async () => {
  const ws = freshWorkspace();
  lastComplete = null;
  const r = await runCli(
    ["record", "--url", `${appBase}/app`, "--for", "2", "--storage-state", storageStateFile(), "--json"],
    ws,
  );
  assert.equal(r.code, 0, `record exited ${r.code}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.id, "testid", "record --json should print the uploaded public id");
  assert.ok(out.sizeBytes > 0, "a non-empty recording should have been uploaded");
  assert.ok(lastComplete, "the ingest pipeline's /complete must have been called");
  assert.equal(lastComplete.sourcePlatform, "web", "the CLI's web capture reports sourcePlatform 'web'");
});

await test("f: --storage-state with a missing file exits 2 before any browser launch", async () => {
  const ws = freshWorkspace();
  const missing = join(ws.cwd, "does-not-exist.json");
  const r = await runCli(["record", "--url", `${appBase}/app`, "--storage-state", missing, "--for", "2"], ws);
  assert.equal(r.code, 2, `expected usage exit 2, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /storage-state file not found/i);
});

await test("g: a storage-state JSON lacking cookies/origins prints the shape warning", async () => {
  const ws = freshWorkspace();
  const bad = join(mkdtempSync(join(tmpdir(), "clipy-guard-bad-")), "not-a-state.json");
  writeFileSync(bad, JSON.stringify({ foo: "bar" }));
  // No API key ⇒ the warning is emitted (validation runs first) then requireKey
  // dies — so we assert the warning without launching a browser.
  const r = await runCli(["record", "--url", `${appBase}/app`, "--storage-state", bad, "--for", "2"], {
    cwd: ws.cwd,
    env: {
      CLIPY_API_URL: apiBase,
      XDG_CONFIG_HOME: ws.configHome,
      CLIPY_API_KEY: "",
      NODE_PATH,
      NO_COLOR: "1",
    },
  });
  assert.notEqual(r.code, 0, "a bad storage-state + no key should not exit 0");
  assert.match(r.stderr, /neither "cookies" nor "origins"/, "the shape warning should be printed");
});

appServer.close();
ingestServer.close();
if (failures > 0) {
  console.error(`\n${failures} auth-guard test(s) failed`);
  process.exit(1);
}
console.log("\nall auth-guard tests passed");
