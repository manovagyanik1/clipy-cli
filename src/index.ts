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
import { CLIPY_SKILL_MD } from "./skill.js";
import { browserLogin, shouldUseManualLogin, type BrowserLoginResult } from "./browserLogin.js";
import {
  BridgeUnavailableError,
  bridgeRequest,
  listSources,
  readBridgeInfo,
  resolveCaptureSource,
  windowLabel,
  type CaptureSource,
  type BridgeInfo,
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
    --note "12: text" Timestamped narration note (repeatable) — for silent
                      captures the notes become the transcript
    --width/--height  Viewport + video size (default 1280×720)
    --wait            Block until the transcript is ready before printing

${c.bold("SESSION")} ${c.dim("(agent works, Clipy records — one active session per directory)")}
  ${c.dim("--source mac-screen on record/session records the REAL screen via the")}
  ${c.dim("running Clipy Mac app (consent-gated, indicator always visible).")}
  ${c.dim("Target one window or display instead of the whole screen:")}
  sources                           List capturable displays + windows (ids for --window/--display)
    --window "<title|app|id>"       Record just that window (e.g. --window Chrome)
    --display <id>                  Record a specific display
  session start --url <app> [--max <sec>] [--title <t>]
                                    Start recording in a background daemon and
                                    return immediately (auto-stops + uploads at
                                    --max, default ${SESSION_DEFAULT_MAX_SEC}s, cap ${SESSION_HARD_CAP_SEC}s)
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

async function loadChromium(): Promise<PwChromium> {
  for (const mod of ["playwright", "playwright-core"]) {
    try {
      const pw = (await import(mod)) as { chromium?: PwChromium };
      if (pw.chromium) return pw.chromium;
    } catch {
      // try the next module
    }
  }
  die(
    `clipy record needs Playwright (a headless browser). Install it once:\n` +
      `  ${c.bold("npm install -g playwright")}\n` +
      `  ${c.bold("npx playwright install chromium")}\n` +
      `Then re-run your command. (Playwright is kept out of the base CLI so the ` +
      `read-only commands stay a small, dependency-free install.)`,
  );
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

/** Parses a `--note` flag value: "12: opened settings" or "12.5s: text" → note
 *  at 12s. A value with no timestamp prefix becomes a note at 0s. */
function parseNoteFlag(value: string): NarrationNote {
  const m = value.match(/^\s*(\d+(?:\.\d+)?)s?\s*:\s*(.+)$/);
  if (m) return { startMs: Math.round(parseFloat(m[1]) * 1000), text: m[2].trim() };
  return { startMs: 0, text: value.trim() };
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

interface RecordOpts {
  url: string;
  forSec: number;
  name?: string;
  description?: string;
  notes: NarrationNote[];
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

  let uploaded: UploadedRecording;
  const autoNotes: NarrationNote[] = [];
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
      const captureStart = Date.now();
      for (const [i, vp] of passes.entries()) {
        if (opts.viewports) {
          await page.setViewportSize({ width: vp.width, height: vp.height }).catch(() => {});
          autoNotes.push({
            startMs: Date.now() - captureStart,
            text: `[auto] Viewport pass ${i + 1}/${passes.length}: ${vp.label}`,
          });
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
    const notes = [...autoNotes, ...opts.notes].sort((a, b) => a.startMs - b.startMs);
    uploaded = await uploadWebmToClipy(ctx, {
      videoPath,
      name: opts.name,
      description: opts.description,
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
  maxSec: number;
  width: number;
  height: number;
  state:
    | "starting"
    | "recording"
    | "stopping"
    | "uploading"
    | "done"
    | "failed"
    | "aborted";
  recordStartEpochMs?: number;
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
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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
  notes: NarrationNote[];
  window?: string;
  display?: string;
  json: boolean;
}): Promise<{ publicId: string; shareUrl: string }> {
  const info = readBridgeInfo();
  const log = (m: string) => {
    if (!opts.json) process.stderr.write(`${m}\n`);
  };
  const target = await resolveBridgeTarget(info, opts);
  log(
    `${c.dim(`asking the Clipy app (v${info.appVersion}) to record ${target?.label ?? "the screen"}…`)}`,
  );
  await bridgeRequest(info, "start", {
    // The recording is stopped by us after forSec; maxSec is the safety net
    // in case this CLI process dies mid-wait.
    maxSec: Math.min(opts.forSec + 60, 1800),
    title: opts.name,
    description: opts.description,
    notes: opts.notes.map((n) => ({ startMs: n.startMs, text: n.text })),
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
    maxSec: number;
    width: number;
    height: number;
    json: boolean;
    source: "web" | "mac-screen";
    window?: string;
    display?: string;
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
    await bridgeRequest(info, "start", {
      maxSec,
      title: opts.name,
      description: opts.description,
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
    maxSec,
    width: opts.width,
    height: opts.height,
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

  if (opts.json) {
    printJson({ state: "recording", url: target.href, maxSec, sessionFile: file });
    return;
  }
  process.stdout.write(`${c.green("✓")} recording ${c.bold(target.href)} (max ${maxSec}s)\n`);
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
    });
    return;
  }
  process.stdout.write(
    `${c.bold(state.state)}${alive ? "" : c.red(" (daemon dead)")} — ${state.url}` +
      `${elapsed != null ? ` — ${elapsed}s elapsed (max ${state.maxSec}s)` : ""}\n`,
  );
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
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      viewport: { width: state.width, height: state.height },
      recordVideo: { dir: state.tmpDir, size: { width: state.width, height: state.height } },
    });
    const page = await context.newPage();

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
    save({ state: "recording", recordStartEpochMs: recordStart });
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

const GUIDE_SCHEMA_VERSION = 1;

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
      cmdDoc("record", "clipy record --url <url> [--for sec] [--viewports list] [--title t] [--note '12: text']… [--wait] [--json]", "Headless one-shot capture of a web app; notes become the transcript. With --source mac-screen: records the real screen via the Clipy Mac app; --window '<title|app|id>' or --display <id> target one window/display (ids from clipy sources)", ["--for", "--viewports", "--title", "--description", "--note", "--width", "--height", "--wait", "--source", "--window", "--display"]),
      cmdDoc("session", "clipy session <start|stop|abort|status> [--url <url>] [--max sec] [--source web|mac-screen] [--window w] [--display d]", "Background recording session; auto-stops + uploads at --max (default 600s, cap 1800s). --window/--display (with --source mac-screen) record one window/display"),
      cmdDoc("mark", "clipy mark \"<text>\"", "Drop a live-timestamped note into the active session"),
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
          maxSec: num(values.max, SESSION_DEFAULT_MAX_SEC),
          width: num(values.width, 1280),
          height: num(values.height, 720),
          json,
          source,
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
