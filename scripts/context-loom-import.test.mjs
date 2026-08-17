#!/usr/bin/env node
/**
 * `clipy context import <loom-url>` end to end, against a throwaway local
 * server that plays BOTH Loom (CLIPY_LOOM_ORIGIN) and the Clipy API
 * (CLIPY_API_URL). Never touches loom.com and never touches prod.
 *
 * The load-bearing assertion is the one that looks like an absence: yt-dlp is
 * stubbed onto PATH and logs every invocation, so "a Loom transcript needs no
 * yt-dlp" is proved by an empty log rather than asserted in a comment.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");

const dir = mkdtempSync(join(tmpdir(), "clipy-loom-import-"));
const home = join(dir, "home");
const binDir = join(dir, "bin");
mkdirSync(home);
mkdirSync(binDir);

// yt-dlp stub: records that it was called at all. A Loom transcript must never
// reach it.
const argvLog = join(dir, "yt-dlp-argv.log");
writeFileSync(
  join(binDir, "yt-dlp"),
  `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stderr.write("stub yt-dlp: unexpected call\\n");
process.exit(1);
`,
);
chmodSync(join(binDir, "yt-dlp"), 0o755);
writeFileSync(join(binDir, "package.json"), '{"type":"module"}\n');

const ID = "8961c11d90fd42d6a8d1bacc71834c90";
const SHARE_URL = `https://www.loom.com/share/${ID}`;

const VTT =
  "WEBVTT\n\n1\n00:00:00.060 --> 00:00:04.605\n<v 0>first we open the dashboard</v>\n\n" +
  "2\n00:00:04.605 --> 00:00:09.000\nthen you click this button right here\n";

/**
 * One server standing in for Loom and Clipy at once.
 * `plan` decides what Loom answers, so each scenario is one object literal.
 */
function startServer(plan) {
  const seen = { create: null, transcriptHits: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      // Plans are written before the port is known, so a `SELF:` prefix stands
      // in for "this server".
      const self = `http://127.0.0.1:${server.address().port}`;
      const resolve = (spec) =>
        Object.fromEntries(
          Object.entries(spec ?? {}).map(([k, v]) => [
            k,
            typeof v === "string" ? v.replace(/^SELF:/, self) : v,
          ]),
        );

      // --- Loom ---------------------------------------------------------
      if (req.url === "/graphql") {
        const parsed = JSON.parse(body);
        if (plan.loomStatus) {
          res.writeHead(plan.loomStatus).end("nope");
          return;
        }
        if (parsed.operationName === "GetVideoSource") {
          json(200, { data: { getVideo: plan.video } });
          return;
        }
        if (parsed.operationName === "FetchVideoTranscript") {
          json(200, { data: { fetchVideoTranscript: plan.transcript ? resolve(plan.transcript) : plan.transcript } });
          return;
        }
        json(200, { data: {} });
        return;
      }
      if (req.url?.startsWith("/captions")) {
        seen.transcriptHits.push(req.url);
        res.writeHead(200, { "content-type": "text/vtt" }).end(VTT);
        return;
      }
      if (req.url?.startsWith("/phrases")) {
        seen.transcriptHits.push(req.url);
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ phrases: [{ ts: 0.06, value: "first we open the dashboard" }, { ts: 4.605, value: "then you click this button right here" }] }));
        return;
      }

      // --- Clipy --------------------------------------------------------
      if (req.url === "/api/v1/context-documents") {
        seen.create = JSON.parse(body);
        json(201, { id: "ctx_1", publicId: "loom01", created: true, classification: null });
        return;
      }
      res.writeHead(404).end("{}");
    });
  });
  return { server, seen };
}

function runCli(port, extraArgs = []) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, "context", "import", SHARE_URL, "--output", dir, "--json", ...extraArgs], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${binDir}:${process.env.PATH}`,
        CLIPY_API_KEY: "test-key",
        CLIPY_API_URL: `http://127.0.0.1:${port}`,
        CLIPY_LOOM_ORIGIN: `http://127.0.0.1:${port}`,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

