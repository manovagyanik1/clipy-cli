/**
 * Phase 2 of the visual pipeline: turn the server's frame timestamps into
 * actual images on disk.
 *
 * One ffmpeg invocation per timestamp with `-ss` BEFORE `-i` so the decoder
 * seeks rather than decoding the whole file up to that point — the difference
 * between a second and several minutes on a long recording.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveFf, runFf, supportsWebp } from "./ffmpeg.js";

/** Frames are context for a reader, not masters — 1600px wide is plenty and
 *  keeps the base64 upload from ballooning. */
const MAX_WIDTH = 1600;
const PER_FRAME_TIMEOUT_MS = 60_000;

export interface ExtractedFrame {
  timestampMs: number;
  path: string;
  /** Basename only — the manifest must never carry a local directory. */
  file: string;
  width?: number;
  height?: number;
  sha256: string;
  byteSize: number;
  mimeType: string;
}

export interface ExtractFramesInput {
  videoPath: string;
  timestampsMs: number[];
  outDir: string;
  notify?: (msg: string) => void;
}

function pad(index: number): string {
  return String(index).padStart(6, "0");
}

/** M:SS, so a warning names the moment the way the user would scrub to it. */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** ffmpeg prints the encoded still's dimensions in its stream summary; parsing
 *  it is cheaper than a second ffprobe spawn per frame. */
function parseDimensions(stderr: string): { width?: number; height?: number } {
  const match = /Video:.*?[,\s](\d{2,5})x(\d{2,5})/.exec(stderr);
  if (!match) return {};
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return {};
  return { width, height };
}

export async function extractFrames(input: ExtractFramesInput): Promise<ExtractedFrame[]> {
  const notify = input.notify ?? (() => {});
  if (input.timestampsMs.length === 0) return [];

  const bin = await resolveFf("ffmpeg", notify);
  const webp = await supportsWebp(bin);
  const ext = webp ? "webp" : "jpg";
  const mimeType = webp ? "image/webp" : "image/jpeg";
  if (!webp) {
    notify("note: this ffmpeg build has no webp encoder — extracting frames as JPEG instead (slightly larger, same content).");
  }

  mkdirSync(input.outDir, { recursive: true });

  // Sorted and de-duplicated: the server may hand back near-identical
  // timestamps, and frame N should mean "the Nth moment in the video".
  const timestamps = [...new Set(input.timestampsMs.filter((t) => Number.isFinite(t) && t >= 0))].sort(
    (a, b) => a - b,
  );

  notify(
    `Extracting ${timestamps.length} frame${timestamps.length === 1 ? "" : "s"} with ffmpeg…`,
  );

  const frames: ExtractedFrame[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestampMs = timestamps[index];
    const file = `${pad(index)}.${ext}`;
    const path = join(input.outDir, file);

    try {
      const res = await runFf(
        bin,
        [
          "-hide_banner",
          "-nostdin",
          "-y",
          "-ss",
          (timestampMs / 1000).toFixed(3),
          "-i",
          input.videoPath,
          "-frames:v",
          "1",
          "-vf",
          `scale='min(${MAX_WIDTH},iw)':-2`,
          "-q:v",
          "3",
          path,
        ],
        PER_FRAME_TIMEOUT_MS,
      );

      // A timestamp past the end of the file exits 0 having written nothing, so
      // the file's existence is the real success check, not the exit code.
      if (res.code !== 0 || !existsSync(path) || statSync(path).size === 0) {
        notify(
          `warning: no frame could be extracted at ${fmtClock(timestampMs)} (moment ${index + 1} of ${timestamps.length}) — skipping that one, the rest continue. ${
            res.stderr.trim().split("\n").pop() ?? ""
          }`.trim(),
        );
        continue;
      }

      const bytes = readFileSync(path);
      frames.push({
        timestampMs,
        path,
        file,
        ...parseDimensions(res.stderr),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
        mimeType,
      });
    } catch (e) {
      notify(
        `warning: no frame could be extracted at ${fmtClock(timestampMs)} (moment ${index + 1} of ${timestamps.length}) — skipping that one, the rest continue. ${(e as Error).message}`,
      );
    }
  }

  return frames;
}
