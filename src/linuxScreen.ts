/**
 * Linux screen capture for agents (`--source screen` on Linux).
 *
 * There is no Clipy desktop app on Linux, so the CLI records the X11 display
 * itself with ffmpeg's x11grab, the same tool `clipy proof` already uses:
 *
 * - a display (one monitor of an X screen, or the whole screen);
 * - one window by id, which is that window's own pixels. Under a compositor
 *   (GNOME, KDE, picom, xcompmgr) a window that is covered still records in
 *   full, and nothing from the window on top appears, which matches the Mac
 *   app's window-only mode. Without a compositor the covered part is black;
 * - a private virtual display (Xvfb) that only the agent draws on, so the
 *   user's screen, cursor and keyboard are never involved.
 *
 * ffmpeg's window capture keeps the size it started with and fails when the
 * window shrinks, so a window take is recorded in segments: a size change
 * closes the segment and opens a new one, and `finish` joins them, fitting
 * every segment into the first one's frame and holding the last frame across
 * the short restart gap so marks stay in sync with the picture.
 *
 * Wayland does not let an app read the screen without the desktop portal's
 * consent dialog, so a Wayland session can record a virtual display or an
 * explicitly named X display, not the user's own screen. That limit is
 * reported, never worked around.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LinuxDisplayInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LinuxWindowInfo {
  id: number;
  app_name: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LinuxSources {
  /** The X display these came from, e.g. ":0". */
  xDisplay: string;
  displays: LinuxDisplayInfo[];
  windows: LinuxWindowInfo[];
  /** Why the window list is empty when it is (missing x11-utils). */
  windowsUnavailable?: string;
}

export type LinuxTarget =
  | { kind: "display"; display: LinuxDisplayInfo }
  | { kind: "window"; window: LinuxWindowInfo };

/** What a shell runner returns; injectable so the parsers are testable. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => RunResult;

export const realRunner: Runner = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { env, encoding: "utf8", timeout: 10_000 });
  return {
    status: r.error ? null : r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
  };
};

// ---------------------------------------------------------------------------
// Environment checks
// ---------------------------------------------------------------------------

/** True when the user's session is Wayland, where reading the real screen
 *  needs the desktop portal's consent and x11grab sees only XWayland. */
export function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  return env.XDG_SESSION_TYPE === "wayland" || (!!env.WAYLAND_DISPLAY && !env.DISPLAY);
}

export interface FfmpegCaps {
  available: boolean;
  x11grab: boolean;
  /** x11grab can capture a window by id (FFmpeg 5.1+). */
  windowId: boolean;
  /** Preferred video encoder: H.264 into MP4, else VP8 into WebM. */
  encoder: "libx264" | "libvpx" | null;
}

export function ffmpegCaps(run: Runner, env: NodeJS.ProcessEnv = process.env): FfmpegCaps {
  const devices = run("ffmpeg", ["-hide_banner", "-devices"], env);
  if (devices.status === null) return { available: false, x11grab: false, windowId: false, encoder: null };
  const x11grab = /\bx11grab\b/.test(devices.stdout + devices.stderr);
  const help = x11grab ? run("ffmpeg", ["-hide_banner", "-h", "demuxer=x11grab"], env) : null;
  const encoders = run("ffmpeg", ["-hide_banner", "-encoders"], env).stdout;
  const encoder = /\blibx264\b/.test(encoders) ? "libx264" : /\blibvpx\b/.test(encoders) ? "libvpx" : null;
  return {
    available: true,
    x11grab,
    windowId: !!help && /-window_id\b/.test(help.stdout + help.stderr),
    encoder,
  };
}

function hasCommand(run: Runner, cmd: string, env: NodeJS.ProcessEnv): boolean {
  return run("sh", ["-c", `command -v ${cmd}`], env).status === 0;
}

// ---------------------------------------------------------------------------
// Source discovery (pure parsers + thin runners)
// ---------------------------------------------------------------------------

/** `xrandr --listactivemonitors`:  ` 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1` */
export function parseMonitors(text: string): LinuxDisplayInfo[] {
  const out: LinuxDisplayInfo[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+):\s+[+*]*(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
    if (!m) continue;
    out.push({
      id: Number(m[1]),
      name: m[2],
      width: Number(m[3]),
      height: Number(m[4]),
      x: Number(m[5]),
      y: Number(m[6]),
    });
  }
  return out;
}

