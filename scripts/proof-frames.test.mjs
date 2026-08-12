#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const work = mkdtempSync(join(tmpdir(), "clipy-proof-test-"));
const binDir = join(work, "bin");
mkdirSync(binDir);

const fakeFfmpeg = join(binDir, "ffmpeg");
const ffmpegArgsPath = join(work, "ffmpeg-args.json");
writeFileSync(
  fakeFfmpeg,
  `#!/usr/bin/env node
const fs = require("node:fs");
const out = process.argv[process.argv.length - 1];
fs.writeFileSync(${JSON.stringify(ffmpegArgsPath)}, JSON.stringify(process.argv.slice(2)));
const mp4 = Buffer.alloc(4096);
mp4.writeUInt32BE(24, 0);
mp4.write("ftyp", 4, "ascii");
fs.writeFileSync(out, mp4);
`,
);
chmodSync(fakeFfmpeg, 0o755);

const frame1 = join(work, "before.png");
const frame2 = join(work, "after.png");
writeFileSync(frame1, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
writeFileSync(frame2, Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]));

const recordedMp4 = join(work, "tool-recording.mp4");
const mp4 = Buffer.alloc(4096);
mp4.writeUInt32BE(24, 0);
mp4.write("ftyp", 4, "ascii");
writeFileSync(recordedMp4, mp4);

const completes = [];
const chunkMediaTypes = [];
let uploads = 0;
const server = createServer(async (req, res) => {
  const body = await new Promise((resolveBody) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
  });
  const json = () => {
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      return {};
    }
  };
  const send = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };

  if (req.url === "/api/videos/raw-upload/initiate") {
    uploads += 1;
    const payload = json();
    assert.equal(payload.createVideoRow, true);
    assert.match(payload.sourceVersion, /^cli-proof\//);
    send(200, { uploadToken: `token-${uploads}`, publicId: `proof${uploads}` });
    return;
  }
  if (req.url === "/api/videos/raw-upload/chunk") {
    assert.ok(body.length > 0, "chunk body should contain multipart video bytes");
    const multipart = body.toString("latin1");
    chunkMediaTypes.push(
      multipart.includes("Content-Type: video/mp4")
        ? "video/mp4"
        : multipart.includes("Content-Type: video/webm")
          ? "video/webm"
          : "unknown",
    );
    send(200, { ok: true });
    return;
  }
  if (req.url === "/api/videos/raw-upload/finalize") {
    send(200, { ok: true });
    return;
  }
  if (req.url === "/api/videos/raw-upload/complete") {
    completes.push(json());
    send(200, { ok: true });
    return;
  }
  if (req.url === "/api/videos/raw-upload/abort") {
    send(200, { ok: true });
    return;
  }
  send(404, { error: "not found" });
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert.ok(address && typeof address === "object");
const apiUrl = `http://127.0.0.1:${address.port}`;
const cli = resolve("dist/index.js");

function run(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args, "--api-url", apiUrl, "--key", "clipy_test"], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

try {
  const frames = await run([
    "proof",
    "--frame",
    frame1,
    "--frame",
    frame2,
    "--caption",
    "Before: save button was disabled",
    "--caption",
    "After: save button is enabled",
    "--hold",
    "1.5",
    "--title",
    "Settings fix proof",
    "--type",
    "bug",
    "--json",
  ]);
  assert.equal(frames.code, 0, frames.stderr);
  const frameResult = JSON.parse(frames.stdout);
  assert.equal(frameResult.id, "proof1");
  assert.equal(frameResult.source.kind, "proof-frames");
  assert.equal(frameResult.source.frameCount, 2);
  assert.equal(frameResult.source.durationSeconds, 3);
  assert.equal(chunkMediaTypes[0], "video/mp4");
  const ffmpegArgs = JSON.parse(readFileSync(ffmpegArgsPath, "utf8"));
  assert.deepEqual(ffmpegArgs.slice(ffmpegArgs.indexOf("-c:v"), ffmpegArgs.indexOf("-c:v") + 2), [
    "-c:v",
    "libx264",
  ]);
  assert.match(ffmpegArgs[ffmpegArgs.indexOf("-filter_complex") + 1], /flags=lanczos/);
  assert.equal(ffmpegArgs[ffmpegArgs.indexOf("-crf") + 1], "14");
  assert.equal(ffmpegArgs[ffmpegArgs.indexOf("-tune") + 1], "stillimage");

  assert.equal(completes[0].name, "Settings fix proof");
  assert.equal(completes[0].recordingKind, "bug_report");
  assert.deepEqual(
    completes[0].narration.notes.map(({ startMs, text }) => ({ startMs, text })),
    [
      { startMs: 0, text: "[proof frame 1/2] Before: save button was disabled" },
      { startMs: 1500, text: "[proof frame 2/2] After: save button is enabled" },
    ],
  );

  const video = await run([
    "proof",
    "--video",
    recordedMp4,
    "--title",
    "Tool-native recording",
    "--note",
    "0: agent opened the verified page",
    "--json",
  ]);
  assert.equal(video.code, 0, video.stderr);
  const videoResult = JSON.parse(video.stdout);
  assert.equal(videoResult.id, "proof2");
  assert.equal(videoResult.source.kind, "proof-video");
  assert.equal(videoResult.source.container, "mp4");
  assert.equal("path" in videoResult.source, false, "JSON must not disclose the local media path");
  assert.equal(chunkMediaTypes[1], "video/mp4");
  assert.equal(completes[1].narration.notes[0].text, "agent opened the verified page");

  const bothSources = await run(["proof", "--frame", frame1, "--video", recordedMp4, "--json"]);
  assert.equal(bothSources.code, 2);
  assert.match(bothSources.stderr, /usage: clipy proof/);

  const captionMismatch = await run([
    "proof",
    "--frame",
    frame1,
    "--frame",
    frame2,
    "--caption",
    "only one caption",
    "--json",
  ]);
  assert.equal(captionMismatch.code, 2);
  assert.match(captionMismatch.stderr, /caption count/);

  const oddWidth = await run(["proof", "--frame", frame1, "--width", "1279", "--json"]);
  assert.equal(oddWidth.code, 1);
  assert.match(oddWidth.stderr, /--width must be even/);

  assert.equal(uploads, 2, "invalid invocations must fail before creating an upload");

  process.stdout.write("proof frames/video: ok\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(work, { recursive: true, force: true });
}
