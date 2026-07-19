#!/usr/bin/env node
/**
 * @clipy/cli — the Clipy command line.
 *
 * List, search, and read your Clipy screen recordings (transcripts, AI
 * summaries, key moments) from the terminal, download the MP4s, or export
 * subtitles — without opening a browser.
 *
 * Auth: a personal API key (`clipy_sk_live_…`). `clipy login` opens your
 * browser to approve this device (like `gh auth login`) and stores the key in
 * ~/.config/clipy/config.json (0600); `--key`/`--paste` store a key you pasted
 * from https://clipy.online/settings/api-keys instead. CLIPY_API_KEY / --key
 * override the stored key. Read-only unless the key carries the "ingest" scope.
 */

import { parseArgs } from "node:util";
import { appendFileSync, closeSync, createWriteStream, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { CLIPY_SKILL_MD } from "./skill.js";
import { browserLogin, shouldUseManualLogin, type BrowserLoginResult } from "./browserLogin.js";
import {
  BridgeUnavailableError,
  bridgeRequest,
  inspectBridge,
  listSources,
  readBridgeInfo,
  resolveCaptureSource,
  windowLabel,
  probeSocketOpenable,
  probeBridgeHandshake,
  bridgeInfoFromFile,
  bridgeAppOutdated,
  MIN_BRIDGE_APP_VERSION,
  type CaptureSource,
  type BridgeInfo,
  type BridgeDiagnostics,
} from "./macBridge.js";

// Exit quietly when stdout/stderr close early (e.g. `clipy list | head`).
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
}

const VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version as string;
  } catch {
    return "0.0.0";
  }
})();

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[22m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[39m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[39m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[39m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[39m` : s),
};

function die(message: string, code = 1): never {
  process.stderr.write(`${c.red("error:")} ${message}\n`);
  process.exit(code);
}

function statusGlyph(status: string | null | undefined): string {
  switch (status) {
    case "ready":
      return c.green("ready");
    case "processing":
    case "pending":
    case "queued":
      return c.yellow(status);
    case "failed":
      return c.red("failed");
    case "none":
    case null:
    case undefined:
      return c.dim("—");
    default:
      return String(status);
  }
}

function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/** Visible-width truncate with ellipsis (plain ASCII widths are fine here). */
function trunc(s: string, width: number): string {
  if (s.length <= width) return s;
  return `${s.slice(0, Math.max(0, width - 1))}…`;
}

// ---------------------------------------------------------------------------
// Config store (~/.config/clipy/config.json)
// ---------------------------------------------------------------------------

function configPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "clipy", "config.json");
}

interface CliConfig {
  apiKey?: string;
  apiUrl?: string;
}

function readConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

function writeConfig(cfg: CliConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort on platforms without POSIX modes
  }
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

interface Ctx {
  apiUrl: string;
  apiKey: string | null;
}

const FETCH_TIMEOUT_MS = 20_000;
type Json = Record<string, unknown>;

function requireKey(ctx: Ctx): string {
  if (ctx.apiKey) return ctx.apiKey;
  die(
    `no API key. Run ${c.bold("clipy login")} to approve this device in your browser, or set CLIPY_API_KEY.`,
  );
}

async function api(ctx: Ctx, path: string, accept = "application/json"): Promise<Response> {
  const key = requireKey(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${ctx.apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: accept,
        "User-Agent": `clipy-cli/${VERSION}`,
      },
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      die(`request timed out after ${FETCH_TIMEOUT_MS / 1000}s (${path})`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson(ctx: Ctx, path: string): Promise<Json> {
  const res = await api(ctx, path);
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = (typeof body.error === "string" && body.error) || `Clipy API error ${res.status}`;
    if (res.status === 401) {
      die(`${msg}. Run ${c.bold("clipy login")} to set a new key.`);
    }
    die(msg);
  }
  return body;
}

// Accepts a bare public id OR a full Clipy watch/share URL and returns the id.
function normalizeId(input: string, ctx: Ctx): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  const hosts = new Set(["clipy.online", "www.clipy.online"]);
  try {
    hosts.add(new URL(ctx.apiUrl).hostname.toLowerCase());
  } catch {
    // ignore
  }
  try {
    const u = new URL(trimmed);
    if (hosts.has(u.hostname.toLowerCase())) {
      const m = u.pathname.match(/\/(?:video|embed)\/([A-Za-z0-9_-]+)/);
      if (m) return m[1];
    }
  } catch {
    // not a URL — treat as a bare id
  }
  return trimmed;
}

interface Recording {
  id: string;
  name: string;
  description: string | null;
  status: string;
  durationSeconds: number | null;
  sourcePlatform: string | null;
  transcriptStatus: string | null;
  summaryStatus: string | null;
  webUrl: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function printRecordingsTable(recordings: Recording[]): void {
  if (recordings.length === 0) {
    process.stdout.write(`${c.dim("no recordings")}\n`);
    return;
  }
  const rows = recordings.map((r) => ({
    id: r.id,
    title: trunc(r.name || "Untitled", 40),
    dur: fmtDuration(r.durationSeconds),
    status: r.status,
    transcript: r.transcriptStatus ?? "—",
    created: fmtDate(r.createdAt),
  }));
  const w = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    title: Math.max(5, ...rows.map((r) => r.title.length)),
    dur: Math.max(3, ...rows.map((r) => r.dur.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    transcript: Math.max(10, ...rows.map((r) => r.transcript.length)),
  };
  process.stdout.write(
    `${c.bold(
      `${"ID".padEnd(w.id)}  ${"TITLE".padEnd(w.title)}  ${"DUR".padEnd(w.dur)}  ${"STATUS".padEnd(w.status)}  ${"TRANSCRIPT".padEnd(w.transcript)}  CREATED`,
    )}\n`,
  );
  for (const r of rows) {
    const statusColored =
      r.status === "ready" ? c.green(r.status.padEnd(w.status)) : c.yellow(r.status.padEnd(w.status));
    process.stdout.write(
      `${c.cyan(r.id.padEnd(w.id))}  ${r.title.padEnd(w.title)}  ${r.dur.padEnd(w.dur)}  ${statusColored}  ${r.transcript.padEnd(w.transcript)}  ${c.dim(r.created)}\n`,
    );
  }
}

function srtTime(seconds: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rem = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(rem).padStart(3, "0")}`;
}

interface Segment {
  start: number;
  end: number;
  text: string;
}

function toSrt(segments: Segment[]): string {
  return segments
    .map((seg, i) => `${i + 1}\n${srtTime(seg.start, ",")} --> ${srtTime(seg.end, ",")}\n${seg.text}\n`)
    .join("\n");
}

function toVtt(segments: Segment[]): string {
  const body = segments
    .map((seg) => `${srtTime(seg.start, ".")} --> ${srtTime(seg.end, ".")}\n${seg.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// Session-mode safety rails (also shown in HELP, so declared before it).
const SESSION_DEFAULT_MAX_SEC = 600;
const SESSION_HARD_CAP_SEC = 1800;

const HELP = `${c.bold("clipy")} — the Clipy (https://clipy.online) command line, v${VERSION}

${c.bold("USAGE")}
  clipy <command> [arguments] [flags]

${c.bold("AUTH")}
  login                             Approve this device in your browser (like ${c.dim("gh auth login")})
  login --no-browser                Copy-code flow for SSH/headless: open the URL anywhere, paste the code back
  login --key <clipy_sk_live_…>     Skip the browser: store a key you pasted
  login --paste                     Prompt for a pasted key instead of the browser
  logout                            Delete the stored key
  whoami                            Check which key is active and that it works

${c.bold("RECORDINGS")}
  list [-n <N>] [--page <P>] [--status <s,…>] [--json]
                                    List your recordings (newest first)
  search <query> [--json]           Full-text search titles + descriptions
  show <id|url> [--json]            One recording's metadata + share link
  transcript <id> [--srt|--vtt|--json]
                                    Print the transcript (plaintext by default)
  summary <id> [--json]             AI summary: TL;DR, key points, action items
  moments <id> [--json]             Key moments (timestamps + captions + click coords)
  context <id>                      Full agent-context bundle as markdown
  download <id> [-o <path>]         Download the MP4
  open <id>                         Open the share page in your browser
  wait <id> [--for transcript|summary|both] [--timeout <sec>]
                                    Block until processing artifacts are ready

${c.bold("RECORD")} ${c.dim("(needs an API key with the \"ingest\" permission)")}
  record --url <http(s) url> [--for <sec>] [--title <t>] [--wait]
                                    Capture a web app headlessly and upload it as
                                    a Clipy recording. Prints the share link + the
                                    agent-context URL. ${c.dim("Requires Playwright:")}
                                    ${c.dim("npm i -g playwright && npx playwright install chromium")}
    --for <sec>       How long to record after load (default 15; per viewport)
    --viewports <l>   Record several sizes into ONE video, e.g.
                      mobile,tablet,desktop or 390x844,1440x900 (chapters marked)
    --title/--description  Recording metadata
    --type <kind>     What this recording IS, so the AI summary reads it right:
                      bug|feature|demo|walkthrough|feedback|discussion|other
                      (aliases of bug_report/feature_request/product_demo/…)
    --note "12: text" Timestamped narration note (repeatable). "12: text" is
                      absolute; "pass2: text" / "pass2@5: text" anchor to the
                      actual start of a --viewports pass. Silent captures → the
                      notes become the transcript
    --width/--height  Viewport + video size (default 1280×720)
    --wait            Block until the transcript is ready before printing

${c.bold("SESSION")} ${c.dim("(agent works, Clipy records — one active session per directory)")}
  ${c.dim("--source mac-screen on record/session records the REAL screen via the")}
  ${c.dim("running Clipy Mac app (consent-gated, indicator always visible).")}
  ${c.dim("Target one window or display instead of the whole screen:")}
  sources                           List capturable displays + windows (ids for --window/--display)
    --window "<title|app|id>"       Record just that window (e.g. --window Chrome)
    --display <id>                  Record a specific display
  session start --url <app> [--max <sec>] [--title <t>] [--type <kind>] [--expose-cdp]
                                    Start recording in a background daemon and
                                    return immediately (auto-stops + uploads at
                                    --max, default ${SESSION_DEFAULT_MAX_SEC}s, cap ${SESSION_HARD_CAP_SEC}s). --type sets
                                    the recording kind (see record). --expose-cdp
                                    opens a CDP endpoint so your tools can drive the
                                    page as it records (off by default; any local
                                    process could attach — CLIPY_DISABLE_CDP=1 forces off)
  mark "<what just happened>"       Drop a live timestamped note; marks become
                                    the recording's transcript chapters
  session stop                      Finish: close browser, upload, print link
  session abort                     Discard the session — nothing is uploaded
  session status                    Show the active session's state

${c.bold("AGENTS")}
  agents install <claude|codex|cursor>
                                    Install the bundled Clipy skill for a coding
                                    agent (teaches it to read + make recordings)
  agents status | uninstall <t>     Show / remove installed skills
  doctor [--json]                   Health check: API key, Mac agent bridge,
                                    Playwright, and install mode — with fix hints
  guide --json                      Machine-readable manifest: every command,
                                    flag, env var, and exit code
  transcript <id> --replace <file>  Replace a transcript with agent-authored
                                    JSON ({segments} or {plaintext}); regenerates
                                    the summary ${c.dim("(needs the \"ingest\" permission)")}
  mcp                               Run the Clipy MCP server (wraps: npx -y @clipy/mcp)

${c.bold("GLOBAL FLAGS")}
  --key <key>       API key for this invocation (else CLIPY_API_KEY, else stored login)
  --api-url <url>   API base (else CLIPY_API_URL, default https://clipy.online)
  --json            Machine-readable output (list/search/show/transcript/summary/moments/wait)
  -v, --version     Print version

${c.bold("EXIT CODES")}
  0 ok · 1 error · 2 usage · 3 artifact not ready (transcript/summary/wait)

${c.bold("SETUP")}
  1. ${c.bold("clipy login")}                approve this device in your browser
  2. ${c.bold("clipy list")}                 (or: ${c.bold("clipy agents install claude")} to wire up a coding agent)

Write commands — ${c.bold("record")}, ${c.bold("session")}/${c.bold("mark")}, and ${c.bold("transcript --replace")} — need a key
with the "ingest" permission. Everything else is read-only.
`;

async function cmdLogin(
  ctx: Ctx,
  opts: { key?: string; paste?: boolean; noBrowser?: boolean },
): Promise<void> {
  const keyFlag = opts.key?.trim() || "";
  // A pasted key, an explicit --paste, or a non-interactive stdout all take the
  // paste path — without a terminal we can't run either interactive flow.
  if (keyFlag || opts.paste || !process.stdout.isTTY) {
    await loginWithPaste(ctx, keyFlag);
    return;
  }
  // --no-browser, SSH sessions, and display-less Linux take the copy-code
  // flow: this machine can't receive the loopback redirect (or can't open a
  // browser at all), so the approval page shows a code to paste back here.
  await loginWithBrowser(ctx, opts.noBrowser || shouldUseManualLogin());
}

/** Browser-approve flow (the default): open clipy.online, approve, store. */
async function loginWithBrowser(ctx: Ctx, manual: boolean): Promise<void> {
  process.stderr.write(
    `${c.dim(manual ? "approve this device from a browser on any machine…" : "opening your browser to approve this device…")}\n`,
  );
  let result: BrowserLoginResult;
  try {
    result = await browserLogin({
      apiUrl: ctx.apiUrl,
      log: (m) => process.stderr.write(`${m}\n`),
      manual,
      promptCode: manual
        ? () => promptVisible("Paste the approval code shown in the browser: ")
        : undefined,
    });
  } catch (e) {
    die(
      `${(e as Error).message}\n` +
        `You can log in with a pasted key instead: ${c.bold("clipy login --key <clipy_sk_live_…>")} ` +
        `(create one at ${ctx.apiUrl}/settings/api-keys).`,
    );
  }
  // Browser-minted keys are stored BEFORE the verify round-trip: the secret
  // was just delivered once and is unrecoverable — a transient network blip
  // on the verify call must not lose it.
  await storeAndVerifyKey(ctx, result.apiKey, { scopes: result.scopes, email: result.email }, { storeFirst: true });
}

/** Paste flow (fallback): take a key from --key or a hidden prompt, store it. */
async function loginWithPaste(ctx: Ctx, keyFlag: string): Promise<void> {
  let key = keyFlag;
  if (!key) {
    key = await promptHidden(`Paste your Clipy API key (from ${ctx.apiUrl}/settings/api-keys): `);
  }
  if (!key.startsWith("clipy_sk_live_")) {
    die("that doesn't look like a Clipy API key (expected it to start with clipy_sk_live_)");
  }
  // Pasted keys still verify first — the user has the secret in hand, and
  // catching a typo'd/revoked key before storing it is the better failure.
  await storeAndVerifyKey(ctx, key, {}, { storeFirst: false });
}

/** Store a key (0600) + verify it against the API, order per `storeFirst`. */
async function storeAndVerifyKey(
  ctx: Ctx,
  key: string,
  meta: { scopes?: string[]; email?: string },
  opts: { storeFirst: boolean },
): Promise<void> {
  const store = (): void => {
    const cfg = readConfig();
    cfg.apiKey = key;
    if (ctx.apiUrl !== "https://clipy.online") cfg.apiUrl = ctx.apiUrl;
    writeConfig(cfg);
  };
  if (opts.storeFirst) {
    store();
    try {
      await apiJson({ ...ctx, apiKey: key }, "/api/v1/recordings?limit=1");
    } catch (e) {
      process.stderr.write(
        `${c.yellow("!")} key saved to ${configPath()}, but verifying it failed (${(e as Error).message}).\n` +
          `  Check with: ${c.bold("clipy whoami")}\n`,
      );
      return;
    }
  } else {
    await apiJson({ ...ctx, apiKey: key }, "/api/v1/recordings?limit=1");
    store();
  }
  const bits: string[] = [];
  if (meta.email) bits.push(meta.email);
  if (meta.scopes?.length) bits.push(`scopes: ${meta.scopes.join(", ")}`);
  const detail = bits.length ? ` ${c.dim(`(${bits.join(" · ")})`)}` : "";
  process.stdout.write(`${c.green("✓")} logged in${detail} — key saved to ${c.dim(configPath())}\n`);
}

/** Plain visible readline prompt (for one-time codes the user just copied). */
function promptVisible(question: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer.trim());
    });
  });
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const anyRl = rl as unknown as { _writeToOutput?: (s: string) => void; output?: NodeJS.WritableStream };
    process.stdout.write(question);
    // Mute echoed input so the key isn't visible / in scrollback.
    anyRl._writeToOutput = () => {};
    rl.question("", (answer) => {
      anyRl._writeToOutput = undefined as unknown as (s: string) => void;
      process.stdout.write("\n");
      rl.close();
      resolvePrompt(answer.trim());
    });
  });
}

function cmdLogout(): void {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    process.stdout.write("no stored key — nothing to do\n");
    return;
  }
  delete cfg.apiKey;
  if (Object.keys(cfg).length === 0) {
    try {
      rmSync(configPath());
    } catch {
      // ignore
    }
  } else {
    writeConfig(cfg);
  }
  process.stdout.write(`${c.green("✓")} stored key removed\n`);
}

async function cmdWhoami(ctx: Ctx): Promise<void> {
  const key = requireKey(ctx);
  const source = process.env.CLIPY_API_KEY === key ? "env CLIPY_API_KEY" : readConfig().apiKey === key ? configPath() : "--key flag";
  await apiJson(ctx, "/api/v1/recordings?limit=1");
  process.stdout.write(
    `${c.green("✓")} key ${c.bold(`${key.slice(0, 22)}…`)} is valid (${c.dim(source)}) against ${ctx.apiUrl}\n`,
  );
}

async function cmdList(ctx: Ctx, opts: { q?: string; n: number; page: number; status?: string; json: boolean }): Promise<void> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.n));
  params.set("page", String(opts.page));
  if (opts.q) params.set("q", opts.q);
  if (opts.status) params.set("status", opts.status);
  const body = await apiJson(ctx, `/api/v1/recordings?${params.toString()}`);
  const recordings = (body.recordings ?? []) as Recording[];
  if (opts.json) {
    printJson(body);
    return;
  }
  printRecordingsTable(recordings);
  const pg = body.pagination as { page?: number; totalPages?: number; total?: number } | undefined;
  if (pg && typeof pg.total === "number" && recordings.length < pg.total) {
    process.stdout.write(
      c.dim(`page ${pg.page ?? opts.page}/${pg.totalPages ?? "?"} of ${pg.total} recordings — use --page/${"-n"} for more\n`),
    );
  }
}

async function cmdShow(ctx: Ctx, id: string, json: boolean): Promise<void> {
  const pid = encodeURIComponent(normalizeId(id, ctx));
  const body = await apiJson(ctx, `/api/v1/recordings/${pid}`);
  if (json) {
    printJson(body);
    return;
  }
  const r = body.recording as Recording | undefined;
  if (!r) die("unexpected response shape");
  process.stdout.write(`${c.bold(r.name || "Untitled")}\n`);
  if (r.description) process.stdout.write(`${r.description}\n`);
  process.stdout.write("\n");
  const kv: Array<[string, string]> = [
    ["id", c.cyan(r.id)],
    ["status", statusGlyph(r.status)],
    ["duration", fmtDuration(r.durationSeconds)],
    ["source", r.sourcePlatform ?? "—"],
    ["transcript", statusGlyph(r.transcriptStatus)],
    ["summary", statusGlyph(r.summaryStatus)],
    ["created", fmtDate(r.createdAt)],
    ["share", c.cyan(r.webUrl)],
    ["video", r.videoUrl ? c.dim(r.videoUrl) : "—"],
  ];
  const w = Math.max(...kv.map(([k]) => k.length));
  for (const [k, v] of kv) process.stdout.write(`${c.dim(k.padEnd(w))}  ${v}\n`);
}

async function cmdTranscript(ctx: Ctx, id: string, fmt: "text" | "srt" | "vtt" | "json"): Promise<void> {
  const pid = encodeURIComponent(normalizeId(id, ctx));
  const body = await apiJson(ctx, `/api/v1/recordings/${pid}/transcript`);
  const status = String(body.status ?? "unknown");
  if (fmt === "json") {
    printJson(body);
    if (status !== "ready") process.exit(3);
    return;
  }
  if (status !== "ready") {
    process.stderr.write(`transcript not ready (status: ${status}). Try ${c.bold(`clipy wait ${normalizeId(id, ctx)}`)}\n`);
    process.exit(3);
  }
  // The ready payload nests under `transcript`; accept top-level too.
  const t = (body.transcript ?? body) as { plaintext?: string; segments?: Segment[] };
  if (fmt === "text") {
    process.stdout.write(`${String(t.plaintext ?? "")}\n`);
    return;
  }
  const segments = (t.segments ?? []) as Segment[];
  if (!segments.length) die("transcript has no segments to export");
  process.stdout.write(fmt === "srt" ? toSrt(segments) : toVtt(segments));
}

async function cmdSummary(ctx: Ctx, id: string, json: boolean): Promise<void> {
  const pid = encodeURIComponent(normalizeId(id, ctx));
  const body = await apiJson(ctx, `/api/v1/recordings/${pid}/summary`);
  const status = String(body.status ?? "unknown");
  if (json) {
    printJson(body);
    if (status !== "ready") process.exit(3);
    return;
  }
  if (status !== "ready") {
    process.stderr.write(`summary not ready (status: ${status}). Try ${c.bold(`clipy wait ${normalizeId(id, ctx)} --for summary`)}\n`);
    process.exit(3);
  }
  const s = body.summary as { tldr?: string; keyPoints?: string[]; actionItems?: string[] } | null;
  if (!s) die("summary missing from response");
  process.stdout.write(`${c.bold("TL;DR")}\n${s.tldr ?? "—"}\n`);
  if (s.keyPoints?.length) {
    process.stdout.write(`\n${c.bold("Key points")}\n`);
    for (const p of s.keyPoints) process.stdout.write(`  • ${p}\n`);
  }
  if (s.actionItems?.length) {
    process.stdout.write(`\n${c.bold("Action items")}\n`);
    for (const a of s.actionItems) process.stdout.write(`  ☐ ${a}\n`);
  }
}

async function cmdMoments(ctx: Ctx, id: string, json: boolean): Promise<void> {
  const pid = encodeURIComponent(normalizeId(id, ctx));
  const body = await apiJson(ctx, `/api/v1/recordings/${pid}/key-moments`);
  if (json) {
    printJson(body);
    return;
  }
  const status = String(body.status ?? "unknown");
  const moments = (body.moments ?? []) as Array<{
    tMs: number;
    timeLabel: string;
    caption: string;
    x: number | null;
    y: number | null;
    frameUrl: string | null;
  }>;
  if (!moments.length) {
    process.stderr.write(`no key moments (status: ${status})\n`);
    process.exit(status === "ready" ? 0 : 3);
  }
  for (const m of moments) {
    const coord = m.x != null && m.y != null ? c.dim(` (click ${(m.x * 100).toFixed(0)}%,${(m.y * 100).toFixed(0)}%)`) : "";
    process.stdout.write(`${c.cyan(m.timeLabel.padStart(7))}  ${m.caption}${coord}\n`);
    if (m.frameUrl) process.stdout.write(`${" ".repeat(9)}${c.dim(m.frameUrl)}\n`);
  }
}

async function cmdContext(ctx: Ctx, id: string): Promise<void> {
  const pid = encodeURIComponent(normalizeId(id, ctx));
  const res = await api(ctx, `/api/agent-context/${pid}`, "text/markdown, text/plain, application/json");
  const text = await res.text();
  if (!res.ok) {
    let msg = `Clipy API error ${res.status}`;
    try {
      const j = JSON.parse(text) as Json;
      if (typeof j.error === "string") msg = j.error;
    } catch {
      // not json
    }
    die(msg);
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function cmdDownload(ctx: Ctx, id: string, outputPath: string | undefined): Promise<void> {
  const pid = normalizeId(id, ctx);
  const body = await apiJson(ctx, `/api/v1/recordings/${encodeURIComponent(pid)}`);
  const rec = body.recording as Recording | undefined;
  if (!rec?.videoUrl) {
    die(`recording ${pid} has no downloadable video yet (status: ${rec?.status ?? "unknown"})`);
  }
  const dest = outputPath ? resolve(outputPath) : join(process.cwd(), `clipy-${pid}.mp4`);
  const target = new URL(rec.videoUrl, ctx.apiUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    die(`refusing to download non-http(s) URL: ${target.protocol}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);
  try {
    const res = await fetch(target, { signal: controller.signal });
    if (!res.ok || !res.body) die(`failed to download video (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length") || 0);
    let done = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        done += chunk.length;
        if (process.stderr.isTTY && total > 0) {
          process.stderr.write(`\r${c.dim(`downloading… ${Math.round((done / total) * 100)}% (${fmtBytes(done)}/${fmtBytes(total)})`)}`);
        }
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      progress,
      createWriteStream(dest),
    );
    if (process.stderr.isTTY && total > 0) process.stderr.write("\r\x1b[2K");
  } finally {
    clearTimeout(timer);
  }
  const bytes = statSync(dest).size;
  process.stdout.write(`${c.green("✓")} saved ${c.bold(dest)} (${fmtBytes(bytes)})\n`);
}

function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function cmdOpen(ctx: Ctx, id: string): Promise<void> {
  const pid = normalizeId(id, ctx);
  const url = `${ctx.apiUrl}/video/${pid}`;
  const platform = process.platform;
  const opener = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(opener, args, { detached: true, stdio: "ignore" });
    child.unref();
    process.stdout.write(`${c.green("✓")} opening ${c.cyan(url)}\n`);
  } catch {
    process.stdout.write(`${url}\n`);
  }
}

async function cmdWait(
  ctx: Ctx,
  id: string,
  need: "transcript" | "summary" | "both",
  timeoutSec: number,
  json: boolean,
): Promise<void> {
  const pid = encodeURIComponent(normalizeId(id, ctx));
  const deadline = Date.now() + timeoutSec * 1000;
  const terminal = new Set(["ready", "failed", "none"]);
  const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let tick = 0;
  for (;;) {
    const transcript = await apiJson(ctx, `/api/v1/recordings/${pid}/transcript`);
    const tStatus = String(transcript.status);
    let summary: Json | null = null;
    let sStatus = "skipped";
    if (need !== "transcript") {
      summary = await apiJson(ctx, `/api/v1/recordings/${pid}/summary`);
      sStatus = String(summary.status);
    }
    const transcriptDone = need === "summary" || terminal.has(tStatus);
    const summaryDone = need === "transcript" || terminal.has(sStatus);
    if (transcriptDone && summaryDone) {
      if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
      if (json) {
        printJson({ id: normalizeId(id, ctx), transcript, ...(summary ? { summary } : {}) });
      } else {
        process.stdout.write(
          `transcript: ${statusGlyph(tStatus)}${need !== "transcript" ? `  summary: ${statusGlyph(sStatus)}` : ""}\n`,
        );
      }
      const failed = tStatus === "failed" || (need !== "transcript" && sStatus === "failed");
      process.exit(failed ? 1 : 0);
    }
    if (Date.now() >= deadline) {
      if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
      process.stderr.write(`timed out after ${timeoutSec}s (transcript: ${tStatus}${need !== "transcript" ? `, summary: ${sStatus}` : ""})\n`);
      process.exit(3);
    }
    if (process.stderr.isTTY) {
      process.stderr.write(`\r${c.yellow(spin[tick++ % spin.length])} waiting… transcript: ${tStatus}${need !== "transcript" ? `, summary: ${sStatus}` : ""} `);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function cmdMcp(): void {
  // `clipy mcp` IS the MCP server: it wraps `npx -y @clipy/mcp` with inherited
  // stdio, so MCP clients can be configured with `clipy mcp` directly.
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npx, ["-y", "@clipy/mcp"], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (e) => die(`failed to launch @clipy/mcp via npx: ${e.message}`));
}

// ---------------------------------------------------------------------------
// doctor — one-shot environment health check. Every dead end an agent hits
// (missing key, dead bridge, unresolvable Playwright, wrong install shape) is
// a PASS/FAIL line here with a fix hint, so a stuck agent can self-diagnose in
// one call instead of guessing. Read-only; --json for programmatic triage.
// ---------------------------------------------------------------------------

type CheckStatus = "pass" | "warn" | "fail" | "info" | "skip";

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  data?: Json;
}

/** Non-dying key probe for doctor — reuses the whoami round-trip endpoint but
 *  returns structured results (die() would exit before other checks run) and
 *  distinguishes offline from rejected so we can degrade gracefully. */
async function probeApiKey(
  ctx: Ctx,
): Promise<{ ok: boolean; offline: boolean; status: number; message: string }> {
  if (!ctx.apiKey) return { ok: false, offline: false, status: 0, message: "no key" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${ctx.apiUrl}/api/v1/recordings?limit=1`, {
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        Accept: "application/json",
        "User-Agent": `clipy-cli/${VERSION}`,
      },
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, offline: false, status: res.status, message: "ok" };
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as Json;
      if (typeof body.error === "string") message = body.error;
    } catch {
      // keep the HTTP status message
    }
    return { ok: false, offline: false, status: res.status, message };
  } catch (e) {
    const message = (e as Error).name === "AbortError" ? "request timed out" : (e as Error).message;
    return { ok: false, offline: true, status: 0, message };
  } finally {
    clearTimeout(timer);
  }
}

async function doctorAuthCheck(ctx: Ctx): Promise<DoctorCheck> {
  if (!ctx.apiKey) {
    return {
      name: "auth",
      status: "fail",
      detail: "no API key configured",
      hint: "run `clipy login` (or set CLIPY_API_KEY)",
      data: { hasKey: false },
    };
  }
  const source =
    process.env.CLIPY_API_KEY === ctx.apiKey
      ? "env CLIPY_API_KEY"
      : readConfig().apiKey === ctx.apiKey
        ? configPath()
        : "--key flag";
  const masked = `${ctx.apiKey.slice(0, 18)}…`;
  const probe = await probeApiKey(ctx);
  const data: Json = { hasKey: true, keySource: source, apiUrl: ctx.apiUrl };
  if (probe.ok) {
    return { name: "auth", status: "pass", detail: `key ${masked} valid (${source}) against ${ctx.apiUrl}`, data };
  }
  if (probe.offline) {
    return {
      name: "auth",
      status: "warn",
      detail: `key ${masked} present (${source}) but ${ctx.apiUrl} is unreachable: ${probe.message}`,
      hint: "check your connection — the key could not be verified",
      data: { ...data, offline: true },
    };
  }
  const hint =
    probe.status === 401
      ? "the key is invalid or revoked — run `clipy login`"
      : probe.status === 403
        ? `the key lacks a required scope — mint one at ${ctx.apiUrl}/settings/api-keys`
        : "check the key and --api-url";
  return {
    name: "auth",
    status: "fail",
    detail: `key ${masked} (${source}) rejected by ${ctx.apiUrl}: ${probe.message}`,
    hint,
    data: { ...data, status: probe.status },
  };
}

function fmtAge(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/** The bridge produces several PASS/FAIL lines: the discovery FILE (validity +
 *  version), its MTIME freshness, the SOCKET's openability, and a live
 *  HANDSHAKE that confirms the running app answers and its version matches the
 *  file (catching the "stale artifact from an app that predates the bridge"
 *  case a pid check alone misses). */
async function doctorBridgeChecks(): Promise<DoctorCheck[]> {
  const b = inspectBridge();
  const fileData: Json = {
    path: b.path,
    exists: b.exists,
    appVersion: b.appVersion,
    pid: b.pid,
    pidAlive: b.pidAlive,
    minAppVersion: MIN_BRIDGE_APP_VERSION,
    mtimeMs: b.mtimeMs,
  };

  if (!b.applicable) {
    return [{ name: "bridge", status: "skip", detail: `n/a — ${b.detail}`, data: fileData }];
  }
  if (!b.exists) {
    return [
      {
        name: "bridge",
        status: "warn",
        detail: `${b.detail} (${b.path})`,
        hint: "only needed for --source mac-screen; open the Clipy app, or install/update it at https://clipy.online/download",
        data: fileData,
      },
    ];
  }

  const out: DoctorCheck[] = [];

  // 1) discovery file validity + version
  if (b.healthy) {
    out.push({ name: "bridge", status: "pass", detail: `${b.detail} at ${b.path}`, data: fileData });
  } else {
    const predate =
      (b.pidAlive === false && bridgeAppOutdated(b.appVersion)) || b.versionOk === false;
    const hint = predate
      ? `your installed Clipy app likely predates the agent bridge (needs v${MIN_BRIDGE_APP_VERSION}+) — update via https://clipy.online/download`
      : b.pidAlive === false
        ? "open the Clipy app (its previous process quit)"
        : "restart the Clipy app";
    out.push({ name: "bridge", status: "fail", detail: `${b.detail} (${b.path})`, hint, data: fileData });
  }

  // 2) mtime freshness (the app rewrites the file every launch on 0.1.41+)
  if (b.mtimeMs != null) {
    const age = fmtAge(Date.now() - b.mtimeMs);
    const staleShaped = b.pidAlive === false;
    out.push({
      name: "bridge mtime",
      status: staleShaped ? "warn" : "info",
      detail: staleShaped
        ? `discovery file last written ${age} ago but its pid is dead — stale artifact`
        : `discovery file written ${age} ago`,
      ...(staleShaped
        ? { hint: `a fresh Clipy launch should rewrite it; if it doesn't, the app predates the bridge (needs v${MIN_BRIDGE_APP_VERSION}+)` }
        : {}),
      data: { mtimeMs: b.mtimeMs },
    });
  }

  // 3) + 4) socket openability + live handshake (only when the file is complete)
  if (b.complete && b.socketPath) {
    const openable = await probeSocketOpenable(b.socketPath);
    out.push({
      name: "bridge socket",
      status: openable ? "pass" : "fail",
      detail: openable ? `socket openable at ${b.socketPath}` : `socket not answering at ${b.socketPath}`,
      ...(openable ? {} : { hint: "stale bridge artifact — restart the Clipy app" }),
      data: { socketPath: b.socketPath, openable },
    });
    if (openable) {
      const info = bridgeInfoFromFile();
      if (info) {
        const hs = await probeBridgeHandshake(info);
        if (hs.ok) {
          const match = !hs.appVersion || !b.appVersion || hs.appVersion === b.appVersion;
          out.push({
            name: "bridge handshake",
            status: match ? "pass" : "fail",
            detail: match
              ? `app answered "status" (v${hs.appVersion ?? "?"})`
              : `discovery file says v${b.appVersion} but the running app reports v${hs.appVersion} — stale bridge artifact`,
            ...(match ? {} : { hint: "restart the Clipy app so it rewrites the discovery file" }),
            data: { fileAppVersion: b.appVersion, liveAppVersion: hs.appVersion ?? null },
          });
        } else {
          out.push({
            name: "bridge handshake",
            status: "fail",
            detail: `no answer to a "status" handshake: ${hs.error}`,
            hint: bridgeAppOutdated(b.appVersion)
              ? `your installed Clipy app likely predates the agent bridge (needs v${MIN_BRIDGE_APP_VERSION}+) — update via https://clipy.online/download`
              : "stale bridge artifact — restart the Clipy app",
          });
        }
      }
    }
  }
  return out;
}

async function doctorPlaywrightCheck(): Promise<DoctorCheck> {
  const res = await resolvePlaywright();
  if (res.ok) {
    return { name: "playwright", status: "pass", detail: `resolved via ${res.source}`, data: { source: res.source } };
  }
  const { mode } = detectInstallMode();
  return {
    name: "playwright",
    status: "fail",
    detail: `${res.error} — record/session cannot launch a browser`,
    hint: playwrightInstallHint(mode),
    data: { installMode: mode },
  };
}

function doctorInstallCheck(): DoctorCheck {
  const { mode, argv1 } = detectInstallMode();
  const label: Record<InstallMode, string> = {
    npx: "npx cache (isolated)",
    global: "global install",
    local: "project-local install",
    unknown: "unknown (running from source?)",
  };
  const hint =
    mode === "npx"
      ? "for repeated use, `npm i -g @clipy/cli` — a global install can load a global Playwright; the npx cache can't"
      : undefined;
  return {
    name: "install",
    status: "info",
    detail: `${label[mode]} — ${argv1 || "?"}`,
    hint,
    data: { mode, argv1 },
  };
}

function doctorGlyph(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return c.green("PASS");
    case "warn":
      return c.yellow("WARN");
    case "fail":
      return c.red("FAIL");
    case "skip":
      return c.dim("SKIP");
    default:
      return c.dim("INFO");
  }
}

async function cmdDoctor(ctx: Ctx, json: boolean): Promise<void> {
  const checks: DoctorCheck[] = [
    await doctorAuthCheck(ctx),
    ...(await doctorBridgeChecks()),
    await doctorPlaywrightCheck(),
    doctorInstallCheck(),
  ];
  const failed = checks.filter((chk) => chk.status === "fail").length;

  if (json) {
    printJson({
      version: VERSION,
      apiUrl: ctx.apiUrl,
      ok: failed === 0,
      checks: checks.map((chk) => ({
        name: chk.name,
        status: chk.status,
        detail: chk.detail,
        ...(chk.hint ? { hint: chk.hint } : {}),
        ...(chk.data ? { data: chk.data } : {}),
      })),
    });
    if (failed > 0) process.exitCode = 1;
    return;
  }

  process.stdout.write(`${c.bold("clipy doctor")} ${c.dim(`— v${VERSION} · ${ctx.apiUrl}`)}\n\n`);
  for (const chk of checks) {
    // Pad to the longest check name ("bridge handshake") so details align.
    process.stdout.write(`${doctorGlyph(chk.status)}  ${chk.name.padEnd(16)}  ${chk.detail}\n`);
    if (chk.hint) process.stdout.write(`      ${c.dim(`↳ ${chk.hint}`)}\n`);
  }
  process.stdout.write("\n");
  if (failed === 0) {
    process.stdout.write(`${c.green("✓")} no failures\n`);
  } else {
    process.stdout.write(
      `${c.red(`✗ ${failed} check${failed === 1 ? "" : "s"} failed`)} — see the hints above.\n`,
    );
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// record — the ONE write command. Drives a headless browser (Playwright),
// captures the page to WebM, and streams it through Clipy's raw-upload
// pipeline exactly like the web recorder does. Needs an API key with the
// `ingest` scope. Everything else in this CLI stays read-only.
// ---------------------------------------------------------------------------

/**
 * POST JSON to an ingest endpoint with the API key. Retries transient failures
 * (network error / 429 / 5xx) and THROWS on hard errors so the caller's
 * try/finally can run its abort + cleanup (die() would process.exit and skip
 * them). Auth/scope errors get a helpful message.
 */
async function ingestPostJson(ctx: Ctx, path: string, payload: unknown): Promise<Json> {
  const key = requireKey(ctx);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${ctx.apiUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": `clipy-cli/${VERSION}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
      throw new Error(
        (e as Error).name === "AbortError" ? `request timed out (${path})` : (e as Error).message,
      );
    } finally {
      clearTimeout(timer);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 1000));
      continue;
    }
    const text = await res.text();
    let body: Json = {};
    try {
      body = text ? (JSON.parse(text) as Json) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const msg = (typeof body.error === "string" && body.error) || `Clipy API error ${res.status}`;
      if (res.status === 401) {
        throw new Error(`${msg}. Run \`clipy login\` with an ingest-scoped key.`);
      }
      if (res.status === 403) {
        throw new Error(
          `${msg}\nYour API key needs the "ingest" permission. Mint one at ` +
            `${ctx.apiUrl}/settings/api-keys (check "Record & upload").`,
        );
      }
      throw new Error(msg);
    }
    return body;
  }
  throw new Error(`request failed after retries (${path})`);
}

/** Upload one chunk as multipart/form-data, retrying transient 429/5xx. */
async function ingestPostChunk(
  ctx: Ctx,
  recordingId: string,
  uploadToken: string,
  partNumber: number,
  bytes: Uint8Array,
): Promise<void> {
  const key = requireKey(ctx);
  for (let attempt = 1; attempt <= 4; attempt++) {
    // Copy the window into a standalone ArrayBuffer: it satisfies BlobPart
    // under strict lib settings (a subarray's .buffer is ArrayBufferLike) and
    // makes the snapshot independent of the reused read buffer.
    const part = bytes.slice().buffer as ArrayBuffer;
    const form = new FormData();
    form.append("recordingId", recordingId);
    form.append("uploadToken", uploadToken);
    form.append("partNumber", String(partNumber));
    form.append("file", new Blob([part], { type: "video/webm" }), `part-${partNumber}.webm`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let res: Response;
    try {
      res = await fetch(`${ctx.apiUrl}/api/videos/raw-upload/chunk`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "User-Agent": `clipy-cli/${VERSION}` },
        body: form,
        signal: controller.signal,
      });
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, attempt * 1000));
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return;
    // 429 (too far ahead) / 5xx are transient — back off and retry.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 1000));
      continue;
    }
    const text = await res.text().catch(() => "");
    // Throw (not die) so cmdRecord's finally can abort + clean up.
    throw new Error(`chunk ${partNumber} failed (HTTP ${res.status})${text ? `: ${text}` : ""}`);
  }
}

// Minimal structural type for the slice of Playwright we use — declared here so
// the CLI typechecks without Playwright installed (it's a lazy runtime import,
// never a build/runtime dependency of the read-only base CLI).
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(opts?: { type?: string; quality?: number }): Promise<Buffer>;
  video(): { path(): Promise<string> } | null;
  close(): Promise<void>;
  on(event: string, handler: (arg: never) => void): unknown;
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(opts: Record<string, unknown>): Promise<PwBrowser>;
}

