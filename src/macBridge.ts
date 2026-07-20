/**
 * Mac bridge client — drives real screen recordings through the running
 * Clipy desktop app over its Unix-socket agent bridge (agent_bridge.rs).
 *
 * Discovery: ~/Library/Application Support/Clipy/agent-bridge.json, written
 * by the app on launch: {socketPath, token, pid, appVersion, protocolVersion}.
 * The file and socket are 0600, and every request carries the per-launch
 * token. Protocol: one JSON request line per connection, one JSON response
 * line back.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

export interface BridgeInfo {
  socketPath: string;
  token: string;
  pid: number;
  appVersion: string;
  protocolVersion: number;
}

export class BridgeUnavailableError extends Error {}

const REQUEST_TIMEOUT_MS = 15_000;
/** stop waits for the streaming upload to hand back the share link. */
const STOP_TIMEOUT_MS = 200_000;

/** The oldest Clipy Mac app version that ships the agent bridge this CLI drives.
 *  Older builds either don't write the discovery file at all or wrote it to a
 *  path the CLI never read (the pre-0.1.41 bundle-id location), so `--source
 *  mac-screen` silently found nothing. Surfaced by `clipy doctor` and in the
 *  stale/missing-bridge errors below. */
export const MIN_BRIDGE_APP_VERSION = "0.1.41";

const UPDATE_HINT =
  "your installed Clipy app may predate the agent bridge — update via https://clipy.online/download";

export function bridgeFilePath(): string {
  if (process.env.CLIPY_BRIDGE_FILE?.trim()) return process.env.CLIPY_BRIDGE_FILE;
  return join(homedir(), "Library", "Application Support", "Clipy", "agent-bridge.json");
}

/** Numeric-dotted version compare: a<b → -1, a==b → 0, a>b → 1. Missing/short
 *  parts count as 0 (so "0.1" == "0.1.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True only when a well-formed appVersion is present AND older than the minimum.
 *  A missing/garbled version returns false — we can't prove it's old, so callers
 *  fall back to the softer "may predate the bridge" hint instead. */
