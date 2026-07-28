#!/usr/bin/env node
/**
 * The primary operator of this command is an agent, so EVERY outcome — success,
 * failure, and the awkward middle — must be exactly one parseable JSON object on
 * stdout, with a stable code and a remediation the agent can run verbatim.
 *
 * The middle case matters most: a transcript that synced with its frames missing
 * is a usable import. If that exits non-zero, agents throw away a document that
 * is sitting in the user's library.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const dir = mkdtempSync(join(tmpdir(), "clipy-envelope-"));
const home = join(dir, "home");
const binDir = join(dir, "bin");
mkdirSync(home);
mkdirSync(binDir);

// A yt-dlp that reports a real video with zero caption tracks.
const META = { id: "dQw4w9WgXcQ", title: "No captions here", duration: 42, subtitles: {}, automatic_captions: {} };
writeFileSync(
  join(binDir, "yt-dlp"),
  `#!/usr/bin/env node
const meta = ${JSON.stringify(JSON.stringify(META))};
if (process.argv.includes("-J")) { process.stdout.write(meta); process.exit(0); }
process.stderr.write("ERROR: no subtitles\\n");
process.exit(1);
`,
);
chmodSync(join(binDir, "yt-dlp"), 0o755);

const video = join(dir, "clip.mp4");
const made = spawnSync("ffmpeg", [
  "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10",
  "-pix_fmt", "yuv420p", video,
]);
assert.equal(made.status, 0, `could not build the test video: ${made.stderr}`);
const vtt = join(dir, "clip.vtt");
writeFileSync(vtt, "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nClick the button here.\n");

function run(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, "context", "import", ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${binDir}:${process.env.PATH}`, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

/** Every --json run must print exactly one object, whatever happened. */
function soleJson(res) {
  const parsed = JSON.parse(res.stdout);
  assert.equal(typeof parsed, "object");
  return parsed;
}

function assertErrorEnvelope(body, code) {
  assert.equal(body.ok, false, "a failure envelope must carry ok:false");
  assert.equal(body.code, code, `expected code ${code}, got ${body.code}`);
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0, "error must be a human sentence");
  assert.equal(typeof body.remediation, "string");
  assert.ok(body.remediation.length > 0, "remediation must name the next action");
  assert.ok("partial" in body, "partial must be present (null when nothing survived)");
}

// --- no captions -----------------------------------------------------------

const noCaptions = await run(["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "--output", dir, "--json"]);
assert.equal(noCaptions.status, 1, "a failed import exits 1");
const noCapBody = soleJson(noCaptions);
assertErrorEnvelope(noCapBody, "no_captions");
assert.match(noCapBody.remediation, /--transcript/, "the remedy for no captions is supplying one");

// --- invalid url (no video id) ---------------------------------------------

const badUrl = await run(["https://www.youtube.com/@someChannel", "--output", dir, "--json"]);
assert.equal(badUrl.status, 1);
assertErrorEnvelope(soleJson(badUrl), "invalid_url");

// --- missing ffmpeg (PATH stripped) ----------------------------------------

const noFfmpeg = await run([video, "--transcript", vtt, "--output", dir, "--json"], { PATH: binDir });
assert.equal(noFfmpeg.status, 1);
const ffBody = soleJson(noFfmpeg);
assertErrorEnvelope(ffBody, "ffmpeg_missing");
assert.match(
  ffBody.remediation,
  /^(brew install ffmpeg|sudo apt install ffmpeg|winget install Gyan\.FFmpeg)$/,
  "the ffmpeg remedy must be runnable verbatim, nothing else in the string",
);

// --- 401 from the server ---------------------------------------------------

async function withServer(handler, fn) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(server.address().port);
  } finally {
    server.close();
  }
}

const unauthorized = await withServer(
  (_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid api key" }));
  },
  (port) =>
    run([video, "--transcript", vtt, "--output", dir, "--sync", "--json"], {
      CLIPY_API_KEY: "bad-key",
      CLIPY_API_URL: `http://127.0.0.1:${port}`,
    }),
);
assert.equal(unauthorized.status, 1);
const authBody = soleJson(unauthorized);
assertErrorEnvelope(authBody, "auth_required");
assert.equal(authBody.remediation, "clipy login", "the auth remedy must be the literal command");
assert.ok(authBody.partial && authBody.partial.bundlePath, "the local bundle survived and must be reported");

// --- partial success: transcript synced, frames failed ---------------------

// ffmpeg exists (frames can be cut) but the frames upload is refused, which is
// the canonical partial: the document IS in the library.
const partial = await withServer(
  (req, res, body) => {
    if (req.url === "/api/v1/context-documents") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "ctx_1",
          publicId: "xg61vyh0d4dy",
          created: true,
          folderName: "Knowledge Base",
          classification: {
            videoType: "tutorial",
            videoTypeConfidence: 0.9,
            needsVisual: true,
            frameTimestampsMs: [1000],
            moments: [{ tMs: 1000, caption: "the button" }],
          },
        }),
      );
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "frame storage is down" }));
  },
  (port) =>
    run([video, "--transcript", vtt, "--output", dir, "--sync", "--json"], {
      CLIPY_API_KEY: "test-key",
      CLIPY_API_URL: `http://127.0.0.1:${port}`,
    }),
);

assert.equal(partial.status, 0, "a partial success MUST exit 0 — the document exists");
const partialBody = soleJson(partial);
assert.equal(partialBody.ok, true, "partial success is still ok:true");
assert.equal(partialBody.publicId, "xg61vyh0d4dy", "the data that DID succeed must be complete");
assert.ok(partialBody.bundlePath, "the bundle path must survive a partial");
assert.ok(partialBody.contextPath.endsWith("recording.md"), "an agent needs the file, not just the directory");
assert.ok(Array.isArray(partialBody.warnings) && partialBody.warnings.length > 0, "the failure must surface as a warning");
const warning = partialBody.warnings[0];
assert.equal(warning.code, "frames_upload_failed");
assert.ok(warning.error.length > 0 && warning.remediation.length > 0);
assert.match(warning.remediation, /clipy context import/, "the remedy is re-running the same import");

// --- a clean success carries an empty warnings array ----------------------

const clean = await run([video, "--transcript", vtt, "--output", dir, "--json"]);
assert.equal(clean.status, 0);
const cleanBody = soleJson(clean);
assert.equal(cleanBody.ok, true);
assert.deepEqual(cleanBody.warnings, [], "warnings must always be present, empty on a clean run");

// --- the human path always carries the same remediation -------------------

const humanFail = await run(["https://www.youtube.com/@someChannel", "--output", dir]);
assert.equal(humanFail.status, 1);
assert.match(humanFail.stderr, /error:/);
assert.match(humanFail.stderr, /to fix: /, "human failures must state the remedy too");
assert.equal(humanFail.stdout, "", "a failure must not print a partial result to stdout");

// --- the human success leads with the headline ---------------------------

const humanOk = await run([video, "--transcript", vtt, "--output", dir]);
assert.equal(humanOk.status, 0);
assert.match(humanOk.stdout, /Your agent-ready context for "clip\.mp4" is ready\./);
assert.match(humanOk.stdout, /→ local bundle: .*recording\.md/);
assert.match(humanOk.stdout, /clipy context read /);
assert.ok(!humanOk.stdout.includes("in your Clipy library"), "a local-only run must not claim a library entry");
assert.match(humanOk.stdout, /transcript: 1 segments from user_file/, "the detail lines must still follow");

process.stdout.write("✓ json envelope: one object per outcome, stable codes, runnable remediation, partial = exit 0\n");