// --- Playwright resolution (shared by record + the session daemon) ----------
// Playwright is a lazy runtime import, never a build/runtime dependency of the
// read-only base CLI. Resolving it has to work in three install shapes, so the
// resolver tries them in order and reports WHERE it found Playwright (or why
// not) — `clipy doctor` surfaces that, and record/daemon turn a miss into a
// mode-aware install hint.

type InstallMode = "npx" | "global" | "local" | "unknown";

type PlaywrightResolution =
  | { ok: true; chromium: PwChromium; source: string }
  | { ok: false; source: null; error: string };

/** Pull `chromium` out of a dynamically-imported Playwright module. A bare
 *  `import('playwright')` (via the package `exports` map) exposes it as a named
 *  export, but importing the raw index.js by file URL (the cwd-local path
 *  below) hits CJS→ESM interop where it only lands on `.default`. Check both. */
function chromiumFrom(mod: unknown): PwChromium | undefined {
  const m = mod as { chromium?: PwChromium; default?: { chromium?: PwChromium } };
  return m.chromium ?? m.default?.chromium;
}

async function resolvePlaywright(): Promise<PlaywrightResolution> {
  // 1) Resolve relative to the CLI itself — a normal dependency, or a global
  //    Playwright sitting beside a global `@clipy/cli` in the same node_modules.
  for (const mod of ["playwright", "playwright-core"]) {
    try {
      const chromium = chromiumFrom(await import(mod));
      if (chromium) return { ok: true, chromium, source: `import('${mod}')` };
    } catch {
      // try the next strategy
    }
  }
  // 2) Resolve relative to the user's project (cwd). Under `npx @clipy/cli` the
  //    package lives in an isolated cache that a bare ESM import cannot resolve
  //    a global/project Playwright from, but a require rooted at cwd can.
  for (const mod of ["playwright", "playwright-core"]) {
    try {
      const requireFromCwd = createRequire(join(process.cwd(), "package.json"));
      const resolved = requireFromCwd.resolve(mod);
      const chromium = chromiumFrom(await import(pathToFileURL(resolved).href));
      if (chromium) return { ok: true, chromium, source: `${mod} at ${dirname(resolved)}` };
    } catch {
      // fall through to the miss
    }
  }
  return {
    ok: false,
    source: null,
    error: "Playwright is not installed where this CLI can load it (tried a bundled import and a cwd-local resolve)",
  };
}

/** Classify how this CLI was invoked so install hints match the user's setup.
 *  npx runs from an isolated `_npx` cache; a global bin lives outside cwd; a
 *  project-local install sits under cwd/node_modules. */
