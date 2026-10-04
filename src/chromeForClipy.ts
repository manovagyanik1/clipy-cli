/**
 * Chrome for Clipy: a dedicated automation browser the CLI owns.
 *
 * A separate, persistent Chrome instance (own --user-data-dir, own identity)
 * launched with the capability flags an agent needs and a daily browser should
 * never run with:
 *
 *   - --remote-debugging-port         → CDP for any driver (Playwright, Puppeteer, raw)
 *   - --auto-select-tab-capture-source-by-title
 *                                     → getDisplayMedia picks its tab WITHOUT the
 *                                       picker. The regex matches the
 *                                       TAB_CAPTURE_TITLE_MARKER prefix, so the
 *                                       capture target is chosen AT RUNTIME by
 *                                       retitling the target tab. The flag is
 *                                       fixed at launch, the choice is not.
 *   - the three background-throttling disables
 *                                     → backgrounded tabs keep rendering, so
 *                                       screencast/capture of hidden tabs works.
 *   - --allowlisted-extension-id      → the Clipy extension installed in this
 *                                       profile may call tabCapture without the
 *                                       toolbar click (see chromeExtensionCapture.ts).
 *                                       Verified on Chrome 154; it is a test
 *                                       switch, not a supported API.
 *
 * The user signs in once; the profile persists across launches. This is the
 * agent-owned end of the capture-provider spectrum: everything here is
 * gesture-free because Clipy launched the browser, which is precisely the line
 * Chrome's security model draws (see docs/plans/2026-09-01-001).
 *
 * State lives at ~/.config/clipy/chrome-for-clipy/: `profile/` (user data dir)
 * and `state.json` ({pid, port, startedAt}). `installApp()` writes a macOS
 * launcher bundle "Chrome for Clipy.app" so the browser exists as a named app
 * in Finder/Spotlight; while running, the Dock still shows Google Chrome's
 * icon (macOS resolves the running bundle from the real binary; renaming that
 * would mean copying the whole .app and breaking its code signature/updates).
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_CDP_PORT = 9333;
/** Retitle a tab to start with this and the auto-select flag captures it.
 *  Deliberately free of regex metacharacters: Chrome may treat the flag value
 *  as a pattern, and e.g. `[clipy-rec]` would become a character class. */
export const TAB_CAPTURE_TITLE_MARKER = "clipy-rec";
export const APP_NAME = "Chrome for Clipy";
/** The Web Store id of the Clipy extension. CLIPY_EXTENSION_ID overrides it
 *  for an unpacked development build. */
export const CLIPY_EXTENSION_STORE_ID = "kpoeghpnpjdaglohmnemgkljahinendl";

export function clipyExtensionId(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLIPY_EXTENSION_ID?.trim();
  return override && /^[a-p]{32}$/.test(override) ? override : CLIPY_EXTENSION_STORE_ID;
}

const MACOS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROME_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];

export interface ChromeForClipyState {
  pid: number;
  port: number;
  startedAt: string;
  binary: string;
}

export function chromeForClipyDir(home: string): string {
  return join(home, ".config", "clipy", "chrome-for-clipy");
}

function profileDir(home: string): string {
  return join(chromeForClipyDir(home), "profile");
}

function stateFile(home: string): string {
  return join(chromeForClipyDir(home), "state.json");
}

export function resolveChromeBinary(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home?: string): string | null {
  void home; // kept in the signature for a future fork-aware resolution
  const override = env.CLIPY_CHROME_BINARY?.trim();
  if (override) return existsSync(override) ? override : null;
  if (platform === "darwin") return existsSync(MACOS_CHROME) ? MACOS_CHROME : null;
  if (platform === "linux") return LINUX_CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
  return null;
}

/** What makes a process OUR instance: the dedicated profile on our port. */
function identityArgs(home: string, port: number): string[] {
  return [`--user-data-dir=${profileDir(home)}`, `--remote-debugging-port=${port}`];
}

