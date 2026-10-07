#!/usr/bin/env node
// --source screen on Linux: parsers and ffmpeg arguments always; a real
// session against a mock upload server when Xvfb and ffmpeg (x11grab) exist.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const m = await import(resolve("dist/linuxScreen.js"));

// --- parsers ---------------------------------------------------------------
assert.deepEqual(
  m.parseMonitors("Monitors: 2\n 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1\n 1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1\n"),
  [
    { id: 0, name: "eDP-1", width: 1920, height: 1080, x: 0, y: 0 },
    { id: 1, name: "HDMI-1", width: 2560, height: 1440, x: 1920, y: 0 },
  ],
);
assert.deepEqual(m.parseProbedScreenSize("  Stream #0:0: Video: rawvideo (BGR[0] / 0x30524742), bgr0, 1280x720, 1 fps"), {
  width: 1280,
  height: 720,
});
assert.deepEqual(m.parseClientList("_NET_CLIENT_LIST(WINDOW): window id # 0x1e00003, 0x2200007\n"), [0x1e00003, 0x2200007]);
assert.deepEqual(m.parseClientList("_NET_CLIENT_LIST:  no such atom on any window.\n"), []);
assert.deepEqual(
  m.parseChildren(
    '     3 children:\n     0x200003 "Title": ("inst" "Class")  500x400+0+0  +0+0\n     0x200005 (has no name): ()  1x1+0+0  +0+0\n',
  ),
  [0x200003],
);
assert.deepEqual(
  m.parseWindowGeometry("  Absolute upper-left X:  250\n  Absolute upper-left Y:  -4\n  Width: 500\n  Height: 400\n  Map State: IsViewable\n"),
  { x: 250, y: -4, width: 500, height: 400, viewable: true },
);
assert.equal(m.parseWindowGeometry("  Absolute upper-left X:  0\n  Absolute upper-left Y:  0\n  Width: 10\n  Height: 10\n  Map State: IsUnMapped\n").viewable, false);
assert.deepEqual(
  m.parseWindowProps('_NET_WM_NAME(UTF8_STRING) = "Issue \\"42\\" - Chromium"\nWM_CLASS(STRING) = "chromium", "Chromium"\n'),
  { title: 'Issue "42" - Chromium', app: "Chromium" },
);
assert.deepEqual(m.parseWindowProps('WM_NAME(STRING) = "xterm"\n'), { title: "xterm", app: "" });

// --- environment -----------------------------------------------------------
assert.equal(m.isWaylandSession({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }), true);
assert.equal(m.isWaylandSession({ WAYLAND_DISPLAY: "wayland-0" }), true);
assert.equal(m.isWaylandSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), false);
assert.deepEqual(m.parseDisplaySize("1600x900"), { width: 1600, height: 900 });
assert.deepEqual(m.parseDisplaySize(undefined), { width: 1280, height: 720 });
assert.throws(() => m.parseDisplaySize("big"), /WIDTHxHEIGHT/);
assert.throws(() => m.parseDisplaySize("100x100"), /between/);