/** The X screen size from ffmpeg's own probe of the display, so a display
 *  can be recorded without any X11 utilities installed. */
export function parseProbedScreenSize(ffmpegStderr: string): { width: number; height: number } | null {
  const m = /Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(ffmpegStderr);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** `xprop -root _NET_CLIENT_LIST`: the managed top-level windows. */
export function parseClientList(text: string): number[] {
  const m = /_NET_CLIENT_LIST\(WINDOW\): window id # (.*)/.exec(text);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-f]+$/i.test(s))
    .map((s) => parseInt(s, 16));
}

/** `xwininfo -root -children` lines: `     0x200003 "Title": ("inst" "Class")  500x400+0+0  +0+0` */
export function parseChildren(text: string): number[] {
  const ids: number[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s+(0x[0-9a-f]+)\s/i.exec(line);
    if (m && !/\(has no name\)/.test(line)) ids.push(parseInt(m[1], 16));
  }
  return ids;
}

/** `xwininfo -id <id>`: absolute geometry and whether it is on screen. */
export function parseWindowGeometry(
  text: string,
): { x: number; y: number; width: number; height: number; viewable: boolean } | null {
  const num = (label: string) => {
    const m = new RegExp(`${label}:\\s+(-?\\d+)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  const x = num("Absolute upper-left X");
  const y = num("Absolute upper-left Y");
  const width = num("Width");
  const height = num("Height");
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height, viewable: /Map State:\s+IsViewable/.test(text) };
}

/** `xprop -id <id> _NET_WM_NAME WM_NAME WM_CLASS`: title and owning app. */
export function parseWindowProps(text: string): { title: string; app: string } {
  const quoted = (re: RegExp) => {
    const m = re.exec(text);
    return m ? m[1].replace(/\\"/g, '"') : "";
  };
  const title = quoted(/_NET_WM_NAME\([^)]*\) = "((?:[^"\\]|\\.)*)"/) || quoted(/WM_NAME\([^)]*\) = "((?:[^"\\]|\\.)*)"/);
  const cls = /WM_CLASS\([^)]*\) = "((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"/.exec(text);
  return { title, app: cls ? cls[2] : "" };
}

/** List what can be recorded on an X display. Displays need only ffmpeg;
 *  the window list needs `xwininfo` and `xprop` (Debian/Ubuntu: x11-utils). */
/** The X display's monitors, or the whole screen as one display. */
export function listDisplays(xDisplay: string, run: Runner = realRunner, env: NodeJS.ProcessEnv = process.env): LinuxDisplayInfo[] {
  const xenv = { ...env, DISPLAY: xDisplay };
  let displays: LinuxDisplayInfo[] = [];
  const monitors = run("xrandr", ["--listactivemonitors"], xenv);
  if (monitors.status === 0) displays = parseMonitors(monitors.stdout);
  if (displays.length === 0) {
    // One display: the whole X screen. Its size from xwininfo when present,
    // else from ffmpeg's own probe of the display.
    const root = run("xwininfo", ["-root"], xenv);
    const geometry = root.status === 0 ? parseWindowGeometry(root.stdout) : null;
    let size = geometry ? { width: geometry.width, height: geometry.height } : null;
    if (!size) {
      const probe = run("ffmpeg", ["-hide_banner", "-f", "x11grab", "-i", xDisplay, "-frames:v", "1", "-f", "null", "-"], xenv);
      size = parseProbedScreenSize(probe.stderr);
    }
    if (size) displays = [{ id: 0, name: `screen ${xDisplay}`, x: 0, y: 0, ...size }];
  }
  return displays;
}

/** The X screen's size: the box around all its monitors. */
export function screenSize(displays: readonly LinuxDisplayInfo[]): { width: number; height: number } | undefined {
  if (displays.length === 0) return undefined;
  return {
    width: Math.max(...displays.map((d) => d.x + d.width)),
    height: Math.max(...displays.map((d) => d.y + d.height)),
  };
}

export function listLinuxSources(xDisplay: string, run: Runner = realRunner, env: NodeJS.ProcessEnv = process.env): LinuxSources {
  const xenv = { ...env, DISPLAY: xDisplay };
  const displays = listDisplays(xDisplay, run, env);

  if (!hasCommand(run, "xwininfo", xenv) || !hasCommand(run, "xprop", xenv)) {
    return {
      xDisplay,
      displays,
      windows: [],
      windowsUnavailable: "listing windows needs xwininfo and xprop (install x11-utils, e.g. `sudo apt install x11-utils`)",
    };
  }
  // A window manager publishes its managed windows; a bare X server (Xvfb
  // with no manager) has only the root's children.
  const clientList = run("xprop", ["-root", "_NET_CLIENT_LIST"], xenv);
  let ids = clientList.status === 0 ? parseClientList(clientList.stdout) : [];
  if (ids.length === 0) {
    const children = run("xwininfo", ["-root", "-children"], xenv);
    ids = children.status === 0 ? parseChildren(children.stdout) : [];
  }
  const windows: LinuxWindowInfo[] = [];
  for (const id of ids) {
    const hex = `0x${id.toString(16)}`;
    const info = run("xwininfo", ["-id", hex], xenv);
    const geometry = info.status === 0 ? parseWindowGeometry(info.stdout) : null;
    if (!geometry || !geometry.viewable || geometry.width < 32 || geometry.height < 32) continue;
    const props = parseWindowProps(run("xprop", ["-id", hex, "_NET_WM_NAME", "WM_NAME", "WM_CLASS"], xenv).stdout);
    if (!props.title && !props.app) continue;
    windows.push({ id, app_name: props.app, title: props.title, x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height });
  }
  return { xDisplay, displays, windows };
}

/** Current geometry of a window, or null once it is closed or unmapped. */
export function windowGeometry(
  xDisplay: string,
  id: number,
  run: Runner = realRunner,
  env: NodeJS.ProcessEnv = process.env,
): { x: number; y: number; width: number; height: number } | null {
  const info = run("xwininfo", ["-id", `0x${id.toString(16)}`], { ...env, DISPLAY: xDisplay });
  const g = info.status === 0 ? parseWindowGeometry(info.stdout) : null;
  return g && g.viewable ? g : null;
}

// ---------------------------------------------------------------------------
// ffmpeg arguments (pure)
// ---------------------------------------------------------------------------

export const CAPTURE_FPS = 30;

/** H.264 and VP8 both need even dimensions. */
function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * One capture segment. A window by id when ffmpeg supports it, else the
 * window's current rectangle of the screen (which follows it only across
 * segments, and can include what covers it). Matroska survives an abrupt
 * exit, which matters for the segment that is live when something fails.
 */
/**
 * The screen area a rectangle covers, clipped on every side and rounded to
 * even sizes. A window partly off the screen covers only its on-screen part:
 * past the left or top the area would slide over pixels the window does not
 * cover, and past the right or bottom x11grab refuses the area outright.
 */
export function clipToScreen(
  r: { x: number; y: number; width: number; height: number },
  screen?: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const right = screen ? Math.min(r.x + r.width, screen.width) : r.x + r.width;
  const bottom = screen ? Math.min(r.y + r.height, screen.height) : r.y + r.height;
  if (right - x < 2 || bottom - y < 2) throw new Error("the window to record is off the screen");
  return { x, y, width: even(right - x), height: even(bottom - y) };
}

export function segmentArgs(opts: {
  xDisplay: string;
  target: LinuxTarget;
  /** The window's current geometry, for the rectangle fallback. */
  rect?: { x: number; y: number; width: number; height: number };
  /** The X screen's size, to clip the rectangle fallback to. */
  screen?: { width: number; height: number };
  windowIdCapture: boolean;
  encoder: "libx264" | "libvpx";
  output: string;
}): string[] {
  const input = ["-f", "x11grab", "-draw_mouse", "1", "-framerate", String(CAPTURE_FPS)];
  if (opts.target.kind === "window" && opts.windowIdCapture) {
    input.push("-window_id", `0x${opts.target.window.id.toString(16)}`);
  } else {
    const r =
      opts.target.kind === "display"
        ? opts.target.display
        : (opts.rect ?? opts.target.window);
    const area = clipToScreen(r, opts.screen);
    input.push("-video_size", `${area.width}x${area.height}`, "-grab_x", String(area.x), "-grab_y", String(area.y));
  }
  input.push("-i", opts.xDisplay);
  const scale = ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"];
  const codec =
    opts.encoder === "libx264"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]
      : ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "2M"];
  // Matroska keeps a cluster in memory until it closes (5 s by default) and
  // a still window compresses to almost nothing, so without these a segment
  // stays at its header for seconds and a crash loses what was buffered.
  const mux = ["-flush_packets", "1", "-cluster_time_limit", "1000", "-f", "matroska"];
  return ["-hide_banner", "-loglevel", "error", "-nostats", "-y", ...input, ...scale, ...codec, ...mux, opts.output];
}

export interface FinishedSegment {
  path: string;
  /** Wall-clock gap after this segment before the next began, in seconds. */
  gapAfterSec: number;
}

/**
 * Join segments into the uploaded file. One segment is copied as is. Several
 * are fitted into the first segment's frame (letterboxed, never stretched),
 * each holding its last frame for the restart gap that followed it.
 */
export function finalizeArgs(opts: {
  segments: FinishedSegment[];
  frame: { width: number; height: number };
  encoder: "libx264" | "libvpx";
  output: string;
}): string[] {
  const container = opts.encoder === "libx264" ? ["-movflags", "+faststart", "-f", "mp4"] : ["-f", "webm"];
  if (opts.segments.length === 1) {
    return ["-hide_banner", "-loglevel", "error", "-y", "-i", opts.segments[0].path, "-c", "copy", ...container, opts.output];
  }
  const w = even(opts.frame.width);
  const h = even(opts.frame.height);
  const inputs = opts.segments.flatMap((s) => ["-i", s.path]);
  const chains = opts.segments.map((s, i) => {
    const hold = s.gapAfterSec > 0.01 ? `,tpad=stop_mode=clone:stop_duration=${s.gapAfterSec.toFixed(3)}` : "";
    return (
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${CAPTURE_FPS}${hold}[v${i}]`
    );
  });
  const filter = `${chains.join(";")};${opts.segments.map((_, i) => `[v${i}]`).join("")}concat=n=${opts.segments.length}:v=1:a=0[out]`;
  const codec =
    opts.encoder === "libx264"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
      : ["-c:v", "libvpx", "-deadline", "good", "-b:v", "2M"];
  return ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", ...codec, ...container, opts.output];
}

