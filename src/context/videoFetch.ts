/**
 * Gets a local video file to extract frames from, for as short a time as
 * possible.
 *
 * Downloaded media is a liability: it is large, it is someone else's content,
 * and the user did not ask for a copy of it on their disk. So every download
 * here is bounded (resolution, bytes, duration), goes to a temp directory, and
 * is deleted on every exit path — success, throw, or Ctrl-C.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASELINE_DOWNLOAD_ARGS,
  DEFAULT_FORMAT,
  MAX_ATTEMPTS,
  PROGRESSIVE_FALLBACK,
  RETRY_BACKOFF_MS,
  TOKEN_FREE_CLIENT_ARGS,
  classifyFailure,
  isRetriable,
  retryNotice,
  sleep,
} from "./retry.js";

/** A 720p video-only rendition of a long talk still runs to hundreds of MB;
 *  past this we are no longer "borrowing" the file. */
const MAX_BYTES = 1_500_000_000;
/** Past four hours the download dominates the import and the frame set is too
 *  sparse to be worth it. */
export const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const SIZE_POLL_MS = 2_000;

/** Every temp dir currently holding borrowed media, so a signal can wipe them
 *  all even if we die between mkdtemp and the finally block. */
const live = new Set<string>();
let handlersInstalled = false;

function purge(): void {
  for (const dir of live) rmSync(dir, { recursive: true, force: true });
  live.clear();
}

function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      purge();
      // Re-raise with the default disposition so the exit code stays honest.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
  process.on("exit", purge);
}

export interface BorrowedVideo {
  path: string;
  /** Cleanup is idempotent; a local source resolves to a no-op. */
  release: () => void;
}

export class VideoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoUnavailableError";
  }
}

/** Local imports already have the file — copying it would double the disk cost
 *  for no benefit. */
export function borrowLocalVideo(path: string): BorrowedVideo {
  return { path, release: () => {} };
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    try {
      total += statSync(join(dir, entry)).size;
    } catch {
      // The file can vanish under us as yt-dlp renames its parts.
    }
  }
  return total;
}

type AttemptResult =
  | { ok: true }
  /** yt-dlp's own failure — classifiable, possibly worth another go. */
  | { ok: false; stderr: string }
  /** Our own bound was hit. Never retried: the next attempt hits the same wall. */
  | { ok: false; abort: string };

/** Leftovers from a failed attempt would be mistaken for a finished download. */
function clearDir(dir: string): void {
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
}

interface AttemptPlan {
  format: string;
  extraArgs: string[];
}

function attemptDownload(
  dir: string,
  input: { ytDlpBin: string; url: string },
  plan: AttemptPlan,
): Promise<AttemptResult> {
  return new Promise<AttemptResult>((resolveRun, reject) => {
    const child = spawn(
      input.ytDlpBin,
      [
        "--ignore-config",
        "--no-playlist",
        "--no-part",
        "--no-progress",
        ...BASELINE_DOWNLOAD_ARGS,
        ...plan.extraArgs,
        "--max-filesize",
        `${Math.floor(MAX_BYTES / 1_000_000)}M`,
        "-f",
        plan.format,
        "-o",
        join(dir, "source.%(ext)s"),
        input.url,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    let aborted: string | null = null;
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 16_384) stderr += d.toString("utf8");
    });

    // --max-filesize only knows sizes the server declared up front, so watch
    // the bytes actually landing too.
    const poll = setInterval(() => {
      try {
        if (dirBytes(dir) > MAX_BYTES) {
          aborted = `the download passed the ${Math.round(MAX_BYTES / 1_000_000_000)}GB ceiling`;
          child.kill("SIGKILL");
        }
      } catch {
        // Directory already gone; the close handler will sort it out.
      }
    }, SIZE_POLL_MS);

    const timer = setTimeout(() => {
      aborted = "the download timed out";
      child.kill("SIGKILL");
    }, DOWNLOAD_TIMEOUT_MS);

    const done = (): void => {
      clearInterval(poll);
      clearTimeout(timer);
    };

    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code) => {
      done();
      if (aborted) {
        resolveRun({ ok: false, abort: aborted });
        return;
      }
      if (code !== 0) {
        resolveRun({ ok: false, stderr: stderr.trim() || `exit ${code}` });
        return;
      }
      resolveRun({ ok: true });
    });
  });
}