// --- ffmpeg arguments ------------------------------------------------------
const win = { id: 0x200003, app_name: "Chromium", title: "A", x: 10, y: 20, width: 501, height: 401 };
const byId = m.segmentArgs({ xDisplay: ":5", target: { kind: "window", window: win }, windowIdCapture: true, encoder: "libx264", output: "s.mkv" });
assert.equal(byId[byId.indexOf("-window_id") + 1], "0x200003");
assert.ok(!byId.includes("-grab_x"), "a window captured by id is not a screen area");
assert.equal(byId[byId.indexOf("-i") + 1], ":5");
assert.equal(byId[byId.indexOf("-cluster_time_limit") + 1], "1000", "segments must flush so a crash keeps them");
// Partly off the top-left of the screen, the area is clipped, not slid over.
const offLeft = m.segmentArgs({
  xDisplay: ":5",
  target: { kind: "window", window: win },
  rect: { x: -100, y: -30, width: 501, height: 401 },
  windowIdCapture: false,
  encoder: "libx264",
  output: "s.mkv",
});
assert.equal(offLeft[offLeft.indexOf("-video_size") + 1], "400x370");
assert.equal(offLeft[offLeft.indexOf("-grab_x") + 1], "0");
assert.equal(offLeft[offLeft.indexOf("-grab_y") + 1], "0");
assert.throws(
  () => m.segmentArgs({ xDisplay: ":5", target: { kind: "window", window: win }, rect: { x: -600, y: 0, width: 501, height: 401 }, windowIdCapture: false, encoder: "libx264", output: "s.mkv" }),
  /off the screen/,
);
// One clipping rule for the recorded area and the frame later segments fit into.
assert.deepEqual(m.clipToScreen({ x: -100, y: -30, width: 501, height: 401 }, { width: 1920, height: 1080 }), { x: 0, y: 0, width: 400, height: 370 });
assert.deepEqual(m.clipToScreen({ x: 1700, y: 900, width: 501, height: 401 }, { width: 1920, height: 1080 }), { x: 1700, y: 900, width: 220, height: 180 });
assert.deepEqual(m.clipToScreen({ x: 10, y: 20, width: 501, height: 401 }), { x: 10, y: 20, width: 500, height: 400 });
assert.throws(() => m.clipToScreen({ x: 0, y: 1080, width: 50, height: 50 }, { width: 1920, height: 1080 }), /off the screen/);
// Past the right and bottom edges too: x11grab refuses an area off the screen.
const offRight = m.segmentArgs({
  xDisplay: ":5",
  target: { kind: "window", window: win },
  rect: { x: 1700, y: 900, width: 501, height: 401 },
  screen: { width: 1920, height: 1080 },
  windowIdCapture: false,
  encoder: "libx264",
  output: "s.mkv",
});
assert.equal(offRight[offRight.indexOf("-video_size") + 1], "220x180");
assert.equal(offRight[offRight.indexOf("-grab_x") + 1], "1700");
assert.throws(
  () => m.segmentArgs({ xDisplay: ":5", target: { kind: "window", window: win }, rect: { x: 1920, y: 0, width: 501, height: 401 }, screen: { width: 1920, height: 1080 }, windowIdCapture: false, encoder: "libx264", output: "s.mkv" }),
  /off the screen/,
);
assert.deepEqual(
  m.screenSize([
    { id: 0, name: "a", x: 0, y: 0, width: 1920, height: 1080 },
    { id: 1, name: "b", x: 1920, y: 0, width: 2560, height: 1440 },
  ]),
  { width: 4480, height: 1440 },
);
assert.equal(m.screenSize([]), undefined);
const byArea = m.segmentArgs({
  xDisplay: ":5",
  target: { kind: "window", window: win },
  rect: { x: 30, y: 40, width: 501, height: 401 },
  windowIdCapture: false,
  encoder: "libvpx",
  output: "s.mkv",
});
assert.equal(byArea[byArea.indexOf("-video_size") + 1], "500x400", "odd sizes round down to even");
assert.equal(byArea[byArea.indexOf("-grab_x") + 1], "30");
assert.equal(byArea[byArea.indexOf("-c:v") + 1], "libvpx");

const one = m.finalizeArgs({ segments: [{ path: "a.mkv", gapAfterSec: 0 }], frame: { width: 500, height: 400 }, encoder: "libx264", output: "o.mp4" });
assert.deepEqual(one.slice(one.indexOf("-c"), one.indexOf("-c") + 2), ["-c", "copy"]);
const two = m.finalizeArgs({
  segments: [
    { path: "a.mkv", gapAfterSec: 0.25 },
    { path: "b.mkv", gapAfterSec: 0 },
  ],
  frame: { width: 500, height: 400 },
  encoder: "libx264",
  output: "o.mp4",
});
const filter = two[two.indexOf("-filter_complex") + 1];
assert.match(filter, /force_original_aspect_ratio=decrease,pad=500:400/, "segments are fitted, never stretched");
assert.match(filter, /\[0:v\][^;]*tpad=stop_mode=clone:stop_duration=0\.250/, "the restart gap holds the last frame");
assert.doesNotMatch(filter, /\[1:v\][^;]*tpad/);
assert.match(filter, /concat=n=2:v=1:a=0\[out\]/);

