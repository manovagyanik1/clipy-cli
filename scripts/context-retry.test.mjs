#!/usr/bin/env node
/**
 * The retry DECISION is the part worth pinning down: which yt-dlp stderr earns
 * another attempt, which earns an escalation, and which must fail immediately.
 * Retrying a private video three times only makes the user wait longer for the
 * same answer — and retrying a bot check actively harms their IP reputation.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { classifyFailure, isRetriable, retryNotice, RETRY_BACKOFF_MS, MAX_ATTEMPTS, TOKEN_FREE_CLIENT_ARGS, PROGRESSIVE_FALLBACK, BASELINE_DOWNLOAD_ARGS, looksLikeStaleBinary } =
  await import(pathToFileURL(join(here, "..", "dist", "context", "retry.js")));

// --- forbidden: retry AND earn the client escalation ----------------------

// The exact line from the owner's failed run.
const OWNER_403 = "ERROR: unable to download video data: HTTP Error 403: Forbidden";
assert.equal(classifyFailure(OWNER_403), "forbidden");
assert.equal(classifyFailure("ERROR: fragment 1 not found, unable to continue\nHTTP Error 403: Forbidden"), "forbidden");
assert.equal(classifyFailure("WARNING: something\nERROR: 403 Forbidden"), "forbidden");

// --- transient: retry, but a different client would not help --------------

for (const stderr of [
  "ERROR: HTTP Error 429: Too Many Requests",
  "ERROR: HTTP Error 500: Internal Server Error",
  "ERROR: HTTP Error 503: Service Unavailable",
  "ERROR: unable to download: The read operation timed out",
  "ERROR: [Errno 54] Connection reset by peer",
  "ERROR: ECONNRESET",
  "ERROR: <urlopen error [Errno 8] nodename nor servname provided> EAI_AGAIN",
  "ERROR: Temporary failure in name resolution",
  "ERROR: Remote end closed connection without response",
]) {
  assert.equal(classifyFailure(stderr), "transient", `should be transient: ${stderr}`);
}

// --- fatal: the video is what it is ---------------------------------------

for (const stderr of [
  "ERROR: Video unavailable. This video is private",
  "ERROR: Join this channel to get access to members-only content",
  "ERROR: Sign in to confirm your age. This video may be inappropriate for some users.",
  "ERROR: HTTP Error 404: Not Found",
  "ERROR: This video is not available in your country",
  "ERROR: Requested format is not available",
  "exit 1",
  "",
]) {
  assert.equal(classifyFailure(stderr), "fatal", `should be fatal: ${stderr}`);
}

// --- the retry gate --------------------------------------------------------

assert.equal(isRetriable("forbidden"), true);
assert.equal(isRetriable("transient"), true);
assert.equal(isRetriable("fatal"), false, "a fatal failure must not be retried");

// A bot check or an unavailable video wearing a 403 mask is still fatal: the
// fatal markers are checked BEFORE the 403 test, because retrying a bot check
// burns the user's IP reputation for nothing.
assert.equal(classifyFailure("ERROR: Video unavailable\nHTTP Error 403: Forbidden"), "fatal");
assert.equal(
  classifyFailure("ERROR: Sign in to confirm you're not a bot. HTTP Error 403: Forbidden"),
  "fatal",
);

// --- narration -------------------------------------------------------------

assert.equal(
  retryNotice(OWNER_403, "forbidden", 2, 3),
  "Download blocked (HTTP 403) — retrying (2/3)…",
  "the 403 notice must name the cause and the attempt count",
);
assert.match(retryNotice("ERROR: HTTP Error 500: Internal Server Error", "transient", 3, 3), /^Download failed \(HTTP Error 500/);
assert.ok(
  !retryNotice("ERROR: HTTP Error 500: boom", "transient", 2, 3).includes("ERROR:"),
  "the raw ERROR: prefix is noise in a user-facing line",
);

// --- the shape the retry loop depends on ----------------------------------

assert.equal(MAX_ATTEMPTS, 3);
assert.deepEqual(RETRY_BACKOFF_MS, [3000, 8000], "backoff must cover the gaps between 3 attempts");
assert.equal(RETRY_BACKOFF_MS.length, MAX_ATTEMPTS - 1);

// The client ladder must stay token-free. `android` and `ios` are PO-token
// gated and are NOT in yt-dlp's defaults, so falling back to them moves away
// from the token-free clients rather than toward them.
const clientArg = TOKEN_FREE_CLIENT_ARGS[TOKEN_FREE_CLIENT_ARGS.indexOf("--extractor-args") + 1];
assert.match(clientArg, /^youtube:player_client=/);
const clients = clientArg.split("=")[1].split(",");
assert.deepEqual(clients, ["tv", "android_vr", "web_embedded"]);
for (const gated of ["android", "ios", "web_safari", "mweb"]) {
  assert.ok(!clients.includes(gated), `${gated} needs a PO token — it must not be in the fallback ladder`);
}
assert.match(PROGRESSIVE_FALLBACK.format, /18/, "the progressive fallback must accept format 18");

// Concurrency stays at 1: raising it is the fastest way to get an IP throttled.
assert.equal(BASELINE_DOWNLOAD_ARGS[BASELINE_DOWNLOAD_ARGS.indexOf("--concurrent-fragments") + 1], "1");
assert.ok(BASELINE_DOWNLOAD_ARGS.includes("--extractor-retries"), "yt-dlp should retry in-process too");

// --- stale binary vs transient 403 ---------------------------------------

// An out-of-date yt-dlp fails during EXTRACTION; a transient 403 fails
// mid-transfer with formats already resolved. Only the first is fixed by
// updating, so only the first should suggest it.
for (const stderr of [
  "ERROR: unable to extract player response",
  "WARNING: Only images are available for download",
  "ERROR: Signature extraction failed: Some formats may be missing",
  "WARNING: n challenge solving failed",
  "WARNING: YouTube is forcing SABR streaming for this client",
]) {
  assert.equal(looksLikeStaleBinary(stderr), true, `should read as a stale binary: ${stderr}`);
}
for (const stderr of [
  "ERROR: unable to download video data: HTTP Error 403: Forbidden",
  "ERROR: HTTP Error 429: Too Many Requests",
  "ERROR: Video unavailable. This video is private",
]) {
  assert.equal(looksLikeStaleBinary(stderr), false, `should NOT blame the binary: ${stderr}`);
}

// --- the loop itself, against a stub yt-dlp -------------------------------

const { borrowYoutubeVideo } = await import(
  pathToFileURL(join(here, "..", "dist", "context", "videoFetch.js"))
);

const dir = mkdtempSync(join(tmpdir(), "clipy-retry-"));

/**
 * A stub that fails `failures` times before writing a file, so the loop's
 * behaviour is observable without a network. It counts its own invocations in
 * a sidecar file because each call is a fresh process.
 */
