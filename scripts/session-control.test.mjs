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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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

/** The single session state file this workspace's daemon wrote (path + parsed). */
function sessionFileOf(configHome) {
  const dir = join(configHome, "clipy", "sessions");
  const file = readdirSync(dir).find((n) => n.startsWith("session-") && n.endsWith(".json"));
  if (!file) throw new Error(`no session state file under ${dir}`);
  return join(dir, file);
}
function readSessionState(configHome) {
  return JSON.parse(readFileSync(sessionFileOf(configHome), "utf8"));
}

// Resolve the GLOBAL Playwright (same copy the CLI daemon uses) for the CDP test.
const globalRequire = createRequire(join(NODE_PATH || tmpdir(), "clipy-noop.cjs"));

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

// --- NEW-1: session resolution via CLIPY_SESSION_FILE from a foreign cwd -----

await test("mark resolves the session via CLIPY_SESSION_FILE from a different cwd", async () => {
  const ws = freshWorkspace();
  const otherCwd = mkdtempSync(join(tmpdir(), "clipy-ctl-other-"));
  try {
    const start = await runCli(["session", "start", "--url", appBase, "--max", "30"], ws);
    assert.equal(start.code, 0, `session start failed (${start.code}): ${start.stderr}`);
    const sessFile = sessionFileOf(ws.configHome);

    // From a different cwd, WITHOUT the env var: the cwd hash misses ⇒ no session.
    const noEnv = await runCli(["mark", "from elsewhere"], { cwd: otherCwd, env: ws.env });
    assert.equal(noEnv.code, 1, `expected exit 1 without CLIPY_SESSION_FILE, got ${noEnv.code}`);
    assert.match(noEnv.stderr, /no recording session/);

    // WITH CLIPY_SESSION_FILE: it resolves the session even from the foreign cwd.
    const withEnv = await runCli(["mark", "resolved by env"], {
      cwd: otherCwd,
      env: { ...ws.env, CLIPY_SESSION_FILE: sessFile },
    });
    assert.equal(withEnv.code, 0, `env-resolved mark failed (${withEnv.code}): ${withEnv.stderr}`);
    assert.match(withEnv.stdout, /✓ mark @/);
  } finally {
    await runCli(["session", "abort"], ws).catch(() => {});
  }
});

// --- NEW-4: in-page __clipyMark assertions over CDP -------------------------

await test("in-page __clipyMark(text, opts) evaluates assertions daemon-side (✓/✗) + rejects bad opts", async () => {
  const ws = freshWorkspace();
  lastComplete = null;
  let cdpBrowser = null;
  try {
    const start = await runCli(["session", "start", "--url", appBase, "--max", "30", "--expose-cdp", "--json"], ws);
    assert.equal(start.code, 0, `session start --expose-cdp failed (${start.code}): ${start.stderr}`);
    const cdpHttpUrl = JSON.parse(start.stdout).cdpHttpUrl;
    assert.ok(cdpHttpUrl, `expected a cdpHttpUrl in start --json; got ${start.stdout}`);

    const { chromium } = globalRequire("playwright");
    cdpBrowser = await chromium.connectOverCDP(cdpHttpUrl);
    const page = cdpBrowser.contexts()[0].pages()[0];

    // The bindings report declared arity (2 / 1) so an agent probing the bridge
    // sees the real signature, not the 0 an exposeBinding wrapper reports.
    const markArity = await page.evaluate(() => window.__clipyMark.length);
    assert.equal(markArity, 2, `window.__clipyMark.length should be 2, got ${markArity}`);
    const chapterArity = await page.evaluate(() => window.__clipyChapter.length);
    assert.equal(chapterArity, 1, `window.__clipyChapter.length should be 1, got ${chapterArity}`);

    // Passing assertion (#t contains Hello) → ✓-annotated, returned to the driver.
    const passRes = await page.evaluate(() =>
      window.__clipyMark("in-page hello", { assertSelector: "#t", assertText: "Hello" }),
    );
    assert.ok(passRes && passRes.text.includes("[assert ✓"), `in-page pass should be ✓: ${JSON.stringify(passRes)}`);

    // Failing assertion (#nope missing) → ✗-annotated (warn: session continues).
    const failRes = await page.evaluate(() => window.__clipyMark("in-page missing", { assertSelector: "#nope" }));
    assert.ok(failRes && failRes.text.includes("[ASSERT ✗"), `in-page fail should be ✗: ${JSON.stringify(failRes)}`);

    // assertText without assertSelector rejects (the driver sees the misuse).
    let threw = false;
    try {
      await page.evaluate(() => window.__clipyMark("bad opts", { assertText: "x" }));
    } catch {
      threw = true;
    }
    assert.ok(threw, "assertText without assertSelector must reject to the driver");

    await cdpBrowser.close(); // detach — the recording keeps going
    cdpBrowser = null;

    const stop = await runCli(["session", "stop", "--json"], ws);
    assert.equal(stop.code, 0, `session stop failed (${stop.code}): ${stop.stderr}`);

    const notes = lastComplete?.narration?.notes ?? [];
    assert.ok(noteText(notes, "in-page hello") && noteText(notes, "in-page hello").text.includes("[assert ✓"), "in-page pass in transcript");
    assert.ok(noteText(notes, "in-page missing") && noteText(notes, "in-page missing").text.includes("[ASSERT ✗"), "in-page fail in transcript");
    assert.match(notes[0].text, /^\[verification\] 2 assertion\(s\): 1 passed, 1 failed$/, `verification leads: ${notes[0]?.text}`);
  } finally {
    if (cdpBrowser) await cdpBrowser.close().catch(() => {});
    await runCli(["session", "abort"], ws).catch(() => {});
  }
});