assert.deepEqual(
  m.segmentsWithGaps([
    { path: "a", startedAt: 0, endedAt: 1000 },
    { path: "b", startedAt: 1300, endedAt: 2000 },
  ]),
  [
    { path: "a", gapAfterSec: 0.3 },
    { path: "b", gapAfterSec: 0 },
  ],
);
const rect = { x: 0, y: 0, width: 500, height: 400 };
assert.equal(m.needsNewSegment(rect, { ...rect, x: 90 }, true), false, "by id, a move needs nothing");
assert.equal(m.needsNewSegment(rect, { ...rect, x: 90 }, false), true, "as an area, a move restarts");
assert.equal(m.needsNewSegment(rect, { ...rect, width: 300 }, true), true, "a resize always restarts");
assert.equal(m.needsNewSegment(rect, { ...rect, width: 501 }, true), false, "a one-pixel change that rounds the same does not");
// A dead daemon's ffmpeg is found by name and by this session's segment path.
{
  const proc = mkdtempSync(join(tmpdir(), "clipy-proc-"));
  const fake = (pid, comm, argv) => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), "comm"), `${comm}\n`);
    writeFileSync(join(proc, String(pid), "cmdline"), argv.join("\0") + "\0");
  };
  fake(101, "ffmpeg", ["ffmpeg", "-f", "x11grab", "/tmp/clipy-session-a/segment-0.mkv"]);
  fake(102, "ffmpeg", ["ffmpeg", "/tmp/clipy-session-b/segment-0.mkv"]);
  fake(103, "sh", ["sh", "-c", "echo /tmp/clipy-session-a/segment-0.mkv"]);
  fake(104, "ffmpeg", ["ffmpeg", "/tmp/clipy-session-ab/segment-0.mkv"]);
  mkdirSync(join(proc, "self"));
  try {
    assert.deepEqual(m.orphanedCaptureProcesses("/tmp/clipy-session-a", proc), [101]);
    assert.deepEqual(m.orphanedCaptureProcesses("/tmp/clipy-session-c", proc), []);
    assert.deepEqual(m.orphanedCaptureProcesses("/tmp/x", join(proc, "missing")), []);
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
}
// A segment ends at its last frame: ffmpeg's own exit, or when we asked it to stop.
assert.equal(m.segmentEndedAt({ exitedAt: 1000 }, 1500), 1000, "a shrink exit is earlier than the tick that notices it");
assert.equal(m.segmentEndedAt({ stopRequestedAt: 1200, exitedAt: 1400 }, 1500), 1200, "a requested stop ends at the request");
assert.equal(m.segmentEndedAt({}, 1500), 1500);
// A process killed by a signal has no exit code, and still counts as gone.
assert.equal(m.hasExited({ exitCode: null, signalCode: "SIGKILL" }), true);
assert.equal(m.hasExited({ exitCode: 1, signalCode: null }), true);
assert.equal(m.hasExited({ exitCode: null, signalCode: null }), false);
console.log("linux-screen: parsers and arguments ok");