function detectInstallMode(): { mode: InstallMode; argv1: string } {
  const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
  const norm = argv1.replace(/\\/g, "/");
  const cwd = resolve(process.cwd()).replace(/\\/g, "/");
  let mode: InstallMode = "unknown";
  if (/\/_npx\//.test(norm)) mode = "npx";
  else if (norm.startsWith(`${cwd}/`) && /\/node_modules\//.test(norm)) mode = "local";
  else if (/\/node_modules\//.test(norm)) mode = "global";
  return { mode, argv1 };
}

/** One-line install hint keyed to the install mode (the `doctor` ↳ line). For
 *  npx we LEAD with the cwd-local install — the only guaranteed-working fix,
 *  since the resolver's cwd-local strategy loads it and the npx cache can't see
 *  a global one. */
function playwrightInstallHint(mode: InstallMode): string {
  if (mode === "npx") {
    return "in your project dir: npm i playwright && npx playwright install chromium (then re-run) — or install globally: npm i -g @clipy/cli playwright && clipy …";
  }
  if (mode === "local") return "npm i -D playwright && npx playwright install chromium";
  return "npm install -g playwright && npx playwright install chromium";
}

/** The full, multi-line message record/daemon die() with when Playwright is
 *  missing — the npx branch is the important fix: `npm i -g playwright` cannot
 *  help a package running from the npx cache (ESM there can't see globals), so
 *  we lead with the cwd-local install, which the resolver DOES load. */
function playwrightMissingMessage(mode: InstallMode): string {
  const head = "clipy record needs Playwright (a headless browser), but it isn't installed where this CLI can load it.";
  if (mode === "npx") {
    return (
      `${head}\n` +
      `You're running via npx, whose isolated cache can't load a globally-installed Playwright. The reliable fix is a project-local install — run this in your project directory (the one you'll run clipy from):\n` +
      `  ${c.bold("npm i playwright && npx playwright install chromium")}\n` +
      `then re-run your command. Alternatively, install everything globally and run the global clipy (not npx):\n` +
      `  ${c.bold("npm i -g @clipy/cli playwright && npx playwright install chromium && clipy record …")}`
    );
  }
  if (mode === "local") {
    return (
      `${head}\n` +
      `  ${c.bold("npm i -D playwright && npx playwright install chromium")}\n` +
      `Then re-run your command.`
    );
  }
  return (
    `${head}\n` +
    `  ${c.bold("npm install -g playwright")}\n` +
    `  ${c.bold("npx playwright install chromium")}\n` +
    `Then re-run your command. (Playwright is kept out of the base CLI so the ` +
    `read-only commands stay a small, dependency-free install.)`
  );
}

async function loadChromium(): Promise<PwChromium> {
  const res = await resolvePlaywright();
  if (res.ok) return res.chromium;
  die(playwrightMissingMessage(detectInstallMode().mode));
}

// --- Narration + shared upload plumbing (used by record AND session mode) ---

interface NarrationNote {
  startMs: number;
  endMs?: number;
  text: string;
}

interface Narration {
  text?: string;
  notes?: NarrationNote[];
}

/** Named viewport presets for `--viewports` (agent demos across screen sizes). */
const VIEWPORT_ALIASES: Record<string, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};

interface ViewportSpec {
  width: number;
  height: number;
  label: string;
}

function parseViewports(spec: string): ViewportSpec[] {
  const out: ViewportSpec[] = [];
  for (const part of spec.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const alias = VIEWPORT_ALIASES[part];
    if (alias) {
      out.push({ ...alias, label: `${part} (${alias.width}×${alias.height})` });
      continue;
    }
    const m = part.match(/^(\d{2,4})x(\d{2,4})$/);
    if (!m) {
      die(
        `invalid viewport "${part}" — use WIDTHxHEIGHT (e.g. 390x844) or ${Object.keys(VIEWPORT_ALIASES).join("/")}`,
        2,
      );
    }
    out.push({ width: parseInt(m[1], 10), height: parseInt(m[2], 10), label: `${m[1]}×${m[2]}` });
  }
  if (out.length === 0) die("no viewports parsed from --viewports", 2);
  if (out.length > 8) die("--viewports supports at most 8 sizes per recording", 2);
  return out;
}

/** A `--note` value parsed but not yet anchored. Absolute notes carry startMs;
 *  pass-scoped notes ("pass2: …", "pass2@5: …") carry a 1-based pass index and
 *  an optional in-pass offset, resolved to a real timestamp only after capture,
 *  against the ACTUAL recorded pass start times (which drift with load time). */
interface ParsedNote {
  text: string;
  startMs?: number;
  pass?: number;
  passOffsetMs?: number;
}

/**
 * Parses a `--note` flag value. Strict grammar — three shapes:
 *   "12: text"    / "12.5s: text"   → absolute note at 12s
 *   "pass2: text"                   → note at the real start of viewport pass 2
 *   "pass2@5: text" / "pass2@5s: t" → 5s into pass 2's real start
 * A value with no recognized prefix is a bare note at 0s. A value that LOOKS
 * like a pass directive but is malformed (e.g. "pass2 text" with no colon, or
 * "pass0:") is REJECTED, not silently demoted to an absolute-0 note — a wrong
 * timestamp that pairs a note with the wrong pass is worse than a hard error.
 */
function parseNoteFlag(value: string): ParsedNote {
  const v = value.trim();
  const passMatch = v.match(/^pass\s*(\d+)\s*(?:@\s*(\d+(?:\.\d+)?)\s*s?)?\s*:\s*(.+)$/i);
  if (passMatch) {
    const pass = parseInt(passMatch[1], 10);
    if (pass < 1) {
      die(`invalid --note "${value}": pass number must be an integer ≥ 1 (e.g. "pass2: text")`, 2);
    }
    return {
      pass,
      passOffsetMs: passMatch[2] ? Math.round(parseFloat(passMatch[2]) * 1000) : 0,
      text: passMatch[3].trim(),
    };
  }
  // Attempted-but-malformed pass directive ("pass2 text", "pass2@: x", "pass0:").
  if (/^pass\s*\d/i.test(v)) {
    die(
      `invalid --note "${value}": pass-scoped notes are "passN: text" or "passN@<seconds>: text" ` +
        `(integer pass ≥ 1, optional @seconds), e.g. "pass2: mobile" or "pass2@5: after scroll"`,
      2,
    );
  }
  const m = v.match(/^(\d+(?:\.\d+)?)\s*s?\s*:\s*(.+)$/);
  if (m) return { startMs: Math.round(parseFloat(m[1]) * 1000), text: m[2].trim() };
  return { startMs: 0, text: v };
}

/** Highest pass index referenced by any pass-scoped note (0 = none). */
function maxPassRef(parsed: ParsedNote[]): number {
  return parsed.reduce((m, n) => (n.pass != null && n.pass > m ? n.pass : m), 0);
}

/** Anchor parsed notes to absolute ms using the recorded pass start offsets
 *  (index 0 = pass 1). Pass-scoped notes land at their pass's real start (+offset);
 *  absolute notes pass through. An out-of-range pass clamps to the last pass. */
function resolveNarrationNotes(parsed: ParsedNote[], passStartsMs: number[]): NarrationNote[] {
  return parsed.map((n) => {
    if (n.pass != null) {
      const base = passStartsMs[n.pass - 1] ?? passStartsMs[passStartsMs.length - 1] ?? 0;
      return { startMs: Math.max(0, Math.round(base + (n.passOffsetMs ?? 0))), text: n.text };
    }
    return { startMs: Math.max(0, Math.round(n.startMs ?? 0)), text: n.text };
  });
}

/** WebM/Matroska files start with the EBML magic. Refuse to upload anything
 *  else — a crashed Chromium can leave a zero-byte or garbage file behind. */
function validateWebmFile(videoPath: string): number {
  const size = statSync(videoPath).size;
  if (size === 0) throw new Error("recording produced an empty file");
  const fd = openSync(videoPath, "r");
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    if (!(head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)) {
      throw new Error("recording file is not valid WebM (corrupt capture?)");
    }
  } finally {
    closeSync(fd);
  }
  return size;
}

// --- Recording kind (--type) -----------------------------------------------
// Declares what a recording IS, so the AI summary doesn't misread a demo as a
// bug report. Sent as `recordingKind` on raw-upload/complete. The literals +
// aliases mirror the server contract exactly (server also normalizes and
// ignores unknowns); the CLI validates locally so agents get instant feedback.

const RECORDING_KINDS = [
  "bug_report",
  "feature_request",
  "product_demo",
  "walkthrough_tutorial",
  "feedback_review",
  "discussion_talk",
  "other",
] as const;

const RECORDING_KIND_ALIASES: Record<string, string> = {
  bug: "bug_report",
  feature: "feature_request",
  demo: "product_demo",
  product: "product_demo",
  walkthrough: "walkthrough_tutorial",
  tutorial: "walkthrough_tutorial",
  guide: "walkthrough_tutorial",
  feedback: "feedback_review",
  review: "feedback_review",
  discussion: "discussion_talk",
  talk: "discussion_talk",
  meeting: "discussion_talk",
};

/** Normalize a --type value (case/space/hyphen-insensitive) to a canonical
 *  recordingKind literal, or null if unrecognized. */
function normalizeRecordingKind(input: string): string | null {
  const norm = input.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((RECORDING_KINDS as readonly string[]).includes(norm)) return norm;
  return RECORDING_KIND_ALIASES[norm] ?? null;
}

/** Validate a --type value; die() with the accepted list on a miss. */
function requireRecordingKind(input: string): string {
  const kind = normalizeRecordingKind(input);
  if (!kind) {
    die(
      `--type "${input}" is not a recording kind. Accepted: ${RECORDING_KINDS.join(", ")} ` +
        `(aliases: bug, feature, demo/product, walkthrough/tutorial/guide, feedback/review, discussion/talk/meeting)`,
      2,
    );
  }
  return kind;
}

interface UploadedRecording {
  publicId: string;
  shareUrl: string;
  contextUrl: string;
  sizeBytes: number;
}

/**
 * Streams a captured WebM through Clipy's raw-upload pipeline
 * (initiate → chunks → finalize → complete). Shared by `clipy record` and
 * session mode. Aborts the server-side upload session on failure.
 */
async function uploadWebmToClipy(
  ctx: Ctx,
  opts: {
    videoPath: string;
    name?: string;
    description?: string;
    narration?: Narration;
    recordingKind?: string;
    log: (m: string) => void;
  },
): Promise<UploadedRecording> {
  const sizeBytes = validateWebmFile(opts.videoPath);
  opts.log(`${c.dim(`captured ${fmtBytes(sizeBytes)} — uploading…`)}`);

  const recordingId = randomUUID();
  let uploadToken = "";
  let publicId = "";
  try {
    // 1) initiate → uploadToken + the video row (createVideoRow so the share
    //    link exists immediately). sourcePlatform 'web' is honest: this IS a
    //    web-content capture.
    const init = await ingestPostJson(ctx, "/api/videos/raw-upload/initiate", {
      recordingId,
      createVideoRow: true,
      sourcePlatform: "web",
      sourceVersion: `cli/${VERSION}`,
    });
    uploadToken = String(init.uploadToken ?? "");
    publicId = String(init.publicId ?? "");
    if (!uploadToken) throw new Error("initiate did not return an uploadToken");

    // 2) stream the WebM in sequential 4 MiB parts read straight off disk (a
    //    long capture never has to sit fully in memory). Sequential keeps
    //    nextPartNumber advancing so we never trip the out-of-order guard.
    const PART_SIZE = 4 * 1024 * 1024;
    const totalParts = Math.max(1, Math.ceil(sizeBytes / PART_SIZE));
    const fd = openSync(opts.videoPath, "r");
    try {
      const window = Buffer.allocUnsafe(PART_SIZE);
      let partNumber = 1;
      let offset = 0;
      while (offset < sizeBytes) {
        const bytesRead = readSync(fd, window, 0, PART_SIZE, offset);
        if (bytesRead <= 0) break;
        // new Blob([...]) snapshots the bytes synchronously, so reusing `window`
        // on the next iteration is safe (the chunk is fully sent before then).
        await ingestPostChunk(ctx, recordingId, uploadToken, partNumber, window.subarray(0, bytesRead));
        if (process.stderr.isTTY) {
          process.stderr.write(`\r${c.dim(`uploading… part ${partNumber}/${totalParts}`)}`);
        }
        offset += bytesRead;
        partNumber++;
      }
    } finally {
      closeSync(fd);
    }
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");

    // 3) finalize (seal bytes) then 4) complete (promote the row + enqueue
    //    transcode/transcribe/summarize). Narration rides `complete` and
    //    becomes the transcript server-side when the capture has no speech.
    await ingestPostJson(ctx, "/api/videos/raw-upload/finalize", { recordingId, uploadToken });
    await ingestPostJson(ctx, "/api/videos/raw-upload/complete", {
      recordingId,
      uploadToken,
      name: opts.name,
      description: opts.description,
      sourcePlatform: "web",
      sourceVersion: `cli/${VERSION}`,
      ...(opts.recordingKind ? { recordingKind: opts.recordingKind } : {}),
      ...(opts.narration && (opts.narration.text || opts.narration.notes?.length)
        ? { narration: opts.narration }
        : {}),
    });
    uploadToken = ""; // completed — nothing to abort below
  } catch (e) {
    // Best-effort: release the half-uploaded streaming session so it doesn't
    // sit as an orphan (the server also janitors orphans after 8 days).
    if (uploadToken) {
      await ingestPostJson(ctx, "/api/videos/raw-upload/abort", { recordingId, uploadToken }).catch(
        () => {},
      );
    }
    throw e;
  }
  return {
    publicId,
    shareUrl: `${ctx.apiUrl}/video/${publicId}`,
    // The friendly content-negotiated form: markdown to agents, a rendered
    // page to browsers. Same document as /api/agent-context/<id>.
    contextUrl: `${ctx.apiUrl}/video/${publicId}.md`,
    sizeBytes,
  };
}

/**
 * Blank-frame heuristic. We can't decode pixels without a dependency, so JPEG
 * size per megapixel is our stddev/complexity proxy: a uniform "still
 * compiling" screen compresses to a tiny JPEG, real UI to a much larger one.
 * Calibrated at quality 30 on a 1280×720 viewport — solid colours, a bare
 * "Compiling…" line, and a lone spinner all land ~6.7–7.0 KB/MP; a real page
 * with a header, nav, text and a table is ~22 KB/MP. 12 KB/MP sits well clear
 * of both, biased to treat splash/compile screens as blank.
 */
function isBlankFrame(jpeg: Buffer, width: number, height: number): boolean {
  const px = Math.max(1, width * height);
  const bytesPerMegapixel = (jpeg.length / px) * 1_000_000;
  return bytesPerMegapixel < 12_000;
}

/**
 * Poll cheap JPEG screenshots until the frame has real content (not the blank
 * t=0 a still-compiling dev server shows) or a 10s cap, so the capture clock —
 * and every note anchored to it — starts on the first meaningful frame, not on
 * a blank one. Returns the ms spent waiting; logs when it waited meaningfully.
 */
async function waitForFirstPaint(
  page: PwPage,
  size: { width: number; height: number },
  log: (m: string) => void,
): Promise<number> {
  const CAP_MS = 10_000;
  const POLL_MS = 250;
  const start = Date.now();
  for (;;) {
    let blank = true;
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 30 });
      blank = isBlankFrame(buf, size.width, size.height);
    } catch {
      blank = true; // screenshot failed (page not ready yet) — keep waiting
    }
    if (!blank) break;
    if (Date.now() - start >= CAP_MS) {
      log(
        c.yellow(
          `no meaningful paint after ${Math.round(CAP_MS / 1000)}s — starting the clock anyway (a blank app shell is fine)`,
        ),
      );
      break;
    }
    await page.waitForTimeout(POLL_MS);
  }
  const waited = Date.now() - start;
  if (waited >= POLL_MS * 2) log(c.dim(`waited ${(waited / 1000).toFixed(1)}s for first meaningful paint`));
  return waited;
}

