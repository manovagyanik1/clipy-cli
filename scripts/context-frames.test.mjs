#!/usr/bin/env node
/**
 * Exercises the TWO-PHASE visual pipeline against a throwaway local server
 * (never prod), using a local-file import so no video is ever downloaded.
 *
 * Phase 1: POST /api/v1/context-documents  → { …, classification }
 * Phase 2: POST /api/v1/context-documents/<id>/frames → { added, total }
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");

const dir = mkdtempSync(join(tmpdir(), "clipy-frames-test-"));
const video = join(dir, "clip.mp4");
const made = spawnSync("ffmpeg", [
  "-v", "error", "-f", "lavfi",
  "-i", "testsrc=duration=5:size=320x240:rate=10",
  "-pix_fmt", "yuv420p", video,
]);
assert.equal(made.status, 0, `could not build the test video: ${made.stderr}`);

const vtt = join(dir, "clip.vtt");
writeFileSync(
  vtt,
  "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst we open the dashboard.\n\n" +
    "00:00:02.000 --> 00:00:04.000\nThen you click this button right here.\n",
);

const CLASSIFICATION = {
  videoType: "tutorial",
  videoTypeConfidence: 0.92,
  needsVisual: true,
  visualReason: "the speaker points at unnamed UI",
  frameTimestampsMs: [1000, 3000],
  moments: [
    { tMs: 1000, caption: "opens the dashboard" },
    { tMs: 3000, caption: "clicks the highlighted button" },
  ],
  model: "test-planner",
};

/** Runs the CLI against a fresh mock server; returns what the server saw. */
async function run(extraArgs, outDir) {
  const seen = { create: null, frames: null };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (req.url === "/api/v1/context-documents") {
        seen.create = { body: parsed, auth: req.headers.authorization };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ctx_1", publicId: "abc123", created: true, classification: CLASSIFICATION }));
        return;
      }
      if (req.url === "/api/v1/context-documents/ctx_1/frames") {
        seen.frames = { body: parsed, auth: req.headers.authorization };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ added: parsed.frames.length, total: parsed.frames.length }));
        return;
      }
      res.writeHead(404).end("{}");
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // spawn, not spawnSync: the mock server shares this event loop.
  const result = await new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [cli, "context", "import", video, "--transcript", vtt, "--output", outDir, "--sync", "--json", ...extraArgs],
      { env: { ...process.env, CLIPY_API_KEY: "test-key", CLIPY_API_URL: `http://127.0.0.1:${port}` } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
  server.close();
  return { ...result, seen };
}

// --- Phase 1 + Phase 2 -----------------------------------------------------

const full = await run([], dir);
assert.equal(full.status, 0, `CLI failed: ${full.stderr}`);

assert.ok(full.seen.create, "phase 1 never happened");
assert.equal(full.seen.create.body.manifest.profile, "transcript", "phase 1 must upload the transcript profile");
assert.equal(full.seen.create.body.manifest.source.fileName, "clip.mp4");
assert.ok(
  !JSON.stringify(full.seen.create.body).includes(dir),
  "phase 1 payload leaked a local filesystem path",
);

assert.ok(full.seen.frames, "phase 2 never happened");
assert.equal(full.seen.frames.auth, "Bearer test-key");
const uploaded = full.seen.frames.body.frames;
assert.equal(uploaded.length, 2, "expected one frame per requested timestamp");
assert.deepEqual(uploaded.map((f) => f.timestampMs), [1000, 3000]);
for (const frame of uploaded) {
  assert.match(frame.mimeType, /^image\/(webp|jpeg)$/);
  assert.match(frame.sha256, /^[0-9a-f]{64}$/);
  const bytes = Buffer.from(frame.base64, "base64");
  assert.ok(bytes.length > 0, "frame uploaded with no bytes");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), frame.sha256, "frame sha256 does not match its bytes");
  assert.ok(frame.width > 0 && frame.height > 0, "frame uploaded without dimensions");
}

const out = JSON.parse(full.stdout);
assert.equal(out.frames, 2);
assert.equal(out.classification.videoType, "tutorial");
assert.equal(out.profile, "visual");

// --- the regenerated local bundle -----------------------------------------

const bundle = out.bundlePath;
const framesDir = join(bundle, "frames");
assert.ok(existsSync(framesDir), "the bundle has no frames/ directory");
const files = readdirSync(framesDir).sort();
assert.equal(files.length, 2);
assert.match(files[0], /^000000\.(webp|jpg)$/);
for (const f of files) assert.ok(statSync(join(framesDir, f)).size > 0, `${f} is empty`);

const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
assert.equal(manifest.serverClassification.videoType, "tutorial");
assert.equal(manifest.serverClassification.needsVisual, true);
assert.equal(manifest.frames.length, 2);
assert.equal(manifest.frames[0].caption, "opens the dashboard", "frame captions must reach the manifest");
assert.equal(manifest.frames[1].caption, "clicks the highlighted button");
assert.equal(manifest.serverClassification.moments.length, 2, "the planned moments belong in the bundle");
assert.equal(manifest.source.fileName, "clip.mp4");
assert.ok(!manifest.frames.some((f) => f.file.includes("/")), "manifest frame refs must be basenames");

const md = readFileSync(join(bundle, "recording.md"), "utf8");
assert.ok(md.includes("Video type: tutorial"), "recording.md does not mention the video type");
assert.ok(md.includes(`![frame at 00:01](frames/${files[0]})`), "recording.md has no inline frame ref");
assert.ok(md.includes(`![frame at 00:03](frames/${files[1]})`), "recording.md is missing the second frame ref");
assert.ok(md.includes("[00:01] opens the dashboard"), "recording.md does not caption the first frame");
assert.ok(md.includes("[00:03] clicks the highlighted button"), "recording.md does not caption the second frame");
assert.ok(!md.includes(dir), "recording.md leaked a local filesystem path");

// --- --no-frames opts out of phase 2 --------------------------------------

const skipDir = mkdtempSync(join(tmpdir(), "clipy-frames-skip-"));
const skipped = await run(["--no-frames"], skipDir);
assert.equal(skipped.status, 0, `CLI failed with --no-frames: ${skipped.stderr}`);
assert.ok(skipped.seen.create, "--no-frames must still run phase 1");
assert.equal(skipped.seen.frames, null, "--no-frames must not run phase 2");

const skipOut = JSON.parse(skipped.stdout);
assert.equal(skipOut.frames, 0);
assert.equal(skipOut.profile, "transcript");
assert.ok(!existsSync(join(skipOut.bundlePath, "frames")), "--no-frames wrote a frames/ directory");
// The verdict still lands locally even when the pictures do not.
const skipManifest = JSON.parse(readFileSync(join(skipOut.bundlePath, "manifest.json"), "utf8"));
assert.equal(skipManifest.serverClassification.videoType, "tutorial");
assert.equal(skipManifest.frames, undefined);

process.stdout.write("✓ two-phase visual pipeline: moment plan, frame upload + captions, bundle regeneration, --no-frames\n");
