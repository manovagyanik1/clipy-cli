/**
 * ffmpeg/ffprobe management for the visual profile.
 *
 * Mirrors ytdlp.ts in shape — prefer Clipy's own copy in ~/.clipy/bin, then a
 * system install on PATH — but deliberately NOT in policy. yt-dlp publishes
 * signed single-file release assets from its own GitHub org, so downloading it
 * is unambiguous. ffmpeg has no equivalent: the project itself ships no
 * binaries, and the third-party builds ffmpeg.org points at differ wildly in
 * trustworthiness and in how scriptable their URLs are. So we only auto-install
 * where there is a canonical, stable, versionless URL (Linux static builds) and
 * otherwise print the one-line install command rather than pulling a binary
 * from a host we cannot vouch for.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const STDERR_CAP = 16_384;

/** johnvansickle.com is the static-build source ffmpeg.org lists for Linux, and
 *  its "release" URLs are versionless, so they stay valid across upgrades. */
const LINUX_BUILDS: Record<string, string> = {
  x64: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
  arm64: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz",
};

export type FfTool = "ffmpeg" | "ffprobe";

function clipyBinDir(): string {
  return join(homedir(), ".clipy", "bin");
}

function exeName(tool: FfTool): string {
  return process.platform === "win32" ? `${tool}.exe` : tool;
}

function managedPath(tool: FfTool): string {
  return join(clipyBinDir(), exeName(tool));
}

function onPath(tool: FfTool): string | null {
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, exeName(tool));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function installHint(): string {
  if (process.platform === "darwin") return "brew install ffmpeg";
  if (process.platform === "win32") return "winget install Gyan.FFmpeg";
  return "sudo apt install ffmpeg";
}

export class FfmpegMissingError extends Error {
  constructor(tool: FfTool) {
    super(
      `${tool} is needed to extract visual evidence for this video, and Clipy has no trustworthy automatic download for ${process.platform}/${process.arch}.\n` +
        `  Install it with: ${installHint()}\n` +
        `  Then re-run this command to add the frames. (Or pass --no-frames to stay transcript-only on purpose.)`,
    );
    this.name = "FfmpegMissingError";
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Always an argument array — never a shell string. Paths here are
 *  user-controlled and must not be re-parsed by anything. */
export function runFf(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
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
      if (stdout.length < STDERR_CAP) stdout += d.toString("utf8").slice(0, STDERR_CAP - stdout.length);
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

/** Unpacks the Linux static tarball, which nests both binaries one directory
 *  deep under a version-stamped name. */
async function installLinux(url: string, notify: (msg: string) => void): Promise<void> {
  notify(
    `ffmpeg is not installed. Downloading a static build into ${clipyBinDir()} (from ${url}) — Clipy keeps its own copy and never installs system-wide.`,
  );
  mkdirSync(clipyBinDir(), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "clipy-ffmpeg-"));
  try {
    const archive = join(work, "ffmpeg.tar.xz");
    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow" });
    } catch (e) {
      throw new Error(
        `could not download ffmpeg from ${url}: ${(e as Error).message}. Install it with \`${installHint()}\` and re-run.`,
      );
    }
    if (!res.ok || !res.body) {
      throw new Error(
        `could not download ffmpeg from ${url} (HTTP ${res.status}). Install it with \`${installHint()}\` and re-run.`,
      );
    }
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(archive));

    const untar = await runFf("tar", ["-xJf", archive, "-C", work], 180_000);
    if (untar.code !== 0) throw new Error(`could not unpack the ffmpeg archive: ${untar.stderr.trim().slice(0, 200)}`);

    const nested = readdirSync(work).find((entry) => entry.startsWith("ffmpeg-") && !entry.endsWith(".tar.xz"));
    if (!nested) throw new Error("the ffmpeg archive did not contain the expected directory");

    for (const tool of ["ffmpeg", "ffprobe"] as FfTool[]) {
      const from = join(work, nested, tool);
      if (!existsSync(from)) throw new Error(`the ffmpeg archive did not contain ${tool}`);
      renameSync(from, managedPath(tool));
      chmodSync(managedPath(tool), 0o755);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const cache = new Map<FfTool, string>();

export async function resolveFf(tool: FfTool, notify: (msg: string) => void): Promise<string> {
  const hit = cache.get(tool);
  if (hit) return hit;

  const managed = managedPath(tool);
  if (existsSync(managed)) {
    cache.set(tool, managed);
    return managed;
  }
  const found = onPath(tool);
  if (found) {
    cache.set(tool, found);
    return found;
  }

  const linuxUrl = process.platform === "linux" ? LINUX_BUILDS[process.arch] : undefined;
  if (!linuxUrl) throw new FfmpegMissingError(tool);

  await installLinux(linuxUrl, notify);
  if (!existsSync(managed)) throw new FfmpegMissingError(tool);
  notify(`Installed ffmpeg and ffprobe to ${clipyBinDir()} (one-time setup).`);
  cache.set(tool, managed);
  return managed;
}

let webpSupport: boolean | null = null;

/**
 * Homebrew's default ffmpeg ships without libwebp, so the still format has to
 * be probed rather than assumed. Probed once per process.
 */
export async function supportsWebp(bin: string): Promise<boolean> {
  if (webpSupport !== null) return webpSupport;
  try {
    const res = await runFf(bin, ["-hide_banner", "-encoders"], 30_000);
    webpSupport = res.code === 0 && /^\s*\S*V\S*\s+libwebp(_anim)?\s/m.test(res.stdout);
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

/** Test seam: lets the suite assert both still formats without a second ffmpeg. */
export function __setWebpSupportForTests(value: boolean | null): void {
  webpSupport = value;
}