/** The launch argv, one place, shared by `clipy chrome start` and the .app launcher. */
export function launchArgs(home: string, port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...identityArgs(home, port),
    // The regex is fixed at launch; the marker makes target selection dynamic.
    `--auto-select-tab-capture-source-by-title=${TAB_CAPTURE_TITLE_MARKER}`,
    `--allowlisted-extension-id=${clipyExtensionId(env)}`,
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
  ];
}

/** Name the profile before first launch so the avatar badge reads as the product. */
function seedProfileName(home: string): void {
  const prefs = join(profileDir(home), "Default", "Preferences");
  if (existsSync(prefs)) return;
  mkdirSync(join(profileDir(home), "Default"), { recursive: true });
  writeFileSync(prefs, JSON.stringify({ profile: { name: APP_NAME } }));
}

export function readState(home: string): ChromeForClipyState | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(home), "utf8")) as ChromeForClipyState;
    return Number.isInteger(parsed.pid) && parsed.pid > 0 &&
      Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535 &&
      typeof parsed.binary === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandHasArgs(pid: number, args: string[]): boolean {
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const command = result.stdout.trim();
  return args.every((arg) => {
    const escaped = arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(command);
  });
}

/** A PID or listening port can be reused. Check the process's launch arguments
 * before adopting it or sending a signal, including instances from the launcher. */
function ownsChrome(pid: number | null, home: string, port: number): pid is number {
  if (!pid || !pidAlive(pid)) return false;
  return commandHasArgs(pid, identityArgs(home, port));
}

/** Our instance, but started without today's flags (an older CLI, an old
 *  launcher app, or a flag added since). It has to be relaunched: flags only
 *  apply when Chrome starts. */
function hasCurrentFlags(pid: number, home: string, port: number, env: NodeJS.ProcessEnv): boolean {
  return commandHasArgs(pid, launchArgs(home, port, env));
}

function extensionRecordingFile(home: string): string {
  return join(chromeForClipyDir(home), "extension-recording.json");
}

/** Notes that the Clipy extension is recording in Chrome for Clipy, until the
 *  recording's own deadline, so a relaunch for flags cannot kill it. */
export function markExtensionRecording(home: string, recording: { recordingId: string; untilEpochMs: number } | null): void {
  if (!recording) {
    rmSync(extensionRecordingFile(home), { force: true });
    return;
  }
  mkdirSync(chromeForClipyDir(home), { recursive: true });
  writeFileSync(extensionRecordingFile(home), JSON.stringify(recording), { mode: 0o600 });
}

function recordingInProgress(home: string): string | null {
  const lock = join(chromeForClipyDir(home), "capture.lock");
  if (existsSync(lock)) {
    const owner = Number(readFileSync(lock, "utf8"));
    if (Number.isInteger(owner) && owner > 0 && pidAlive(owner)) return "a chrome-for-clipy session is recording";
  }
  try {
    const marker = JSON.parse(readFileSync(extensionRecordingFile(home), "utf8")) as { untilEpochMs?: number };
    // Ten minutes of grace past the auto-stop covers the upload.
    if (typeof marker.untilEpochMs === "number" && marker.untilEpochMs + 600_000 > Date.now()) {
      return "the Clipy extension is recording";
    }
  } catch {
    // no marker
  }
  return null;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return true;
}

async function relaunchForFlags(pid: number, home: string): Promise<string | null> {
  const busy = recordingInProgress(home);
  if (busy) {
    return `Chrome for Clipy was started without the current launch flags, but ${busy}. Finish that recording, then run \`clipy chrome stop\` and try again`;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return null;
  }
  if (await waitForExit(pid, 10_000)) return null;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return null;
  }
  return (await waitForExit(pid, 5_000)) ? null : `Chrome for Clipy (pid ${pid}) did not exit for a relaunch`;
}

async function cdpReachable(port: number): Promise<{ ok: boolean; browser?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { Browser?: string };
    return { ok: true, browser: body.Browser };
  } catch {
    return { ok: false };
  }
}

