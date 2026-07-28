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

    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(
        input.ytDlpBin,
        [
          "--ignore-config",
          "--no-playlist",
          "--no-part",
          "--no-progress",
          "--max-filesize",
          `${Math.floor(MAX_BYTES / 1_000_000)}M`,
          "-f",
          "bv*[height<=720]/b[height<=720]",
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
          reject(new VideoUnavailableError(`${aborted}, so frames were skipped.`));
          return;
        }
        if (code !== 0) {
          reject(
            new VideoUnavailableError(
              `yt-dlp could not download the video for frame extraction: ${stderr.trim().split("\n").pop() ?? `exit ${code}`}`,
            ),
          );
          return;
        }
        resolveRun();
      });
    });

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