// --- P0: a mark NEVER drops -------------------------------------------------

// (1) Genuinely-unreachable control endpoint → the asserted mark is recorded
// with a ⚠ UNVERIFIED tag (never a silent pass) and lands in the K tally bucket.
// Simulated by pointing the client at a closed port (deterministic ECONNREFUSED);
// the daemon never sees the mark, so nothing dedups it away.
await test("unreachable control endpoint → asserted mark recorded ⚠ UNVERIFIED + K tally bucket", async () => {
  const ws = freshWorkspace();
  lastComplete = null;
  try {
    const start = await runCli(["session", "start", "--url", appBase, "--max", "60"], ws);
    assert.equal(start.code, 0, `session start failed (${start.code}): ${start.stderr}`);

    const sessFile = sessionFileOf(ws.configHome);
    const st = JSON.parse(readFileSync(sessFile, "utf8"));
    const deadPort = await new Promise((res) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => res(p));
      });
    });
    // The daemon keeps its real port in memory; only the client reads this field,
    // and `session stop` uses the control FILE, so this doesn't break stop.
    writeFileSync(sessFile, JSON.stringify({ ...st, controlPort: deadPort }));

    const m = await runCli(["mark", "cannot verify this", "--assert-selector", "#t", "--assert-text", "Hello"], ws);
    assert.equal(m.code, 0, `a mark to an unreachable daemon must still exit 0, got ${m.code}: ${m.stderr}`);
    assert.match(m.stderr, /UNVERIFIED/, `expected a loud ⚠ UNVERIFIED line: ${m.stderr}`);

    const stop = await runCli(["session", "stop", "--json"], ws);
    assert.equal(stop.code, 0, `session stop failed (${stop.code}): ${stop.stderr}`);

    const notes = lastComplete?.narration?.notes ?? [];
    const mark = noteText(notes, "cannot verify this");
    assert.ok(mark, `the un-droppable mark must be in the transcript: ${JSON.stringify(notes.map((n) => n.text))}`);
    assert.ok(mark.text.includes("[ASSERT ⚠"), `the mark must carry the ⚠ unverified tag: ${mark.text}`);
    assert.match(notes[0].text, /^\[verification\].*\bunverified\b/, `tally must show the K bucket: ${notes[0]?.text}`);
  } finally {
    await runCli(["session", "abort"], ws).catch(() => {});
  }
});