export interface ChromeStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  cdpUrl: string | null;
  cdpReady: boolean;
  browser: string | null;
  profileDir: string;
  appInstalled: boolean;
}

export async function chromeStatus(home: string, platform: NodeJS.Platform): Promise<ChromeStatus> {
  const state = readState(home);
  const port = state?.port ?? DEFAULT_CDP_PORT;
  const cdp = await cdpReachable(port);
  // The pid can go stale after a relaunch. Verify the current listener before
  // exposing its endpoint, even when the saved browser process is still alive.
  const candidate = findListenerPid(port);
  const listenerOwned = ownsChrome(candidate, home, port);
  const pid = listenerOwned ? candidate
    : state && ownsChrome(state.pid, home, port) ? state.pid : null;
  const running = pid !== null;
  return {
    running,
    pid,
    port: running ? port : null,
    cdpUrl: listenerOwned && cdp.ok ? `http://127.0.0.1:${port}` : null,
    cdpReady: listenerOwned && cdp.ok,
    browser: listenerOwned && cdp.ok ? cdp.browser ?? null : null,
    profileDir: profileDir(home),
    appInstalled: platform === "darwin" ? existsSync(appBundlePath(home)) : false,
  };
}

/** The pid actually listening on the CDP port, for instances we did not spawn
 *  (the .app launcher, a profile-picker relaunch) whose pid our state file
 *  cannot know. */
