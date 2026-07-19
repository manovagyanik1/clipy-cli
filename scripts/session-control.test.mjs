#!/usr/bin/env node
/**
 * The session control-plane protocol test. No test framework, no deps.
 *
 * A `clipy session` runs a detached recording daemon that owns the live
 * Playwright page. `clipy mark`/`chapter` reach it over a local, bearer-token
 * HTTP control endpoint (127.0.0.1, OS-assigned port), whose port + token are
 * written to the 0600 session state file. This suite drives that protocol
 * end-to-end against a trivial static page and inspects the uploaded `complete`
 * payload (captured by a local mock of the ingest API — never clipy.online):
 *
 *   - the control endpoint rejects an unauthenticated request (401), a non-JSON
 *     content-type (415), and an over-cap body (413)
 *   - a plain `clipy mark` lands in the transcript
 *   - a passing and a failing assertion annotate the mark ✓/✗ and both surface
 *     under a leading `[verification] N assertion(s): P passed, F failed` note
 *   - `clipy chapter "AFTER"` stores `=== CHAPTER: AFTER ===`
 *   - `clipy mark --ago` backdates onto the recording clock (payload ordering)
 *   - `clipy session run -- <cmd>` uploads on exit 0, discards + propagates the
 *     code on a non-zero exit (no `complete` call)
 *   - `clipy playwright-path` prints a node_modules path and exits 0
 *   - the mark flag guards (--assert-text without --assert-selector; --at with
 *     --ago) are usage errors (exit 2)
 *
 * Playwright + chromium exist only globally here, so the CLI runs with NODE_PATH
 * set to the global node_modules. When Playwright can't be resolved even so
 * (a bare environment / the mirror-repo publish CI), the whole suite SKIPS with
 * exit 0 rather than failing. Session state files are keyed by cwd, so each
 * session test runs from its own scratch cwd and always aborts in a finally.
 *
 * Run: npm run test:session   (or, after `npm run build`, `node scripts/session-control.test.mjs`)
 */

import { createServer } from "node:http";
import { spawnSync, spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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

let NODE_PATH = "";
try {
  NODE_PATH = execSync("npm root -g", { encoding: "utf8" }).trim();
} catch {
  NODE_PATH = "";
}

const pw = spawnSync(process.execPath, [DIST_INDEX, "playwright-path"], {
  env: { ...process.env, NODE_PATH, NO_COLOR: "1" },
  encoding: "utf8",
});
if (pw.status !== 0) {
  console.log("skipped: playwright not resolvable (no headless browser available)");
  process.exit(0);
}

// --- The static page being recorded -----------------------------------------

const appServer = createServer((_req, res) => {
  res
    .writeHead(200, { "Content-Type": "text/html" })
    .end(`<!doctype html><html><body><h1 id="t">Hello</h1></body></html>`);
});
await new Promise((r) => appServer.listen(0, "127.0.0.1", r));
const appBase = `http://127.0.0.1:${appServer.address().port}`;

// --- Mock of Clipy's raw-upload ingest API (never clipy.online) -------------

let completeCalls = 0;
let lastComplete = null;

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
    completeCalls += 1;
    lastComplete = JSON.parse((await readBody(req)).toString() || "{}");
    res.writeHead(200, json).end("{}");
    return;
  }
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

