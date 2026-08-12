import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveFf, runFf } from "./context/ffmpeg.js";

const MAX_FRAMES = 50;
const MAX_TOTAL_SECONDS = 300;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 250 * 1024 * 1024;
const SUPPORTED_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp)$/i;

export interface RenderProofFramesOptions {
  framePaths: string[];
  outputPath: string;
  holdSeconds: number;
  width: number;
  height: number;
  notify: (message: string) => void;
}

export interface RenderedProof {
  videoPath: string;
  framePaths: string[];
  durationSeconds: number;
}

function evenDimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 320 || value > 3840) {
    throw new Error(`${label} must be an integer between 320 and 3840`);
  }
  if (value % 2 !== 0) {
    throw new Error(`${label} must be even for video encoding`);
  }
  return value;
}

function validateFrames(paths: string[]): string[] {
  if (paths.length === 0) throw new Error("proof needs at least one --frame");
  if (paths.length > MAX_FRAMES) {
    throw new Error(`proof accepts at most ${MAX_FRAMES} frames`);
  }

  let totalBytes = 0;
  return paths.map((input) => {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`proof frame does not exist: ${path}`);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`proof frame is not a file: ${path}`);
    if (stat.size === 0) throw new Error(`proof frame is empty: ${path}`);
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`proof frame exceeds 50 MiB: ${path}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error("proof frames exceed the 250 MiB total input limit");
    }
    if (!SUPPORTED_IMAGE_EXTENSIONS.test(path)) {
      throw new Error(`unsupported proof frame format (use PNG, JPEG, or WebP): ${path}`);
    }
    return path;
  });
}

/**
 * Turns a bounded sequence of screenshots into a silent MP4. Each screenshot
 * is held for the same duration; narration/captions remain separate so the
 * server can expose them as timestamped agent evidence.
 *
 * Every argument goes directly to spawn(), never through a shell. Frame paths
 * may therefore contain whitespace or shell metacharacters safely.
 */
export async function renderProofFrames(
  opts: RenderProofFramesOptions,
): Promise<RenderedProof> {
  const framePaths = validateFrames(opts.framePaths);
  if (!Number.isFinite(opts.holdSeconds) || opts.holdSeconds < 0.25 || opts.holdSeconds > 30) {
    throw new Error("--hold must be between 0.25 and 30 seconds");
  }
  const durationSeconds = framePaths.length * opts.holdSeconds;
  if (durationSeconds > MAX_TOTAL_SECONDS) {
    throw new Error(`proof video is capped at ${MAX_TOTAL_SECONDS} seconds`);
  }
  const width = evenDimension(opts.width, "--width");
  const height = evenDimension(opts.height, "--height");

  const ffmpeg = await resolveFf("ffmpeg", opts.notify);
  const args: string[] = ["-hide_banner", "-loglevel", "error"];
  for (const framePath of framePaths) {
    args.push("-loop", "1", "-t", String(opts.holdSeconds), "-i", framePath);
  }

  const filters: string[] = framePaths.map(
    (_frame, index) =>
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,fps=30,format=yuv420p[v${index}]`,
  );
  filters.push(
    `${framePaths.map((_frame, index) => `[v${index}]`).join("")}` +
      `concat=n=${framePaths.length}:v=1:a=0[outv]`,
  );

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[outv]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-tune",
    "stillimage",
    "-crf",
    "14",
    "-profile:v",
    "main",
    "-movflags",
    "+faststart",
    "-an",
    "-y",
    opts.outputPath,
  );

  const result = await runFf(ffmpeg, args, Math.max(120_000, durationSeconds * 10_000));
  if (result.code !== 0) {
    const detail = result.stderr.trim().slice(-1_000);
    throw new Error(`ffmpeg could not create the proof video${detail ? `: ${detail}` : ""}`);
  }

  return { videoPath: opts.outputPath, framePaths, durationSeconds };
}