function findListenerPid(port: number): number | null {
  try {
    const out = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    const pid = Number.parseInt(out.stdout.trim().split("\n")[0] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function startChrome(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  port: number,
): Promise<{ ok: true; state: ChromeForClipyState } | { ok: false; error: string }> {
  if (env.CLIPY_DISABLE_CDP === "1") return { ok: false, error: "Chrome for Clipy requires CDP, but CLIPY_DISABLE_CDP=1" };
  const existing = readState(home);
  if (existing && ownsChrome(existing.pid, home, existing.port)) {
    if (!ownsChrome(findListenerPid(existing.port), home, existing.port)) {
      return { ok: false, error: `CDP port ${existing.port} is not owned by Chrome for Clipy` };
    }
    if (hasCurrentFlags(existing.pid, home, existing.port, env)) {
      return (await cdpReachable(existing.port)).ok
        ? { ok: true, state: existing }
        : { ok: false, error: `Chrome is running but CDP on port ${existing.port} is not responding` };
    }
    const failed = await relaunchForFlags(existing.pid, home);
    if (failed) return { ok: false, error: failed };
  } else {
    // A live instance we did not spawn may already own the port (launched from
    // the .app, or Chrome relaunched itself and our pid went stale). Spawning a
    // duplicate into the same profile races the single-instance handoff: the
    // connect that follows can land on the dying duplicate. Adopt instead.
    const listener = findListenerPid(port);
    const cdp = await cdpReachable(port);
    if (cdp.ok || listener) {
      if (!ownsChrome(listener, home, port)) {
        return { ok: false, error: `Port ${port} is in use by a process not owned by Chrome for Clipy` };
      }
      if (hasCurrentFlags(listener, home, port, env)) {
        if (!cdp.ok) {
          return { ok: false, error: `Chrome is running but CDP on port ${port} is not responding` };
        }
        const state: ChromeForClipyState = {
          pid: listener,
          port,
          startedAt: existing?.startedAt ?? new Date().toISOString(),
          binary: existing?.binary ?? resolveChromeBinary(env, platform, home) ?? "",
        };
        mkdirSync(chromeForClipyDir(home), { recursive: true });
        writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
        return { ok: true, state };
      }
      const failed = await relaunchForFlags(listener, home);
      if (failed) return { ok: false, error: failed };
    }
  }
  const binary = resolveChromeBinary(env, platform, home);
  if (!binary) {
    return { ok: false, error: "Google Chrome not found; install it or set CLIPY_CHROME_BINARY" };
  }
  mkdirSync(profileDir(home), { recursive: true });
  seedProfileName(home);
  const child = spawn(binary, launchArgs(home, port, env), {
    detached: true,
    stdio: "ignore",
  });
  const spawnError = await new Promise<Error | null>((resolve) => {
    child.once("error", resolve);
    child.once("spawn", () => resolve(null));
  });
  if (spawnError) return { ok: false, error: `Chrome failed to spawn: ${spawnError.message}` };
  child.unref();
  if (typeof child.pid !== "number") {
    return { ok: false, error: "Chrome failed to spawn" };
  }
  const state: ChromeForClipyState = {
    pid: child.pid,
    port,
    startedAt: new Date().toISOString(),
    binary,
  };
  writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
  // CDP takes a moment; callers that need it poll. We wait briefly so `start`
  // failing to boot is reported here rather than on the caller's first request.
  for (let i = 0; i < 20; i++) {
    if ((await cdpReachable(port)).ok) {
      const listenerPid = findListenerPid(port);
      if (!ownsChrome(listenerPid, home, port)) {
        return { ok: false, error: `CDP port ${port} is not owned by Chrome for Clipy` };
      }
      state.pid = listenerPid;
      writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
      return { ok: true, state };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: `Chrome started (pid ${child.pid}) but CDP on port ${port} did not come up within 10s` };
}

export function stopChrome(home: string): { ok: boolean; stopped: boolean; error?: string } {
  const state = readState(home);
  const port = state?.port ?? DEFAULT_CDP_PORT;
  const listener = findListenerPid(port);
  const pid = state && ownsChrome(state.pid, home, port) ? state.pid
    : ownsChrome(listener, home, port) ? listener : null;
  if (!pid) {
    rmSync(stateFile(home), { force: true });
    return { ok: true, stopped: false };
  }
  try {
    process.kill(pid, "SIGTERM");
    rmSync(stateFile(home), { force: true });
    return { ok: true, stopped: true };
  } catch (error) {
    return { ok: false, stopped: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Capture engine: session recording inside Chrome for Clipy
// ---------------------------------------------------------------------------
//
// A hidden "recorder" page (file://, because about:blank is not a secure
// context and has no navigator.mediaDevices) getDisplayMedia-captures the
// TARGET tab, which the launch flag auto-selects by the clipy-rec title marker.
// A CDP-dispatched click provides the user activation. The target is loaded
// first (an about:blank tab registers no title with the capture source list),
// and the capture then follows the tab through later navigations, because tab
// capture is bound to the tab, not the page. Chunks stream to disk as
// MediaRecorder produces them, so a crashed daemon leaves a playable prefix.

/** Structural slices of Playwright's Page/Browser. The daemon passes real
 *  Playwright objects; these keep this module free of a playwright import. */
export interface CfcPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: string | ((arg: never) => T)): Promise<T>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  waitForFunction(fn: string, arg?: unknown, opts?: { timeout?: number }): Promise<unknown>;
  exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
}
export interface CfcContext {
  newPage(): Promise<CfcPage>;
  pages(): CfcPage[];
  newCDPSession(page: CfcPage): Promise<{ send(method: string, params?: Record<string, unknown>): Promise<unknown> }>;
}
export interface CfcBrowser {
  contexts(): CfcContext[];
  close(): Promise<void>;
}
export interface CfcChromium {
  connectOverCDP(endpoint: string): Promise<CfcBrowser>;
}

export interface ChromeCaptureHandle {
  /** Disconnecting handle: closing it detaches CDP and leaves Chrome running. */
  browser: CfcBrowser;
  /** The target page: the daemon navigates, instruments, and evaluates marks on it. */
  page: CfcPage;
  /** Stop MediaRecorder, flush remaining chunks, close both pages; returns the webm path. */
  stop(): Promise<string>;
  /** Abort: drop the capture and close both pages. */
  discard(): Promise<void>;
}

const RECORDER_HTML = `<!doctype html>
<title>Clipy session recorder</title>
<button id="go" style="font-size:32px">start capture</button>
<script>
  let rec = null, stream = null, starting = false;
  window.startCapture = async () => {
    if (starting) return;
    starting = true;
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: true });
    rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" });
    // Deliver chunks strictly in order: MediaRecorder events are ordered, but the
    // async exposed-function calls are not, so chain them.
    let sending = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const blob = e.data;
      sending = sending.then(async () => {
        const buf = new Uint8Array(await blob.arrayBuffer());
        for (let i = 0; i < buf.length; i += 1 << 18) {
          let s = "";
          const slice = buf.subarray(i, i + (1 << 18));
          for (let j = 0; j < slice.length; j += 0x8000)
            s += String.fromCharCode.apply(null, slice.subarray(j, j + 0x8000));
          await window.clipyChunk(btoa(s));
        }
      });
    };
    rec.onstop = () => {
      sending.then(() => {
        stream.getTracks().forEach((t) => t.stop());
        return window.clipyCaptureDone();
      }, (error) => {
        stream.getTracks().forEach((t) => t.stop());
        return window.clipyCaptureDone(String(error));
      });
    };
    rec.start(2000);
    rec.onerror = (event) => window.clipyCaptureDone(event.error?.message || "MediaRecorder failed");
    return { video: stream.getVideoTracks().length, audio: stream.getAudioTracks().length };
  };
  window.stopCapture = () => { if (rec && rec.state !== "inactive") rec.stop(); else window.clipyCaptureDone(); };
  document.getElementById("go").addEventListener("click", async () => {
    try {
      document.body.dataset.result = JSON.stringify(await window.startCapture());
    } catch (e) {
      document.body.dataset.result = JSON.stringify({ error: e.name + ": " + e.message });
    }
  });
</script>
`;

export async function startChromeForClipyCapture(
  chromium: CfcChromium,
  opts: {
    home: string;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    port: number;
    tmpDir: string;
    /** Loaded into the target tab BEFORE capture starts (see the marker note below). */
    targetUrl: string;
    log: (m: string) => void;
  },
): Promise<ChromeCaptureHandle> {
  const started = await startChrome(opts.home, opts.env, opts.platform, opts.port);
  if (!started.ok) throw new Error(`Chrome for Clipy is not available: ${started.error}`);

  opts.log(`chrome ready (pid ${started.state.pid || "adopted"}); connecting CDP`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${started.state.port}`);
  opts.log("CDP connected");
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error("Chrome for Clipy has no browser context to attach to");
  }

  let target: CfcPage | undefined;
  let recorder: CfcPage | undefined;
  const captureLock = join(chromeForClipyDir(opts.home), "capture.lock");
  let locked = false;
  const cleanup = async () => {
    if (target) await target.close().catch(() => {});
    if (recorder) await recorder.close().catch(() => {});
    await browser.close().catch(() => {});
    if (locked) {
      rmSync(captureLock, { force: true });
      locked = false;
    }
  };
  try {
    if (existsSync(captureLock)) {
      const owner = Number(readFileSync(captureLock, "utf8"));
      if (Number.isInteger(owner) && owner > 0 && !pidAlive(owner)) rmSync(captureLock, { force: true });
    }
    try {
      writeFileSync(captureLock, String(process.pid), { flag: "wx", mode: 0o600 });
      locked = true;
    } catch {
      throw new Error("Chrome for Clipy already has an active capture; stop or abort it first");
    }

    // The launch flag selects by title across the entire browser. A leftover
    // or unrelated marker-titled tab makes that selection ambiguous. Leave it
    // alone and refuse capture rather than risk recording the wrong tab.
    for (const existingPage of context.pages()) {
      if ((await existingPage.title()).includes(TAB_CAPTURE_TITLE_MARKER)) {
        throw new Error(`Another tab contains the capture marker "${TAB_CAPTURE_TITLE_MARKER}"; rename or close it before recording`);
      }
    }

    // Navigate the target FIRST: an about:blank tab does not register a title
    // with the capture source list, so the marker would match nothing and
    // getDisplayMedia rejects (InvalidStateError) instead of auto-selecting.
    // The marker title is pinned against SPA title rewrites only until capture
    // selects the tab; afterwards the capture follows the tab regardless.
    target = await context.newPage();
    try {
      await target.goto(opts.targetUrl, { waitUntil: "load", timeout: 30_000 });
    } catch {
      opts.log("target page load timed out; capturing its current state anyway");
    }
    opts.log("target page loaded; starting capture");
    const marker = `${TAB_CAPTURE_TITLE_MARKER} session target`;
    await target.evaluate(
      `(() => {
        let original = document.title;
        document.title = ${JSON.stringify(marker)};
        const el = document.querySelector("title");
        const observer = new MutationObserver(() => {
          if (document.title !== ${JSON.stringify(marker)}) {
            original = document.title;
            document.title = ${JSON.stringify(marker)};
          }
        });
        if (el) observer.observe(el, { childList: true });
        globalThis.__clipyRestoreCaptureTitle = () => {
          observer.disconnect();
          if (document.title === ${JSON.stringify(marker)}) document.title = original;
          delete globalThis.__clipyRestoreCaptureTitle;
        };
      })()`,
    );

    const videoPath = join(opts.tmpDir, "capture.webm");
    mkdirSync(opts.tmpDir, { recursive: true });
    writeFileSync(videoPath, Buffer.alloc(0));
    let captureDone: (error?: string) => void;
    const captureFinished = new Promise<string | undefined>((r) => (captureDone = r));

    recorder = await context.newPage();
    await recorder.exposeFunction("clipyChunk", (b64: string) => {
      appendFileSync(videoPath, Buffer.from(b64, "base64"));
    });
    await recorder.exposeFunction("clipyCaptureDone", (error?: string) => captureDone(error));
    const recorderHtml = join(opts.tmpDir, "recorder.html");
    writeFileSync(recorderHtml, RECORDER_HTML);
    await recorder.goto(pathToFileURL(recorderHtml).href);

    // getDisplayMedia requires the calling document to be FOCUSED, and this
    // Chrome window is usually in the OS background while an agent drives it.
    // Playwright emulates focus for browsers it launches but not over CDP
    // attach, so enable it explicitly. Without this the capture rejects with
    // InvalidStateError whenever the window isn't frontmost.
    try {
      const cdp = await context.newCDPSession(recorder);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (error) {
      opts.log(`focus emulation unavailable (${error instanceof Error ? error.message : String(error)}); capture may require the window to be frontmost`);
    }

    // The trusted click is the user activation; first attempts can hang without
    // resolving OR rejecting (observed on Chrome 152), hence the retry loop.
    let resultRaw: string | null = null;
    for (let attempt = 1; attempt <= 3 && !resultRaw; attempt++) {
      if (attempt > 1) await recorder.goto(pathToFileURL(recorderHtml).href);
      await recorder.bringToFront();
      await recorder.click("#go", { timeout: 5000 });
      try {
        // Plain EXPRESSION strings: an arrow-function string is itself a truthy
        // expression to Playwright, which made this resolve instantly and the
        // retry loop fire concurrent getDisplayMedia calls (→ InvalidStateError).
        await recorder.waitForFunction("document.body.dataset.result", undefined, { timeout: 15000 });
        resultRaw = (await recorder.evaluate<string | undefined>("document.body.dataset.result")) ?? null;
      } catch {
        opts.log(`capture attempt ${attempt} did not resolve within 15s; retrying`);
      }
    }
    if (!resultRaw) {
      throw new Error("getDisplayMedia never resolved. Is this Chrome running with the Chrome for Clipy launch flags?");
    }
    const tracks = JSON.parse(resultRaw) as { video?: number; audio?: number; error?: string };
    if (tracks.error || !tracks.video) {
      throw new Error(`tab capture failed: ${tracks.error ?? "no video track"}`);
    }
    await target.evaluate("globalThis.__clipyRestoreCaptureTitle?.()");
    opts.log(`tab capture live (${tracks.video} video, ${tracks.audio ?? 0} audio track${tracks.audio === 1 ? "" : "s"})`);

    const recorderPage = recorder;
    const finish = async (keep: boolean): Promise<string> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (keep) {
          await recorderPage.evaluate("window.stopCapture()");
          const error = await Promise.race([
            captureFinished,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Capture did not finish flushing within 15s")), 15_000);
            }),
          ]);
          if (error) throw new Error(`Capture failed: ${error}`);
        }
        return videoPath;
      } finally {
        if (timer) clearTimeout(timer);
        await cleanup();
        if (!keep) rmSync(videoPath, { force: true });
      }
    };

    return {
      browser,
      page: target,
      stop: () => finish(true),
      discard: async () => {
        await finish(false);
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// macOS launcher bundle: "Chrome for Clipy.app"
// ---------------------------------------------------------------------------

export function appBundlePath(home: string): string {
  return join(home, "Applications", `${APP_NAME}.app`);
}

/**
 * Install "Chrome for Clipy.app": a small launcher bundle carrying the name,
 * the icon, and the baked-in launch flags. It gives the automation browser a
 * saved, named identity in Finder/Spotlight/login items; while RUNNING, the
 * Dock still shows Google Chrome, because macOS attributes a process to the
 * bundle that owns its executable.
 *
 * A full FORK (copy Chrome.app, rename, re-icon, ad-hoc re-sign) was built
 * and rejected on 2026-09-02: changing the bundle identifier and re-signing
 * breaks Chrome's helper processes (pages stop loading and CDP wedges),
 * even with entitlements preserved. Branded Chrome does not tolerate being
 * forked. If full Dock branding becomes a requirement, base the fork on
 * "Google Chrome for Testing" (unbranded, automation-tolerant, but ships
 * without the proprietary codecs many sites need) rather than retrying this.
 */
export function installApp(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  port: number,
): { ok: true; path: string } | { ok: false; error: string } {
  if (platform !== "darwin") {
    return { ok: false, error: "the launcher app is macOS-only; use `clipy chrome start` elsewhere" };
  }
  const binary = resolveChromeBinary(env, platform, home);
  if (!binary) {
    return { ok: false, error: "Google Chrome not found; install it or set CLIPY_CHROME_BINARY" };
  }
  const bundle = appBundlePath(home);
  // A previous install may be the abandoned 1.3GB fork, so replace it wholesale.
  rmSync(bundle, { recursive: true, force: true });
  const macos = join(bundle, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  // The Chrome-roundel-with-Clipy-hub icon ships in the package's assets/.
  // Best-effort: a missing asset (source checkout without the file) still
  // produces a working, if blank-iconed, launcher.
  let hasIcon = false;
  try {
    const iconSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "chrome-for-clipy.icns");
    if (existsSync(iconSrc)) {
      const resources = join(bundle, "Contents", "Resources");
      mkdirSync(resources, { recursive: true });
      copyFileSync(iconSrc, join(resources, "chrome-for-clipy.icns"));
      hasIcon = true;
    }
  } catch {
    // icon is cosmetic
  }
  const args = launchArgs(home, port, env)
    .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
    .join(" \\\n  ");
  writeFileSync(
    join(macos, "chrome-for-clipy"),
    `#!/bin/sh\nexec '${binary.replace(/'/g, `'\\''`)}' \\\n  ${args}\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>online.clipy.chrome-for-clipy</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>chrome-for-clipy</string>${hasIcon ? "\n  <key>CFBundleIconFile</key><string>chrome-for-clipy</string>" : ""}
</dict>
</plist>
`,
  );
  return { ok: true, path: bundle };
}