async function scenario(plan, extraArgs = []) {
  const { server, seen } = startServer(plan);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const run = await runCli(port, extraArgs);
    return { run, seen, envelope: JSON.parse(run.stdout) };
  } finally {
    server.close();
  }
}

const OK_VIDEO = {
  __typename: "RegularUserVideo",
  id: ID,
  name: "Resetting multiple inputs",
  createdAt: "2024-05-14T23:57:02.479Z",
  video_properties: { duration: 178, width: 1664, height: 1080 },
};

function bundleFilesFor() {
  return readdirSync(dir).filter((f) => f.startsWith("clipy-context-"));
}

// ---------------------------------------------------------------------------
// 1. The happy path: WebVTT captions, synced.
// ---------------------------------------------------------------------------
{
  const { run, seen, envelope } = await scenario(
    { video: OK_VIDEO, transcript: { __typename: "VideoTranscriptDetails", captions_source_url: "SELF:/captions.vtt", source_url: "SELF:/phrases.json", language: "en" } },
    ["--sync"],
  );
  assert.equal(run.status, 0, `import failed: ${run.stderr}`);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.synced, true);

  const manifest = seen.create.manifest;
  assert.deepEqual(manifest.source, {
    kind: "loom",
    // Provenance names the real place, never the test origin.
    canonicalUrl: SHARE_URL,
    providerId: ID,
  });
  assert.equal(manifest.durationMs, 178_000);
  assert.equal(manifest.title, "Resetting multiple inputs");
  assert.equal(manifest.profile, "transcript");
  // Loom's transcript is machine ASR; calling it creator-provided would
  // overstate its fidelity to every agent that reads the manifest.
  assert.equal(manifest.transcript.source, "auto_captions");
  assert.equal(manifest.language, "en");
  assert.ok(manifest.sufficiency, "the deterministic classifier must still run");

  // Real cue boundaries, and the `<v 0>` voice tag stripped.
  assert.deepEqual(seen.create.transcript.segments[0], {
    startMs: 60,
    endMs: 4605,
    text: "first we open the dashboard",
  });

  // The bundle is the same shape as every other one, warning and all.
  const bundle = join(dir, bundleFilesFor().at(-1));
  const md = readFileSync(join(bundle, "recording.arec"), "utf8");
  assert.match(md, /NOTE FOR AI AGENTS/, "the untrusted-content warning must be present");
  assert.match(md, /- Source: loom/);
  assert.match(md, /\[00:00\] first we open the dashboard/);
  for (const file of ["recording.arec", "recording.md", "manifest.json", "transcript.json"]) {
    assert.ok(existsSync(join(bundle, file)), `missing ${file}`);
  }
  assert.equal(
    readFileSync(join(bundle, "recording.arec"), "utf8"),
    readFileSync(join(bundle, "recording.md"), "utf8"),
    "the legacy recording.md copy must remain byte-identical",
  );

  // Captions were preferred over the phrase JSON, and only one was fetched.
  assert.deepEqual(seen.transcriptHits, ["/captions.vtt"]);
  // The headline claim: no yt-dlp, at all.
  assert.equal(existsSync(argvLog), false, `yt-dlp was invoked: ${existsSync(argvLog) ? readFileSync(argvLog, "utf8") : ""}`);
}