interface RecordOpts {
  url: string;
  forSec: number;
  name?: string;
  description?: string;
  recordingKind?: string;
  notes: ParsedNote[];
  viewports: ViewportSpec[] | null;
  width: number;
  height: number;
  wait: boolean;
  json: boolean;
}

async function cmdRecord(ctx: Ctx, opts: RecordOpts): Promise<void> {
  // Validate the target URL up front — a headless browser will happily hang on
  // a typo'd or non-http(s) URL otherwise.
  let target: URL;
  try {
    target = new URL(opts.url);
  } catch {
    die(`invalid --url: ${opts.url}`, 2);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    die(`--url must be http(s), got ${target.protocol}`, 2);
  }
  requireKey(ctx); // fail fast before we spin up a browser

  const chromium = await loadChromium();
  const tmpDir = join(tmpdir(), `clipy-record-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  const log = (m: string) => {
    if (!opts.json) process.stderr.write(`${m}\n`);
  };

  // Multi-viewport mode records every size sequentially into ONE video; the
  // frame is sized to the largest viewport and smaller passes letterbox
  // inside it. Each pass emits an auto note so the transcript chapters the
  // passes ("Viewport mobile (390×844)" …).
  const passes: ViewportSpec[] = opts.viewports ?? [
    { width: opts.width, height: opts.height, label: `${opts.width}×${opts.height}` },
  ];
  const frame = {
    width: Math.max(...passes.map((v) => v.width)),
    height: Math.max(...passes.map((v) => v.height)),
  };

  // A pass-scoped note ("pass3: …") that names a pass we won't record is almost
  // always a mistake — fail fast before spinning up the browser.
  const maxRef = maxPassRef(opts.notes);
  if (maxRef > passes.length) {
    die(
      `--note "pass${maxRef}: …" refers to pass ${maxRef}, but this recording has ${passes.length} pass${passes.length === 1 ? "" : "es"}` +
        `${opts.viewports ? "" : " (pass-scoped notes are for --viewports; use an absolute timestamp otherwise)"}`,
      2,
    );
  }

  let uploaded: UploadedRecording;
  const autoNotes: NarrationNote[] = [];
  // The real start of each pass, measured from the capture clock (index 0 =
  // pass 1). Pass-scoped notes anchor to these actual times, not fixed guesses.
  const passStartsMs: number[] = [];
  try {
    // --- Capture -----------------------------------------------------------
    let videoPath: string;
    log(`${c.dim("launching headless chromium…")}`);
    const browser = await chromium.launch({
      headless: true,
      // Cloud sandboxes / CI containers run as root where Chromium's own
      // sandbox can't initialize; this is a user-driven capture of a URL they
      // chose, so the browser sandbox isn't a trust boundary here.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const context = await browser.newContext({
        viewport: { width: frame.width, height: frame.height },
        recordVideo: { dir: tmpDir, size: frame },
      });
      const page = await context.newPage();
      // captureStart is set AFTER the first meaningful paint (below), so notes
      // and pass marks aren't anchored to the blank t=0 a compiling app shows.
      let captureStart = 0;
      for (const [i, vp] of passes.entries()) {
        if (opts.viewports) {
          await page.setViewportSize({ width: vp.width, height: vp.height }).catch(() => {});
          log(`${c.dim(`viewport ${vp.label}…`)}`);
        }
        log(`${c.dim(`opening ${target.href}…`)}`);
        try {
          await page.goto(target.href, { waitUntil: "load", timeout: 30_000 });
        } catch {
          // A slow SPA may not fire 'load' — keep recording anyway; the agent
          // asked to capture whatever is on screen for --for seconds.
          log(c.yellow(`page load timed out; recording current state anyway`));
        }
        // Gate the capture clock on first meaningful paint (once, on pass 1).
        if (i === 0) {
          await waitForFirstPaint(page, frame, log);
          captureStart = Date.now();
        }
        const passStart = Date.now() - captureStart;
        passStartsMs[i] = passStart;
        if (opts.viewports) {
          autoNotes.push({
            startMs: passStart,
            // "pass N/M start" is a deterministic, machine-parseable tag so
            // downstream key-moment alignment knows exactly where each pass began.
            text: `[auto] Viewport pass ${i + 1}/${passes.length} start: ${vp.label}`,
          });
        }
        log(`${c.dim(`recording for ${opts.forSec}s…`)}`);
        if (opts.viewports) {
          // Slow scroll through the page so each size shows real layout, not
          // just the fold. Scroll in ~6 steps across the pass duration.
          const steps = 6;
          const stepMs = (opts.forSec * 1000) / steps;
          for (let s = 0; s < steps; s++) {
            await page.waitForTimeout(stepMs);
            await page.mouse.wheel(0, Math.round(vp.height * 0.7)).catch(() => {});
          }
        } else {
          await page.waitForTimeout(opts.forSec * 1000);
        }
      }
      const video = page.video();
      // Close the page then context so Playwright finalizes + flushes the WebM.
      await page.close();
      await context.close();
      if (!video) throw new Error("browser did not produce a video (recordVideo unavailable)");
      videoPath = await video.path();
    } finally {
      await browser.close().catch(() => {});
    }

    // --- Upload ------------------------------------------------------------
    const notes = [...autoNotes, ...resolveNarrationNotes(opts.notes, passStartsMs)].sort(
      (a, b) => a.startMs - b.startMs,
    );
    uploaded = await uploadWebmToClipy(ctx, {
      videoPath,
      name: opts.name,
      description: opts.description,
      recordingKind: opts.recordingKind,
      narration: notes.length ? { notes } : undefined,
      log,
    });
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }

  if (opts.wait && uploaded.publicId) {
    log(`${c.dim("waiting for transcript…")}`);
    await waitForArtifacts(ctx, uploaded.publicId).catch(() => {
      log(c.yellow("artifacts not ready yet — they'll finish in the background"));
    });
  }

  if (opts.json) {
    printJson({
      id: uploaded.publicId,
      shareUrl: uploaded.shareUrl,
      contextUrl: uploaded.contextUrl,
      sizeBytes: uploaded.sizeBytes,
    });
    return;
  }
  process.stdout.write(`${c.green("✓")} recorded — ${c.bold(uploaded.shareUrl)}\n`);
  process.stdout.write(`${c.dim("agent context:")} ${uploaded.contextUrl}\n`);
  process.stdout.write(
    `${c.dim("next:")} clipy context ${uploaded.publicId}  ·  clipy transcript ${uploaded.publicId}\n`,
  );
}

/** Poll until the transcript reaches a terminal state (or ~5 min elapse). */
async function waitForArtifacts(ctx: Ctx, publicId: string): Promise<void> {
  const pid = encodeURIComponent(publicId);
  const deadline = Date.now() + 300_000;
  const terminal = new Set(["ready", "failed", "none"]);
  for (;;) {
    const t = await apiJson(ctx, `/api/v1/recordings/${pid}/transcript`);
    if (terminal.has(String(t.status))) return;
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------
// Session mode — "the agent works, Clipy is the camera crew."
//
//   clipy session start --url <app>     start recording in a detached daemon
//   clipy mark "reproduced the bug"     drop a timestamped note (live clock)
//   clipy session stop                  finalize + upload; marks become the
//                                       recording's narration → transcript
//   clipy session abort                 discard everything, upload nothing
//
// The daemon is this same binary re-invoked with a hidden __session-daemon
// command, detached from the parent so `session start` returns immediately
// while Chromium keeps recording. Control is file-based (portable everywhere
// Node runs): the daemon polls a control file for stop/abort, `clipy mark`
// appends JSON lines to a marks file, and all state lives in a session file
// keyed by the working directory (one active session per workspace).
//
// Safety rails (enforced here, not by prompts): a mandatory max duration
// (default 600s, hard cap 1800s) auto-stops AND UPLOADS the partial result;
// abort/error paths clean up both local temp files and the server-side
// upload session; a crashed daemon is detected via pid-liveness and cleared.
// ---------------------------------------------------------------------------

interface SessionResult {
  publicId: string;
  shareUrl: string;
  contextUrl: string;
  sizeBytes: number;
}

interface SessionState {
  version: 1;
  /** 'web' (default) = local Playwright daemon; 'mac' = the desktop app's
   *  agent bridge owns the recording and this file only routes the verbs. */
  kind?: "web" | "mac";
  bridge?: { socketPath: string; token: string; pid: number };
  pid: number;
  cwd: string;
  url: string;
  name?: string;
  description?: string;
  recordingKind?: string;
  maxSec: number;
  width: number;
  height: number;
  /** Opt-in (via --expose-cdp): only then does the daemon launch a debugging
   *  port. The env kill switch CLIPY_DISABLE_CDP=1 overrides it in the daemon. */
  exposeCdp?: boolean;
  state:
    | "starting"
    | "recording"
    | "stopping"
    | "uploading"
    | "done"
    | "failed"
    | "aborted";
  recordStartEpochMs?: number;
  /** CDP endpoints for the daemon's Chromium (web sessions, --expose-cdp only),
   *  so an agent can attach with its own Playwright and drive navigation/clicks/
   *  viewport WHILE clipy records. cdpUrl is the browser ws endpoint; cdpHttpUrl
   *  is the http base — both accepted by playwright.connectOverCDP(). */
  cdpUrl?: string;
  cdpHttpUrl?: string;
  error?: string;
  /** On upload failure the capture is preserved here instead of deleted. */
  keptVideoPath?: string;
  result?: SessionResult;
  marksPath: string;
  controlPath: string;
  logPath: string;
  tmpDir: string;
}

function sessionDir(): string {
  return join(dirname(configPath()), "sessions");
}

/** One session per workspace: the session file is keyed by cwd. */
function sessionFilePath(cwd: string): string {
  const digest = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return join(sessionDir(), `session-${digest}.json`);
}

function readSessionState(file: string): SessionState | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionState;
  } catch {
    return null;
  }
}

function writeSessionState(file: string, state: SessionState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // 0600: the state file can hold a CDP endpoint that grants full control of
  // the recording browser — keep it owner-only. mode on writeFileSync is
  // umask-masked, so chmod explicitly to guarantee it.
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on platforms without POSIX modes
  }
  renameSync(tmp, file);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionIsActive(state: SessionState): boolean {
  return (
    ["starting", "recording", "stopping", "uploading"].includes(state.state) &&
    pidAlive(state.pid)
  );
}

function cleanupSessionFiles(state: SessionState, file: string): void {
  for (const p of [state.marksPath, state.controlPath, file]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best-effort
    }
  }
}

// --- Mac bridge flows (--source mac-screen): the desktop app records -------

/** Resolves --window/--display to a bridge capture source (null = app default,
 *  i.e. the full primary display). die()s with the candidate list on no/ambiguous
 *  match so the agent can correct itself. */
async function resolveBridgeTarget(
  info: BridgeInfo,
  opts: { window?: string; display?: string },
): Promise<{ source: CaptureSource; label: string } | null> {
  if (!opts.window && !opts.display) return null;
  try {
    return await resolveCaptureSource(info, opts);
  } catch (e) {
    die((e as Error).message);
  }
}

/** One-shot real-screen recording through the running Clipy app. */
async function cmdRecordMac(opts: {
  forSec: number;
  name?: string;
  description?: string;
  recordingKind?: string;
  notes: ParsedNote[];
  window?: string;
  display?: string;
  json: boolean;
}): Promise<{ publicId: string; shareUrl: string }> {
  // A real-screen capture is one continuous take — there are no viewport passes
  // to anchor pass-scoped notes against.
  const macMaxRef = maxPassRef(opts.notes);
  if (macMaxRef > 1) {
    die(
      `--note "pass${macMaxRef}: …" needs --viewports (multiple passes). --source mac-screen is one continuous capture — use an absolute timestamp, e.g. --note "12: text".`,
      2,
    );
  }
  const info = readBridgeInfo();
  const log = (m: string) => {
    if (!opts.json) process.stderr.write(`${m}\n`);
  };
  const target = await resolveBridgeTarget(info, opts);
  log(
    `${c.dim(`asking the Clipy app (v${info.appVersion}) to record ${target?.label ?? "the screen"}…`)}`,
  );
  // --type on the mac path: the current Clipy app doesn't forward recordingKind
  // from the bridge to its raw-upload/complete call (its AgentCompleteExtras has
  // no such field — desktop follow-up). We still send it (serde ignores unknown
  // start-args, so it's forward-compatible) but tell the user it isn't applied
  // yet, rather than silently dropping their intent.
  if (opts.recordingKind) {
    log(
      c.yellow(
        `note: --type is not applied to --source mac-screen recordings yet (needs a Clipy app update)`,
      ),
    );
  }
  const notes = resolveNarrationNotes(opts.notes, [0]);
  await bridgeRequest(info, "start", {
    // The recording is stopped by us after forSec; maxSec is the safety net
    // in case this CLI process dies mid-wait.
    maxSec: Math.min(opts.forSec + 60, 1800),
    title: opts.name,
    description: opts.description,
    ...(opts.recordingKind ? { recordingKind: opts.recordingKind } : {}),
    notes: notes.map((n) => ({ startMs: n.startMs, text: n.text })),
    ...(target ? { source: target.source } : {}),
  });
  log(`${c.dim(`recording for ${opts.forSec}s…`)}`);
  await new Promise((r) => setTimeout(r, opts.forSec * 1000));
  log(`${c.dim("stopping + uploading…")}`);
  const result = await bridgeRequest(info, "stop");
  return {
    publicId: String(result.publicId ?? ""),
    shareUrl: String(result.shareUrl ?? ""),
  };
}

function macSessionState(info: BridgeInfo, maxSec: number): SessionState {
  const dir = sessionDir();
  return {
    version: 1,
    kind: "mac",
    bridge: { socketPath: info.socketPath, token: info.token, pid: info.pid },
    pid: info.pid,
    cwd: process.cwd(),
    url: "mac-screen",
    maxSec,
    width: 0,
    height: 0,
    state: "recording",
    recordStartEpochMs: Date.now(),
    marksPath: join(dir, "unused"),
    controlPath: join(dir, "unused"),
    logPath: join(dir, "unused"),
    tmpDir: join(dir, "unused"),
  };
}

function bridgeInfoFromSession(state: SessionState): BridgeInfo {
  if (!state.bridge) {
    die("session file is missing bridge info — abort it with `clipy session abort` and restart");
  }
  return {
    socketPath: state.bridge.socketPath,
    token: state.bridge.token,
    pid: state.bridge.pid,
    appVersion: "",
    protocolVersion: 1,
  };
}

async function cmdSessionStart(
  ctx: Ctx,
  opts: {
    url: string;
    name?: string;
    description?: string;
    recordingKind?: string;
    maxSec: number;
    width: number;
    height: number;
    json: boolean;
    source: "web" | "mac-screen";
    window?: string;
    display?: string;
    exposeCdp?: boolean;
  },
): Promise<void> {
  if (opts.source === "mac-screen") {
    const file = sessionFilePath(process.cwd());
    const existing = readSessionState(file);
    if (existing && existing.kind !== "mac" && sessionIsActive(existing)) {
      die("a web recording session is already active here — finish or abort it first");
    }
    const info = readBridgeInfo();
    const maxSec = Math.min(Math.max(1, opts.maxSec), SESSION_HARD_CAP_SEC);
    const target = await resolveBridgeTarget(info, opts);
    // See cmdRecordMac: --type isn't applied on the mac path yet (desktop gap);
    // send it forward-compat but tell the user.
    if (opts.recordingKind && !opts.json) {
      process.stderr.write(
        `${c.yellow("note: --type is not applied to --source mac-screen recordings yet (needs a Clipy app update)")}\n`,
      );
    }
    await bridgeRequest(info, "start", {
      maxSec,
      title: opts.name,
      description: opts.description,
      ...(opts.recordingKind ? { recordingKind: opts.recordingKind } : {}),
      ...(target ? { source: target.source } : {}),
    });
    writeSessionState(file, macSessionState(info, maxSec));
    if (opts.json) {
      printJson({ state: "recording", source: "mac-screen", maxSec, target: target?.label });
      return;
    }
    process.stdout.write(
      `${c.green("✓")} the Clipy app is recording ${target ? target.label : "your screen"} (max ${maxSec}s)\n`,
    );
    process.stdout.write(
      `${c.dim("while it runs:")} clipy mark "what just happened"\n` +
        `${c.dim("when finished:")} clipy session stop   ${c.dim("· discard:")} clipy session abort\n`,
    );
    return;
  }
  let target: URL;
  try {
    target = new URL(opts.url);
  } catch {
    die(`invalid --url: ${opts.url}`, 2);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    die(`--url must be http(s), got ${target.protocol}`, 2);
  }
  const key = requireKey(ctx);
  await loadChromium(); // fail fast with install instructions before daemonizing

  const file = sessionFilePath(process.cwd());
  const existing = readSessionState(file);
  if (existing && sessionIsActive(existing)) {
    die(
      `a recording session is already active in this workspace (pid ${existing.pid}, started for ${existing.url}).\n` +
        `Finish it with \`clipy session stop\` or discard it with \`clipy session abort\`.`,
    );
  }
  if (existing) cleanupSessionFiles(existing, file); // stale (daemon died) — clear

  const maxSec = Math.min(Math.max(1, opts.maxSec), SESSION_HARD_CAP_SEC);
  const id = randomUUID();
  const dir = sessionDir();
  mkdirSync(dir, { recursive: true });
  const state: SessionState = {
    version: 1,
    pid: 0,
    cwd: process.cwd(),
    url: target.href,
    name: opts.name,
    description: opts.description,
    recordingKind: opts.recordingKind,
    maxSec,
    width: opts.width,
    height: opts.height,
    exposeCdp: opts.exposeCdp,
    state: "starting",
    marksPath: join(dir, `marks-${id}.jsonl`),
    controlPath: join(dir, `control-${id}.json`),
    logPath: join(dir, `daemon-${id}.log`),
    tmpDir: join(tmpdir(), `clipy-session-${id}`),
  };

  const logFd = openSync(state.logPath, "a");
  const child = spawn(process.execPath, [process.argv[1], "__session-daemon", file], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      CLIPY_API_KEY: key,
      CLIPY_API_URL: ctx.apiUrl,
    },
  });
  closeSync(logFd);
  if (!child.pid) die("failed to spawn the session daemon");
  state.pid = child.pid;
  writeSessionState(file, state);
  child.unref();

  // Wait for the daemon to actually start recording (first Chromium launch on
  // a cold cache can take a while) so the agent's next command lands inside a
  // live recording, not a race.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const s = readSessionState(file);
    if (s?.state === "recording") break;
    if (s?.state === "failed") {
      die(`session failed to start: ${s.error ?? "unknown error"} (log: ${state.logPath})`);
    }
    if (Date.now() >= deadline || (s && !pidAlive(s.pid))) {
      die(`session daemon did not start in time (log: ${state.logPath})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const started = readSessionState(file);
  if (opts.json) {
    printJson({
      state: "recording",
      url: target.href,
      maxSec,
      sessionFile: file,
      cdpUrl: started?.cdpUrl ?? null,
      cdpHttpUrl: started?.cdpHttpUrl ?? null,
    });
    return;
  }
  process.stdout.write(`${c.green("✓")} recording ${c.bold(target.href)} (max ${maxSec}s)\n`);
  if (started?.cdpHttpUrl) {
    process.stdout.write(
      `${c.yellow("⚠ CDP exposed:")} any local process can attach to and control this browser while the session runs.\n` +
        `${c.dim(`drive the browser: connect your tools to ${started.cdpHttpUrl}`)}\n`,
    );
  } else if (opts.exposeCdp) {
    // Asked for it, but it isn't up — either env-disabled or discovery failed.
    process.stdout.write(
      `${c.dim(
        process.env.CLIPY_DISABLE_CDP === "1"
          ? "CDP not exposed (CLIPY_DISABLE_CDP=1 overrides --expose-cdp)"
          : "CDP requested but the endpoint could not be established — see the daemon log",
      )}\n`,
    );
  }
  process.stdout.write(
    `${c.dim("while it runs:")} clipy mark "what just happened"\n` +
      `${c.dim("when finished:")} clipy session stop   ${c.dim("· discard:")} clipy session abort\n`,
  );
}

function requireSession(): { file: string; state: SessionState } {
  const file = sessionFilePath(process.cwd());
  const state = readSessionState(file);
  if (!state) {
    die(`no recording session in this workspace. Start one with \`clipy session start --url <app>\`.`);
  }
  return { file, state };
}