function freshWorkspace() {
  const configHome = mkdtempSync(join(tmpdir(), "clipy-ctl-cfg-"));
  const cwd = mkdtempSync(join(tmpdir(), "clipy-ctl-cwd-"));
  return {
    cwd,
    configHome,
    env: {
      CLIPY_API_KEY: API_KEY,
      CLIPY_API_URL: apiBase,
      XDG_CONFIG_HOME: configHome,
      NODE_PATH,
      NO_COLOR: "1",
    },
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

/** Read the single session state file this workspace's daemon wrote. */
function readSessionState(configHome) {
  const dir = join(configHome, "clipy", "sessions");
  const file = readdirSync(dir).find((n) => n.startsWith("session-") && n.endsWith(".json"));
  if (!file) throw new Error(`no session state file under ${dir}`);
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

const noteText = (notes, needle) => notes.find((n) => typeof n.text === "string" && n.text.includes(needle));

// --- The main protocol run (tests a–e in one session) -----------------------

await test("session control protocol: 401 guard, plain mark, assert ✓/✗ + [verification], chapter, --ago backdating", async () => {
  const ws = freshWorkspace();
  lastComplete = null;
  try {
    const start = await runCli(
      ["session", "start", "--url", appBase, "--max", "30", "--json"],
      ws,
    );
    assert.equal(start.code, 0, `session start failed (${start.code}): ${start.stderr}`);

    // (a) The control endpoint is bearer-token gated — no/wrong token ⇒ 401.
    const state = readSessionState(ws.configHome);
    assert.ok(state.controlPort > 0, "state file exposes a controlPort");
    assert.ok(typeof state.controlToken === "string" && state.controlToken, "state file exposes a controlToken");
    const ctlUrl = `http://127.0.0.1:${state.controlPort}/mark`;
    const noAuth = await fetch(ctlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "unauthorized" }),
    });
    assert.equal(noAuth.status, 401, "no bearer token ⇒ 401");
    const wrongAuth = await fetch(ctlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: JSON.stringify({ text: "unauthorized" }),
    });
    assert.equal(wrongAuth.status, 401, "wrong bearer token ⇒ 401");

    // (a2) A non-JSON content-type on an authed POST ⇒ 415.
    const wrongCtype = await fetch(ctlUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Authorization: `Bearer ${state.controlToken}` },
      body: JSON.stringify({ text: "x" }),
    });
    assert.equal(wrongCtype.status, 415, "non-JSON content-type ⇒ 415");

    // (a3) An over-cap body ⇒ 413 (rejected up front by declared Content-Length,
    // and the body is drained so we read the status cleanly, not a socket error).
    const tooBig = await fetch(ctlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.controlToken}` },
      body: "x".repeat(1_500_000),
    });
    assert.equal(tooBig.status, 413, "an over-cap body ⇒ 413");

    // (b) A plain mark works.
    const plain = await runCli(["mark", "note one plain"], ws);
    assert.equal(plain.code, 0, `plain mark exited ${plain.code}: ${plain.stderr}`);
    assert.match(plain.stdout, /✓ mark @/, "plain mark prints a ✓ confirmation");

    // (c) One passing and one failing assertion.
    const pass = await runCli(["mark", "hello shows", "--assert-selector", "#t", "--assert-text", "Hello"], ws);
    assert.equal(pass.code, 0, `passing assertion mark exited ${pass.code}: ${pass.stderr}`);
    assert.match(pass.stdout, /✓/, "a satisfied assertion prints ✓");
    const fail = await runCli(["mark", "missing thing", "--assert-selector", "#nope"], ws);
    assert.equal(fail.code, 0, `failing assertion mark (warn) exited ${fail.code}: ${fail.stderr}`);
    assert.match(fail.stdout, /✗/, "an unsatisfied assertion prints ✗");

    // (d) A chapter boundary.
    const chapter = await runCli(["chapter", "AFTER"], ws);
    assert.equal(chapter.code, 0, `chapter exited ${chapter.code}: ${chapter.stderr}`);

    // (e) A live-clock reference mark, then a backdated one.
    const reference = await runCli(["mark", "reference-live"], ws);
    assert.equal(reference.code, 0, `reference mark exited ${reference.code}: ${reference.stderr}`);
    const backdated = await runCli(["mark", "way-back", "--ago", "30"], ws);
    assert.equal(backdated.code, 0, `--ago mark exited ${backdated.code}: ${backdated.stderr}`);

    const stop = await runCli(["session", "stop", "--json"], ws);
    assert.equal(stop.code, 0, `session stop failed (${stop.code}): ${stop.stderr}`);

    // --- Inspect the uploaded transcript ---
    const notes = lastComplete?.narration?.notes ?? [];
    assert.ok(notes.length > 0, "the complete payload carries the recorded marks");

    // The verification scorecard leads the transcript (2 assertions: 1/1).
    assert.match(notes[0].text, /^\[verification\]/, "the [verification] note leads the transcript");
    assert.ok(
      noteText(notes, "2 assertion(s): 1 passed, 1 failed"),
      `expected a 2/1-passed verification note; got ${JSON.stringify(notes.map((n) => n.text))}`,
    );

    // (b) plain mark present.
    assert.ok(noteText(notes, "note one plain"), "plain mark is in the transcript");

    // (c) annotations: pass carries [assert ✓ …], fail carries [ASSERT ✗ …].
    const passNote = noteText(notes, "hello shows");
    assert.ok(passNote && passNote.text.includes("[assert ✓"), `pass mark should be ✓-annotated: ${passNote?.text}`);
    const failNote = noteText(notes, "missing thing");
    assert.ok(failNote && failNote.text.includes("[ASSERT ✗"), `fail mark should be ✗-annotated: ${failNote?.text}`);

    // (d) chapter stored in canonical form.
    assert.ok(noteText(notes, "=== CHAPTER: AFTER ==="), "chapter stored as '=== CHAPTER: AFTER ==='");

    // (e) the --ago mark is backdated before the live reference mark.
    const refNote = noteText(notes, "reference-live");
    const backNote = noteText(notes, "way-back");
    assert.ok(refNote && backNote, "both the reference and backdated marks are present");
    assert.ok(
      backNote.startMs < refNote.startMs,
      `--ago should backdate: way-back(${backNote.startMs}ms) must precede reference-live(${refNote.startMs}ms)`,
    );
  } finally {
    await runCli(["session", "abort"], ws).catch(() => {});
  }
});

// --- session run: exit 0 uploads, non-zero aborts + propagates --------------

await test("session run -- <cmd exit 0> uploads (complete called)", async () => {
  const ws = freshWorkspace();
  const before = completeCalls;
  try {
    const r = await runCli(
      ["session", "run", "--url", appBase, "--max", "30", "--", process.execPath, "-e", "process.exit(0)"],
      ws,
    );
    assert.equal(r.code, 0, `session run (exit 0) should exit 0; got ${r.code}: ${r.stderr}`);
    assert.ok(completeCalls > before, "a clean child exit uploads the recording (complete called)");
  } finally {
    await runCli(["session", "abort"], ws).catch(() => {});
  }
});

await test("session run -- <cmd exit 3> aborts with exit 3 and no upload", async () => {
  const ws = freshWorkspace();
  const before = completeCalls;
  try {
    const r = await runCli(
      ["session", "run", "--url", appBase, "--max", "30", "--", process.execPath, "-e", "process.exit(3)"],
      ws,
    );
    assert.equal(r.code, 3, `a non-zero child exit must propagate (expected 3, got ${r.code}): ${r.stderr}`);
    assert.equal(completeCalls, before, "an aborted session must NOT upload (no complete call)");
  } finally {
    await runCli(["session", "abort"], ws).catch(() => {});
  }
});

// --- playwright-path --------------------------------------------------------

await test("playwright-path prints a node_modules path and exits 0", async () => {
  const r = await runCli(["playwright-path"], { env: { NODE_PATH, NO_COLOR: "1" } });
  assert.equal(r.code, 0, `playwright-path should exit 0; got ${r.code}: ${r.stderr}`);
  assert.match(r.stdout.trim(), /node_modules/, "it prints the resolving node_modules directory");
});

// --- Flag guards (usage errors, no session needed) --------------------------

await test("mark --assert-text without --assert-selector is a usage error (exit 2)", async () => {
  const ws = freshWorkspace();
  const r = await runCli(["mark", "claim", "--assert-text", "Active"], ws);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /--assert-text needs --assert-selector/);
});

await test("mark --at with --ago is a usage error (exit 2)", async () => {
  const ws = freshWorkspace();
  const r = await runCli(["mark", "claim", "--at", "2", "--ago", "3"], ws);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /--at and --ago are mutually exclusive/);
});

appServer.close();
ingestServer.close();
if (failures > 0) {
  console.error(`\n${failures} session-control test(s) failed`);
  process.exit(1);
}
console.log("\nall session-control tests passed");
