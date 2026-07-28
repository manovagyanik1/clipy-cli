/**
 * yt-dlp management + the two provider calls the transcript profile needs.
 *
 * The binary is Clipy's own (~/.clipy/bin), never a system install. Every
 * invocation is a spawn with an argument array — no shell — and always carries
 * --ignore-config --no-playlist so a user's yt-dlp config can't redirect what
 * we run or fan a single URL out into a channel.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MAX_ATTEMPTS, RETRY_BACKOFF_MS, classifyFailure, isRetriable, retryNotice, sleep } from "./retry.js";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

/**
 * NIGHTLY, not stable. yt-dlp's own README calls stable "often stale and prone
 * to external breakage" and names nightly "the recommended channel for regular
 * users" — and YouTube-side breakage in 2026 has repeatedly been fixed the same
 * week it appeared. A stable pin means shipping known-broken extraction for
 * weeks. See docs/research/2026-07-29-ytdlp-403-fallbacks.md §4.
 */
const RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download";
/** Past this, our managed copy is refreshed before it is used. */
const MAX_BINARY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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

/**
 * Refreshes OUR copy if it has gone stale.
 *
 * Deliberately never touches a yt-dlp the user installed themselves: `-U` on a
 * Homebrew or pipx binary either fails or fights the package manager, and
 * either way it is not ours to modify. Failure here is always swallowed — a
 * stale binary might still work, and an unreachable GitHub must not block an
 * import that would otherwise succeed.
 */
async function refreshManagedBinary(bin: string, notify: (msg: string) => void): Promise<void> {
  if (bin !== managedPath()) return;
  let age: number;
  try {
    age = Date.now() - statSync(bin).mtimeMs;
  } catch {
    return;
  }
  if (age < MAX_BINARY_AGE_MS) return;

  notify(
    `Your yt-dlp copy is ${Math.floor(age / (24 * 60 * 60 * 1000))} days old — updating it (YouTube breaks extraction often; this is Clipy's own copy, not a system install)…`,
  );
  try {
    const res = await run(bin, ["-U"], 120_000);
    notify(
      res.code === 0
        ? "yt-dlp is up to date."
        : "yt-dlp could not update itself — continuing with the copy you have.",
    );
  } catch {
    notify("yt-dlp could not update itself — continuing with the copy you have.");
  }
  // Stamp it either way: a failed check should not be retried on every import.
  try {
    const now = new Date();
    utimesSync(bin, now, now);
  } catch {
    // Best effort.
  }
}

export async function resolveYtDlp(notify: (msg: string) => void): Promise<string> {
  if (cached) return cached;
  const managed = managedPath();
  if (existsSync(managed)) {
    await refreshManagedBinary(managed, notify);
    return (cached = managed);
  }
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
  source: "creator_captions" | "auto_captions" | "auto_captions_translated";
  /** The real language of the text, e.g. "hi" — never a track name like "hi-orig". */
  language: string;
  /** Set only when the text is a machine translation. */
  translatedFrom?: string;
}

/** yt-dlp marks a video's own caption track with an -orig suffix. */
function baseLang(track: string): string {
  return track.replace(/-orig$/i, "");
}

/**
 * The language the video was actually spoken in, if we can tell. The -orig
 * track name is the strongest signal (YouTube adds it precisely to distinguish
 * the source track from its ~200 auto-translations); the metadata `language`
 * field is the fallback.
 */