// A recording's work directory is owner-only, and one that is not ours is refused.
{
  const base = mkdtempSync(join(tmpdir(), "clipy-private-"));
  try {
    const fresh = join(base, "a", "b");
    m.ensurePrivateDir(fresh);
    assert.equal(statSync(fresh).mode & 0o777, 0o700);
    const loose = join(base, "loose");
    mkdirSync(loose, { mode: 0o755 });
    m.ensurePrivateDir(loose);
    assert.equal(statSync(loose).mode & 0o777, 0o700, "an existing directory is tightened");
    symlinkSync(loose, join(base, "link"));
    assert.throws(() => m.ensurePrivateDir(join(base, "link")), /not a directory owned by this user/);
    if (process.getuid?.() === 0) {
      const foreign = join(base, "foreign");
      mkdirSync(foreign);
      chownSync(foreign, 65534, 65534);
      assert.throws(() => m.ensurePrivateDir(foreign), /not a directory owned by this user/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// --- live: a real X display and the real CLI ------------------------------
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const caps = m.ffmpegCaps(m.realRunner);
if (process.platform !== "linux" || !has("Xvfb") || !caps.x11grab || !caps.encoder) {
  console.log(`linux-screen: live session skipped (${process.platform}, Xvfb ${has("Xvfb")}, ${m.describeCaps(caps)})`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "clipy-linux-screen-"));
const completes = [];
const uploadedBytes = new Map();
let refuseUploads = false;
let stallUploads = false;
const stalled = [];
const server = createServer(async (req, res) => {
  const body = await new Promise((r) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => r(Buffer.concat(chunks)));
  });
  const send = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.url === "/api/videos/raw-upload/initiate" && refuseUploads) return send(500, { error: "upload service unavailable" });
  if (req.url === "/api/videos/raw-upload/initiate" && stallUploads) return stalled.push(() => send(500, { error: "stalled" }));
  if (req.url === "/api/videos/raw-upload/initiate") return send(200, { uploadToken: "t", publicId: `screen${completes.length + 1}` });
  if (req.url === "/api/videos/raw-upload/chunk") {
    const n = completes.length;
    uploadedBytes.set(n, Buffer.concat([uploadedBytes.get(n) ?? Buffer.alloc(0), body]));
    return send(200, { ok: true });
  }
  if (req.url === "/api/videos/raw-upload/finalize") return send(200, { ok: true });
  if (req.url === "/api/videos/raw-upload/complete") {
    completes.push(JSON.parse(body.toString("utf8")));
    return send(200, { ok: true });
  }
  if (req.url === "/api/videos/raw-upload/abort") return send(200, { ok: true });
  send(404, { error: "not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
const cli = resolve("dist/index.js");
const env = { ...process.env, XDG_CONFIG_HOME: join(work, "config"), NO_COLOR: "1" };
delete env.DISPLAY;

function run(args, extraEnv = {}) {
  return new Promise((r) => {
    // Before the args, so a `session run … -- cmd` keeps them for clipy.
    const dash = args.indexOf("--");
    const own = dash === -1 ? args : args.slice(0, dash);
    const rest = dash === -1 ? [] : args.slice(dash);
    const child = spawn(process.execPath, [cli, ...own, "--api-url", apiUrl, "--key", "clipy_test", ...rest], {
      cwd: work,
      env: { ...env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => r({ code, stdout, stderr }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // No display, no flag: refused with the ways forward, before anything runs.
  const noDisplay = await run(["session", "start", "--source", "screen"]);
  assert.notEqual(noDisplay.code, 0);
  assert.match(noDisplay.stderr, /--virtual-display/);

  // A private display, recorded whole; `session run` hands the driver DISPLAY.
  const started = await run(["session", "start", "--source", "screen", "--virtual-display", "--width", "640", "--height", "480", "--title", "Agent screen", "--json"]);
  assert.equal(started.code, 0, started.stderr);
  const info = JSON.parse(started.stdout);
  assert.equal(info.captureMode, "linux-screen");
  assert.equal(info.virtualDisplay, true);
  assert.match(info.xDisplay, /^:\d+$/);
  assert.equal(info.source.kind, "display");
  await sleep(1200);
  const mark = await run(["mark", "opened the settings page", "--observed", "Save is enabled", "--verdict", "pass"]);
  assert.equal(mark.code, 0, mark.stderr);
  const assertion = await run(["mark", "x", "--assert-selector", "#save"]);
  assert.equal(assertion.code, 2, "a screen has no page to evaluate selectors against");
  await sleep(800);
  const stopped = await run(["session", "stop", "--json"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(completes.length, 1);
  assert.equal(completes[0].name, "Agent screen");
  const notes = completes[0].narration.notes.map((n) => n.text);
  assert.ok(notes.some((t) => t.startsWith("opened the settings page") && t.includes("driver-attested")), notes.join(" | "));
  const uploaded = uploadedBytes.get(0);
  assert.ok(uploaded && uploaded.includes(Buffer.from("ftyp")), "the upload is an MP4");
  assert.ok(!spawnSync("sh", ["-c", `ls /tmp/.X11-unix/X${info.xDisplay.slice(1)} 2>/dev/null`]).stdout.length, "the virtual display is gone after stop");

  // One-shot record of a private display.
  const recorded = await run(["record", "--source", "screen", "--virtual-display", "--for", "2", "--note", "1: halfway", "--json"]);
  assert.equal(recorded.code, 0, recorded.stderr);
  const recordedJson = JSON.parse(recorded.stdout);
  assert.equal(recordedJson.id, "screen2");
  assert.match(recordedJson.contextUrl, /\/video\/screen2\.arec$/, "record --json carries the agent context URL");
  assert.ok(recordedJson.sizeBytes > 0, "record --json carries the uploaded size");
  assert.deepEqual(completes[1].narration.notes.map((n) => n.text), ["halfway"]);

  // A failed upload keeps the finished video, says where, and drops the segments.
  refuseUploads = true;
  const refused = await run(["record", "--source", "screen", "--virtual-display", "--for", "1"]);
  refuseUploads = false;
  assert.notEqual(refused.code, 0);
  const kept = refused.stderr.match(/The recording was kept at: (\S+)/)?.[1];
  assert.ok(kept, refused.stderr);
  assert.ok(existsSync(kept), "the kept recording is on disk");
  assert.equal(statSync(dirname(kept)).mode & 0o777, 0o700, "the kept recording's directory is owner-only");
  assert.deepEqual(readdirSync(dirname(kept)).filter((n) => n.startsWith("segment-")), [], "segments are removed");
  rmSync(dirname(kept), { recursive: true, force: true });

  // A session whose upload fails keeps the capture, even when the sessions
  // directory is on another filesystem from /tmp (rename cannot cross).
  if (existsSync("/dev/shm")) {
    const otherFs = mkdtempSync("/dev/shm/clipy-config-");
    try {
      const xenv = { XDG_CONFIG_HOME: otherFs };
      const kStarted = await run(["session", "start", "--source", "screen", "--virtual-display", "--json"], xenv);
      assert.equal(kStarted.code, 0, kStarted.stderr);
      const kTmp = JSON.parse(readFileSync(JSON.parse(kStarted.stdout).sessionFile, "utf8")).tmpDir;
      await sleep(1200);
      assert.equal(statSync(kTmp).mode & 0o777, 0o700, "the session's segments are owner-only");
      refuseUploads = true;
      const kStopped = await run(["session", "stop"], xenv);
      refuseUploads = false;
      assert.notEqual(kStopped.code, 0);
      const keptAt = kStopped.stderr.match(/The capture was kept at: (\S+)/)?.[1];
      assert.ok(keptAt, kStopped.stderr);
      assert.ok(keptAt.startsWith(otherFs), `kept in the sessions directory: ${keptAt}`);
      assert.ok(existsSync(keptAt), "the capture survives a failed upload across filesystems");
      assert.equal(statSync(keptAt).mode & 0o777, 0o600, "a kept capture is owner-only");
      await sleep(500);
      assert.equal(existsSync(kTmp), false, "the moved-out capture leaves no segments behind");
    } finally {
      refuseUploads = false;
      rmSync(otherFs, { recursive: true, force: true });
    }
  }

  // A daemon killed mid-upload leaves the finished capture as the only copy:
  // the next session verb keeps it and says where.
  {
    const uStarted = await run(["session", "start", "--source", "screen", "--virtual-display", "--json"]);
    assert.equal(uStarted.code, 0, uStarted.stderr);
    const uFile = JSON.parse(uStarted.stdout).sessionFile;
    const uTmp = JSON.parse(readFileSync(uFile, "utf8")).tmpDir;
    await sleep(1200);
    stallUploads = true;
    const uStopping = run(["session", "stop"]);
    let uState = null;
    for (let i = 0; i < 150 && uState?.state !== "uploading"; i++) {
      await sleep(100);
      try {
        uState = JSON.parse(readFileSync(uFile, "utf8"));
      } catch {
        // between writes
      }
    }
    assert.equal(uState?.state, "uploading");
    process.kill(uState.pid, "SIGKILL");
    const uStopped = await uStopping;
    stallUploads = false;
    for (const release of stalled.splice(0)) release();
    assert.notEqual(uStopped.code, 0);
    const uKept = uStopped.stderr.match(/The capture was kept at: (\S+)/)?.[1];
    assert.ok(uKept, uStopped.stderr);
    assert.ok(existsSync(uKept), "the capture survives its daemon dying mid-upload");
    assert.equal(statSync(uKept).mode & 0o777, 0o600, "a kept capture is owner-only");
    assert.ok(!uKept.startsWith(uTmp), `moved out of the work directory: ${uKept}`);
    assert.equal(existsSync(uTmp), false, "the rest of the work directory is removed");
    rmSync(uKept, { force: true });
  }

  // A dead daemon whose recovery move failed reported the capture inside its
  // work directory. Cleanup moves it out when it can, and otherwise keeps it
  // in place and drops only the segments.
  const craftSession = (configHome, fields = {}) => {
    const sessions = join(configHome, "clipy", "sessions");
    mkdirSync(sessions, { recursive: true });
    const tmpDir = mkdtempSync(join(tmpdir(), "clipy-session-crafted-"));
    const video = join(tmpDir, "recording.mp4");
    writeFileSync(video, Buffer.alloc(64 * 1024, 7));
    writeFileSync(join(tmpDir, "segment-0.mkv"), "segment");
    const file = join(sessions, `session-${createHash("sha1").update(work).digest("hex").slice(0, 16)}.json`);
    writeFileSync(file, JSON.stringify({
      kind: "linux-screen", state: "failed", error: "upload service unavailable", pid: 2 ** 30, url: "screen",
      tmpDir, keptVideoPath: video, logPath: join(sessions, "daemon.log"),
      marksPath: join(sessions, "marks.jsonl"), controlPath: join(sessions, "control.json"),
      ...fields,
    }));
    return { tmpDir, video };
  };
  {
    const config = mkdtempSync(join(work, "crafted-config-"));
    const crafted = craftSession(config);
    const aborted = await run(["session", "abort"], { XDG_CONFIG_HOME: config });
    assert.equal(aborted.code, 0, aborted.stderr);
    const movedTo = aborted.stderr.match(/kept at: (\S+)/)?.[1];
    assert.ok(movedTo?.startsWith(config), aborted.stderr);
    assert.equal(readFileSync(movedTo).length, 64 * 1024, "the whole capture was moved");
    assert.equal(existsSync(crafted.tmpDir), false);
  }
  // A failure with no finished video leaves nothing to keep: its segments go.
  {
    const config = mkdtempSync(join(work, "crafted-failed-"));
    const crafted = craftSession(config, { keptVideoPath: undefined });
    rmSync(crafted.video);
    const stoppedFailed = await run(["session", "stop"], { XDG_CONFIG_HOME: config });
    assert.notEqual(stoppedFailed.code, 0);
    assert.doesNotMatch(stoppedFailed.stderr, /kept at/);
    assert.equal(existsSync(crafted.tmpDir), false, "no orphaned segments");
  }

  // A mark or chapter is often the first verb to find the daemon dead mid-upload.
  {
    const config = mkdtempSync(join(work, "crafted-mark-"));
    const uploading = (c) => {
      const crafted = craftSession(c, { state: "uploading", keptVideoPath: undefined });
      const file = readdirSync(join(c, "clipy", "sessions")).find((n) => n.startsWith("session-"));
      const statePath = join(c, "clipy", "sessions", file);
      writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), videoPath: crafted.video }));
      return crafted;
    };
    const markCrafted = uploading(config);
    const marked = await run(["mark", "late note", "--json"], { XDG_CONFIG_HOME: config });
    assert.notEqual(marked.code, 0);
    const markJson = JSON.parse(marked.stdout);
    assert.equal(markJson.state, "cleared");
    assert.ok(markJson.keptVideoPath?.startsWith(config), marked.stdout);
    assert.equal(readFileSync(markJson.keptVideoPath).length, 64 * 1024, "mark keeps the capture and says where");
    assert.equal(existsSync(markCrafted.tmpDir), false);
    const chapterCrafted = uploading(config);
    const chaptered = await run(["chapter", "AFTER"], { XDG_CONFIG_HOME: config });
    assert.notEqual(chaptered.code, 0);
    const chapterKept = chaptered.stderr.match(/The capture was kept at: (\S+)/)?.[1];
    assert.ok(chapterKept && existsSync(chapterKept), chaptered.stderr);
    assert.equal(existsSync(chapterCrafted.tmpDir), false);
  }
  const fullFs = mkdtempSync(join(work, "full-"));
  if (spawnSync("mount", ["-t", "tmpfs", "-o", "size=256k", "tmpfs", fullFs]).status !== 0) {
    console.log("linux-screen: full-disk cleanup skipped (cannot mount a tmpfs)");
  } else {
    try {
      const crafted = craftSession(fullFs);
      spawnSync("sh", ["-c", `cat /dev/zero > ${fullFs}/filler 2>/dev/null`]);
      const stoppedFull = await run(["session", "stop"], { XDG_CONFIG_HOME: fullFs });
      assert.notEqual(stoppedFull.code, 0);
      assert.equal(stoppedFull.stderr.match(/The capture was kept at: (\S+)/)?.[1], crafted.video, stoppedFull.stderr);
      assert.equal(readFileSync(crafted.video).length, 64 * 1024, "a capture that cannot move stays whole");
      assert.deepEqual(readdirSync(crafted.tmpDir), ["recording.mp4"], "only the segments are dropped");
      assert.deepEqual(readdirSync(join(fullFs, "clipy", "sessions")).filter((n) => n.startsWith("kept-")), [], "no partial copy is left");
      rmSync(crafted.tmpDir, { recursive: true, force: true });
    } finally {
      spawnSync("umount", [fullFs]);
    }
  }

  // `session run` gives the driver the recorded display.
  const displayFile = join(work, "display.txt");
  const wrapped = await run([
    "session", "run", "--source", "screen", "--virtual-display", "--",
    "sh", "-c", `echo "$DISPLAY" > ${displayFile}; sleep 1`,
  ]);
  assert.equal(wrapped.code, 0, wrapped.stderr);
  assert.match(readFileSync(displayFile, "utf8").trim(), /^:\d+$/);
  assert.equal(completes.length, 3, "a driver that exits 0 uploads the take");

  // A window on an existing display: its own pixels, through a resize.
  const vd = await m.startVirtualDisplay({ width: 800, height: 600 });
  try {
    if (!has("xmessage") || !has("xdotool")) {
      console.log("linux-screen: window session skipped (needs xmessage and xdotool)");
    } else {
      const app = spawn("xmessage", ["-geometry", "400x300+50+50", "Clipy window under test"], { env: { ...process.env, DISPLAY: vd.display }, stdio: "ignore" });
      await sleep(800);
      const sources = await run(["sources", "--x-display", vd.display, "--json"]);
      assert.equal(sources.code, 0, sources.stderr);
      const listed = JSON.parse(sources.stdout);
      const target = listed.windows.find((w) => w.app_name.toLowerCase().includes("xmessage") || w.title.includes("xmessage"));
      assert.ok(target, `xmessage listed: ${sources.stdout}`);
      const startedWin = await run(["session", "start", "--source", "screen", "--x-display", vd.display, "--window", String(target.id), "--json"]);
      assert.equal(startedWin.code, 0, startedWin.stderr);
      assert.equal(JSON.parse(startedWin.stdout).source.id, target.id);
      assert.equal(JSON.parse(startedWin.stdout).windowCapture, caps.windowId ? "window" : "area", "an agent can tell window pixels from a screen area");
      await sleep(1200);
      spawnSync("xdotool", ["windowsize", String(target.id), "300", "200"], { env: { ...process.env, DISPLAY: vd.display } });
      await sleep(1500);
      const stoppedWin = await run(["session", "stop", "--json"]);
      assert.equal(stoppedWin.code, 0, stoppedWin.stderr);
      const winNotes = completes[3].narration.notes.map((n) => n.text);
      assert.ok(winNotes.some((t) => /window resized to 300x200/.test(t)), winNotes.join(" | "));
      app.kill();

      // ffmpeg killed by a signal (an OOM kill, say) is restarted, not left dead.
      const signalled = await run(["session", "start", "--source", "screen", "--x-display", vd.display, "--json"]);
      assert.equal(signalled.code, 0, signalled.stderr);
      const signalledState = JSON.parse(readFileSync(JSON.parse(signalled.stdout).sessionFile, "utf8"));
      await sleep(800);
      const [firstFfmpeg] = m.orphanedCaptureProcesses(signalledState.tmpDir);
      assert.ok(firstFfmpeg, "ffmpeg records the display");
      process.kill(firstFfmpeg, "SIGKILL");
      await sleep(2500);
      const restarted = m.orphanedCaptureProcesses(signalledState.tmpDir);
      assert.ok(restarted.length === 1 && restarted[0] !== firstFfmpeg, `a new ffmpeg took over: ${restarted}`);
      const stoppedSignalled = await run(["session", "stop", "--json"]);
      assert.equal(stoppedSignalled.code, 0, stoppedSignalled.stderr);
      const signalledNotes = completes.at(-1).narration.notes.map((n) => n.text);
      assert.ok(signalledNotes.some((t) => /restarted after an interruption/.test(t)), signalledNotes.join(" | "));

      // A daemon killed outright leaves its ffmpeg running; the next session
      // verb that finds the dead daemon stops it.
      const crashed = await run(["session", "start", "--source", "screen", "--x-display", vd.display, "--json"]);
      assert.equal(crashed.code, 0, crashed.stderr);
      const crashedState = JSON.parse(readFileSync(JSON.parse(crashed.stdout).sessionFile, "utf8"));
      await sleep(800);
      assert.ok(m.orphanedCaptureProcesses(crashedState.tmpDir).length > 0, "ffmpeg records while the daemon runs");
      process.kill(crashedState.pid, "SIGKILL");
      await sleep(300);
      assert.ok(m.orphanedCaptureProcesses(crashedState.tmpDir).length > 0, "killing the daemon leaves ffmpeg behind");
      const cleared = await run(["session", "stop"]);
      assert.notEqual(cleared.code, 0);
      assert.match(cleared.stderr, /no longer running|died mid-stop/);
      await sleep(500);
      assert.deepEqual(m.orphanedCaptureProcesses(crashedState.tmpDir), [], "the orphaned ffmpeg is stopped");
      assert.equal(existsSync(crashedState.tmpDir), false, "the dead session's segments are removed");

      // A daemon that is still starting when the CLI gives up is stopped, so
      // it cannot go on to record and upload behind a reported failure.
      const realFfmpeg = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
      const fakeBin = mkdtempSync(join(work, "fake-ffmpeg-"));
      writeFileSync(
        join(fakeBin, "ffmpeg"),
        // Slow but working in the daemon: each probe answers inside its own
        // 10 s limit, and together they outlast the CLI's 30 s start wait.
        `#!/bin/sh\nif grep -q __session-daemon /proc/$PPID/cmdline 2>/dev/null; then sleep 9.5; fi\nexec ${realFfmpeg} "$@"\n`,
        { mode: 0o755 },
      );
      try {
        const sessionsDir = join(work, "config", "clipy", "sessions");
        const before = new Set(existsSync(sessionsDir) ? readdirSync(sessionsDir) : []);
        const tmpBefore = new Set(readdirSync(tmpdir()));
        const stuck = await run(["session", "start", "--source", "screen", "--x-display", vd.display, "--json"], {
          PATH: `${fakeBin}:${process.env.PATH}`,
        });
        assert.notEqual(stuck.code, 0);
        assert.match(stuck.stderr, /did not start in time/);
        // The session daemon is this CLI's node re-run with __session-daemon
        // (the fake ffmpeg's own grep for that word is not one).
        const daemons = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
          try {
            const argv = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0");
            return argv[0] === process.execPath && argv.includes("__session-daemon");
          } catch {
            return false;
          }
        });
        assert.deepEqual(daemons, [], "the starting daemon was stopped");
        const left = readdirSync(sessionsDir).filter((n) => !before.has(n) && n.startsWith("session-"));
        assert.deepEqual(left, [], "its session state is cleared");
        await sleep(10_000); // past when the slow ffmpeg would have started recording
        assert.deepEqual(
          readdirSync(tmpdir()).filter((n) => n.startsWith("clipy-session-")).filter((n) => !tmpBefore.has(n)),
          [],
          "nothing is recording into a work directory",
        );
      } finally {
        spawnSync("pkill", ["-f", "^sleep 9.5$"]);
      }
    }
  } finally {
    await vd.stop();
  }
  console.log("linux-screen: live sessions ok");
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
