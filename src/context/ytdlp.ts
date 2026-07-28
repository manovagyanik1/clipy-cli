/**
 * yt-dlp management + the two provider calls the transcript profile needs.
 *
 * The binary is Clipy's own (~/.clipy/bin), never a system install. Every
 * invocation is a spawn with an argument array — no shell — and always carries
 * --ignore-config --no-playlist so a user's yt-dlp config can't redirect what
 * we run or fan a single URL out into a channel.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

const RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const STDERR_CAP = 16_384;

export function clipyBinDir(): string {
  return join(homedir(), ".clipy", "bin");
}

function assetName(): string {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  return "yt-dlp";
}

function managedPath(): string {
  return join(clipyBinDir(), process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

function onPath(): string | null {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? ["yt-dlp.exe"] : ["yt-dlp"];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += d.toString("utf8").slice(0, STDERR_CAP - stderr.length);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s`));
        return;
      }
      resolveRun({ code, stdout, stderr });
    });
  });
}

/** Both halves of a failed auto-install: what we were doing, and how to do it
 *  by hand. A user staring at "HTTP 403" cannot act; a user told the URL and
 *  the destination can. */
function installFailure(url: string, reason: string): Error {
  return new Error(
    `could not install yt-dlp: ${reason}\n` +
      `  Clipy was downloading ${url}\n` +
      `  into ${clipyBinDir()} (its own copy — it never installs system-wide).\n` +
      `  To do it by hand: download that file, save it as ${managedPath()}, and \`chmod +x\` it.\n` +
      `  Or install yt-dlp any way you like (\`brew install yt-dlp\`, \`pipx install yt-dlp\`) — Clipy uses a copy on your PATH if it finds one.`,
  );
}

async function install(notify: (msg: string) => void): Promise<string> {
  const url = `${RELEASE_BASE}/${assetName()}`;
  notify(`yt-dlp is not installed. Downloading it into ${clipyBinDir()} (from ${url}) — Clipy keeps its own copy and never installs system-wide.`);

  mkdirSync(clipyBinDir(), { recursive: true });
  const target = managedPath();
  const tmp = `${target}.download`;

  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    throw installFailure(url, `the download could not start (${(e as Error).message}). Check your network or proxy.`);
  }
  if (!res.ok || !res.body) throw installFailure(url, `the download returned HTTP ${res.status}`);
  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw installFailure(url, `writing the binary failed (${(e as Error).message})`);
  }
  try {
    chmodSync(target, 0o755);
  } catch {
    // Windows has no POSIX modes.
  }
  notify(`Installed yt-dlp to ${clipyBinDir()} (one-time setup).`);
  return target;
}

let cached: string | null = null;

export async function resolveYtDlp(notify: (msg: string) => void): Promise<string> {
  if (cached) return cached;
  const managed = managedPath();
  if (existsSync(managed)) return (cached = managed);
  const found = onPath();
  if (found) return (cached = found);
  return (cached = await install(notify));
}

export interface YoutubeMeta {
  id: string;
  title: string;
  durationMs: number;
  language?: string;
  /** Track names only — nothing here is trusted as a path or command. */
  subtitleLangs: string[];
  autoCaptionLangs: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function langKeys(v: unknown): string[] {
  if (!v || typeof v !== "object") return [];
  return Object.keys(v as Record<string, unknown>).filter((k) => /^[A-Za-z0-9_.-]+$/.test(k));
}

/** yt-dlp -J on a single video. Only whitelisted fields survive. */
export async function fetchVideoMeta(bin: string, url: string): Promise<YoutubeMeta> {
  const res = await run(bin, ["--ignore-config", "--no-playlist", "-J", "--skip-download", url], 90_000);
  if (res.code !== 0) {
    throw new Error(`yt-dlp could not read that video: ${res.stderr.trim().split("\n").pop() ?? `exit ${res.code}`}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error("yt-dlp returned output this version of Clipy could not parse");
  }
  const info = (parsed ?? {}) as Record<string, unknown>;
  const duration = Number(info.duration);
  return {
    id: str(info.id) ?? "",
    title: str(info.title) ?? "Untitled video",
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0,
    language: str(info.language),
    subtitleLangs: langKeys(info.subtitles),
    autoCaptionLangs: langKeys(info.automatic_captions),
  };
}

export interface FetchedCaptions {
  format: "json3" | "vtt";
  text: string;
  source: "creator_captions" | "auto_captions";
  language: string;
}

/**
 * Picks one caption track and downloads only that track. Creator captions beat
 * auto-captions; an exact language match beats a regional variant (en-US for
 * a request of `en`).
 */
function pickLang(available: string[], want: string): string | null {
  const lower = want.toLowerCase();
  const base = lower.split("-")[0];
  // YouTube advertises auto-TRANSLATED tracks for ~200 languages, so falling
  // back to "whatever is first" would silently hand back a machine translation
  // of the video into Abkhazian. Only the requested language counts.
  return (
    available.find((l) => l.toLowerCase() === lower) ??
    available.find((l) => l.toLowerCase() === base) ??
    available.find((l) => l.toLowerCase().startsWith(`${base}-`)) ??
    null
  );
}

export async function fetchCaptions(
  bin: string,
  url: string,
  meta: YoutubeMeta,
  langPref: string,
): Promise<FetchedCaptions | null> {
  const attempts: { source: "creator_captions" | "auto_captions"; lang: string; flag: string }[] = [];
  const creator = pickLang(meta.subtitleLangs, langPref);
  if (creator) attempts.push({ source: "creator_captions", lang: creator, flag: "--write-subs" });
  const auto = pickLang(meta.autoCaptionLangs, langPref);
  if (auto) attempts.push({ source: "auto_captions", lang: auto, flag: "--write-auto-subs" });

  for (const attempt of attempts) {
    for (const format of ["json3", "vtt"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "clipy-subs-"));
      try {
        const res = await run(
          bin,
          [
            "--ignore-config",
            "--no-playlist",
            "--skip-download",
            attempt.flag,
            "--sub-langs",
            attempt.lang,
            "--sub-format",
            format,
            "-o",
            join(dir, "track.%(ext)s"),
            url,
          ],
          180_000,
        );
        if (res.code !== 0) continue;
        const file = readdirSync(dir).find((f) => f.endsWith(`.${format}`));
        if (!file) continue;
        const text = readFileSync(join(dir, file), "utf8");
        if (!text.trim()) continue;
        return { format, text, source: attempt.source, language: attempt.lang };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return null;
}