// (2) A daemon that STALLS then catches up (kill -STOP / -CONT, the real recompile
// scenario). The client times out and writes a ⚠ mark of record + a plain mark.
// When the daemon resumes and processes both HTTP calls late: the ⚠ is NOT
// overwritten by the late verdict (which judged a later page state) — instead the
// late evaluation is a SEPARATE late-check note at its own time, K still counts the
// ⚠, and the plain mark is deduped to exactly one.
await test("SIGSTOP/SIGCONT: ⚠ is the mark of record; a late eval becomes a separate late-check, plain mark exactly-once", async () => {
  const ws = freshWorkspace();
  lastComplete = null;
  let daemonPid = 0;
  let stopped = false;
  try {
    const start = await runCli(["session", "start", "--url", appBase, "--max", "60"], ws);
    assert.equal(start.code, 0, `session start failed (${start.code}): ${start.stderr}`);
    daemonPid = readSessionState(ws.configHome).pid;
    try {
      process.kill(daemonPid, "SIGSTOP");
      stopped = true;
    } catch (e) {
      console.log(`    (skipping — SIGSTOP unavailable: ${e.message})`);
      return;
    }
    // Freeze → both calls time out on the client and fall back to the file.
    const shortTimeout = { cwd: ws.cwd, env: { ...ws.env, CLIPY_CONTROL_TIMEOUT_MS: "800" } };
    const asserted = await runCli(
      ["mark", "slow assert claim", "--assert-selector", "#t", "--assert-text", "Hello"],
      shortTimeout,
    );
    assert.equal(asserted.code, 0, `a slow asserted mark must exit 0, got ${asserted.code}: ${asserted.stderr}`);
    assert.match(asserted.stderr, /UNVERIFIED/, `client should report ⚠ after the timeout: ${asserted.stderr}`);
    const plain = await runCli(["mark", "slow plain claim"], shortTimeout);
    assert.equal(plain.code, 0, `a slow plain mark must exit 0, got ${plain.code}: ${plain.stderr}`);

    // Resume and give the daemon a moment to process the buffered HTTP requests.
    process.kill(daemonPid, "SIGCONT");
    stopped = false;
    await new Promise((r) => setTimeout(r, 2000));

    const stop = await runCli(["session", "stop", "--json"], ws);
    assert.equal(stop.code, 0, `session stop failed (${stop.code}): ${stop.stderr}`);

    const notes = lastComplete?.narration?.notes ?? [];
    const texts = notes.map((n) => n.text);

    // (a) the ⚠ mark of record survives VERBATIM (exactly one, carrying ⚠).
    const warnHits = notes.filter((n) => n.text.includes("slow assert claim") && n.text.includes("[ASSERT ⚠"));
    assert.equal(warnHits.length, 1, `the ⚠ mark must survive verbatim exactly once: ${JSON.stringify(texts)}`);

    // (b) the late evaluation is a SEPARATE late-check note at a LATER timestamp,
    // referencing the original claim — it must NOT have overwritten the ⚠.
    const late = notes.find((n) => n.text.includes('[late check of "slow assert claim"'));
    assert.ok(late, `a separate late-check note must reference the claim: ${JSON.stringify(texts)}`);
    assert.ok(
      late.startMs > warnHits[0].startMs,
      `the late check (${late.startMs}ms) must be timestamped AFTER the claim (${warnHits[0].startMs}ms)`,
    );
    // and it must not read as a plain verdict on the original mark:
    assert.ok(!warnHits[0].text.includes("[assert ✓") && !warnHits[0].text.includes("[ASSERT ✗"), "the ⚠ mark must not be rewritten into a ✓/✗");

    // (c) the tally counts the ⚠ in K and does NOT count the late eval in P/F.
    assert.match(
      notes[0].text,
      /^\[verification\] 1 assertion\(s\): 0 passed, 0 failed, 1 unverified$/,
      `tally must count the ⚠ in K, not the late eval: ${notes[0]?.text}`,
    );

    // (d) the plain (non-asserted) mark appears EXACTLY once (deduped).
    const plainHits = notes.filter((n) => n.text.includes("slow plain claim"));
    assert.equal(plainHits.length, 1, `the plain mark must appear exactly once: ${JSON.stringify(plainHits.map((h) => h.text))}`);
  } finally {
    if (stopped && daemonPid) {
      try {
        process.kill(daemonPid, "SIGCONT");
      } catch {
        // already gone
      }
    }
    await runCli(["session", "abort"], ws).catch(() => {});
  }
});