async function cmdMark(text: string, json: boolean): Promise<void> {
  const { file, state } = requireSession();
  if (state.kind === "mac") {
    const result = await bridgeRequest(bridgeInfoFromSession(state), "mark", { text }).catch(
      (e: Error) => {
        if (e instanceof BridgeUnavailableError) {
          cleanupSessionFiles(state, file);
          die("the Clipy app is no longer running — session cleared. Start a new one.");
        }
        die(e.message);
      },
    );
    if (json) {
      printJson(result);
      return;
    }
    process.stdout.write(
      `${c.green("✓")} mark @ ${Number(result.atSeconds ?? 0).toFixed(1)}s — ${text.trim()}\n`,
    );
    return;
  }
  if (!pidAlive(state.pid)) {
    cleanupSessionFiles(state, file);
    die("the session daemon is no longer running (crashed?) — session cleared. Start a new one.");
  }
  if (state.state !== "recording" || !state.recordStartEpochMs) {
    die(`session is ${state.state} — marks can only be added while recording`);
  }
  const tMs = Math.max(0, Date.now() - state.recordStartEpochMs);
  appendFileSync(state.marksPath, `${JSON.stringify({ tMs, text: text.trim() })}\n`);
  if (json) {
    printJson({ tMs, text: text.trim() });
    return;
  }
  const sec = (tMs / 1000).toFixed(1);
  process.stdout.write(`${c.green("✓")} mark @ ${sec}s — ${text.trim()}\n`);
}

