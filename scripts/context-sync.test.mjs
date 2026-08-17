#!/usr/bin/env node
/**
 * Asserts the POST body `clipy context import --sync` sends against the
 * UploadContextPayload contract, using a throwaway local server (never prod).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");

const dir = mkdtempSync(join(tmpdir(), "clipy-sync-test-"));
const video = join(dir, "clip.mp4");
spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-pix_fmt", "yuv420p", video]);
const vtt = join(dir, "clip.vtt");
writeFileSync(vtt, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello from the test fixture.\n\n00:00:01.000 --> 00:00:02.000\nSecond line of narration.\n");

let received = null;
// What the server answers next. The second run stands in for a re-import the
// server matched to a document the user already had.
let reply = { id: "ctx_1", publicId: "abc123", created: true };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received = { method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// spawn, not spawnSync: the mock server shares this event loop, so a blocking
// child could never be answered.
const runCli = () =>
  new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [cli, "context", "import", video, "--transcript", vtt, "--output", dir, "--sync", "--tag", "docs", "--tag", "api", "--folder", "Imports", "--json"],
      { env: { ...process.env, CLIPY_API_KEY: "test-key", CLIPY_API_URL: `http://127.0.0.1:${port}` } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });

const run = await runCli();

assert.equal(run.status, 0, `CLI failed: ${run.stderr}`);
assert.ok(received, "server received no request");
assert.equal(received.method, "POST");
assert.equal(received.url, "/api/v1/context-documents");
assert.equal(received.auth, "Bearer test-key");

const b = received.body;
assert.equal(typeof b.idempotencyKey, "string");
assert.ok(b.idempotencyKey.length > 0);
assert.deepEqual(b.tags, ["docs", "api"]);
assert.equal(b.folderName, "Imports");
assert.equal(typeof b.arecMarkdown, "string");
assert.ok(b.arecMarkdown.includes("NOTE FOR AI AGENTS"));
assert.equal(b.manifest.bundleVersion, 1);
assert.equal(b.manifest.arecVersion, "0.3-draft");
assert.equal(b.manifest.profile, "transcript");
assert.equal(b.manifest.compiler.name, "@clipy/cli");
assert.equal(b.manifest.source.kind, "local");
assert.match(b.manifest.source.contentHash, /^[0-9a-f]{64}$/);
assert.equal(b.transcript.source, "user_file");
assert.equal(b.transcript.segments.length, 2);
// The bundle must never carry source media or local paths.
assert.equal(b.frames, undefined);
assert.ok(!JSON.stringify(b).includes(dir), "payload leaked a local filesystem path");

const out = JSON.parse(run.stdout);
assert.equal(out.synced, true);
assert.equal(out.publicId, "abc123");
assert.equal(out.refreshed, false);

// Second import of the same source: the server dedupes on source identity and
// refreshes the document it already has. Same public id, no second entry.
reply = { id: "ctx_1", publicId: "abc123", created: false, refreshed: true };
const again = await runCli();
server.close();

assert.equal(again.status, 0, `re-import failed: ${again.stderr}`);
assert.match(again.stderr, /Already in your Knowledge Base — refreshed ✓/);
const outAgain = JSON.parse(again.stdout);
assert.equal(outAgain.refreshed, true);
assert.equal(outAgain.publicId, "abc123", "a refreshed import must keep the same public id");

process.stdout.write("✓ context sync payload matches the UploadContextPayload contract\n");
process.stdout.write("✓ a re-imported source is reported as refreshed, not created\n");
