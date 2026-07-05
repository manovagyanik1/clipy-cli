#!/usr/bin/env node
/**
 * @clipy/cli — the Clipy command line.
 *
 * List, search, and read your Clipy screen recordings (transcripts, AI
 * summaries, key moments) from the terminal, download the MP4s, or export
 * subtitles — without opening a browser.
 *
 * Auth: a personal API key (`clipy_sk_live_…`), minted at
 * https://clipy.online/settings/api-keys. `clipy login` stores it in
 * ~/.config/clipy/config.json (0600); CLIPY_API_KEY / --key override it.
 * Read-only: the CLI can never create, modify, or delete recordings.
 */

import { parseArgs } from "node:util";
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";

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
    `no API key. Run ${c.bold("clipy login")} (create a key at ${ctx.apiUrl}/settings/api-keys), or set CLIPY_API_KEY.`,
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

const HELP = `${c.bold("clipy")} — the Clipy (https://clipy.online) command line, v${VERSION}

${c.bold("USAGE")}
  clipy <command> [arguments] [flags]

${c.bold("AUTH")}
  login [--key <clipy_sk_live_…>]   Verify + store your API key (${c.dim("~/.config/clipy/config.json")})
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

${c.bold("AGENTS")}
  mcp                               Run the Clipy MCP server (wraps: npx -y @clipy/mcp)

${c.bold("GLOBAL FLAGS")}
  --key <key>       API key for this invocation (else CLIPY_API_KEY, else stored login)
  --api-url <url>   API base (else CLIPY_API_URL, default https://clipy.online)
  --json            Machine-readable output (list/search/show/transcript/summary/moments/wait)
  -v, --version     Print version

${c.bold("EXIT CODES")}
  0 ok · 1 error · 2 usage · 3 artifact not ready (transcript/summary/wait)

${c.bold("SETUP")}
  1. Create a key at ${c.cyan("https://clipy.online/settings/api-keys")}
  2. ${c.bold("clipy login")}
  3. ${c.bold("clipy list")}

The CLI is read-only: it can never create, modify, or delete recordings.
`;

async function cmdLogin(ctx: Ctx, keyFlag: string | undefined): Promise<void> {
  let key = keyFlag?.trim() || "";
  if (!key) {
    key = await promptHidden(
      `Paste your Clipy API key (from ${ctx.apiUrl}/settings/api-keys): `,
    );
  }
  if (!key.startsWith("clipy_sk_live_")) {
    die("that doesn't look like a Clipy API key (expected it to start with clipy_sk_live_)");
  }
  // Verify before storing.
  const probe = { ...ctx, apiKey: key };
  await apiJson(probe, "/api/v1/recordings?limit=1");
  const cfg = readConfig();
  cfg.apiKey = key;
  if (ctx.apiUrl !== "https://clipy.online") cfg.apiUrl = ctx.apiUrl;
  writeConfig(cfg);
  process.stdout.write(`${c.green("✓")} key verified and saved to ${c.dim(configPath())}\n`);
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
      await cmdLogin(ctx, values.key as string | undefined);
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
      if (!rest[0]) die("usage: clipy transcript <id|url> [--srt|--vtt|--json]", 2);
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
    default:
      die(`unknown command: ${command}\n\n${HELP}`, 2);
  }
}

main().catch((e: Error) => die(e.message));