function makeStub(name, script) {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

// CommonJS on purpose: the stub has no extension, so node loads it as CJS.
const COUNTER = `
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const log = process.env.STUB_LOG;
appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const calls = readFileSync(log, "utf8").trim().split("\\n").length;
const outIdx = process.argv.indexOf("-o");
const out = process.argv[outIdx + 1].replace("%(ext)s", "mp4");
`;

const notes = [];
const notify = (m) => notes.push(m);

// 403 twice, then success — exactly the owner's "succeeds on retry" case.
const flaky = makeStub(
  "yt-dlp-flaky",
  `${COUNTER}
if (calls <= 2) { process.stderr.write("ERROR: unable to download video data: HTTP Error 403: Forbidden\\n"); process.exit(1); }
writeFileSync(out, "x".repeat(2048));
`,
);
const flakyLog = join(dir, "flaky.log");
writeFileSync(flakyLog, "");
process.env.STUB_LOG = flakyLog;
const borrowed = await borrowYoutubeVideo({
  ytDlpBin: flaky, url: "https://www.youtube.com/watch?v=77FB-LS0Bjk", durationMs: 60_000, notify,
});
assert.ok(existsSync(borrowed.path), "a transient 403 must not lose the download");
assert.equal(readFileSync(flakyLog, "utf8").trim().split("\n").length, 3, "expected 3 attempts");
assert.deepEqual(
  notes.filter((n) => n.includes("retrying")),
  ["Download blocked (HTTP 403) — retrying (2/3)…", "Download blocked (HTTP 403) — retrying (3/3)…"],
  "both retries must be narrated",
);
borrowed.release();
assert.ok(!existsSync(borrowed.path), "the borrowed copy must still be deleted on release");

// A private video must fail on the FIRST attempt.
const privateStub = makeStub(
  "yt-dlp-private",
  `${COUNTER}
process.stderr.write("ERROR: Video unavailable. This video is private\\n");
process.exit(1);
`,
);
const privateLog = join(dir, "private.log");
writeFileSync(privateLog, "");
process.env.STUB_LOG = privateLog;
await assert.rejects(
  borrowYoutubeVideo({ ytDlpBin: privateStub, url: "https://www.youtube.com/watch?v=x", durationMs: 60_000, notify: () => {} }),
  /private/,
);
assert.equal(
  readFileSync(privateLog, "utf8").trim().split("\n").length,
  1,
  "a fatal failure must not be retried",
);

// A 403 that never clears: 3 normal attempts, then the two escalation rungs.
const blocked = makeStub(
  "yt-dlp-blocked",
  `${COUNTER}
process.stderr.write("ERROR: unable to download video data: HTTP Error 403: Forbidden\\n");
process.exit(1);
`,
);
const blockedLog = join(dir, "blocked.log");
writeFileSync(blockedLog, "");
process.env.STUB_LOG = blockedLog;
const blockedNotes = [];
await assert.rejects(
  borrowYoutubeVideo({
    ytDlpBin: blocked, url: "https://www.youtube.com/watch?v=x", durationMs: 60_000,
    notify: (m) => blockedNotes.push(m),
  }),
  /403/,
);
const blockedCalls = readFileSync(blockedLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(blockedCalls.length, MAX_ATTEMPTS + 2, "a persistent 403 earns both escalation rungs");

const clientOf = (call) => {
  const i = call.indexOf("--extractor-args");
  return i === -1 ? null : call[i + 1];
};
for (const call of blockedCalls.slice(0, MAX_ATTEMPTS)) {
  assert.equal(clientOf(call), null, "the first attempts must use yt-dlp's own default clients");
}
assert.equal(clientOf(blockedCalls[MAX_ATTEMPTS]), "youtube:player_client=tv,android_vr,web_embedded");
assert.equal(clientOf(blockedCalls[MAX_ATTEMPTS + 1]), "youtube:player_client=tv,android_vr");
assert.equal(
  blockedCalls[MAX_ATTEMPTS + 1][blockedCalls[MAX_ATTEMPTS + 1].indexOf("-f") + 1],
  PROGRESSIVE_FALLBACK.format,
  "the last rung must relax the format selection, not just the client",
);
// Every attempt carries the baseline hardening.
for (const call of blockedCalls) {
  assert.ok(call.includes("--extractor-retries"), "baseline retry args missing from an attempt");
  assert.equal(call[call.indexOf("--concurrent-fragments") + 1], "1");
}
assert.ok(
  blockedNotes.some((n) => n.includes("token-free player clients")),
  "the client escalation must be narrated",
);
assert.ok(
  blockedNotes.some((n) => n.includes("progressive format")),
  "the progressive fallback must be narrated",
);

// The escalation stops the moment a different client gives a fatal answer.
const fatalOnEscalation = makeStub(
  "yt-dlp-fatal-esc",
  `${COUNTER}
if (process.argv.includes("--extractor-args")) {
  process.stderr.write("ERROR: Video unavailable. This video is private\\n");
} else {
  process.stderr.write("ERROR: HTTP Error 403: Forbidden\\n");
}
process.exit(1);
`,
);
const escLog = join(dir, "esc.log");
writeFileSync(escLog, "");
process.env.STUB_LOG = escLog;
await assert.rejects(
  borrowYoutubeVideo({ ytDlpBin: fatalOnEscalation, url: "https://www.youtube.com/watch?v=x", durationMs: 60_000, notify: () => {} }),
  /private/,
);
assert.equal(
  readFileSync(escLog, "utf8").trim().split("\n").length,
  MAX_ATTEMPTS + 1,
  "a fatal answer from the first escalation must stop the ladder",
);

rmSync(dir, { recursive: true, force: true });

process.stdout.write("✓ download retry ladder: 403 → 3 retries → token-free clients → progressive; fatal stops at once\n");
