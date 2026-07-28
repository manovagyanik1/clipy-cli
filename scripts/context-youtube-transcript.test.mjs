#!/usr/bin/env node
/**
 * `--transcript` on a YouTube URL must use the file and never touch YouTube's
 * captions. yt-dlp is stubbed on PATH (with HOME pointed at a scratch dir so
 * the managed ~/.clipy/bin copy can't win the lookup), and it records every
 * invocation — so "captions were not fetched" is an assertion, not a hope.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");

const dir = mkdtempSync(join(tmpdir(), "clipy-yt-transcript-"));
const home = join(dir, "home");
const binDir = join(dir, "bin");
mkdirSync(home);
mkdirSync(binDir);

const argvLog = join(dir, "yt-dlp-argv.log");
const META = { id: "dQw4w9WgXcQ", title: "A caption-less video", duration: 12, subtitles: {}, automatic_captions: {} };

const stub = join(binDir, "yt-dlp");
writeFileSync(
  stub,
  `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("-J")) {
  const meta = ${JSON.stringify(JSON.stringify(META))};
  const parsed = JSON.parse(meta);
  if (process.env.CLIPY_STUB_DURATION !== undefined) parsed.duration = Number(process.env.CLIPY_STUB_DURATION);
  process.stdout.write(JSON.stringify(parsed));
  process.exit(0);
}
process.stderr.write("stub yt-dlp: unexpected call\\n");
process.exit(1);
`,
);
chmodSync(stub, 0o755);
// .mjs shim so the stub runs as ESM regardless of the ambient package.json.
writeFileSync(join(binDir, "package.json"), '{"type":"module"}\n');

const vtt = join(dir, "mine.vtt");
writeFileSync(
  vtt,
  "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHand written line one.\n\n" +
    "00:00:03.000 --> 00:00:06.000\nHand written line two.\n",
);

const seen = { create: null };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/v1/context-documents") {
      seen.create = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ctx_1", publicId: "yt123", created: true, classification: null }));
      return;
    }
    res.writeHead(404).end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

function runCli(target, extraEnv = {}) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [cli, "context", "import", target, "--transcript", vtt, "--output", dir, "--sync", "--json"],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PATH: `${binDir}:${process.env.PATH}`,
          CLIPY_API_KEY: "test-key",
          CLIPY_API_URL: `http://127.0.0.1:${port}`,
          ...extraEnv,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

// Shell-escaped exactly as zsh delivers it — the CLI must normalise it before
// yt-dlp ever sees it, or yt-dlp silently resolves a placeholder video.
const run = await runCli("https://www.youtube.com/watch\\?v\\=dQw4w9WgXcQ");

assert.equal(run.status, 0, `CLI failed: ${run.stderr}`);

const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(calls.length, 1, `yt-dlp was called ${calls.length}× — metadata only was expected`);
assert.ok(calls[0].includes("-J"), "the one yt-dlp call must be the metadata read");
assert.ok(
  !calls.some((c) => c.includes("--write-subs") || c.includes("--write-auto-subs")),
  "captions were fetched despite --transcript",
);

assert.ok(run.stderr.includes("Using your transcript file (2 segments)"), "the override was not narrated");

const out = JSON.parse(run.stdout);
const manifest = JSON.parse(readFileSync(join(out.bundlePath, "manifest.json"), "utf8"));
assert.equal(manifest.transcript.source, "user_file", "the transcript must be attributed to the user's file");
assert.equal(manifest.source.kind, "youtube", "the source is still the YouTube video");
assert.equal(manifest.source.providerId, "dQw4w9WgXcQ");
assert.equal(manifest.title, "A caption-less video", "YouTube metadata still supplies the title");
assert.equal(manifest.durationMs, 12_000, "YouTube metadata still supplies the duration");

const transcript = JSON.parse(readFileSync(join(out.bundlePath, "transcript.json"), "utf8"));
assert.equal(transcript.segments.length, 2, "the bundle transcript did not come from the file");
assert.match(transcript.segments[0].text, /Hand written line one/);

assert.equal(seen.create.transcript.segments.length, 2, "the uploaded transcript did not come from the file");
assert.equal(seen.create.manifest.transcript.source, "user_file");

// The mangled input must have been rebuilt into the canonical URL.
assert.equal(
  calls[0][calls[0].length - 1],
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "yt-dlp was handed a URL that was not canonicalised",
);
assert.ok(!JSON.stringify(calls).includes("\\"), "a backslash survived into the yt-dlp argv");
assert.equal(manifest.source.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

// A stub/placeholder video reports no duration — refuse rather than compile it.
const zero = await runCli("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { CLIPY_STUB_DURATION: "0" });
assert.notEqual(zero.status, 0, "a zero-duration video must not produce a bundle");
// --json puts the failure on stdout as one envelope, not on stderr.
const zeroBody = JSON.parse(zero.stdout);
assert.equal(zeroBody.ok, false);
assert.equal(zeroBody.code, "invalid_url");
assert.match(zeroBody.error, /could not read this video/, `unexpected failure text: ${zero.stdout}`);

// A URL with no extractable video id fails before yt-dlp is ever spawned.
const callsBefore = readFileSync(argvLog, "utf8").trim().split("\n").length;
const channel = await runCli("https://www.youtube.com/@someChannel");
assert.notEqual(channel.status, 0, "a channel URL must not be importable");
const channelBody = JSON.parse(channel.stdout);
assert.equal(channelBody.code, "invalid_url");
assert.match(channelBody.error, /could not find a video id/, `unexpected failure text: ${channel.stdout}`);
assert.equal(
  readFileSync(argvLog, "utf8").trim().split("\n").length,
  callsBefore,
  "an unparseable URL must not reach yt-dlp at all",
);

server.close();

process.stdout.write("✓ youtube import: --transcript wins over captions, URLs canonicalise, stub/id-less URLs refused\n");