// ---------------------------------------------------------------------------
// Virtual display
// ---------------------------------------------------------------------------

export interface VirtualDisplay {
  display: string;
  pid: number;
  compositorPid?: number;
  stop(): Promise<void>;
}

/** Parse `--virtual-display` / `--virtual-display 1600x900`. */
export function parseDisplaySize(value: string | undefined): { width: number; height: number } {
  if (!value || value === "true") return { width: 1280, height: 720 };
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(value.trim());
  if (!m) throw new Error(`--virtual-display takes WIDTHxHEIGHT, e.g. 1280x720 (got "${value}")`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 320 || height < 240 || width > 3840 || height > 2160) {
    throw new Error("--virtual-display size must be between 320x240 and 3840x2160");
  }
  return { width: even(width), height: even(height) };
}

function freeDisplayNumber(): number {
  for (let n = 90; n < 200; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error("no free X display number between :90 and :199");
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

async function terminate(child: ChildProcess | null, graceMs = 3000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
}

/**
 * Start a private X display for the agent. A compositor is started on it when
 * one is installed, so a covered window still records in full; it is not
 * required for display capture.
 */
export async function startVirtualDisplay(
  size: { width: number; height: number },
  run: Runner = realRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VirtualDisplay> {
  if (!hasCommand(run, "Xvfb", env)) {
    throw new Error("--virtual-display needs Xvfb (Debian/Ubuntu: `sudo apt install xvfb`)");
  }
  const n = freeDisplayNumber();
  const display = `:${n}`;
  const xvfb = spawn("Xvfb", [display, "-screen", "0", `${size.width}x${size.height}x24`, "-nolisten", "tcp"], {
    stdio: "ignore",
    env,
  });
  const up = await waitFor(() => existsSync(`/tmp/.X11-unix/X${n}`) || hasExited(xvfb), 5000);
  if (!up || hasExited(xvfb)) {
    await terminate(xvfb);
    throw new Error(`Xvfb did not start on ${display}`);
  }
  let compositor: ChildProcess | null = null;
  for (const name of ["picom", "xcompmgr"]) {
    if (hasCommand(run, name, env)) {
      compositor = spawn(name, [], { stdio: "ignore", env: { ...env, DISPLAY: display } });
      break;
    }
  }
  return {
    display,
    pid: xvfb.pid ?? 0,
    compositorPid: compositor?.pid,
    async stop() {
      await terminate(compositor);
      await terminate(xvfb);
    },
  };
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

export interface ScreenRecorder {
  /** Epoch ms when the first segment's ffmpeg started: the video's zero, so
   *  marks are stamped against it rather than against when start returned. */
  startedAt: number;
  /** Called on the session's ~400 ms tick. Returns an auto-mark to record
   *  (e.g. a resize) or null. Throws when the capture can no longer run. */
  tick(): string | null;
  /** True once the recorded window closed: nothing more can be captured. */
  ended(): boolean;
  /** Stop capturing and produce the file to upload. */
  finish(): Promise<string>;
  /** Stop capturing and delete everything. */
  discard(): Promise<void>;
}

interface LiveSegment {
  path: string;
  child: ChildProcess;
  startedAt: number;
  /** The rectangle it records: its size always, its position only matters
   *  when ffmpeg cannot capture by window id and records the screen area. */
  rect: { x: number; y: number; width: number; height: number };
  stderr: string;
  /** Set when we asked it to stop, so its exit is expected. */
  stopping: boolean;
  /** When we asked it to stop: the last frame it records. */
  stopRequestedAt?: number;
  /** When it exited, which can be well before a tick notices. */
  exitedAt?: number;
}

interface DoneSegment {
  path: string;
  startedAt: number;
  endedAt: number;
}

/** Ask ffmpeg to finish its file cleanly ('q'), then insist. */
async function stopFfmpeg(seg: LiveSegment): Promise<void> {
  seg.stopping = true;
  seg.stopRequestedAt ??= Date.now();
  if (seg.child.exitCode !== null || seg.child.signalCode !== null) return;
  const exited = new Promise<void>((r) => seg.child.once("exit", () => r()));
  try {
    seg.child.stdin?.write("q");
    seg.child.stdin?.end();
  } catch {
    // stdin already closed
  }
  const term = setTimeout(() => seg.child.kill("SIGINT"), 5000);
  const kill = setTimeout(() => seg.child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(term);
  clearTimeout(kill);
}

function nonEmpty(path: string, minBytes = 1): boolean {
  try {
    return statSync(path).size >= minBytes;
  } catch {
    return false;
  }
}

/**
 * When a segment's last frame was captured. ffmpeg exits by itself when a
 * window shrinks, up to a tick before it is noticed, and the wall-clock gap to
 * the next segment has to start at that exit or every later mark drifts.
 */
export function segmentEndedAt(seg: { stopRequestedAt?: number; exitedAt?: number }, now: number): number {
  return Math.min(seg.exitedAt ?? now, seg.stopRequestedAt ?? now, now);
}

/**
 * Whether a child process is gone. A process killed by a signal (an OOM
 * SIGKILL, say) keeps `exitCode` null and sets `signalCode` instead.
 */
export function hasExited(child: { exitCode: number | null; signalCode: NodeJS.Signals | string | null }): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function exitDescription(child: { exitCode: number | null; signalCode: NodeJS.Signals | string | null }): string {
  return child.signalCode !== null ? `ffmpeg was killed by ${child.signalCode}` : `ffmpeg exited with ${child.exitCode}`;
}

/** A Matroska header alone is ~600 bytes; past this, frames are landing. */
const FIRST_FRAMES_BYTES = 1024;

/** Segments in order with the wall-clock gap that followed each one. */
export function segmentsWithGaps(done: readonly DoneSegment[]): FinishedSegment[] {
  return done.map((s, i) => ({
    path: s.path,
    gapAfterSec: i + 1 < done.length ? Math.max(0, (done[i + 1].startedAt - s.endedAt) / 1000) : 0,
  }));
}

/** Whether a window's live geometry needs a new segment. */
export function needsNewSegment(
  recording: { x: number; y: number; width: number; height: number },
  now: { x: number; y: number; width: number; height: number },
  windowIdCapture: boolean,
): boolean {
  if (even(now.width) !== even(recording.width) || even(now.height) !== even(recording.height)) return true;
  // Captured by id, the picture follows the window by itself; captured as a
  // screen area, the area has to be moved with it.
  return !windowIdCapture && (now.x !== recording.x || now.y !== recording.y);
}

/**
 * Start recording. Resolves once the first segment is producing bytes, so a
 * recording that cannot capture (no display, a refused window) fails here,
 * loudly, rather than looking like it runs while writing nothing.
 */
export async function startScreenRecorder(opts: {
  xDisplay: string;
  target: LinuxTarget;
  tmpDir: string;
  caps: FfmpegCaps;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
}): Promise<ScreenRecorder> {
  const run = opts.run ?? realRunner;
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  if (!opts.caps.available) throw new Error("recording the screen needs ffmpeg on PATH");
  if (!opts.caps.x11grab) throw new Error("this ffmpeg was built without x11grab, so it cannot record an X display");
  const encoder = opts.caps.encoder;
  if (!encoder) throw new Error("this ffmpeg has neither libx264 nor libvpx, so it cannot encode the recording");
  ensurePrivateDir(opts.tmpDir);
  // Only the rectangle fallback needs the screen's edges to clip to.
  const screen =
    opts.target.kind === "window" && !opts.caps.windowId ? screenSize(listDisplays(opts.xDisplay, run, env)) : undefined;

  const done: DoneSegment[] = [];
  let live: LiveSegment | null = null;
  let firstSize: { width: number; height: number } | null = null;
  let closed = false;
  // True while a segment change is queued, so ticks wait for it.
  let busy = false;
  let failures = 0;
  let segmentCount = 0;
  let fatal: Error | null = null;
  // Every segment change runs through this one queue, so a restart and a
  // stop can never interleave and `finish` waits for whatever is in flight.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>) => {
    queue = queue.then(step).catch((e: Error) => {
      fatal ??= e;
      log(`screen capture: ${e.message}`);
    });
  };

  const currentRect = () => {
    if (opts.target.kind === "display") return opts.target.display;
    return windowGeometry(opts.xDisplay, opts.target.window.id, run, env);
  };

  const openSegment = async (): Promise<void> => {
    const rect = currentRect();
    if (!rect) throw new Error("the window to record is closed or minimized");
    const path = join(opts.tmpDir, `segment-${segmentCount++}.mkv`);
    const args = segmentArgs({
      xDisplay: opts.xDisplay,
      target: opts.target,
      rect,
      screen,
      windowIdCapture: opts.caps.windowId,
      encoder,
      output: path,
    });
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"], env: { ...env, DISPLAY: opts.xDisplay } });
    const seg: LiveSegment = { path, child, startedAt: Date.now(), rect: { ...rect }, stderr: "", stopping: false };
    child.once("exit", () => {
      seg.exitedAt ??= Date.now();
    });
    child.stderr?.on("data", (d: Buffer) => {
      seg.stderr = (seg.stderr + d.toString()).slice(-4000);
    });
    // The first bytes prove capture works; a refused display or window makes
    // ffmpeg exit instead.
    const ok = await waitFor(() => nonEmpty(path, FIRST_FRAMES_BYTES) || hasExited(child), 8000);
    if (!ok || hasExited(child)) {
      await stopFfmpeg(seg);
      rmSync(path, { force: true });
      const detail = seg.stderr.trim().split("\n").slice(-2).join(" ");
      throw new Error(`ffmpeg could not record ${opts.xDisplay}: ${detail || "it wrote nothing"}`);
    }
    // The frame later segments are fitted into is what this one recorded:
    // in the area fallback that is the clipped on-screen part of the window.
    const recorded =
      opts.target.kind === "window" && !opts.caps.windowId ? clipToScreen(rect, screen) : rect;
    firstSize ??= { width: even(recorded.width), height: even(recorded.height) };
    live = seg;
    log(`recording segment ${path} at ${even(recorded.width)}x${even(recorded.height)}`);
  };

  // Reads `live` when the queued step runs, not when it was queued, so it
  // always closes the segment that is actually recording.
  const closeSegment = async (): Promise<void> => {
    const seg = live;
    if (!seg) return;
    live = null;
    await stopFfmpeg(seg);
    if (nonEmpty(seg.path)) done.push({ path: seg.path, startedAt: seg.startedAt, endedAt: segmentEndedAt(seg, Date.now()) });
  };

  await openSegment();
  const startedAt = (live as LiveSegment | null)?.startedAt ?? Date.now();

  return {
    startedAt,
    tick() {
      if (fatal) throw fatal;
      if (closed || busy) return null;
      const seg: LiveSegment | null = live;
      if (!seg) return null;
      if (opts.target.kind === "window") {
        const g = currentRect();
        if (!g) {
          closed = true;
          enqueue(closeSegment);
          return "[auto] the recorded window closed or was minimized; recording ended";
        }
        if (needsNewSegment(seg.rect, g, opts.caps.windowId)) {
          busy = true;
          enqueue(async () => {
            await closeSegment();
            await openSegment();
            busy = false;
          });
          return even(g.width) !== even(seg.rect.width) || even(g.height) !== even(seg.rect.height)
            ? `[auto] window resized to ${even(g.width)}x${even(g.height)}`
            : null;
        }
      }
      if (!seg.stopping && hasExited(seg.child)) {
        // ffmpeg died on its own. Keep what it wrote and start again, a few
        // times; past that the capture is broken and the session must fail.
        failures += 1;
        const reason = seg.stderr.trim().split("\n").pop() || exitDescription(seg.child);
        if (failures > 3) throw new Error(`screen capture keeps failing: ${reason}`);
        busy = true;
        live = null;
        if (nonEmpty(seg.path)) done.push({ path: seg.path, startedAt: seg.startedAt, endedAt: segmentEndedAt(seg, Date.now()) });
        enqueue(async () => {
          await openSegment();
          busy = false;
        });
        return "[auto] screen capture restarted after an interruption";
      }
      return null;
    },
    ended: () => closed,
    async finish() {
      closed = true;
      enqueue(closeSegment);
      await queue;
      if (done.length === 0) throw fatal ?? new Error("the screen capture produced no video");
      const output = join(opts.tmpDir, encoder === "libx264" ? "recording.mp4" : "recording.webm");
      const r = spawnSync(
        "ffmpeg",
        finalizeArgs({ segments: segmentsWithGaps(done), frame: firstSize ?? { width: 1280, height: 720 }, encoder, output }),
        { encoding: "utf8", env },
      );
      if (r.status !== 0 || !nonEmpty(output)) {
        const detail = (r.stderr ?? "").trim().split("\n").pop();
        throw new Error(`could not finish the recording: ${detail || "ffmpeg failed"}`);
      }
      return output;
    },
    async discard() {
      closed = true;
      enqueue(closeSegment);
      await queue;
      rmSync(opts.tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Creates the directory a recording is written into, readable only by this
 * user: on a shared machine `/tmp` is listable by everyone, and the segments
 * are the user's screen. A directory that already exists must be ours.
 */
export function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") mkdirSync(dir, { recursive: true, mode: 0o700 });
    else if (code !== "EEXIST") throw e;
  }
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`refusing to record into ${dir}: it is not a directory owned by this user`);
  }
  chmodSync(dir, 0o700);
}

/** The whole X screen (or its first monitor) as a display target. */
export function defaultDisplay(sources: LinuxSources): LinuxDisplayInfo {
  const first = sources.displays[0];
  if (!first) throw new Error(`could not read the size of X display ${sources.xDisplay}`);
  return first;
}

/** For tests and `clipy doctor`: write a short capability summary. */
export function describeCaps(caps: FfmpegCaps): string {
  if (!caps.available) return "ffmpeg missing";
  if (!caps.x11grab) return "ffmpeg without x11grab";
  return `ffmpeg x11grab${caps.windowId ? " with window capture" : " (no window_id: windows are recorded as their screen area)"}, ${caps.encoder ?? "no encoder"}`;
}

/**
 * The ffmpeg processes still writing segments into `tmpDir`. A session daemon
 * that was killed outright cannot stop its ffmpeg, which would otherwise keep
 * encoding into a directory nobody reads. Matching both the process name and
 * this session's own segment path means a reused pid, or another session's
 * capture, is never picked up.
 */
export function orphanedCaptureProcesses(tmpDir: string, procRoot = "/proc"): number[] {
  const marker = `${join(tmpDir, "segment-")}`;
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(join(procRoot, entry, "comm"), "utf8").trim() !== "ffmpeg") continue;
      const argv = readFileSync(join(procRoot, entry, "cmdline"), "utf8").split("\0");
      if (argv.some((arg) => arg.startsWith(marker))) pids.push(Number(entry));
    } catch {
      // exited while we looked, or not ours to read
    }
  }
  return pids;
}