/**
 * Three attempts on yt-dlp's own defaults, then two escalations.
 *
 * The 403 this exists for is not a verdict about the video — the identical
 * command succeeds a minute later, because the media URL YouTube signed has
 * expired and only a fresh extraction mints a new one. Re-running the binary IS
 * the re-extraction, which is why the outer loop earns its keep even though
 * BASELINE_DOWNLOAD_ARGS already makes yt-dlp retry internally.
 *
 * The escalation ladder and the reasoning behind each rung are documented in
 * docs/research/2026-07-29-ytdlp-403-fallbacks.md §3.
 */
async function downloadWithRetries(
  dir: string,
  input: { ytDlpBin: string; url: string; notify: (msg: string) => void },
): Promise<void> {
  const base: AttemptPlan = { format: DEFAULT_FORMAT, extraArgs: [] };
  let last = "";

  const escalations: { plan: AttemptPlan; notice: string; success: string }[] = [
    {
      plan: { format: DEFAULT_FORMAT, extraArgs: TOKEN_FREE_CLIENT_ARGS },
      notice: "Still blocked — trying YouTube's token-free player clients (tv, android_vr, web_embedded)…",
      success: "A different player client worked — continuing with frame extraction.",
    },
    {
      plan: PROGRESSIVE_FALLBACK,
      notice: "Still blocked — falling back to a pre-muxed progressive format (lower resolution, but it downloads in one piece)…",
      success: "The progressive format worked — continuing with frame extraction.",
    },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) clearDir(dir);
    const result = await attemptDownload(dir, input, base);
    if (result.ok) return;
    if ("abort" in result) throw new VideoUnavailableError(`${result.abort}, so frames were skipped.`);

    last = result.stderr;
    const kind = classifyFailure(last);
    if (!isRetriable(kind)) {
      throw new VideoUnavailableError(`yt-dlp could not download the video for frame extraction: ${lastLine(last)}`);
    }
    if (attempt === MAX_ATTEMPTS) break;

    input.notify(retryNotice(last, kind, attempt + 1, MAX_ATTEMPTS));
    await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 5_000);
  }

  for (const step of escalations) {
    input.notify(step.notice);
    clearDir(dir);
    const result = await attemptDownload(dir, input, step.plan);
    if (result.ok) {
      input.notify(step.success);
      return;
    }
    if ("abort" in result) throw new VideoUnavailableError(`${result.abort}, so frames were skipped.`);
    last = result.stderr;
    // A fatal answer from a different client is the video's real answer.
    if (!isRetriable(classifyFailure(last))) break;
  }

  throw new VideoUnavailableError(
    `yt-dlp could not download the video for frame extraction: ${lastLine(last)}`,
  );
}

function lastLine(stderr: string): string {
  return stderr.split("\n").filter(Boolean).pop() ?? "unknown error";
}

/**
 * Downloads a bounded rendition of a YouTube video into a temp directory.
 * Throws VideoUnavailableError when the source is out of bounds — callers treat
 * that as "stay transcript-only", not as a failed import.
 */
export async function borrowYoutubeVideo(input: {
  ytDlpBin: string;
  url: string;
  durationMs: number;
  notify: (msg: string) => void;
}): Promise<BorrowedVideo> {
  if (input.durationMs > MAX_DURATION_MS) {
    throw new VideoUnavailableError(
      `the video is ${Math.round(input.durationMs / 3_600_000)}h long — over the ${MAX_DURATION_MS / 3_600_000}h ceiling for frame extraction, so no video was downloaded.`,
    );
  }

  installSignalHandlers();
  const dir = mkdtempSync(join(tmpdir(), "clipy-frames-"));
  live.add(dir);

  const release = (): void => {
    rmSync(dir, { recursive: true, force: true });
    live.delete(dir);
  };

  try {
    input.notify("Downloading a low-resolution (≤720p) copy of the video for frame extraction — it is deleted the moment the frames are cut…");
    await downloadWithRetries(dir, input);

    const file = readdirSync(dir).find((f) => f.startsWith("source."));
    if (!file || !existsSync(join(dir, file)) || statSync(join(dir, file)).size === 0) {
      throw new VideoUnavailableError("the download produced no usable video file, so frames were skipped.");
    }

    return { path: join(dir, file), release };
  } catch (e) {
    release();
    throw e;
  }
}