export function bridgeAppOutdated(appVersion: string | null | undefined): boolean {
  const v = appVersion?.trim();
  if (!v || !/^\d+(\.\d+)*$/.test(v)) return false;
  return compareVersions(v, MIN_BRIDGE_APP_VERSION) < 0;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads + validates the discovery file; throws BridgeUnavailableError with a
 *  diagnostic one-liner (file path, pid + liveness, appVersion, and an update
 *  hint when the app looks too old) so an agent hitting a dead end can see what
 *  was actually found and self-correct. */
export function readBridgeInfo(): BridgeInfo {
  const path = bridgeFilePath();
  if (process.platform !== "darwin" && !process.env.CLIPY_BRIDGE_FILE) {
    throw new BridgeUnavailableError(
      "--source mac-screen records through the Clipy Mac app, which only runs on macOS.",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new BridgeUnavailableError(
      `the Clipy app is not running: no agent bridge file at ${path}. ` +
        `Open Clipy (or install it from https://clipy.online/download). ` +
        `If Clipy IS running, ${UPDATE_HINT}.`,
    );
  }
  let info: BridgeInfo;
  try {
    info = JSON.parse(raw) as BridgeInfo;
  } catch {
    throw new BridgeUnavailableError(
      `agent bridge file at ${path} is corrupt (unparseable JSON) — restart the Clipy app`,
    );
  }
  if (!info.socketPath || !info.token || typeof info.pid !== "number") {
    const seen = info.appVersion ? ` (file reports appVersion ${info.appVersion})` : "";
    throw new BridgeUnavailableError(
      `agent bridge file at ${path} is incomplete — missing socketPath/token/pid${seen}. ` +
        `Restart the Clipy app.`,
    );
  }
  if (!pidAlive(info.pid)) {
    // A dead pid whose file also reports a pre-bridge version is the classic
    // "app predates the agent bridge" shape: an older Clipy is running under a
    // different pid and can't rewrite this file (it has no bridge code), so a
    // fresh launch never clears the stale artifact. Say so, don't just say
    // "restart".
    if (bridgeAppOutdated(info.appVersion)) {
      throw new BridgeUnavailableError(
        `stale agent bridge at ${path} (pid ${info.pid} is dead, file appVersion ${info.appVersion}). ` +
          `Your installed Clipy app likely predates the agent bridge (needs ${MIN_BRIDGE_APP_VERSION}+) — ` +
          `update via https://clipy.online/download.`,
      );
    }
    throw new BridgeUnavailableError(
      `stale agent bridge at ${path}: pid ${info.pid} is not running (dead)` +
        `${info.appVersion ? `, appVersion ${info.appVersion}` : ""} — the Clipy app has quit. ` +
        `Open Clipy and try again.`,
    );
  }
  return info;
}

/** Full BridgeInfo (INCLUDING the token) straight from the discovery file,
 *  skipping the liveness/version gating readBridgeInfo does — for the doctor
 *  handshake, which wants to attempt a `status` call even against a possibly
 *  stale file. Returns null when absent/incomplete. The token this carries must
 *  never be logged or placed in doctor's printed output. */
export function bridgeInfoFromFile(): BridgeInfo | null {
  try {
    const info = JSON.parse(readFileSync(bridgeFilePath(), "utf8")) as Partial<BridgeInfo>;
    if (!info.socketPath || !info.token || typeof info.pid !== "number") return null;
    return {
      socketPath: info.socketPath,
      token: info.token,
      pid: info.pid,
      appVersion: typeof info.appVersion === "string" ? info.appVersion : "",
      protocolVersion: typeof info.protocolVersion === "number" ? info.protocolVersion : 1,
    };
  } catch {
    return null;
  }
}

/** Can we open the bridge's Unix socket at all? (Openable but unanswered is a
 *  distinct failure from a missing socket — doctor reports them separately.) */
export function probeSocketOpenable(socketPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ path: socketPath });
    let done = false;
    const finish = (openable: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolvePromise(openable);
    };
    const timer = setTimeout(() => finish(false), 2_000);
    socket.on("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/** Live handshake: ask the running app for its status (which echoes appVersion)
 *  so doctor can confirm the socket answers AND catch a discovery file that
 *  points at a different app version than the one actually replying. */
export async function probeBridgeHandshake(
  info: BridgeInfo,
): Promise<{ ok: boolean; appVersion?: string; error?: string }> {
  try {
    const data = await bridgeRequest(info, "status");
    const appVersion = typeof data.appVersion === "string" ? data.appVersion : undefined;
    return { ok: true, appVersion };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Structured, non-throwing health snapshot of the agent bridge for `clipy
 *  doctor`. Mirrors readBridgeInfo's validation but reports each sub-check
 *  (exists / parses / complete / pid alive / appVersion) instead of failing on
 *  the first problem. */
export interface BridgeDiagnostics {
  path: string;
  /** false on non-macOS without CLIPY_BRIDGE_FILE — the bridge doesn't apply. */
  applicable: boolean;
  exists: boolean;
  parses: boolean;
  complete: boolean;
  pid: number | null;
  pidAlive: boolean | null;
  appVersion: string | null;
  /** true = >= MIN, false = < MIN, null = unknown (missing/garbled version). */
  versionOk: boolean | null;
  socketPath: string | null;
  /** Discovery-file mtime (ms) — the app rewrites it on every launch (0.1.41+),
   *  so a very old mtime alongside a dead pid is the stale-artifact shape. */
  mtimeMs: number | null;
  healthy: boolean;
  detail: string;
}

export function inspectBridge(): BridgeDiagnostics {
  const path = bridgeFilePath();
  const applicable = process.platform === "darwin" || !!process.env.CLIPY_BRIDGE_FILE?.trim();
  const base: BridgeDiagnostics = {
    path,
    applicable,
    exists: false,
    parses: false,
    complete: false,
    pid: null,
    pidAlive: null,
    appVersion: null,
    versionOk: null,
    socketPath: null,
    mtimeMs: null,
    healthy: false,
    detail: "",
  };
  if (!applicable) {
    return {
      ...base,
      detail: "not macOS — the agent bridge is only used for --source mac-screen on macOS",
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {
      ...base,
      detail: "no bridge file (the Clipy app is not running, or it predates the agent bridge)",
    };
  }
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // mtime is best-effort context, not a gate
  }
  const rep: BridgeDiagnostics = { ...base, exists: true, mtimeMs };
  let info: Partial<BridgeInfo>;
  try {
    info = JSON.parse(raw) as Partial<BridgeInfo>;
  } catch {
    return { ...rep, detail: "bridge file is corrupt (unparseable JSON)" };
  }
  rep.parses = true;
  rep.appVersion = typeof info.appVersion === "string" ? info.appVersion : null;
  rep.socketPath = typeof info.socketPath === "string" ? info.socketPath : null;
  rep.pid = typeof info.pid === "number" ? info.pid : null;
  rep.complete = !!info.socketPath && !!info.token && typeof info.pid === "number";
  if (!rep.complete) {
    return { ...rep, detail: "bridge file is incomplete (missing socketPath/token/pid)" };
  }
  rep.pidAlive = pidAlive(info.pid as number);
  rep.versionOk = rep.appVersion ? !bridgeAppOutdated(rep.appVersion) : null;
  if (!rep.pidAlive) {
    return { ...rep, detail: `pid ${rep.pid} is not running (the Clipy app has quit)` };
  }
  if (bridgeAppOutdated(rep.appVersion)) {
    return {
      ...rep,
      detail: `Clipy app v${rep.appVersion} is older than the required v${MIN_BRIDGE_APP_VERSION} — ${UPDATE_HINT}`,
    };
  }
  return {
    ...rep,
    healthy: true,
    detail: `Clipy app v${rep.appVersion ?? "?"} running (pid ${rep.pid})`,
  };
}

interface BridgeOk {
  ok: true;
  data: Record<string, unknown>;
}
interface BridgeErr {
  ok: false;
  error: { code: string; message: string };
}

// --- Capture-source targeting (record a window/display, not just the screen) --

/** Mirrors the app's serde-tagged CaptureSourceDto: {type:"window",id} etc. */
export type CaptureSource =
  | { type: "display"; id: number }
  | { type: "window"; id: number }
  | { type: "area"; display_id: number; x: number; y: number; width: number; height: number };

export interface BridgeDisplay {
  id: number;
  name: string;
  width: number;
  height: number;
}

export interface BridgeWindow {
  id: number;
  app_name: string;
  title: string;
  width: number;
  height: number;
}

export interface BridgeSources {
  displays: BridgeDisplay[];
  windows: BridgeWindow[];
}

/** Enumerate capturable displays + windows from the running app. */
export async function listSources(info: BridgeInfo): Promise<BridgeSources> {
  const data = await bridgeRequest(info, "sources");
  const displays = Array.isArray(data.displays) ? (data.displays as BridgeDisplay[]) : [];
  const windows = Array.isArray(data.windows) ? (data.windows as BridgeWindow[]) : [];
  return { displays, windows };
}

export function windowLabel(w: BridgeWindow): string {
  return w.title ? `${w.app_name} — ${w.title}` : w.app_name;
}

/**
 * A structured description of the surface the CAMERA is actually pointed at,
 * read LIVE from the running app at resolve time (never carried over from an
 * earlier `clipy sources` listing — staleness is the whole point).
 *
 * Why this exists: driver-attested evidence proves what the DRIVER observed.
 * Nothing tied that to what the camera saw, so a driver working a background tab
 * could produce a truthful "10 passed" tally over footage of something else —
 * worse than unverified, because the tally vouches for the wrong footage.
 * Reporting the resolved surface lets the caller catch the mismatch in second
 * one instead of minute six.
 *
 * NOT SOLVED HERE, DELIBERATELY: Clipy does not activate/foreground the target.
 * It cannot know which tab/page/simulator/window the driver means (on
 * --source mac-screen we may not be recording a browser at all), and taking
 * control of the surface would re-import the browser-ownership premise 0.8.3
 * removed. Focusing the right surface is the caller's job; ours is to say
 * plainly what we're filming. Please don't reopen this.
 */
export interface ResolvedSource {
  /** CLOSED SET, shared with @clipy/mcp. Names WHAT THE CAMERA IS POINTED AT,
   *  never the transport — "mac-screen" is a transport and is deliberately not a
   *  kind here. ("headless_browser" is the MCP's owned-page capture.) */
  kind: "window" | "display" | "headless_browser";
  /** OMITTED when there genuinely isn't one (never null, never synthesized) — a
   *  fabricated identifier is the exact false-confidence this field prevents. */
  id?: number;
  /** The live title at resolve time. Windows fall back to the app name; displays
   *  to their name, else id + bounds. Never empty, never fabricated — and OMITTED
   *  entirely when no specific surface was resolved (the app's default capture),
   *  for the same reason `id` is: a guessed label is worse than a missing one. */
  title?: string;
  /** Windows only — the owning application. */
  app?: string;
}

export function describeWindow(w: BridgeWindow): ResolvedSource {
  return {
    kind: "window",
    id: w.id,
    // A window can legitimately have no title (some app shells); naming the app
    // is honest, inventing a title would not be.
    title: w.title || w.app_name || `window ${w.id}`,
    app: w.app_name,
  };
}

export function describeDisplay(d: BridgeDisplay): ResolvedSource {
  return {
    kind: "display",
    id: d.id,
    // Displays have no title; fall back to the name, then the identifier +
    // bounds, so the field is never an empty string.
    title: d.name || `display ${d.id} (${d.width}×${d.height})`,
  };
}

/**
 * Resolves --window/--display flags to a CaptureSource. A numeric value is
 * treated as an id from `clipy sources`; anything else is a case-insensitive
 * substring match on "app_name title" (windows) or name (displays). Ambiguity
 * throws with the candidate list — ids are unstable across app launches, so
 * silent guessing would record the wrong thing.
 */
export async function resolveCaptureSource(
  info: BridgeInfo,
  opts: { window?: string; display?: string },
): Promise<{ source: CaptureSource; label: string; resolved: ResolvedSource }> {
  if (opts.window && opts.display) {
    throw new Error("--window and --display are mutually exclusive — pick one capture source");
  }
  const sources = await listSources(info);
  if (opts.window) {
    const q = opts.window.trim();
    let matches: BridgeWindow[];
    if (/^\d+$/.test(q)) {
      matches = sources.windows.filter((w) => w.id === Number(q));
    } else {
      const needle = q.toLowerCase();
      matches = sources.windows.filter((w) =>
        `${w.app_name} ${w.title}`.toLowerCase().includes(needle),
      );
      // Several windows of several apps can match a loose substring; an exact
      // app-name match ("Chrome") is almost always what the caller meant.
      if (matches.length > 1) {
        const exactApp = matches.filter((w) => w.app_name.toLowerCase() === needle);
        if (exactApp.length >= 1) matches = exactApp;
      }
    }
    if (matches.length === 0) {
      const available = sources.windows.map((w) => `  ${w.id}  ${windowLabel(w)}`).join("\n");
      throw new Error(
        `no window matches "${q}". Available windows (clipy sources):\n${available || "  (none)"}`,
      );
    }
    if (matches.length > 1) {
      const list = matches.map((w) => `  ${w.id}  ${windowLabel(w)}`).join("\n");
      throw new Error(`"${q}" matches ${matches.length} windows — use the id instead:\n${list}`);
    }
    return {
      source: { type: "window", id: matches[0].id },
      label: windowLabel(matches[0]),
      resolved: describeWindow(matches[0]),
    };
  }
  if (opts.display) {
    const q = opts.display.trim();
    const matches = /^\d+$/.test(q)
      ? sources.displays.filter((d) => d.id === Number(q))
      : sources.displays.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));
    if (matches.length === 0) {
      const available = sources.displays.map((d) => `  ${d.id}  ${d.name}`).join("\n");
      throw new Error(`no display matches "${q}". Available displays:\n${available || "  (none)"}`);
    }
    if (matches.length > 1) {
      const list = matches.map((d) => `  ${d.id}  ${d.name}`).join("\n");
      throw new Error(`"${q}" matches ${matches.length} displays — use the id instead:\n${list}`);
    }
    return {
      source: { type: "display", id: matches[0].id },
      label: matches[0].name || `display ${matches[0].id}`,
      resolved: describeDisplay(matches[0]),
    };
  }
  throw new Error("resolveCaptureSource called without --window or --display");
}

/** One request line in, one response line out. */
export function bridgeRequest(
  info: BridgeInfo,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = cmd === "stop" ? STOP_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: info.socketPath });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(
          new Error(
            cmd === "stop"
              ? "the Clipy app did not finish the upload in time — check the app; the recording may still complete in the background"
              : `the Clipy app did not answer (${cmd}) — is it responding?`,
          ),
        );
      }
    }, timeoutMs);

    socket.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? new BridgeUnavailableError(
              "the Clipy app is not running (agent bridge socket unavailable). Open Clipy and try again.",
            )
          : e,
      );
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ token: info.token, cmd, ...args })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as BridgeOk | BridgeErr;
        if (parsed.ok) {
          resolvePromise(parsed.data ?? {});
        } else {
          reject(new Error(parsed.error?.message ?? "bridge error"));
        }
      } catch {
        reject(new Error("unparseable response from the Clipy app bridge"));
      }
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("the Clipy app closed the bridge connection unexpectedly"));
      }
    });
  });
}
