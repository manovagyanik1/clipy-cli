/** ffprobe wrapper for local-file imports. */

import { spawn } from "node:child_process";

export interface ProbeResult {
  durationMs: number;
  width?: number;
  height?: number;
}

const INSTALL_HINT =
  "ffprobe was not found. Install ffmpeg (macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt install ffmpeg · Windows: winget install Gyan.FFmpeg) and try again.";

function run(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 8192) stderr += d.toString("utf8");
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new Error(INSTALL_HINT) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

export async function probeVideo(path: string): Promise<ProbeResult> {
  const res = await run(
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    60_000,
  );
  if (res.code !== 0) {
    throw new Error(`ffprobe could not read ${path}: ${res.stderr.trim().split("\n").pop() ?? `exit ${res.code}`}`);
  }

  let parsed: { streams?: unknown; format?: unknown };
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch {
    throw new Error(`ffprobe returned unparseable output for ${path}`);
  }

  const streams = Array.isArray(parsed.streams) ? (parsed.streams as Record<string, unknown>[]) : [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) {
    throw new Error(`${path} has no video stream — Clipy context imports need a video file.`);
  }

  const format = (parsed.format ?? {}) as Record<string, unknown>;
  const seconds = Number(format.duration ?? video.duration);
  const width = Number(video.width);
  const height = Number(video.height);

  return {
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0,
    ...(Number.isFinite(width) && width > 0 ? { width } : {}),
    ...(Number.isFinite(height) && height > 0 ? { height } : {}),
  };
}