// ---------------------------------------------------------------------------
// 2. Reruns are idempotent — same bundle, no second document shape.
// ---------------------------------------------------------------------------
{
  const before = bundleFilesFor();
  const { run, envelope } = await scenario({
    video: OK_VIDEO,
    transcript: { __typename: "VideoTranscriptDetails", captions_source_url: "SELF:/captions.vtt", language: "en" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(bundleFilesFor(), before, "a rerun must not create a second bundle");
  assert.equal(envelope.bundlePath, join(dir, before.at(-1)));
}

// ---------------------------------------------------------------------------
// 3. No captions URL → the phrase JSON carries it.
// ---------------------------------------------------------------------------
{
  const { run, seen } = await scenario(
    { video: OK_VIDEO, transcript: { __typename: "VideoTranscriptDetails", source_url: "SELF:/phrases.json" } },
    ["--sync"],
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(seen.transcriptHits, ["/phrases.json"]);
  const segments = seen.create.transcript.segments;
  assert.equal(segments[0].text, "first we open the dashboard");
  // A phrase runs until the next starts; the last runs to the end of the video.
  assert.equal(segments[0].endMs, 4605);
  assert.equal(segments[1].endMs, 178_000);
}

// ---------------------------------------------------------------------------
// 4. The ~16% with no transcript: refuse, never an empty-looking success.
// ---------------------------------------------------------------------------
{
  const before = bundleFilesFor();
  const { run, envelope } = await scenario({ video: OK_VIDEO, transcript: { __typename: "InvalidRequestWarning" } });
  assert.equal(run.status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, "no_captions");
  assert.match(envelope.remediation, /--transcript/);
  assert.deepEqual(bundleFilesFor(), before, "a transcript-less Loom must not leave a bundle behind");
}

// ---------------------------------------------------------------------------
// 5. Private, password-protected, deleted, and unreachable are four answers.
// ---------------------------------------------------------------------------
{
  const cases = [
    [{ video: { __typename: "PrivateVideo" } }, "source_private", false],
    [{ video: { __typename: "VideoPasswordMissingOrIncorrect" } }, "source_private", false],
    [{ video: null }, "invalid_url", false],
    [{ loomStatus: 503 }, "loom_unreachable", true],
  ];
  for (const [plan, code, retryable] of cases) {
    const { run, envelope } = await scenario(plan);
    assert.equal(run.status, 1, `${code} should exit 1`);
    assert.equal(envelope.code, code, `expected ${code}, got ${envelope.code}: ${envelope.error}`);
    assert.ok(envelope.remediation, "every failure carries a next action");
    // A retryable code says "run it again"; a fatal one must not.
    assert.equal(/re-run the same command|Re-run the same command/i.test(envelope.remediation), retryable, `${code} remediation retry advice is wrong: ${envelope.remediation}`);
  }
}

// ---------------------------------------------------------------------------
// 6. --transcript overrides the provider, exactly as it does for YouTube.
// ---------------------------------------------------------------------------
{
  const mine = join(dir, "mine.vtt");
  writeFileSync(mine, "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHand written line one.\n");
  const { run, seen } = await scenario(
    { video: OK_VIDEO, transcript: { __typename: "VideoTranscriptDetails", captions_source_url: "SELF:/captions.vtt" } },
    ["--sync", "--transcript", mine],
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(seen.transcriptHits, [], "Loom's own transcript must not be fetched when one was supplied");
  assert.equal(seen.create.manifest.transcript.source, "user_file");
  assert.equal(seen.create.transcript.segments[0].text, "Hand written line one.");
}

// ---------------------------------------------------------------------------
// 7. The GraphQL answer is the one thing an attacker controls, so a transcript
//    location pointing off the answering host is refused rather than fetched.
// ---------------------------------------------------------------------------
{
  const { run, envelope } = await scenario({
    video: OK_VIDEO,
    transcript: { __typename: "VideoTranscriptDetails", captions_source_url: "http://169.254.169.254/latest/meta-data/" },
  });
  assert.equal(run.status, 1);
  assert.equal(envelope.code, "loom_unreachable");
  assert.match(envelope.error, /off its own CDN/);
}

// ---------------------------------------------------------------------------
// 8. Both new codes are published in the guide, with honest retry advice — the
//    table is what an agent branches on, so a code missing from it is a bug.
// ---------------------------------------------------------------------------
{
  const guide = JSON.parse(
    await new Promise((done) => {
      const child = spawn(process.execPath, [cli, "guide", "--json"], { env: { ...process.env, HOME: home } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => done(out));
    }),
  );
  const byCode = Object.fromEntries(guide.errorCodes.map((e) => [e.code, e]));
  assert.equal(byCode.loom_unreachable.retryable, true);
  assert.equal(byCode.source_private.retryable, false);
  assert.match(byCode.no_captions.meaning, /Loom/);
  assert.match(guide.commands.find((c) => c.name === "context import").usage, /loom-url/);
}

rmSync(dir, { recursive: true, force: true });
console.log("context-loom-import: ok");
