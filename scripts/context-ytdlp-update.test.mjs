#!/usr/bin/env node
/**
 * The managed yt-dlp refreshes itself when it goes stale — and NEVER touches a
 * yt-dlp the user installed themselves. `-U` on a Homebrew or pipx binary
 * either fails or fights the package manager, and either way it is not ours to
 * modify.
 *
 * Each case runs in its own process because resolveYtDlp memoises its answer.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ytdlpModule = join(here, "..", "dist", "context", "ytdlp.js");
// The stubs carry a `#!/usr/bin/env node` shebang, so node itself must stay
// reachable on PATH even in the cases that are otherwise PATH-empty.
const NODE_DIR = dirname(process.execPath);

const DAY_MS = 24 * 60 * 60 * 1000;

/** A yt-dlp that records every invocation, so "-U was run" is observable. */
function writeStub(path, log) {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`,
  );
  chmodSync(path, 0o755);
}

/** Runs resolveYtDlp in a child with HOME/PATH pinned; returns notify output. */
function resolveIn(home, path, log) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(ytdlpModule)}).then(async (m) => {
           const notes = [];
           const bin = await m.resolveYtDlp((x) => notes.push(x));
           process.stdout.write(JSON.stringify({ bin, notes }));
         });`,
      ],
      { env: { ...process.env, HOME: home, USERPROFILE: home, PATH: path, STUB_LOG: log } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

const calls = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

// --- a stale managed copy updates itself ----------------------------------

{
  const dir = mkdtempSync(join(tmpdir(), "clipy-upd-stale-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".clipy", "bin"), { recursive: true });
  const managed = join(home, ".clipy", "bin", "yt-dlp");
  const log = join(dir, "calls.log");
  writeStub(managed, log);
  const old = new Date(Date.now() - 30 * DAY_MS);
  utimesSync(managed, old, old);

  const res = await resolveIn(home, NODE_DIR, log);
  assert.equal(res.status, 0, res.stderr);
  const { bin, notes } = JSON.parse(res.stdout);
  assert.equal(bin, managed, "the managed copy must be preferred");
  assert.deepEqual(calls(log).map(JSON.parse), [["-U"]], "a 30-day-old managed copy must self-update");
  assert.ok(
    notes.some((n) => /30 days old/.test(n)),
    "the update must be narrated with the actual age",
  );
  assert.ok(
    notes.some((n) => /not a system install/.test(n)),
    "the narration must say whose binary is being touched",
  );
  // The mtime stamp means the next import does not re-check immediately.
  const res2 = await resolveIn(home, NODE_DIR, log);
  assert.equal(JSON.parse(res2.stdout).notes.length, 0, "a freshly checked copy must not re-check");
  assert.equal(calls(log).length, 1, "the update must not run twice in a row");
}

// --- a fresh managed copy is left alone -----------------------------------

{
  const dir = mkdtempSync(join(tmpdir(), "clipy-upd-fresh-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".clipy", "bin"), { recursive: true });
  const managed = join(home, ".clipy", "bin", "yt-dlp");
  const log = join(dir, "calls.log");
  writeStub(managed, log);
  const recent = new Date(Date.now() - 2 * DAY_MS);
  utimesSync(managed, recent, recent);

  const res = await resolveIn(home, NODE_DIR, log);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(calls(log), [], "a 2-day-old copy must not be updated");
  assert.deepEqual(JSON.parse(res.stdout).notes, [], "and must not narrate anything");
}

// --- a PATH-installed yt-dlp is NEVER updated -----------------------------

{
  const dir = mkdtempSync(join(tmpdir(), "clipy-upd-path-"));
  const home = join(dir, "home");
  const binDir = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const onPath = join(binDir, "yt-dlp");
  const log = join(dir, "calls.log");
  writeStub(onPath, log);
  const ancient = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(onPath, ancient, ancient);

  const res = await resolveIn(home, `${binDir}:${NODE_DIR}`, log);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).bin, onPath, "a PATH copy is still used");
  assert.deepEqual(
    calls(log),
    [],
    "a user-installed yt-dlp must NEVER be self-updated, however old it is",
  );
}

process.stdout.write("✓ yt-dlp management: stale managed copy self-updates once; PATH installs are never touched\n");
