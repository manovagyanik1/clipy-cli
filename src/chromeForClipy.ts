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
import { listenerPid, processArgs, processExists, terminateProcess, type ArgMatcher, type Probe } from "./processProbe.js";

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
  if (platform === "win32") return windowsChromeCandidates(env, platform).find((p) => existsSync(p)) ?? null;
  return null;
}

/** Windows env names are case-insensitive, but a copied env object (`{...process.env}`) is not. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return undefined;
}

/** System-wide installs, then the per-user install, then whatever the
 *  installer registered under App Paths (covers a non-default install dir). */
export function windowsChromeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "win32"): string[] {
  const suffix = join("Google", "Chrome", "Application", "chrome.exe");
  const out: string[] = [];
  for (const root of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"]) {
    const dir = envValue(env, root);
    if (dir) out.push(join(dir, suffix));
  }
  // The registry is only readable on a real Windows host.
  if (platform === "win32" && process.platform === "win32") {
    for (const hive of ["HKCU", "HKLM"]) {
      const registered = readAppPath(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, env);
      if (registered) out.push(registered);
    }
  }
  return [...new Set(out)];
}

function readAppPath(key: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync("reg", ["query", key, "/ve"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (result.error || result.status !== 0) return null;
  // "    (Default)    REG_SZ    C:\...\chrome.exe". The value name is localized
  // ("(Standard)", …), so anchor on the type token instead.
  const match = /\bREG_(EXPAND_)?SZ\s+(.+?)\s*$/m.exec(result.stdout ?? "");
  if (!match?.[2]) return null;
  const value = match[2].replace(/^"(.*)"$/, "$1");
  return match[1] ? value.replace(/%([^%]+)%/g, (whole, name: string) => envValue(env, name) ?? whole) : value;
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
    // pid 0: launched in the background, pid not known until CDP answers. The
    // port is what matters then; status and stop find the listener on it.
    return Number.isInteger(parsed.pid) && parsed.pid >= 0 &&
      Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535 &&
      typeof parsed.binary === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** The host cannot answer an ownership question (a probe tool is missing or
 *  failed). Surfaced as an explicit error: never guessed as "ours", which would
 *  let a reused PID or a foreign debugging port be adopted or signalled, and
 *  never as "not ours", which is what made every Windows start fail with a
 *  misleading "not owned" error. */
export class OwnershipUnverifiableError extends Error {}

function probed<T>(result: Probe<T>, what: string): T {
  if (!result.supported) {
    throw new OwnershipUnverifiableError(
      `Chrome for Clipy cannot verify ${what} on ${process.platform}: ${result.reason}`,
    );
  }
  return result.value;
}

/** The pid actually listening on the CDP port, for instances we did not spawn
 *  (the .app launcher, a profile-picker relaunch) whose pid our state file
 *  cannot know. */
function findListenerPid(port: number): number | null {
  return probed(listenerPid(port), `which process listens on port ${port}`);
}

/** A PID or listening port can be reused. Check the process's launch arguments
 * before adopting it or sending a signal, including instances from the launcher.
 * Returns the process's argument matcher when it is ours, so a follow-up flag
 * check does not re-read the command line. */
function ownedInstance(pid: number | null, home: string, port: number): ArgMatcher | null {
  if (!pid || !processExists(pid)) return null;
  const matcher = probed(processArgs(pid), `the launch arguments of pid ${pid}`);
  return matcher && matcher(identityArgs(home, port)) ? matcher : null;
}

function ownsChrome(pid: number | null, home: string, port: number): pid is number {
  return ownedInstance(pid, home, port) !== null;
}

/** Our instance, but started without today's flags (an older CLI, an old
 *  launcher app, or a flag added since). It has to be relaunched: flags only
 *  apply when Chrome starts. */
function hasCurrentFlags(instance: ArgMatcher, home: string, port: number, env: NodeJS.ProcessEnv): boolean {
  return instance(launchArgs(home, port, env));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    if (Number.isInteger(owner) && owner > 0 && processExists(owner)) return "a chrome-for-clipy session is recording";
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
  while (processExists(pid)) {
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
  return (await stopProcess(pid)) ? null : `Chrome for Clipy (pid ${pid}) did not exit for a relaunch`;
}

/** Graceful stop, escalating to a kill after 10s. True once the pid is gone. */
async function stopProcess(pid: number): Promise<boolean> {
  try {
    terminateProcess(pid, false);
  } catch {
    return !processExists(pid);
  }
  if (await waitForExit(pid, 10_000)) return true;
  try {
    terminateProcess(pid, true);
  } catch {
    return !processExists(pid);
  }
  return waitForExit(pid, 5_000);
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
  /** The macOS launcher bundle exists. Always false elsewhere: there is no launcher to install. */
  appInstalled: boolean;
  /** Set when the host could not verify ownership; running/pid are then unknown, reported as not running. */
  error?: string;
}

export async function chromeStatus(home: string, platform: NodeJS.Platform): Promise<ChromeStatus> {
  const state = readState(home);
  const port = state?.port ?? DEFAULT_CDP_PORT;
  const cdp = await cdpReachable(port);
  const base = {
    profileDir: profileDir(home),
    appInstalled: platform === "darwin" ? existsSync(appBundlePath(home)) : false,
  };
  try {
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
      ...base,
    };
  } catch (error) {
    if (!(error instanceof OwnershipUnverifiableError)) throw error;
    return { running: false, pid: null, port: null, cdpUrl: null, cdpReady: false, browser: null, ...base, error: error.message };
  }
}

/** Whether this host can run the ownership checks at all, for `clipy doctor`.
 *  Probes the listener table and this very process's command line, so a pass
 *  means both tools ran and parsed real output. */
export function ownershipProbeStatus(): { ok: true } | { ok: false; error: string } {
  try {
    findListenerPid(DEFAULT_CDP_PORT);
    const self = probed(processArgs(process.pid), "the launch arguments of this process");
    if (!self) return { ok: false, error: "this process's own command line is not readable" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** `/Applications/Google Chrome.app` for a binary inside an app bundle. */
function appBundleOf(binary: string): string | null {
  return /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(binary)?.[1] ?? null;
}

/** The pid of the frontmost app. `lsappinfo` answers in a few milliseconds,
 *  which matters: the guard below races Chrome's own activation. */
function frontmostPid(): number | null {
  const asn = spawnSync("lsappinfo", ["front"], { encoding: "utf8" }).stdout?.trim();
  if (!asn) return null;
  const info = spawnSync("lsappinfo", ["info", "-only", "pid", asn], { encoding: "utf8" }).stdout ?? "";
  const pid = Number(/"pid"=(\d+)/.exec(info)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Activate an app by pid. By pid, not bundle id, because the app the user was
 *  in may itself be Google Chrome, which shares our instance's bundle id. */
function activatePid(pid: number): void {
  spawnSync("osascript", [
    "-l", "JavaScript", "-e",
    `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions(0)`,
  ], { stdio: "ignore", timeout: 2000 });
}

/** `open -g` asks macOS not to bring Chrome forward, but Chrome activates
 *  itself about half a second into startup anyway. While the launch settles,
 *  hand focus back to whatever the user was in whenever OUR instance takes it.
 *  The user switching apps themselves is left alone. */
function guardFocus(home: string, port: number): () => void {
  const previous = frontmostPid();
  if (previous === null) return () => {};
  const timer = setInterval(() => {
    const front = frontmostPid();
    if (front === null || front === previous) return;
    let ours: boolean;
    try {
      ours = ownsChrome(front, home, port);
    } catch {
      return; // unverifiable: leave focus alone rather than guess
    }
    if (ours) activatePid(previous);
  }, 50);
  return () => clearInterval(timer);
}

/** Brings an already-running instance forward for `--foreground`, which
 *  otherwise only affects a fresh launch. macOS activates the app by pid; other
 *  platforms ask Chrome to activate a page target over CDP, which raises its
 *  window. Best effort: a running browser is still a successful start. */
async function bringToForeground(pid: number, port: number, platform: NodeJS.Platform): Promise<void> {
  if (platform === "darwin") {
    activatePid(pid);
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    const targets = (await res.json()) as Array<{ id?: string; type?: string }>;
    const page = targets.find((t) => t.type === "page" && t.id);
    if (page?.id) {
      await fetch(`http://127.0.0.1:${port}/json/activate/${encodeURIComponent(page.id)}`, {
        signal: AbortSignal.timeout(2000),
      });
    }
  } catch {
    // nothing to raise, or CDP refused; the instance is still usable
  }
}

/** How long a background launch with no pid yet counts as still starting. */
const PENDING_LAUNCH_MS = 60_000;

function launchPending(state: ChromeForClipyState): boolean {
  return state.pid === 0 && Date.now() - Date.parse(state.startedAt) < PENDING_LAUNCH_MS;
}

/** How long `stop` waits for a still-starting background launch to open CDP. */
const PENDING_STOP_WAIT_MS = 10_000;

async function waitForOwnedListener(home: string, port: number, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listener = findListenerPid(port);
    if (ownsChrome(listener, home, port)) return listener;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Chrome's self-activation was observed 0.4-0.5s after launch; keep guarding
 *  past CDP coming up so a late activation is still caught. */
const FOCUS_GUARD_MIN_MS = 3000;

export interface StartChromeOptions {
  /** Bring the window forward, for steps a person does (sign in, install the
   *  extension). Agent launches stay in the background. */
  foreground?: boolean;
}

export async function startChrome(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  port: number,
  opts: StartChromeOptions = {},
): Promise<{ ok: true; state: ChromeForClipyState } | { ok: false; error: string }> {
  if (env.CLIPY_DISABLE_CDP === "1") return { ok: false, error: "Chrome for Clipy requires CDP, but CLIPY_DISABLE_CDP=1" };
  try {
    return await startChromeVerified(home, env, platform, port, opts);
  } catch (error) {
    if (error instanceof OwnershipUnverifiableError) return { ok: false, error: error.message };
    throw error;
  }
}

async function startChromeVerified(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  port: number,
  opts: StartChromeOptions,
): Promise<{ ok: true; state: ChromeForClipyState } | { ok: false; error: string }> {
  const existing = readState(home);
  const existingInstance = existing ? ownedInstance(existing.pid, home, existing.port) : null;
  if (existing && existingInstance) {
    // No listener yet (still booting) is not a foreign owner; the CDP check
    // below reports it as not responding. Our own pid needs no second read.
    const listener = findListenerPid(existing.port);
    if (listener !== null && listener !== existing.pid && !ownsChrome(listener, home, existing.port)) {
      return { ok: false, error: `CDP port ${existing.port} is not owned by Chrome for Clipy` };
    }
    if (hasCurrentFlags(existingInstance, home, existing.port, env)) {
      if (!(await cdpReachable(existing.port)).ok) {
        return { ok: false, error: `Chrome is running but CDP on port ${existing.port} is not responding` };
      }
      if (opts.foreground) await bringToForeground(existing.pid, existing.port, platform);
      return { ok: true, state: existing };
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
      const listenerInstance = ownedInstance(listener, home, port);
      if (!listener || !listenerInstance) {
        return { ok: false, error: `Port ${port} is in use by a process not owned by Chrome for Clipy` };
      }
      if (hasCurrentFlags(listenerInstance, home, port, env)) {
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
        if (opts.foreground) await bringToForeground(listener, port, platform);
        return { ok: true, state };
      }
      const failed = await relaunchForFlags(listener, home);
      if (failed) return { ok: false, error: failed };
    }
  }
  // A background launch that has not answered yet: a second instance into the
  // same profile would race the first one's single-instance handoff.
  if (existing && launchPending(existing)) {
    return { ok: false, error: `Chrome for Clipy is still starting on port ${existing.port}; try again in a moment` };
  }
  const binary = resolveChromeBinary(env, platform, home);
  if (!binary) {
    return { ok: false, error: "Google Chrome not found; install it or set CLIPY_CHROME_BINARY" };
  }
  mkdirSync(profileDir(home), { recursive: true });
  seedProfileName(home);
  const state: ChromeForClipyState = { pid: 0, port, startedAt: new Date().toISOString(), binary };
  // Spawning the binary directly always activates Chrome on macOS. LaunchServices
  // with -g does not, and -n starts a new instance instead of handing the
  // arguments to the user's own running Chrome. It leaves us no child pid; the
  // pid comes from the CDP listener below, as it already did for adoption.
  const bundle = platform === "darwin" && !opts.foreground ? appBundleOf(binary) : null;
  const launchedAt = Date.now();
  let stopGuard: () => void = () => {};
  // Only a browser we hold a child handle for can be stopped on a failed start:
  // the handle, not a pid lookup, proves it is ours. An `open` launch has none.
  let abandon = (error: string) => {
    rmSync(stateFile(home), { force: true });
    return { ok: false as const, error };
  };
  if (bundle) {
    stopGuard = guardFocus(home, port);
    const opened = spawnSync("open", ["-g", "-n", "-a", bundle, "--args", ...launchArgs(home, port, env)], { encoding: "utf8" });
    if (opened.status !== 0) {
      stopGuard();
      return { ok: false, error: `Chrome failed to launch: ${(opened.stderr || opened.error?.message || "open failed").trim()}` };
    }
    // Saved before CDP answers so a slow first boot on a non-default port stays
    // discoverable by status and stop.
    writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
  } else {
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
    const spawnedPid = child.pid;
    state.pid = spawnedPid;
    writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
    // We launched this browser, so a start that fails after this point must not
    // leave it running untracked (nothing else would ever stop it).
    abandon = (error: string) => {
      if (child.exitCode === null && child.signalCode === null && processExists(spawnedPid)) {
        try {
          terminateProcess(spawnedPid, true);
        } catch {
          // already gone
        }
      }
      rmSync(stateFile(home), { force: true });
      return { ok: false as const, error };
    };
  }
  try {
    // CDP takes a moment; callers that need it poll. We wait briefly so `start`
    // failing to boot is reported here rather than on the caller's first request.
    for (let i = 0; i < 20; i++) {
      if ((await cdpReachable(port)).ok) {
        let listenerPid: number | null;
        try {
          listenerPid = findListenerPid(port);
          if (!ownsChrome(listenerPid, home, port)) {
            return abandon(`CDP port ${port} is not owned by Chrome for Clipy`);
          }
        } catch (error) {
          if (error instanceof OwnershipUnverifiableError) return abandon(error.message);
          throw error;
        }
        state.pid = listenerPid;
        writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
        const settle = FOCUS_GUARD_MIN_MS - (Date.now() - launchedAt);
        if (bundle && settle > 0) await new Promise((r) => setTimeout(r, settle));
        return { ok: true, state };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Left running and tracked on purpose: a slow first boot (profile creation,
    // an update) may still come up, and `clipy chrome stop` can verify and stop it.
    return {
      ok: false,
      error: `Chrome started${state.pid ? ` (pid ${state.pid})` : ""} but CDP on port ${port} did not come up within 10s`,
    };
  } finally {
    stopGuard();
  }
}

export async function stopChrome(home: string): Promise<{ ok: boolean; stopped: boolean; error?: string }> {
  const state = readState(home);
  const port = state?.port ?? DEFAULT_CDP_PORT;
  let pid: number | null;
  try {
    pid = state && ownsChrome(state.pid, home, port) ? state.pid : null;
    if (!pid) {
      const listener = findListenerPid(port);
      pid = ownsChrome(listener, home, port) ? listener : null;
    }
    if (!pid && state && launchPending(state)) {
      // A background launch that has not opened CDP yet. The state file is the
      // only record of its port, so wait for it rather than forget it.
      pid = await waitForOwnedListener(home, port, PENDING_STOP_WAIT_MS);
      if (!pid) {
        return {
          ok: false,
          stopped: false,
          error: `Chrome for Clipy is still starting on port ${port}; run \`clipy chrome stop\` again in a moment`,
        };
      }
    }
  } catch (error) {
    // Unverifiable is not "not running": keep the state file so a later stop
    // (with the probe fixed) still finds the browser.
    if (error instanceof OwnershipUnverifiableError) return { ok: false, stopped: false, error: error.message };
    throw error;
  }
  if (!pid) {
    rmSync(stateFile(home), { force: true });
    return { ok: true, stopped: false };
  }
  if (process.platform !== "win32") {
    // POSIX: SIGTERM is a clean Chrome shutdown; returning at once is the long-standing contract.
    try {
      terminateProcess(pid, false);
      rmSync(stateFile(home), { force: true });
      return { ok: true, stopped: true };
    } catch (error) {
      return { ok: false, stopped: false, error: errorMessage(error) };
    }
  }
  // Windows: WM_CLOSE is a request, so confirm the exit and escalate if ignored.
  if (await stopProcess(pid)) {
    rmSync(stateFile(home), { force: true });
    return { ok: true, stopped: true };
  }
  return { ok: false, stopped: false, error: `Chrome for Clipy (pid ${pid}) did not exit` };
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
  close(): Promise<void>;
}
export interface CfcContext {
  newPage(): Promise<CfcPage>;
  pages(): CfcPage[];
  /** Playwright's "page" event, fired as a tab is created. */
  on?(event: "page", listener: (page: CfcPage) => void): unknown;
  off?(event: "page", listener: (page: CfcPage) => void): unknown;
  newCDPSession(page: CfcPage): Promise<{ send(method: string, params?: Record<string, unknown>): Promise<unknown>; detach?(): Promise<void> }>;
}
export interface CfcBrowser {
  contexts(): CfcContext[];
  newBrowserCDPSession(): Promise<{ send(method: string, params?: Record<string, unknown>): Promise<unknown>; detach(): Promise<void> }>;
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

/** Opens a tab without making Chrome the frontmost app. On macOS, Playwright's
 *  newPage(), bringToFront() and Target.activateTarget all activate Chrome
 *  (measured on Chrome 154); a background Target.createTarget does not. With
 *  `newWindow` the tab gets its own background window, where it is the active,
 *  visible tab without anything being activated. */
async function newBackgroundPage(browser: CfcBrowser, context: CfcContext, newWindow = false): Promise<CfcPage> {
  const before = new Set(context.pages());
  const cdp = await browser.newBrowserCDPSession();
  let targetId: string | undefined;
  try {
    const created = (await cdp.send("Target.createTarget", { url: "about:blank", background: true, newWindow })) as {
      targetId?: string;
    };
    targetId = created?.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
  if (!targetId) throw new Error("Chrome for Clipy did not report the background tab it opened");
  // Match by target id: an agent may open its own tab at the same moment, and
  // "the first new page" would then be theirs.
  const checked = new Set<CfcPage>(before);
  for (let i = 0; i < 100; i++) {
    for (const page of context.pages()) {
      if (checked.has(page)) continue;
      checked.add(page);
      if ((await pageTargetId(context, page)) === targetId) return page;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Chrome for Clipy did not open a background tab");
}

async function pageTargetId(context: CfcContext, page: CfcPage): Promise<string | null> {
  try {
    const session = await context.newCDPSession(page);
    try {
      const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
      return info?.targetInfo?.targetId ?? null;
    } finally {
      await session.detach?.().catch(() => {});
    }
  } catch {
    return null; // closed while we looked
  }
}

/** While a capture runs, the agent driving Chrome for Clipy may open tabs with
 *  newPage(), and each one pulls Chrome to the front. When Chrome takes focus
 *  right after a tab appears, hand it back to the app the user was in. Focus
 *  the user gives the window themselves (clicking into it to watch) is left
 *  alone: only a steal within a moment of a new tab is undone. */
interface TabFocusGuard {
  /** Opens one of Clipy's own background tabs. Tabs made this way never arm
   *  the guard: they do not activate Chrome, so focus the user gives Chrome
   *  right after one is theirs. */
  ownTab(create: () => Promise<CfcPage>): Promise<CfcPage>;
  stop(): void;
}

function guardTabFocus(chromePid: number, context: CfcContext, platform: NodeJS.Platform): TabFocusGuard {
  if (platform !== "darwin" || chromePid <= 0) return { ownTab: (create) => create(), stop: () => {} };
  const guard = createTabStealGuard(chromePid, activatePid);
  const stopWatching = watchFrontmost((pid) => guard.frontChanged(pid));
  const tabs = trackAgentTabs(context, (at) => guard.tabOpened(at));
  return {
    ownTab: tabs.ownTab,
    stop() {
      tabs.stop();
      stopWatching();
    },
  };
}

/** Calls `onAgentTab` with the creation time of each tab that appears in
 *  `context`, except the ones opened through `ownTab`. Uses Playwright's
 *  "page" event, which fires as the tab is created and well before Chrome
 *  activates (0.4-0.5s), so the time is the tab's own; contexts without
 *  events are polled. A page that appears while one of our own tabs is being
 *  opened is held back, with its time, until that tab is identified: ours is
 *  ignored, any other is the agent's. Exported for tests. */
export function trackAgentTabs(
  context: Pick<CfcContext, "pages" | "on" | "off">,
  onAgentTab: (createdAt: number) => void,
  intervalMs = 100,
): TabFocusGuard {
  const seen = new Set<CfcPage>(context.pages());
  const ours = new Set<CfcPage>();
  const held = new Map<CfcPage, number>();
  let opening = 0;
  const judge = (page: CfcPage, at: number) => {
    if (seen.has(page)) return;
    seen.add(page);
    if (!ours.has(page)) onAgentTab(at);
  };
  const consider = (page: CfcPage) => {
    if (seen.has(page) || held.has(page)) return;
    if (opening > 0 && !ours.has(page)) held.set(page, Date.now());
    else judge(page, Date.now());
  };
  const events = typeof context.on === "function";
  if (events) context.on!("page", consider);
  const timer = events ? null : setInterval(() => context.pages().forEach(consider), intervalMs);
  return {
    async ownTab(create) {
      opening++;
      try {
        const page = await create();
        ours.add(page);
        return page;
      } finally {
        opening--;
        if (opening === 0) {
          const pending = [...held];
          held.clear();
          for (const [page, at] of pending) judge(page, at);
        }
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      if (events) context.off?.("page", consider);
    },
  };
}

/** Chrome activates within a few hundred ms of opening a tab. */
const TAB_STEAL_WINDOW_MS = 1000;

/** The decision part of the tab focus guard, fed by frontmost-app changes and
 *  agent tabs (with the time each tab was created) as they happen. Chrome
 *  coming forward after a tab was created and within the steal window is
 *  undone, back to the app it displaced; Chrome already in front when the tab
 *  was created was put there by the user and is left alone. Exported for tests. */
export function createTabStealGuard(
  chromePid: number,
  activate: (pid: number) => void,
  now: () => number = Date.now,
): { frontChanged(pid: number): void; tabOpened(createdAt?: number): void } {
  let lastOther: number | null = null;
  let chromeFrontSince: number | null = null;
  let armedFrom = 0;
  let armedUntil = 0;
  const caused = (at: number) => at >= armedFrom && at < armedUntil;
  return {
    frontChanged(pid) {
      if (pid !== chromePid) {
        if (pid > 0) lastOther = pid;
        chromeFrontSince = null;
        return;
      }
      if (chromeFrontSince !== null) return; // already in front: no new activation
      chromeFrontSince = now();
      if (caused(chromeFrontSince) && lastOther !== null) activate(lastOther);
    },
    tabOpened(createdAt = now()) {
      armedFrom = createdAt;
      armedUntil = createdAt + TAB_STEAL_WINDOW_MS;
      // Reported late (held while Clipy opened its own tab): Chrome may have
      // come forward in between, after the tab existed.
      if (chromeFrontSince !== null && caused(chromeFrontSince) && lastOther !== null) activate(lastOther);
    },
  };
}

/** Reports every frontmost-app change on macOS from ONE long-lived process,
 *  instead of spawning `lsappinfo` on a timer. NSWorkspace only refreshes
 *  frontmostApplication while a run loop runs, hence runUntilDate. If the
 *  watcher cannot run, nothing is reported and the guard simply never acts. */
const FRONTMOST_WATCHER = `ObjC.import('AppKit');
var ws = $.NSWorkspace.sharedWorkspace, out = $.NSFileHandle.fileHandleWithStandardOutput, last = -1;
while (true) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  var app = ws.frontmostApplication, pid = app.isNil() ? 0 : app.processIdentifier;
  if (pid !== last) {
    last = pid;
    out.writeData($(String(pid) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
  }
}`;

function watchFrontmost(onChange: (pid: number) => void): () => void {
  const child = spawn("osascript", ["-l", "JavaScript", "-e", FRONTMOST_WATCHER], { stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", () => {});
  child.unref();
  let pending = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const pid = Number(pending.slice(0, nl).trim());
      pending = pending.slice(nl + 1);
      if (Number.isInteger(pid) && pid > 0) onChange(pid);
    }
  });
  (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
  return () => {
    child.kill();
  };
}

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
    /** Called with the new target tab before it loads `targetUrl`, so
     *  listeners (browser evidence) see the first page load. */
    onTargetPage?: (page: CfcPage) => void | Promise<void>;
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
  const tabGuard = guardTabFocus(started.state.pid, context, opts.platform);
  const cleanup = async () => {
    tabGuard.stop();
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
      if (Number.isInteger(owner) && owner > 0 && !processExists(owner)) rmSync(captureLock, { force: true });
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
    target = await tabGuard.ownTab(() => newBackgroundPage(browser, context));
    try {
      await opts.onTargetPage?.(target);
    } catch (err) {
      opts.log(`target page hook failed: ${(err as Error).message}`);
    }
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

    // getDisplayMedia rejects (InvalidStateError) from a tab that is not the
    // active one, so the recorder gets its own background window.
    recorder = await tabGuard.ownTab(() => newBackgroundPage(browser, context, true));
    await recorder.exposeFunction("clipyChunk", (b64: string) => {
      appendFileSync(videoPath, Buffer.from(b64, "base64"));
    });
    await recorder.exposeFunction("clipyCaptureDone", (error?: string) => captureDone(error));
    const recorderHtml = join(opts.tmpDir, "recorder.html");
    writeFileSync(recorderHtml, RECORDER_HTML);
    await recorder.goto(pathToFileURL(recorderHtml).href);

    // getDisplayMedia requires the calling document to be FOCUSED, and this
    // Chrome window stays in the OS background while an agent drives it.
    // Playwright emulates focus for browsers it launches but not over CDP
    // attach, so enable it explicitly. Without this the capture rejects with
    // InvalidStateError whenever the window isn't frontmost. The recorder is
    // already the active tab of its own window, so no bringToFront() is needed;
    // on macOS that call activates Chrome.
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