async function cmdSessionStop(json: boolean): Promise<void> {
  const { file, state } = requireSession();
  if (state.kind === "mac") {
    if (!json) process.stderr.write(`${c.dim("stopping + uploading…")}\n`);
    const result = await bridgeRequest(bridgeInfoFromSession(state), "stop").catch((e: Error) => {
      cleanupSessionFiles(state, file);
      die(e.message);
    });
    cleanupSessionFiles(state, file);
    const publicId = String(result.publicId ?? "");
    reportSessionResult(
      {
        publicId,
        shareUrl: String(result.shareUrl ?? ""),
        contextUrl: `https://clipy.online/api/agent-context/${publicId}`,
        sizeBytes: 0,
      },
      json,
    );
    return;
  }
  if (!pidAlive(state.pid)) {
    // Daemon already gone: it may have finished (auto-stop at max duration)
    // or crashed. Report whatever terminal state it left behind.
    if (state.state === "done" && state.result) {
      reportSessionResult(state.result, json);
      cleanupSessionFiles(state, file);
      return;
    }
    cleanupSessionFiles(state, file);
    die(
      state.state === "failed"
        ? `session failed: ${state.error ?? "unknown"} (log: ${state.logPath})`
        : "the session daemon is no longer running (crashed?) — session cleared.",
    );
  }
  writeFileSync(state.controlPath, JSON.stringify({ action: "stop" }));
  if (!json) process.stderr.write(`${c.dim("stopping + uploading…")}\n`);
  // Stop = close browser + upload; give long recordings room to finish.
  const deadline = Date.now() + 600_000;
  for (;;) {
    const s = readSessionState(file);
    if (s?.state === "done" && s.result) {
      reportSessionResult(s.result, json);
      cleanupSessionFiles(s, file);
      return;
    }
    if (s?.state === "failed") {
      const kept = s.keptVideoPath ? `\nThe capture was kept at: ${s.keptVideoPath}` : "";
      cleanupSessionFiles(s, file);
      die(`session upload failed: ${s.error ?? "unknown"}${kept}`);
    }
    if (s?.state === "aborted") {
      cleanupSessionFiles(s, file);
      die("session was aborted");
    }
    if (s && !pidAlive(s.pid)) {
      cleanupSessionFiles(s, file);
      die(`the session daemon died mid-stop (log: ${state.logPath})`);
    }
    if (Date.now() >= deadline) {
      die(`timed out waiting for the session to finish (log: ${state.logPath})`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function reportSessionResult(result: SessionResult, json: boolean): void {
  if (json) {
    printJson({
      id: result.publicId,
      shareUrl: result.shareUrl,
      contextUrl: result.contextUrl,
      sizeBytes: result.sizeBytes,
    });
    return;
  }
  process.stdout.write(`${c.green("✓")} recorded — ${c.bold(result.shareUrl)}\n`);
  process.stdout.write(`${c.dim("agent context:")} ${result.contextUrl}\n`);
  process.stdout.write(
    `${c.dim("next:")} clipy context ${result.publicId}  ·  clipy wait ${result.publicId}\n`,
  );
}

async function cmdSessionAbort(json: boolean): Promise<void> {
  const { file, state } = requireSession();
  if (state.kind === "mac") {
    await bridgeRequest(bridgeInfoFromSession(state), "abort").catch(() => {});
    cleanupSessionFiles(state, file);
    if (json) printJson({ state: "aborted" });
    else process.stdout.write(`${c.green("✓")} session aborted — nothing was uploaded\n`);
    return;
  }
  if (!pidAlive(state.pid)) {
    cleanupSessionFiles(state, file);
    if (!json) process.stdout.write(`${c.green("✓")} stale session cleared (daemon was not running)\n`);
    else printJson({ state: "cleared" });
    return;
  }
  writeFileSync(state.controlPath, JSON.stringify({ action: "abort" }));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const s = readSessionState(file);
    if (!s || s.state === "aborted" || s.state === "failed" || !pidAlive(s.pid)) break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const final = readSessionState(file);
  if (final) cleanupSessionFiles(final, file);
  if (json) printJson({ state: "aborted" });
  else process.stdout.write(`${c.green("✓")} session aborted — nothing was uploaded\n`);
}

async function cmdSessionStatus(json: boolean): Promise<void> {
  const file = sessionFilePath(process.cwd());
  const state = readSessionState(file);
  if (!state) {
    if (json) printJson({ state: "none" });
    else process.stdout.write(`${c.dim("no session in this workspace")}\n`);
    return;
  }
  if (state.kind === "mac" && state.state === "recording") {
    // The stored pid is the desktop APP's, which outlives the recording — ask
    // the bridge for the truth instead of inferring from process liveness.
    try {
      const status = await bridgeRequest(bridgeInfoFromSession(state), "status");
      const session = status.agentSession as
        | { elapsedSec?: number; maxSec?: number; marks?: number }
        | null
        | undefined;
      if (!session) {
        if (json) printJson({ state: "ended", url: state.url });
        else
          process.stdout.write(
            `${c.bold("ended")} — the app finished this recording (auto-stop or Stop in the app).\n` +
              `${c.dim("clear the session file with:")} clipy session abort\n`,
          );
        return;
      }
      if (json) {
        printJson({
          state: "recording",
          url: state.url,
          elapsedSec: session.elapsedSec ?? null,
          maxSec: session.maxSec ?? state.maxSec,
          marks: session.marks ?? null,
        });
        return;
      }
      process.stdout.write(
        `${c.bold("recording")} — ${state.url} — ${session.elapsedSec ?? "?"}s elapsed (max ${session.maxSec ?? state.maxSec}s, ${session.marks ?? 0} marks)\n`,
      );
      return;
    } catch {
      if (json) printJson({ state: "dead", url: state.url });
      else
        process.stdout.write(
          `${c.bold("dead")} — the Clipy app is not answering. ${c.dim("clear with:")} clipy session abort\n`,
        );
      return;
    }
  }
  const alive = pidAlive(state.pid);
  const elapsed =
    state.recordStartEpochMs && state.state === "recording"
      ? Math.round((Date.now() - state.recordStartEpochMs) / 1000)
      : null;
  if (json) {
    printJson({
      state: alive || ["done", "failed", "aborted"].includes(state.state) ? state.state : "dead",
      url: state.url,
      elapsedSec: elapsed,
      maxSec: state.maxSec,
      pid: state.pid,
      cdpUrl: state.cdpUrl ?? null,
      cdpHttpUrl: state.cdpHttpUrl ?? null,
    });
    return;
  }
  process.stdout.write(
    `${c.bold(state.state)}${alive ? "" : c.red(" (daemon dead)")} — ${state.url}` +
      `${elapsed != null ? ` — ${elapsed}s elapsed (max ${state.maxSec}s)` : ""}\n`,
  );
  if (state.cdpHttpUrl && state.state === "recording" && alive) {
    process.stdout.write(`${c.dim(`drive the browser: connect your tools to ${state.cdpHttpUrl}`)}\n`);
  }
}

// --- The daemon itself (hidden __session-daemon command) --------------------

interface PwFrame {
  url(): string;
  parentFrame(): unknown;
}
interface PwConsoleMessage {
  type(): string;
  text(): string;
}

/** Reserve a free localhost TCP port for Chromium's CDP endpoint. Binding to
 *  :0 then closing hands us a concrete port to pass to --remote-debugging-port,
 *  which we can then poll — passing 0 directly leaves the chosen port only in
 *  Chromium's DevToolsActivePort file, which Playwright's temp profile hides. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

/** After Chromium is up with --remote-debugging-port, its HTTP endpoint exposes
 *  the browser-level ws URL at /json/version. Poll until it answers (or 10s). */
async function discoverCdpWsUrl(port: number): Promise<string | null> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
    } catch {
      // endpoint not up yet
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function runSessionDaemon(file: string): Promise<void> {
  const state = readSessionState(file);
  if (!state) {
    process.stderr.write(`[clipy-session] session file missing: ${file}\n`);
    process.exit(1);
  }
  const ctx: Ctx = {
    apiUrl: process.env.CLIPY_API_URL || "https://clipy.online",
    apiKey: process.env.CLIPY_API_KEY || null,
  };
  const save = (patch: Partial<SessionState>) => {
    Object.assign(state, patch);
    writeSessionState(file, state);
  };
  const log = (m: string) => process.stderr.write(`[clipy-session] ${new Date().toISOString()} ${m}\n`);

  const autoMarks: NarrationNote[] = [];
  let recordStart = 0;
  const autoMark = (text: string) => {
    if (autoMarks.length >= 50 || recordStart === 0) return;
    autoMarks.push({ startMs: Math.max(0, Date.now() - recordStart), text });
  };

  mkdirSync(state.tmpDir, { recursive: true });
  let browser: PwBrowser | null = null;
  try {
    const chromium = await loadChromium();
    log(`launching chromium for ${state.url}`);
    // CDP is OPT-IN (--expose-cdp) and the env kill switch wins over the flag:
    // no debugging port is opened unless the user asked AND CLIPY_DISABLE_CDP
    // isn't set. When enabled, Playwright still controls the browser over its
    // own pipe; the extra --remote-debugging-port opens a parallel TCP endpoint
    // an agent can attach to.
    const wantCdp = !!state.exposeCdp && process.env.CLIPY_DISABLE_CDP !== "1";
    if (state.exposeCdp && !wantCdp) log("CDP disabled by CLIPY_DISABLE_CDP=1 — not opening a debugging port");
    const cdpPort = wantCdp ? await pickFreePort().catch(() => 0) : 0;
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
      ],
    });
    const context = await browser.newContext({
      viewport: { width: state.width, height: state.height },
      recordVideo: { dir: state.tmpDir, size: { width: state.width, height: state.height } },
    });
    const page = await context.newPage();

    // Best-effort: publish the CDP URL so `session start`/`status` can hand it
    // to the agent. The recording works fine even if discovery fails.
    let cdpUrl: string | undefined;
    let cdpHttpUrl: string | undefined;
    if (cdpPort) {
      cdpUrl = (await discoverCdpWsUrl(cdpPort)) ?? undefined;
      if (cdpUrl) {
        cdpHttpUrl = `http://127.0.0.1:${cdpPort}`;
        log(`CDP endpoint ready at ${cdpHttpUrl} (${cdpUrl})`);
      } else {
        log(`CDP endpoint not reachable on port ${cdpPort} — browser drive unavailable`);
      }
    }

    // Auto-marks: instrumentation ground truth alongside the agent's intent
    // marks. Type-tagged with [auto] so the transcript distinguishes them.
    page.on("framenavigated", ((frame: PwFrame) => {
      try {
        if (frame.parentFrame() === null) autoMark(`[auto] navigated to ${frame.url()}`);
      } catch {
        // never let instrumentation kill the recording
      }
    }) as never);
    page.on("console", ((msg: PwConsoleMessage) => {
      try {
        if (msg.type() === "error") {
          autoMark(`[auto] console error: ${msg.text().slice(0, 200)}`);
        }
      } catch {
        // ignore
      }
    }) as never);

    recordStart = Date.now();
    save({ state: "recording", recordStartEpochMs: recordStart, cdpUrl, cdpHttpUrl });
    try {
      await page.goto(state.url, { waitUntil: "load", timeout: 30_000 });
    } catch {
      log("page load timed out; recording current state anyway");
    }

    // Main loop: poll the control file; enforce the max-duration rail.
    let stopReason: "stop" | "abort" | "max" = "stop";
    for (;;) {
      await page.waitForTimeout(400);
      let control: { action?: string } | null = null;
      try {
        control = JSON.parse(readFileSync(state.controlPath, "utf8")) as { action?: string };
      } catch {
        control = null;
      }
      if (control?.action === "abort") {
        stopReason = "abort";
        break;
      }
      if (control?.action === "stop") {
        stopReason = "stop";
        break;
      }
      if (Date.now() - recordStart >= state.maxSec * 1000) {
        stopReason = "max";
        break;
      }
    }

    if (stopReason === "abort") {
      log("abort requested — discarding capture");
      save({ state: "aborted" });
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      try {
        rmSync(state.tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      return;
    }

    if (stopReason === "max") {
      autoMark(`[auto] session auto-stopped at the ${state.maxSec}s max duration`);
      log(`max duration ${state.maxSec}s reached — auto-stopping and uploading`);
    }
    save({ state: "stopping" });
    const video = page.video();
    await page.close();
    await context.close();
    if (!video) throw new Error("browser did not produce a video (recordVideo unavailable)");
    const videoPath = await video.path();
    await browser.close().catch(() => {});
    browser = null;

    // Merge the agent's marks (written live by `clipy mark` with its own
    // clock) with the [auto] instrumentation marks.
    const agentMarks: NarrationNote[] = [];
    try {
      for (const line of readFileSync(state.marksPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const m = JSON.parse(line) as { tMs?: number; text?: string };
        if (typeof m.tMs === "number" && typeof m.text === "string" && m.text.trim()) {
          agentMarks.push({ startMs: Math.max(0, Math.round(m.tMs)), text: m.text.trim() });
        }
      }
    } catch {
      // no marks file — fine
    }
    const notes = [...agentMarks, ...autoMarks].sort((a, b) => a.startMs - b.startMs);

    save({ state: "uploading" });
    const uploaded = await uploadWebmToClipy(ctx, {
      videoPath,
      name: state.name,
      description: state.description,
      recordingKind: state.recordingKind,
      narration: notes.length ? { notes } : undefined,
      log: (m) => log(m.replace(/\x1b\[[0-9;]*m/g, "")),
    }).catch((e: Error) => {
      // Keep the capture — losing the bytes is worse than leaving a file.
      const kept = join(sessionDir(), `kept-${randomUUID()}.webm`);
      try {
        renameSync(videoPath, kept);
        save({ keptVideoPath: kept });
      } catch {
        // original path stays in tmpDir (cleanup below is skipped on throw)
      }
      throw e;
    });
    save({ state: "done", result: uploaded });
    log(`done — ${uploaded.shareUrl}`);
    try {
      rmSync(state.tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  } catch (e) {
    save({ state: "failed", error: (e as Error).message });
    log(`failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// agents — install the bundled Clipy skill for a coding agent, so one command
// teaches Claude Code / Codex / Cursor how to read AND make recordings.
// ---------------------------------------------------------------------------

const AGENT_TARGETS = ["claude", "codex", "cursor"] as const;
type AgentTarget = (typeof AGENT_TARGETS)[number];

function skillPathFor(target: AgentTarget): string {
  const home = homedir();
  switch (target) {
    case "claude":
      return join(home, ".claude", "skills", "clipy", "SKILL.md");
    case "codex": {
      const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
      return join(codexHome, "skills", "clipy", "SKILL.md");
    }
    case "cursor":
      return join(home, ".cursor", "skills", "clipy", "SKILL.md");
  }
}

async function cmdAgents(
  ctx: Ctx,
  sub: string | undefined,
  targetRaw: string | undefined,
  json: boolean,
): Promise<void> {
  if (sub === "status" || sub === undefined) {
    const status = AGENT_TARGETS.map((t) => {
      const p = skillPathFor(t);
      let installed = false;
      try {
        installed = statSync(p).isFile();
      } catch {
        installed = false;
      }
      return { target: t, installed, path: p };
    });
    if (json) {
      printJson({ agents: status });
      return;
    }
    for (const s of status) {
      process.stdout.write(
        `${s.installed ? c.green("✓ installed") : c.dim("— not installed")}  ${s.target.padEnd(7)} ${c.dim(s.path)}\n`,
      );
    }
    process.stdout.write(`${c.dim("install with:")} clipy agents install <claude|codex|cursor>\n`);
    return;
  }

  const target = targetRaw as AgentTarget | undefined;
  if (!target || !AGENT_TARGETS.includes(target)) {
    die(`usage: clipy agents <status|install|uninstall> <${AGENT_TARGETS.join("|")}>`, 2);
  }
  const path = skillPathFor(target);
  if (sub === "install") {
    // First-run onboarding: with no API key configured, sign in first so the
    // installed skill can actually read + make recordings. Interactive
    // terminals only — without a TTY (CI) set CLIPY_API_KEY instead. SSH and
    // display-less Linux auto-route to the copy-code flow. An already-
    // configured key is left untouched. loginWithBrowser die()s (with the
    // paste fallback) if it fails.
    if (!ctx.apiKey && process.stdout.isTTY && !json) {
      process.stdout.write(`${c.dim("No Clipy API key found — signing you in first…")}\n`);
      await loginWithBrowser(ctx, shouldUseManualLogin());
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, CLIPY_SKILL_MD);
    if (json) {
      printJson({ installed: true, target, path });
      return;
    }
    process.stdout.write(`${c.green("✓")} Clipy skill installed for ${c.bold(target)} at ${c.dim(path)}\n`);
    process.stdout.write(
      `${c.dim("It teaches the agent to read clipy.online links and to record with clipy record / session.")}\n`,
    );
    return;
  }
  if (sub === "uninstall") {
    try {
      rmSync(dirname(path), { recursive: true, force: true });
    } catch {
      // best-effort
    }
    if (json) {
      printJson({ uninstalled: true, target, path });
      return;
    }
    process.stdout.write(`${c.green("✓")} Clipy skill removed for ${target}\n`);
    return;
  }
  die(`usage: clipy agents <status|install|uninstall> <${AGENT_TARGETS.join("|")}>`, 2);
}

// ---------------------------------------------------------------------------
// guide — machine-readable capability manifest. `clipy guide --json` is the
// single document an agent can fetch to learn env vars, exit codes, and every
// command's shape without trial-and-error. Bump GUIDE_SCHEMA_VERSION when the
// contract changes.
// ---------------------------------------------------------------------------

const GUIDE_SCHEMA_VERSION = 3;

function cmdGuide(json: boolean): void {
  if (!json) {
    process.stdout.write(HELP);
    process.stdout.write(`\n${c.dim("machine-readable form:")} clipy guide --json\n`);
    return;
  }
  const cmdDoc = (name: string, usage: string, description: string, flags: string[] = []) => ({
    name,
    usage,
    description,
    flags,
  });
  printJson({
    schemaVersion: GUIDE_SCHEMA_VERSION,
    binary: "clipy",
    version: VERSION,
    description:
      "Clipy (clipy.online) command line: read your screen recordings' transcripts/summaries/key moments, and record web apps headlessly (one-shot or live session with timestamped marks).",
    outputConvention: {
      jsonFlag: "--json",
      stdout: "primary results (JSON when --json is set)",
      stderr: "progress + human hints; never JSON",
      errors: "exit non-zero with a message on stderr prefixed 'error:'",
    },
    env: [
      { name: "CLIPY_API_KEY", description: "API key (clipy_sk_live_…) from clipy.online/settings/api-keys; write commands need the 'ingest' scope" },
      { name: "CLIPY_API_URL", description: "API base URL override (default https://clipy.online)" },
      { name: "CLIPY_DISABLE_CDP", description: "set to 1 to force session --expose-cdp off (a hard kill switch that wins over the flag)" },
      { name: "NO_COLOR", description: "disable ANSI color" },
    ],
    exitCodes: [
      { code: 0, meaning: "success" },
      { code: 1, meaning: "error" },
      { code: 2, meaning: "usage error" },
      { code: 3, meaning: "artifact not ready yet (transcript/summary/wait)" },
    ],
    commands: [
      cmdDoc("login", "clipy login [--no-browser] [--key <key>] [--paste]", "Approve this device in the browser (default). --no-browser (auto-detected on SSH and display-less Linux) prints the approval URL to open on any device and prompts for the code it shows. --key/--paste store a pasted key (also the automatic path when stdout is not a TTY)", ["--no-browser", "--key <key>", "--paste"]),
      cmdDoc("logout", "clipy logout", "Delete the stored key"),
      cmdDoc("whoami", "clipy whoami", "Check the active key"),
      cmdDoc("list", "clipy list [-n N] [--page P] [--status s,…] [--json]", "List recordings, newest first"),
      cmdDoc("search", "clipy search <query> [--json]", "Full-text search titles + descriptions"),
      cmdDoc("show", "clipy show <id|url> [--json]", "One recording's metadata + share link"),
      cmdDoc("transcript", "clipy transcript <id> [--srt|--vtt|--json] | clipy transcript <id> --replace <file.json|-> ", "Print the transcript, or REPLACE it (ingest scope; file holds {segments:[{start,end,text}]} or {plaintext}; regenerates the summary)", ["--srt", "--vtt", "--json", "--replace <file>"]),
      cmdDoc("summary", "clipy summary <id> [--json]", "AI summary: TL;DR, key points, action items"),
      cmdDoc("moments", "clipy moments <id> [--json]", "Key moments: timestamps, captions, click coords"),
      cmdDoc("context", "clipy context <id>", "Full agent-context bundle as markdown"),
      cmdDoc("download", "clipy download <id> [-o path]", "Download the MP4"),
      cmdDoc("open", "clipy open <id>", "Open the share page in a browser"),
      cmdDoc("wait", "clipy wait <id> [--for transcript|summary|both] [--timeout sec]", "Block until artifacts are ready"),
      cmdDoc("record", "clipy record --url <url> [--for sec] [--viewports list] [--title t] [--type kind] [--note '12: text']… [--wait] [--json]", "Headless one-shot capture of a web app; notes become the transcript. Notes are absolute ('12: text') or pass-scoped ('pass2: text' / 'pass2@5: text', anchored to a --viewports pass's real start; a malformed pass note is rejected). --type declares the recording kind (bug_report|feature_request|product_demo|walkthrough_tutorial|feedback_review|discussion_talk|other, plus aliases bug/feature/demo/walkthrough/feedback/discussion) so the AI summary reads it correctly. With --source mac-screen: records the real screen via the Clipy Mac app (--type not yet applied on mac); --window '<title|app|id>' or --display <id> target one window/display (ids from clipy sources)", ["--for", "--viewports", "--title", "--description", "--type", "--note", "--width", "--height", "--wait", "--source", "--window", "--display"]),
      cmdDoc("session", "clipy session <start|stop|abort|status> [--url <url>] [--max sec] [--type kind] [--source web|mac-screen] [--window w] [--display d] [--expose-cdp]", "Background recording session; auto-stops + uploads at --max (default 600s, cap 1800s). --type sets the recording kind (see record). --window/--display (with --source mac-screen) record one window/display. --expose-cdp (web sessions) opens a CDP endpoint (cdpUrl/cdpHttpUrl in the state file + session start/status output) so your own tools can drive the page while it records; OFF by default (any local process could attach), and CLIPY_DISABLE_CDP=1 forces it off", ["--url", "--max", "--type", "--source", "--window", "--display", "--expose-cdp"]),
      cmdDoc("mark", "clipy mark \"<text>\"", "Drop a live-timestamped note into the active session"),
      cmdDoc("doctor", "clipy doctor [--json]", "One-shot health check: API key + whoami round-trip, Mac agent bridge (exists/parses/pid/appVersion>=" + MIN_BRIDGE_APP_VERSION + "), Playwright resolvability (and where it resolved from), and install mode (npx/global/local) — each a pass/warn/fail with a fix hint; exits non-zero if any check fails"),
      cmdDoc("sources", "clipy sources [--json]", "List displays + windows the Clipy Mac app can capture — ids feed --window/--display"),
      cmdDoc("agents", "clipy agents <status|install|uninstall> <claude|codex|cursor>", "Install the bundled Clipy skill for a coding agent; install triggers a browser login first when no key is configured (interactive terminals only)"),
      cmdDoc("guide", "clipy guide --json", "This manifest"),
      cmdDoc("mcp", "clipy mcp", "Run the Clipy MCP server (wraps npx -y @clipy/mcp)"),
    ],
    notes: [
      "Read commands accept a bare public id or the full https://clipy.online/video/<id> URL.",
      "login opens a browser to approve this device (loopback redirect to 127.0.0.1); use --key/--paste or a piped key on headless boxes.",
      "record/session/mark/transcript --replace are the only write commands; they need a key with the 'ingest' permission.",
      "Headless captures have no audio: --note flags and session marks become the transcript, labeled agent-narration.",
      "--note is absolute ('12: text') or pass-scoped ('pass2: text' / 'pass2@5: text'); pass-scoped notes anchor to the real start of a --viewports pass, so they don't drift when load time shifts the pass boundaries. A malformed pass note (e.g. 'pass2 text' with no colon) is a usage error, not silently demoted.",
      "--type declares what a recording IS (bug_report/feature_request/product_demo/walkthrough_tutorial/feedback_review/discussion_talk/other, plus short aliases) so the AI summary doesn't misread a demo as a bug report. Applied on web today; --source mac-screen support is pending a Clipy app update.",
      "session --expose-cdp (web, opt-in) publishes a CDP endpoint (cdpHttpUrl) in `session start`/`session status` output and the 0600 session state file; connect with playwright.connectOverCDP() to drive the recorded page. Off by default (any local process could attach); CLIPY_DISABLE_CDP=1 forces it off.",
      "clipy record gates its capture clock on the first non-blank frame (up to a 10s cap, then starts anyway) so notes aren't anchored to a still-compiling t=0.",
      "Run `clipy doctor` first when record/session or --source mac-screen fails — it names the exact missing piece (key, bridge socket/handshake/version, Playwright, install mode).",
      "Public recordings have an unauthenticated context document at https://clipy.online/video/<id>.md.",
    ],
  });
}

/** transcript --replace: PUT agent-authored transcript content. */
async function cmdTranscriptReplace(ctx: Ctx, id: string, file: string): Promise<void> {
  const pid = encodeURIComponent(normalizeId(id, ctx));
  let raw: string;
  if (file === "-") {
    raw = readFileSync(0, "utf8");
  } else {
    raw = readFileSync(resolve(file), "utf8");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    die("replace file must be JSON: {segments:[{start,end,text}...]} or {plaintext:\"...\"}", 2);
  }
  const key = requireKey(ctx);
  const res = await fetch(`${ctx.apiUrl}/api/v1/recordings/${pid}/transcript`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": `clipy-cli/${VERSION}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = (typeof body.error === "string" && body.error) || `Clipy API error ${res.status}`;
    if (res.status === 403) {
      die(`${msg}\nYour API key needs the "ingest" permission (clipy.online/settings/api-keys).`);
    }
    die(msg);
  }
  printJson(body);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: "boolean", default: false },
      key: { type: "string" },
      paste: { type: "boolean", default: false },
      "no-browser": { type: "boolean", default: false },
      "api-url": { type: "string" },
      status: { type: "string" },
      page: { type: "string" },
      n: { type: "string", short: "n" },
      limit: { type: "string" },
      output: { type: "string", short: "o" },
      srt: { type: "boolean", default: false },
      vtt: { type: "boolean", default: false },
      for: { type: "string" },
      timeout: { type: "string" },
      url: { type: "string" },
      name: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      note: { type: "string", multiple: true },
      viewports: { type: "string" },
      max: { type: "string" },
      replace: { type: "string" },
      source: { type: "string" },
      window: { type: "string" },
      display: { type: "string" },
      type: { type: "string" },
      "expose-cdp": { type: "boolean", default: false },
      width: { type: "string" },
      height: { type: "string" },
      wait: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const cfg = readConfig();
  const ctx: Ctx = {
    apiUrl: (
      (values["api-url"] as string | undefined) ||
      process.env.CLIPY_API_URL ||
      cfg.apiUrl ||
      "https://clipy.online"
    ).replace(/\/+$/, ""),
    apiKey: (values.key as string | undefined) || process.env.CLIPY_API_KEY || cfg.apiKey || null,
  };

  const [command, ...rest] = positionals;

  if (!command || values.help || command === "help") {
    process.stdout.write(HELP);
    if (!command && !values.help) process.exitCode = 2;
    return;
  }

  const json = Boolean(values.json);
  const num = (v: unknown, dflt: number): number => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };

  switch (command) {
    case "login":
      await cmdLogin(ctx, {
        key: values.key as string | undefined,
        paste: Boolean(values.paste),
        noBrowser: Boolean(values["no-browser"]),
      });
      return;
    case "logout":
      cmdLogout();
      return;
    case "whoami":
      await cmdWhoami(ctx);
      return;
    case "list":
      await cmdList(ctx, {
        n: num(values.n ?? values.limit, 20),
        page: num(values.page, 1),
        status: values.status as string | undefined,
        json,
      });
      return;
    case "search": {
      const q = rest.join(" ").trim();
      if (!q) die("usage: clipy search <query>", 2);
      await cmdList(ctx, { q, n: num(values.n ?? values.limit, 20), page: num(values.page, 1), status: values.status as string | undefined, json });
      return;
    }
    case "show":
      if (!rest[0]) die("usage: clipy show <id|url>", 2);
      await cmdShow(ctx, rest[0], json);
      return;
    case "transcript": {
      if (!rest[0]) die("usage: clipy transcript <id|url> [--srt|--vtt|--json] [--replace <file.json|->]", 2);
      if (values.replace) {
        await cmdTranscriptReplace(ctx, rest[0], String(values.replace));
        return;
      }
      const fmt = json ? "json" : values.srt ? "srt" : values.vtt ? "vtt" : "text";
      await cmdTranscript(ctx, rest[0], fmt);
      return;
    }
    case "summary":
      if (!rest[0]) die("usage: clipy summary <id|url> [--json]", 2);
      await cmdSummary(ctx, rest[0], json);
      return;
    case "moments":
    case "key-moments":
      if (!rest[0]) die("usage: clipy moments <id|url> [--json]", 2);
      await cmdMoments(ctx, rest[0], json);
      return;
    case "context":
      if (!rest[0]) die("usage: clipy context <id|url>", 2);
      await cmdContext(ctx, rest[0]);
      return;
    case "download":
      if (!rest[0]) die("usage: clipy download <id|url> [-o <path>]", 2);
      await cmdDownload(ctx, rest[0], values.output as string | undefined);
      return;
    case "open":
      if (!rest[0]) die("usage: clipy open <id|url>", 2);
      await cmdOpen(ctx, rest[0]);
      return;
    case "wait": {
      if (!rest[0]) die("usage: clipy wait <id|url> [--for transcript|summary|both] [--timeout <sec>]", 2);
      const needRaw = String(values.for ?? "transcript");
      if (!["transcript", "summary", "both"].includes(needRaw)) {
        die("--for must be transcript, summary, or both", 2);
      }
      await cmdWait(ctx, rest[0], needRaw as "transcript" | "summary" | "both", num(values.timeout, 300), json);
      return;
    }
    case "mcp":
      cmdMcp();
      return;
    case "doctor":
      await cmdDoctor(ctx, json);
      return;
    case "agents":
      await cmdAgents(ctx, rest[0], rest[1], json);
      return;
    case "guide":
      cmdGuide(json);
      return;
    case "sources": {
      // Enumerate what the Mac app can capture, so --window/--display have ids.
      try {
        const sources = await listSources(readBridgeInfo());
        if (json) {
          printJson(sources);
          return;
        }
        process.stdout.write(`${c.bold("DISPLAYS")}\n`);
        for (const d of sources.displays) {
          process.stdout.write(`  ${d.id}\t${d.name || "display"}\t${c.dim(`${d.width}×${d.height}`)}\n`);
        }
        process.stdout.write(`${c.bold("WINDOWS")}\n`);
        for (const w of sources.windows) {
          process.stdout.write(`  ${w.id}\t${windowLabel(w)}\t${c.dim(`${w.width}×${w.height}`)}\n`);
        }
        process.stdout.write(
          `${c.dim('record one with: clipy record --source mac-screen --window "<title or id>"')}\n`,
        );
      } catch (e) {
        die((e as Error).message);
      }
      return;
    }
    case "record": {
      const source = String(values.source ?? "web");
      if (source !== "web" && source !== "mac-screen") {
        die("--source must be web (headless browser) or mac-screen (the Clipy Mac app)", 2);
      }
      if ((values.window || values.display) && source !== "mac-screen") {
        die("--window/--display record the real screen — add --source mac-screen", 2);
      }
      if (values.window && values.display) {
        die("--window and --display are mutually exclusive — pick one capture source", 2);
      }
      const recordingKind = values.type ? requireRecordingKind(String(values.type)) : undefined;
      if (source === "mac-screen") {
        const noteFlags = (values.note as string[] | undefined) ?? [];
        const forSec = num(values.for, 15);
        // The app-side safety watchdog caps a bridge recording at 1800s; a
        // longer --for would auto-stop at the cap while we kept waiting.
        if (forSec > 1740) {
          die("--for is capped at 1740s for --source mac-screen (the app auto-stops at 1800s)", 2);
        }
        try {
          const result = await cmdRecordMac({
            forSec,
            name:
              ((values.title as string | undefined) ?? (values.name as string | undefined))?.trim() ||
              undefined,
            description: (values.description as string | undefined)?.trim() || undefined,
            recordingKind,
            window: (values.window as string | undefined)?.trim() || undefined,
            display: (values.display as string | undefined)?.trim() || undefined,
            notes: noteFlags.map(parseNoteFlag),
            json,
          });
          if (values.wait && result.publicId) {
            await waitForArtifacts(ctx, result.publicId).catch(() => {});
          }
          if (json) {
            printJson({ id: result.publicId, shareUrl: result.shareUrl });
          } else {
            process.stdout.write(`${c.green("✓")} recorded — ${c.bold(result.shareUrl)}\n`);
            process.stdout.write(
              `${c.dim("next:")} clipy context ${result.publicId}  ·  clipy wait ${result.publicId}\n`,
            );
          }
        } catch (e) {
          die((e as Error).message);
        }
        return;
      }
      const url = (values.url as string | undefined)?.trim() || rest[0];
      if (!url) {
        die("usage: clipy record --url <http(s) url> [--for <sec>] [--name <title>] [--viewports <list>] [--source web|mac-screen] [--wait]", 2);
      }
      const noteFlags = (values.note as string[] | undefined) ?? [];
      await cmdRecord(ctx, {
        url,
        forSec: num(values.for, 15),
        name:
          ((values.title as string | undefined) ?? (values.name as string | undefined))?.trim() ||
          undefined,
        description: (values.description as string | undefined)?.trim() || undefined,
        recordingKind,
        notes: noteFlags.map(parseNoteFlag),
        viewports: values.viewports ? parseViewports(String(values.viewports)) : null,
        width: num(values.width, 1280),
        height: num(values.height, 720),
        wait: Boolean(values.wait),
        json,
      });
      return;
    }
    case "session": {
      const sub = rest[0];
      if (sub === "start") {
        const source = String(values.source ?? "web");
        if (source !== "web" && source !== "mac-screen") {
          die("--source must be web (headless browser) or mac-screen (the Clipy Mac app)", 2);
        }
        if ((values.window || values.display) && source !== "mac-screen") {
          die("--window/--display record the real screen — add --source mac-screen", 2);
        }
        if (values.window && values.display) {
          die("--window and --display are mutually exclusive — pick one capture source", 2);
        }
        const url = (values.url as string | undefined)?.trim() || rest[1];
        if (!url && source === "web") {
          die("usage: clipy session start --url <http(s) url> [--max <sec>] [--source web|mac-screen]", 2);
        }
        await cmdSessionStart(ctx, {
          url: url || "mac-screen",
          window: (values.window as string | undefined)?.trim() || undefined,
          display: (values.display as string | undefined)?.trim() || undefined,
          name:
            ((values.title as string | undefined) ?? (values.name as string | undefined))?.trim() ||
            undefined,
          description: (values.description as string | undefined)?.trim() || undefined,
          recordingKind: values.type ? requireRecordingKind(String(values.type)) : undefined,
          maxSec: num(values.max, SESSION_DEFAULT_MAX_SEC),
          width: num(values.width, 1280),
          height: num(values.height, 720),
          json,
          source,
          exposeCdp: Boolean(values["expose-cdp"]),
        });
        return;
      }
      if (sub === "stop") {
        await cmdSessionStop(json);
        return;
      }
      if (sub === "abort") {
        await cmdSessionAbort(json);
        return;
      }
      if (sub === "status" || sub === undefined) {
        await cmdSessionStatus(json);
        return;
      }
      die("usage: clipy session <start|stop|abort|status>", 2);
      return;
    }
    case "mark": {
      const text = rest.join(" ").trim();
      if (!text) die('usage: clipy mark "<what just happened>"', 2);
      await cmdMark(text, json);
      return;
    }
    case "__session-daemon": {
      if (!rest[0]) die("internal: __session-daemon needs a session file", 2);
      await runSessionDaemon(rest[0]);
      return;
    }
    default:
      die(`unknown command: ${command}\n\n${HELP}`, 2);
  }
}

main().catch((e: Error) => die(e.message));