// --- Backdated assertion divergence: a --at/--ago verdict describes the LIVE
// page, not the backdated moment. Over the 2s threshold the mark stays where the
// agent put it but gets a disclaimer + signed drift; under it, nothing.
await test("backdated + assertion over 2s gets a divergence disclaimer + signed drift; under 2s does not", async () => {
  const ws = freshWorkspace();
  lastComplete = null;
  try {
    const start = await runCli(["session", "start", "--url", appBase, "--max", "60"], ws);
    assert.equal(start.code, 0, `session start failed (${start.code}): ${start.stderr}`);
    // Let the clock advance so the backdate is a real gap, not clamped to ~0.
    await new Promise((r) => setTimeout(r, 4000));

    // --ago 10 → stamped well in the past, assertion observed now (drift > 2s).
    const far = await runCli(
      ["mark", "backdated far", "--ago", "10", "--assert-selector", "#t", "--assert-text", "Hello", "--json"],
      ws,
    );
    assert.equal(far.code, 0, `backdated asserted mark should exit 0: ${far.stderr}`);
    const farJson = JSON.parse(far.stdout);
    assert.ok(farJson.text.includes("[assert ✓"), `the verdict must stay intact: ${farJson.text}`);
    assert.ok(farJson.text.includes("(assertion observed"), `expected a divergence disclaimer: ${farJson.text}`);
    assert.ok(
      typeof farJson.assert.driftSec === "number" && farJson.assert.driftSec >= 2,
      `expected a signed drift ≥ 2s: ${JSON.stringify(farJson.assert)}`,
    );
    const farStamp = farJson.tMs;

    // --ago 1 → below the 2s threshold, no disclaimer, no drift field.
    const near = await runCli(
      ["mark", "backdated near", "--ago", "1", "--assert-selector", "#t", "--assert-text", "Hello", "--json"],
      ws,
    );
    assert.equal(near.code, 0, `near-backdated mark should exit 0: ${near.stderr}`);
    const nearJson = JSON.parse(near.stdout);
    assert.ok(nearJson.text.includes("[assert ✓"), `verdict intact: ${nearJson.text}`);
    assert.ok(!nearJson.text.includes("(assertion observed"), `no disclaimer under 2s: ${nearJson.text}`);
    assert.ok(nearJson.assert.driftSec === undefined, `no drift field under 2s: ${JSON.stringify(nearJson.assert)}`);

    const stop = await runCli(["session", "stop", "--json"], ws);
    assert.equal(stop.code, 0, `session stop failed (${stop.code}): ${stop.stderr}`);

    const notes = lastComplete?.narration?.notes ?? [];
    const farNote = noteText(notes, "backdated far");
    assert.ok(farNote && farNote.text.includes("(assertion observed"), `the disclaimer must persist in the transcript: ${farNote?.text}`);
    // The mark stays at its backdated position (earlier than the near mark).
    const nearNote = noteText(notes, "backdated near");
    assert.ok(farNote.startMs <= farStamp + 5 && farNote.startMs < nearNote.startMs, `backdated stamp preserved (${farNote?.startMs}ms) and precedes the near mark (${nearNote?.startMs}ms)`);
  } finally {
    await runCli(["session", "abort"], ws).catch(() => {});
  }
});

// --- NEW-2: --user-data-dir persistent profile ------------------------------

await test("record --user-data-dir uses a persistent profile and uploads", async () => {
  const ws = freshWorkspace();
  const profile = mkdtempSync(join(tmpdir(), "clipy-ctl-profile-"));
  const before = completeCalls;
  const r = await runCli(
    ["record", "--url", appBase, "--for", "2", "--user-data-dir", profile, "--json"],
    ws,
  );
  assert.equal(r.code, 0, `record --user-data-dir should exit 0; got ${r.code}: ${r.stderr}`);
  assert.ok(completeCalls > before, "the persistent-profile capture uploaded (complete called)");
});

await test("--user-data-dir + --storage-state is a usage error (exit 2)", async () => {
  const ws = freshWorkspace();
  const profile = mkdtempSync(join(tmpdir(), "clipy-ctl-profile2-"));
  const r = await runCli(
    ["record", "--url", appBase, "--user-data-dir", profile, "--storage-state", join(profile, "auth.json")],
    ws,
  );
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /mutually exclusive/);
});

await test("--user-data-dir on a locked profile (SingletonLock) is refused (exit 2)", async () => {
  const ws = freshWorkspace();
  const profile = mkdtempSync(join(tmpdir(), "clipy-ctl-locked-"));
  writeFileSync(join(profile, "SingletonLock"), ""); // looks like a live Chrome profile
  const r = await runCli(["record", "--url", appBase, "--user-data-dir", profile], ws);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /live\/locked Chrome profile/);
});

appServer.close();
ingestServer.close();
if (failures > 0) {
  console.error(`\n${failures} session-control test(s) failed`);
  process.exit(1);
}
console.log("\nall session-control tests passed");