function originalLanguage(meta: YoutubeMeta): string | undefined {
  const tagged = [...meta.subtitleLangs, ...meta.autoCaptionLangs].find((l) =>
    /-orig$/i.test(l),
  );
  return tagged ?? meta.language;
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

export interface CaptionAttempt {
  /** The track name to ask yt-dlp for — may carry the -orig suffix. */
  track: string;
  source: "creator_captions" | "auto_captions" | "auto_captions_translated";
  language: string;
  translatedFrom?: string;
  flag: "--write-subs" | "--write-auto-subs";
}

/**
 * Which caption track to try, in order. Exported for tests: the ranking is the
 * whole feature, and it is worth asserting without a network round trip.
 *
 * An explicit --language is obeyed and nothing else is attempted — silently
 * importing a different language than the one asked for would be worse than
 * failing. Otherwise: creator captions beat machine ones, and within the
 * machine ones the video's ORIGINAL language beats a translation of it,
 * because YouTube's auto-translations are a translation OF a transcription and
 * degrade twice over.
 */
export function planCaptionAttempts(meta: YoutubeMeta, explicitLanguage?: string): CaptionAttempt[] {
  const attempts: CaptionAttempt[] = [];
  const seen = new Set<string>();
  const orig = originalLanguage(meta);

  const add = (
    track: string | null | undefined,
    kind: "creator" | "auto",
  ): void => {
    if (!track || seen.has(`${kind}:${track}`)) return;
    seen.add(`${kind}:${track}`);
    const language = baseLang(track);
    const translated =
      kind === "auto" && !!orig && baseLang(orig).toLowerCase() !== language.toLowerCase();
    attempts.push({
      track,
      language,
      source:
        kind === "creator"
          ? "creator_captions"
          : translated
            ? "auto_captions_translated"
            : "auto_captions",
      ...(translated ? { translatedFrom: baseLang(orig!) } : {}),
      flag: kind === "creator" ? "--write-subs" : "--write-auto-subs",
    });
  };

  if (explicitLanguage) {
    add(pickLang(meta.subtitleLangs, explicitLanguage), "creator");
    add(pickLang(meta.autoCaptionLangs, explicitLanguage), "auto");
    return attempts;
  }

  // 2. Any creator track, the original language for preference.
  add(orig ? pickLang(meta.subtitleLangs, orig) : null, "creator");
  add(meta.subtitleLangs[0], "creator");

  // 3-5. Auto: original language, then English, then whatever exists.
  add(orig ? pickLang(meta.autoCaptionLangs, orig) : null, "auto");
  add(pickLang(meta.autoCaptionLangs, "en"), "auto");
  add(meta.autoCaptionLangs[0], "auto");

  return attempts;
}

/** One human-readable phrase for a track's provenance. */
export function describeCaptions(c: { source: FetchedCaptions["source"]; language: string; translatedFrom?: string }): string {
  if (c.source === "creator_captions") return `${c.language}, creator-provided`;
  if (c.source === "auto_captions_translated") {
    return `${c.language}, auto-translated from ${c.translatedFrom}`;
  }
  return `${c.language}, auto-generated — video's original language`;
}

export async function fetchCaptions(
  bin: string,
  url: string,
  meta: YoutubeMeta,
  opts: { language?: string; notify?: (msg: string) => void; onFailure?: (reason: string) => void } = {},
): Promise<FetchedCaptions | null> {
  const attempts = planCaptionAttempts(meta, opts.language);
  // A track can be listed and still refuse to download — YouTube rate-limits
  // (HTTP 429) under exactly the retry patterns an import produces. Reporting
  // that as "this video has no captions" sends the user to fix the wrong thing.
  let lastFailure: string | null = null;

  for (const attempt of attempts) {
    opts.notify?.(`Downloading captions (${describeCaptions(attempt)})…`);

    // Retrying the PREFERRED track before dropping to the next language is what
    // keeps re-runs idempotent: a transient 403/429 on the original-language
    // track must not silently promote a machine translation, because that would
    // change the transcript under a bundle fingerprint that has not changed and
    // the server would reject the re-upload as a content conflict.
    for (let tryN = 1; tryN <= MAX_ATTEMPTS; tryN += 1) {
      let stderr = "";
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
              attempt.track,
              "--sub-format",
              format,
              "-o",
              join(dir, "track.%(ext)s"),
              url,
            ],
            180_000,
          );
          if (res.code !== 0) {
            stderr = res.stderr.trim();
            const line = stderr.split("\n").filter(Boolean).pop();
            if (line) lastFailure = `${attempt.track}: ${line}`;
            continue;
          }
          const file = readdirSync(dir).find((f) => f.endsWith(`.${format}`));
          if (!file) continue;
          const text = readFileSync(join(dir, file), "utf8");
          if (!text.trim()) continue;
          return {
            format,
            text,
            source: attempt.source,
            language: attempt.language,
            ...(attempt.translatedFrom ? { translatedFrom: attempt.translatedFrom } : {}),
          };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      const kind = classifyFailure(stderr);
      if (!stderr || !isRetriable(kind) || tryN === MAX_ATTEMPTS) break;
      opts.notify?.(retryNotice(stderr, kind, tryN + 1, MAX_ATTEMPTS));
      await sleep(RETRY_BACKOFF_MS[tryN - 1] ?? 5_000);
    }
  }
  if (lastFailure) opts.onFailure?.(lastFailure);
  return null;
}
