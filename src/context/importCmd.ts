/**
 * `clipy context import <youtube-url|local-file>` — compiles a local Clipy
 * context bundle (AREC v0.2-draft) and optionally syncs it to the library.
 *
 * Syncing is a TWO-PHASE protocol, and the split is deliberate: the server is
 * the classification brain. Phase 1 uploads the transcript bundle and the
 * server answers with a verdict — what kind of video this is, whether the
 * transcript stands alone, and if not, exactly which timestamps to look at.
 * Phase 2 fetches only those frames and uploads them. The CLI never decides a
 * profile locally, so a local-only run (no --sync) stays honestly
 * transcript-only and makes no claim about sufficiency.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  buildManifest,
  buildNormalizedTranscript,
  classifyTranscript,
  parseSrt,
  parseVtt,
  parseYoutubeJson3,
  renderArecMarkdown,
  slugHash,
  type ArecCompleteness,
  type ArecManifest,
  type ContextSource,
  type ManifestFrame,
  type NormalizedTranscript,
  type PlannedMoment,
  type ServerClassification,
  type TranscriptSegment,
  type UploadContextPayload,
  type UploadFrame,
} from "../context-core/index.js";
import { describeCaptions, fetchCaptions, fetchVideoMeta, resolveYtDlp } from "./ytdlp.js";
import { canonicalYoutubeUrl, isYoutubeHost, parseYoutubeId } from "./youtubeUrl.js";
import { ImportError, type ImportWarning } from "./errors.js";
import { looksLikeStaleBinary } from "./retry.js";
import { probeVideo } from "./probe.js";
import { extractFrames, type ExtractedFrame } from "./frames.js";
import { borrowLocalVideo, borrowYoutubeVideo, type BorrowedVideo } from "./videoFetch.js";

export interface ImportOptions {
  apiUrl: string;
  apiKey: string | null;
  cliVersion: string;
  transcriptPath?: string;
  outputDir?: string;
  language?: string;
  title?: string;
  tags: string[];
  folder?: string;
  sync: boolean;
  /** false = --no-frames: sync, take the verdict, but never download media. */
  frames: boolean;
  json: boolean;
}

type Input =
  | { kind: "youtube"; url: string; videoId: string }
  | { kind: "local"; path: string }
  | { kind: "url"; url: string };

function classifyInput(raw: string): Input {
  const trimmed = raw.trim();
  // Shell-escaped input (`watch\?v\=…`) still has to be recognised as YouTube,
  // so host detection runs on the de-escaped string.
  const unescaped = trimmed.replace(/\\/g, "");
  let parsed: URL | null = null;
  try {
    parsed = new URL(unescaped);
  } catch {
    parsed = null;
  }

  if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    if (isYoutubeHost(parsed.hostname)) {
      const videoId = parseYoutubeId(trimmed);
      if (!videoId) {
        throw new ImportError(
          "invalid_url",
          `could not find a video id in "${raw}". Channel, playlist and search URLs are not supported.`,
          `Pass a single-video URL, e.g. clipy context import "https://www.youtube.com/watch?v=<id>" (youtu.be/<id> and /shorts/<id> also work).`,
        );
      }
      // Everything downstream uses the canonical URL — never the raw input.
      return { kind: "youtube", url: canonicalYoutubeUrl(videoId), videoId };
    }
    return { kind: "url", url: unescaped };
  }

  const path = resolve(trimmed);
  if (existsSync(path) && statSync(path).isFile()) return { kind: "local", path };

  throw new ImportError(
    "source_unreadable",
    `could not read "${raw}" — it is neither a YouTube URL nor a readable local file.`,
    `Check the path exists, or pass a YouTube URL: clipy context import "https://www.youtube.com/watch?v=<id>"`,
  );
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface ClipyTranscriptJson {
  segments?: unknown;
}

function parseTranscriptFile(path: string): TranscriptSegment[] {
  const text = readFileSync(path, "utf8");
  const lower = path.toLowerCase();

  if (lower.endsWith(".vtt")) return parseVtt(text);
  if (lower.endsWith(".srt")) return parseSrt(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError(
      "transcript_unreadable",
      `--transcript ${path} is neither .vtt/.srt nor valid JSON.`,
      `Supply WebVTT (.vtt), SubRip (.srt), or Clipy transcript JSON ({"segments":[{"startMs","endMs","text"}]}).`,
    );
  }

  // json3 (YouTube) and Clipy transcript JSON both land here.
  const json3 = parseYoutubeJson3(parsed);
  if (json3.length > 0) return json3;

  const raw = (parsed as ClipyTranscriptJson).segments;
  if (!Array.isArray(raw)) {
    throw new ImportError(
      "transcript_unreadable",
      `--transcript ${path} has no usable segments.`,
      `Supply WebVTT (.vtt), SubRip (.srt), or Clipy transcript JSON ({"segments":[{"startMs","endMs","text"}]}).`,
    );
  }
  const segments: TranscriptSegment[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const startMs = Number(item.startMs);
    const endMs = Number(item.endMs);
    const value = item.text;
    if (!Number.isFinite(startMs) || typeof value !== "string") continue;
    segments.push({ startMs, endMs: Number.isFinite(endMs) ? endMs : startMs, text: value });
  }
  if (segments.length === 0) {
    throw new ImportError(
      "transcript_unreadable",
      `--transcript ${path} has no usable segments.`,
      `Supply WebVTT (.vtt), SubRip (.srt), or Clipy transcript JSON ({"segments":[{"startMs","endMs","text"}]}).`,
    );
  }
  return segments;
}

/** Platform-correct, runnable verbatim — an agent should be able to paste it. */
const FFMPEG_INSTALL_COMMAND =
  process.platform === "darwin"
    ? "brew install ffmpeg"
    : process.platform === "win32"
      ? "winget install Gyan.FFmpeg"
      : "sudo apt install ffmpeg";

/** Resolves + parses `--transcript`, shared by every input kind. */
function loadUserTranscript(transcriptPath: string): TranscriptSegment[] {
  const resolved = resolve(transcriptPath);
  if (!existsSync(resolved)) {
    throw new ImportError(
      "transcript_unreadable",
      `--transcript ${resolved} does not exist.`,
      `Check the path, or drop --transcript to use the provider's captions.`,
    );
  }
  notify(`Reading the transcript from ${basename(resolved)}…`);
  return parseTranscriptFile(resolved);
}

/** How Phase 2 would get at the pixels, if the server asks for them. */
type MediaRef =
  | { kind: "local"; path: string }
  | { kind: "youtube"; url: string; ytDlpBin: string; durationMs: number };

interface Compiled {
  manifest: ArecManifest;
  transcript: NormalizedTranscript;
  markdown: string;
  /** Stable across runs and machines; the sync idempotency key is derived from it. */
  fingerprint: string;
  media: MediaRef;
}

function notify(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** M:SS / H:MM:SS, matching how a user would scrub to the moment. */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * The exact command to run again. Printed with every partial success, because
 * "re-run it" is only actionable if the user does not have to reconstruct the
 * flags they used ten minutes ago.
 */
function rerunCommand(target: string, opts: ImportOptions): string {
  const quote = (v: string) => (/[\s"']/.test(v) ? JSON.stringify(v) : v);
  const parts = ["clipy", "context", "import", quote(target)];
  if (opts.transcriptPath) parts.push("--transcript", quote(opts.transcriptPath));
  if (opts.outputDir) parts.push("--output", quote(opts.outputDir));
  if (opts.language) parts.push("--language", quote(opts.language));
  if (opts.folder) parts.push("--folder", quote(opts.folder));
  for (const tag of opts.tags) parts.push("--tag", quote(tag));
  parts.push("--sync");
  return parts.join(" ");
}

async function compileYoutube(url: string, videoId: string, opts: ImportOptions): Promise<Compiled> {
  const bin = await resolveYtDlp(notify);
  notify("Fetching video info…");
  const meta = await fetchVideoMeta(bin, url);

  // A zero duration is how YouTube's placeholder/consent stubs come back. They
  // are not real videos, and compiling one produces an empty bundle attributed
  // to a URL the user did ask for — worse than a refusal.
  if (!meta.durationMs) {
    throw new ImportError(
      "invalid_url",
      `could not read this video: ${url} returned no duration. That usually means it is private, region-blocked, age-gated, members-only, or an unfinished live stream.`,
      `Open the URL in a browser to check it plays, or import a local copy: clipy context import ./<file> --transcript <file.vtt>`,
    );
  }
  notify(`Found: "${meta.title}" (${fmtClock(meta.durationMs)})`);

  // providerId comes from the URL we parsed, not from yt-dlp's echo, so the
  // manifest points at the video the user named even if metadata is partial.
  const id = meta.id || videoId;
  const source: ContextSource = {
    kind: "youtube",
    canonicalUrl: canonicalYoutubeUrl(id),
    providerId: id,
  };

  // An explicit --transcript is the user overriding the provider, so YouTube's
  // captions are never consulted — not even as a fallback.
  if (opts.transcriptPath) {
    const segments = loadUserTranscript(opts.transcriptPath);
    notify(`Using your transcript file (${segments.length} segments) — skipping YouTube captions.`);
    const transcript = buildNormalizedTranscript(segments, {
      ...(opts.language ? { language: opts.language } : {}),
      source: "user_file",
      durationMs: meta.durationMs || undefined,
    });
    return finish({
      title: opts.title ?? meta.title,
      source,
      durationMs: meta.durationMs,
      transcript,
      fingerprint: `youtube:${id}`,
      media: { kind: "youtube", url, ytDlpBin: bin, durationMs: meta.durationMs },
      opts,
    });
  }

  let downloadFailure: string | null = null;
  const captions = await fetchCaptions(bin, url, meta, {
    ...(opts.language ? { language: opts.language } : {}),
    notify,
    onFailure: (reason) => {
      downloadFailure = reason;
    },
  });
  if (!captions) {
    // A listed track that refused to download is a different problem with a
    // different fix, so it must not be reported as an absent track.
    if (downloadFailure) {
      const stale = looksLikeStaleBinary(downloadFailure);
      throw new ImportError(
        "no_captions",
        `the captions are listed but could not be downloaded: ${downloadFailure}`,
        stale
          ? `This looks like an out-of-date yt-dlp (an extraction failure, not a block). Update it — the managed copy self-updates, or run: yt-dlp -U`
          : `If this is HTTP 429, YouTube is rate-limiting this machine — wait a few minutes and re-run. Otherwise supply your own captions: clipy context import <url> --transcript <file.vtt>`,
      );
    }
    const available = [...new Set([...meta.subtitleLangs, ...meta.autoCaptionLangs])];
    if (available.length > 0) {
      throw new ImportError(
        "no_captions",
        `this video has no captions in "${opts.language ?? "any usable language"}". Available: ${available.slice(0, 20).join(", ")}${available.length > 20 ? `, … (${available.length} total)` : ""}.`,
        `Re-run picking one of those: clipy context import <url> --language ${available[0]}`,
      );
    }
    throw new ImportError(
      "no_captions",
      "this video has no captions at all (neither creator-provided nor auto-generated).",
      `Supply your own: clipy context import <url> --transcript <file.vtt|file.srt|transcript.json>`,
    );
  }

  const raw =
    captions.format === "json3"
      ? parseYoutubeJson3(JSON.parse(captions.text))
      : parseVtt(captions.text);

  const transcript = buildNormalizedTranscript(raw, {
    language: captions.language,
    source: captions.source,
    durationMs: meta.durationMs || undefined,
  });
  notify(`Got ${transcript.segments.length} caption segments (${describeCaptions(captions)}).`);

  return finish({
    title: opts.title ?? meta.title,
    source,
    durationMs: meta.durationMs,
    transcript,
    fingerprint: `youtube:${id}`,
    media: { kind: "youtube", url, ytDlpBin: bin, durationMs: meta.durationMs },
    opts,
  });
}

async function compileLocal(path: string, opts: ImportOptions): Promise<Compiled> {
  if (!opts.transcriptPath) {
    throw new ImportError(
      "no_captions",
      "local files need a transcript — Clipy cannot transcribe them yet.",
      `Re-run with a caption file: clipy context import ${JSON.stringify(path)} --transcript <file.vtt|file.srt|transcript.json>`,
    );
  }
  notify(`Probing ${basename(path)} with ffprobe…`);
  let probe;
  try {
    probe = await probeVideo(path);
  } catch (e) {
    const message = (e as Error).message;
    if (/ffprobe was not found/i.test(message)) {
      throw new ImportError("ffmpeg_missing", message, FFMPEG_INSTALL_COMMAND);
    }
    if (/no video stream/i.test(message)) {
      throw new ImportError(
        "no_video_stream",
        message,
        `Supply a file with a video track, or import the audio transcript-only with --no-frames.`,
      );
    }
    throw new ImportError("source_unreadable", message, `Check the file plays, then re-run.`);
  }
  const contentHash = sha256File(path);
  const segments = loadUserTranscript(opts.transcriptPath);
  notify(`Got ${segments.length} transcript segments (${fmtClock(probe.durationMs)} of video).`);

  const transcript = buildNormalizedTranscript(segments, {
    ...(opts.language ? { language: opts.language } : {}),
    source: "user_file",
    durationMs: probe.durationMs || undefined,
  });

  return finish({
    title: opts.title ?? basename(path),
    // basename only — the bundle and the upload must never carry the user's
    // directory layout, and `path` here is already absolute.
    source: { kind: "local", contentHash, fileName: basename(path) },
    durationMs: probe.durationMs,
    transcript,
    fingerprint: `local:${contentHash}`,
    media: { kind: "local", path },
    opts,
  });
}

function finish(input: {
  title: string;
  source: ContextSource;
  durationMs: number;
  transcript: NormalizedTranscript;
  fingerprint: string;
  media: MediaRef;
  opts: ImportOptions;
}): Compiled {
  const sufficiency = classifyTranscript(input.transcript);
  const manifest = buildManifest({
    title: input.title,
    source: input.source,
    durationMs: input.durationMs,
    profile: "transcript",
    transcript: input.transcript,
    compiler: { name: "@clipy/cli", version: input.opts.cliVersion },
    sufficiency,
    createdAt: new Date().toISOString(),
  });
  return {
    manifest,
    transcript: input.transcript,
    markdown: renderArecMarkdown(manifest, input.transcript),
    fingerprint: input.fingerprint,
    media: input.media,
  };
}

/**
 * Rebuilds a compiled bundle around the server's verdict and the frames we
 * fetched for it. recording.md is a pure function of the manifest plus the
 * transcript, so re-rendering is the whole update.
 */
function withVisualEvidence(
  compiled: Compiled,
  classification: ServerClassification,
  frames: ManifestFrame[],
  completeness?: ArecCompleteness,
): Compiled {
  const manifest: ArecManifest = {
    ...compiled.manifest,
    profile: frames.length > 0 ? "visual" : compiled.manifest.profile,
    serverClassification: classification,
    ...(frames.length > 0 ? { frames } : {}),
    ...(completeness ? { completeness } : {}),
  };
  return {
    ...compiled,
    manifest,
    markdown: renderArecMarkdown(manifest, compiled.transcript),
  };
}

/** A frame is captioned by the planned moment it was cut for. Timestamps can
 *  drift by a keyframe, so match on proximity; a caption from a different
 *  moment would be worse than none. */
const CAPTION_MATCH_TOLERANCE_MS = 2_000;

function captionForFrame(moments: PlannedMoment[] | undefined, timestampMs: number): string | undefined {
  let best: PlannedMoment | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const m of moments ?? []) {
    const delta = Math.abs(m.tMs - timestampMs);
    if (delta < bestDelta) {
      best = m;
      bestDelta = delta;
    }
  }
  return best && bestDelta <= CAPTION_MATCH_TOLERANCE_MS ? best.caption : undefined;
}

/** Writes into a temp sibling then renames, so a failure never leaves a half bundle. */
function writeBundle(
  dir: string,
  compiled: Compiled,
  frames: ExtractedFrame[] = [],
): { path: string; rewritten: boolean } {
  mkdirSync(dir, { recursive: true });
  const bundlePath = join(dir, `clipy-context-${slugHash(compiled.fingerprint)}`);

  const contents: Record<string, string> = {
    "recording.md": compiled.markdown,
    // createdAt changes every run; compare on everything else so a rerun over an
    // unchanged source is genuinely idempotent.
    "manifest.json": `${JSON.stringify(compiled.manifest, null, 2)}\n`,
    "transcript.json": `${JSON.stringify(compiled.transcript, null, 2)}\n`,
  };

  let rewritten = false;
  if (existsSync(bundlePath)) {
    const entries = readdirSync(bundlePath);
    if (!entries.includes("manifest.json")) {
      throw new Error(
        `${bundlePath} exists but is not a Clipy context bundle — refusing to overwrite it. Use --output <dir> to write elsewhere.`,
      );
    }
    rewritten = !sameBundle(bundlePath, contents);
    if (!rewritten && frames.length === 0) return { path: bundlePath, rewritten: false };
  }

  const staging = mkdtempSync(join(dir, ".clipy-context-tmp-"));
  try {
    for (const [name, body] of Object.entries(contents)) writeFileSync(join(staging, name), body);
    if (frames.length > 0) {
      mkdirSync(join(staging, "frames"), { recursive: true });
      for (const frame of frames) copyFileSync(frame.path, join(staging, "frames", frame.file));
    }
    rmSync(bundlePath, { recursive: true, force: true });
    renameSync(staging, bundlePath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { path: bundlePath, rewritten };
}

function sameBundle(bundlePath: string, contents: Record<string, string>): boolean {
  try {
    // recording.md is a pure function of the manifest and the transcript, and it
    // embeds the compile timestamp — comparing it byte-wise would make every
    // rerun look like a content change.
    const a = JSON.parse(readFileSync(join(bundlePath, "manifest.json"), "utf8")) as Record<string, unknown>;
    const b = JSON.parse(contents["manifest.json"]) as Record<string, unknown>;
    delete a.createdAt;
    delete b.createdAt;
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
    if (readFileSync(join(bundlePath, "transcript.json"), "utf8") !== contents["transcript.json"]) return false;
    if (!existsSync(join(bundlePath, "recording.md"))) return false;
    return true;
  } catch {
    return false;
  }
}

/** One place for the auth/UA/timeout shape both phases share. */
async function apiPost(
  opts: ImportOptions,
  path: string,
  payload: unknown,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let res: Response;
  try {
    res = await fetch(`${opts.apiUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": `clipy-cli/${opts.cliVersion}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    throw new ImportError(
      "server_unreachable",
      `could not reach the Clipy API at ${opts.apiUrl}: ${(e as Error).message}`,
      `Check your network, then re-run. Without --sync the local bundle is still written and readable with: clipy context read <bundle>`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { ok: res.ok, status: res.status, body };
}

/** The server's verdict is untrusted input like anything else off the wire:
 *  every field is checked, and timestamps are clamped to the video. */
function parseClassification(raw: unknown, durationMs: number): ServerClassification | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const videoType = typeof c.videoType === "string" ? c.videoType.slice(0, 80) : "";
  if (!videoType) return null;

  const confidence = Number(c.videoTypeConfidence);
  const rawMoments = Array.isArray(c.moments) ? c.moments : [];
  const moments = rawMoments
    .flatMap((m) => {
      if (!m || typeof m !== "object") return [];
      const tMs = Number((m as Record<string, unknown>).tMs);
      const caption = (m as Record<string, unknown>).caption;
      if (!Number.isFinite(tMs) || typeof caption !== "string" || !caption.trim()) return [];
      return [{ tMs, caption: caption.trim().slice(0, 300) }];
    })
    .slice(0, 60);
  const rawTimestamps = Array.isArray(c.frameTimestampsMs) ? c.frameTimestampsMs : [];
  const frameTimestampsMs = rawTimestamps
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t >= 0 && (durationMs <= 0 || t <= durationMs))
    // A server bug (or a compromised response) must not turn into an unbounded
    // ffmpeg fan-out on the user's machine.
    .slice(0, 60);

  return {
    videoType,
    videoTypeConfidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    needsVisual: c.needsVisual === true,
    ...(typeof c.visualReason === "string" && c.visualReason.trim()
      ? { visualReason: c.visualReason.trim().slice(0, 300) }
      : {}),
    frameTimestampsMs,
    ...(moments.length ? { moments } : {}),
    ...(typeof c.model === "string" && c.model.trim() ? { model: c.model.trim().slice(0, 80) } : {}),
  };
}

interface SyncResult {
  documentId: string;
  publicId: string;
  created: boolean;
  folderName: string | null;
  classification: ServerClassification | null;
}

async function sync(compiled: Compiled, opts: ImportOptions, bundlePath: string): Promise<SyncResult> {
  if (!opts.apiKey) {
    throw new ImportError(
      "auth_required",
      `--sync needs an API key, and none is configured. The local bundle is already written to ${bundlePath}.`,
      "clipy login",
      { bundlePath },
    );
  }

  const payload: UploadContextPayload = {
    idempotencyKey: slugHash(
      `${compiled.fingerprint}|${compiled.manifest.source.contentHash ?? ""}|${compiled.manifest.compiler.version}`,
    ),
    manifest: compiled.manifest,
    arecMarkdown: compiled.markdown,
    transcript: compiled.transcript,
    ...(opts.tags.length ? { tags: opts.tags } : {}),
    ...(opts.folder ? { folderName: opts.folder } : {}),
  };

  notify(
    `Uploading the transcript to Clipy (${compiled.transcript.segments.length} segments, no video)…`,
  );
  const { ok, status, body } = await apiPost(opts, "/api/v1/context-documents", payload);

  if (!ok) {
    // Every one of these fails in PHASE 1, before anything reached the library
    // — so the local bundle is the user's intact fallback, and saying so is the
    // difference between "it broke" and "here is what you still have".
    const detail = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    const partial = { bundlePath };
    if (status === 401) {
      throw new ImportError(
        "auth_required",
        `sync failed: ${detail}. Your local bundle is complete and unaffected: ${bundlePath}`,
        "clipy login",
        partial,
      );
    }
    if (status === 403) {
      throw new ImportError(
        "wrong_scope",
        `sync failed: ${detail}. The key is valid but lacks the ingest scope. Your local bundle is complete and unaffected: ${bundlePath}`,
        "Mint a key with the ingest scope at https://clipy.online/settings/api-keys, then re-run with it.",
        partial,
      );
    }
    if (status === 409) {
      throw new ImportError(
        "content_conflict",
        `sync failed: ${detail}. That idempotency key already points at different content — this source changed since the last import. Your local bundle is complete and unaffected: ${bundlePath}`,
        "Delete the old document in your library, or import from a fresh copy.",
        partial,
      );
    }
    if (status === 429) {
      throw new ImportError(
        "quota_exceeded",
        `sync failed: ${detail}. You have hit today's ingest quota (it resets at 00:00 UTC). Your local bundle is complete and unaffected: ${bundlePath}`,
        "Re-run after 00:00 UTC. Do not retry in a loop — it only burns the limit.",
        partial,
      );
    }
    throw new ImportError(
      "server_unreachable",
      `sync failed while uploading the transcript: ${detail}. Your local bundle is complete and unaffected: ${bundlePath}`,
      `Re-run the same command. The bundle is readable meanwhile: clipy context read ${bundlePath}`,
      partial,
    );
  }

  return {
    documentId: typeof body.id === "string" ? body.id : "",
    publicId: typeof body.publicId === "string" ? body.publicId : "",
    created: body.created !== false,
    folderName: typeof body.folderName === "string" ? body.folderName : null,
    classification: parseClassification(body.classification, compiled.manifest.durationMs),
  };
}

/** Phase 2. Frames go up as base64 in one request; the server dedupes on the
 *  sha256 we computed here, so a retried import re-uploads nothing new. */
async function uploadFrames(
  documentId: string,
  frames: ExtractedFrame[],
  opts: ImportOptions,
): Promise<{ added: number; total: number }> {
  const payload: { frames: UploadFrame[] } = {
    frames: frames.map((f) => ({
      timestampMs: f.timestampMs,
      mimeType: f.mimeType,
      base64: readFileSync(f.path).toString("base64"),
      sha256: f.sha256,
      ...(f.width ? { width: f.width } : {}),
      ...(f.height ? { height: f.height } : {}),
    })),
  };

  const { ok, status, body } = await apiPost(
    opts,
    `/api/v1/context-documents/${encodeURIComponent(documentId)}/frames`,
    payload,
  );
  if (!ok) {
    const detail = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    throw new Error(`uploading the frames failed: ${detail}`);
  }
  return {
    added: Number(body.added) || 0,
    total: Number(body.total) || 0,
  };
}

/**
 * Phase 2, end to end: get the media, cut the frames the server asked for,
 * upload them, and always let go of the borrowed video.
 *
 * Every failure here is non-fatal. The transcript bundle is already written and
 * already synced, so a missing ffmpeg or an undownloadable video costs the user
 * the pictures, not the import.
 */
async function collectFrames(
  compiled: Compiled,
  timestampsMs: number[],
  opts: ImportOptions,
): Promise<{ frames: ExtractedFrame[]; workDir: string | null; failure: string | null }> {
  let borrowed: BorrowedVideo | null = null;
  const workDir = mkdtempSync(join(tmpdir(), "clipy-frames-out-"));

  try {
    borrowed =
      compiled.media.kind === "local"
        ? borrowLocalVideo(compiled.media.path)
        : await borrowYoutubeVideo({
            ytDlpBin: compiled.media.ytDlpBin,
            url: compiled.media.url,
            durationMs: compiled.media.durationMs,
            notify,
          });

    const frames = await extractFrames({
      videoPath: borrowed.path,
      timestampsMs,
      outDir: workDir,
      notify,
    });
    notify(`Extracted ${frames.length} of ${timestampsMs.length} frames.`);
    return { frames, workDir, failure: null };
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true });
    return { frames: [], workDir: null, failure: (e as Error).message };
  } finally {
    borrowed?.release();
  }
}

export async function cmdContextImport(target: string, opts: ImportOptions): Promise<void> {
  const input = classifyInput(target);
  if (input.kind === "url") {
    throw new ImportError(
      "invalid_url",
      "direct media URLs are not supported yet.",
      `Download the file first, then: clipy context import ./<file> --transcript <file.vtt>`,
    );
  }

  let compiled =
    input.kind === "youtube" ? await compileYoutube(input.url, input.videoId, opts) : await compileLocal(input.path, opts);

  const outputDir = resolve(opts.outputDir ?? process.cwd());
  let { path: bundlePath, rewritten } = writeBundle(outputDir, compiled);

  const report = compiled.manifest.sufficiency;
  let synced: SyncResult | null = null;
  let uploadedFrames: ExtractedFrame[] = [];
  let frameUpload: { added: number; total: number } | null = null;
  // Everything that went wrong WITHOUT costing the user the import. These ride
  // out on a successful (exit 0) result — an agent must not read a missing
  // frame as a failed import.
  const warnings: ImportWarning[] = [];

  /**
   * The bundle outlives the run, and the warning envelope does not — so the
   * verdict has to be written INTO the document. "Transcript-only because the
   * words were enough" and "transcript-only because the frames failed" look
   * identical on disk otherwise.
   */
  const completenessOf = (
    classification: ServerClassification,
    /** Frames that reached the DOCUMENT — not merely the local bundle. A failed
     *  upload leaves the images on disk but the document still can't show them. */
    attachedFrames = 0,
  ): ArecCompleteness => {
    const planned = classification.needsVisual ? classification.frameTimestampsMs.length : 0;
    const missing = Math.max(0, planned - attachedFrames);
    if (missing === 0) return { status: "complete" };
    const cause = warnings[0];
    return {
      status: "incomplete",
      missingFrames: missing,
      ...(cause ? { reasonCode: cause.code, reason: cause.error } : {}),
      rerunCommand: rerunCommand(target, opts),
    };
  };

  if (opts.sync) {
    // Phase 1: the transcript bundle goes up, the verdict comes back.
    synced = await sync(compiled, opts, bundlePath);
    const classification = synced.classification;
    notify(
      `Synced ✓ — ${synced.publicId} (private${synced.folderName ? `, filed in ${synced.folderName}` : ""}).`,
    );

    if (classification) {
      const wanted = classification.frameTimestampsMs.length;
      const needs = classification.needsVisual && wanted > 0;

      // Three outcomes, not two: the server gates on whether the video needs
      // pixels at all, THEN indexes it. A yes with nothing to point at is its
      // own case — saying "the transcript stands on its own" there would
      // contradict the verdict we were just given.
      notify(
        `Classified: ${classification.videoType} (${classification.videoTypeConfidence.toFixed(2)}) — ${
          needs
            ? `${wanted} visual moment${wanted === 1 ? "" : "s"} identified`
            : classification.needsVisual
              ? "this video leans on its visuals, but no specific moment could be pinpointed — staying transcript-only"
              : "no visual moments; the transcript stands on its own"
        }`,
      );

      if (needs && !opts.frames) {
        notify(
          `Frames skipped on purpose (--no-frames): no media was downloaded and the bundle stays transcript-only.\n` +
            `  The document is already in your library; to add the ${wanted} frame${wanted === 1 ? "" : "s"} later, run:\n` +
            `    ${rerunCommand(target, opts)}`,
        );
      } else if (needs) {
        // Phase 2: fetch only the moments the server named.
        const { frames, workDir, failure } = await collectFrames(compiled, classification.frameTimestampsMs, opts);
        if (failure) {
          warnings.push({
            code: /403/.test(failure)
              ? "ytdlp_download_403"
              : /ffmpeg|ffprobe/i.test(failure)
                ? "ffmpeg_missing"
                : "frames_upload_failed",
            error: `frames could not be extracted: ${failure.split("\n")[0]}`,
            remediation: /ffmpeg|ffprobe/i.test(failure)
              ? FFMPEG_INSTALL_COMMAND
              : rerunCommand(target, opts),
          });
          // Phase 1 already succeeded — this is a PARTIAL success, and saying
          // "failed" here would send the user hunting for a document that is
          // sitting in their library right now.
          notify(
            `Frames could not be extracted, but your import is NOT lost.\n` +
              `  Created: ${synced.publicId} — transcript, summary text and the ${classification.videoType} classification are all in your library.\n` +
              `  Missing: ${classification.frameTimestampsMs.length} frame${classification.frameTimestampsMs.length === 1 ? "" : "s"} of visual evidence.\n` +
              `  Why: ${failure.split("\n").join("\n  ")}\n` +
              `  To finish it once that is sorted, re-run:\n    ${rerunCommand(target, opts)}`,
          );
        }
        try {
          if (frames.length > 0 && synced.documentId) {
            notify(`Uploading ${frames.length} frame${frames.length === 1 ? "" : "s"}…`);
            try {
              frameUpload = await uploadFrames(synced.documentId, frames, opts);
              uploadedFrames = frames;
              notify(
                `Frames attached ✓ — ${frameUpload.added} new (${frameUpload.total} on the document).`,
              );
            } catch (e) {
              warnings.push({
                code: "frames_upload_failed",
                error: `the frames were cut but ${(e as Error).message}`,
                remediation: rerunCommand(target, opts),
              });
              // Same partial-success rule as a failed extraction: the document
              // exists, only the pictures are missing.
              notify(
                `The frames were cut but ${(e as Error).message}\n` +
                  `  Your import is NOT lost: ${synced.publicId} is in your library with its transcript and classification.\n` +
                  `  The frames are also in the local bundle, so nothing was re-downloaded for nothing.\n` +
                  `  To retry just the upload, re-run:\n    ${rerunCommand(target, opts)}`,
              );
              uploadedFrames = frames;
            }
          } else if (frames.length > 0) {
            warnings.push({
              code: "frames_upload_failed",
              error: "frames were extracted but the server returned no document id, so they were not uploaded.",
              remediation: rerunCommand(target, opts),
            });
            notify("frames were extracted but the server returned no document id, so they were not uploaded.");
          }

          // Regenerate the LOCAL bundle around the verdict + the frames.
          compiled = withVisualEvidence(
            compiled,
            classification,
            uploadedFrames.map((f) => {
              const caption = captionForFrame(classification.moments, f.timestampMs);
              return {
                timestampMs: f.timestampMs,
                file: f.file,
                sha256: f.sha256,
                ...(f.width ? { width: f.width } : {}),
                ...(f.height ? { height: f.height } : {}),
                ...(caption ? { caption } : {}),
              };
            }),
            // frameUpload is set only when the server accepted them.
            completenessOf(classification, frameUpload ? uploadedFrames.length : 0),
          );
          ({ path: bundlePath } = writeBundle(outputDir, compiled, uploadedFrames));
        } finally {
          if (workDir) rmSync(workDir, { recursive: true, force: true });
        }
      }

      // Even with no frames, the verdict itself belongs in the bundle.
      if (uploadedFrames.length === 0) {
        compiled = withVisualEvidence(compiled, classification, [], completenessOf(classification));
        ({ path: bundlePath } = writeBundle(outputDir, compiled));
      }
    }
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          bundlePath,
          // The file an agent should actually open. Naming the directory alone
          // makes every caller guess at the entry point.
          contextPath: join(bundlePath, "recording.md"),
          title: compiled.manifest.title,
          profile: compiled.manifest.profile,
          recommendedProfile: report?.recommendedProfile ?? null,
          overallScore: report?.overallScore ?? null,
          gapCount: report?.gaps.length ?? 0,
          ...(synced ? { synced: true, publicId: synced.publicId } : opts.sync ? { synced: false } : {}),
          ...(synced?.folderName ? { folderName: synced.folderName } : {}),
          classification: synced?.classification ?? null,
          frames: uploadedFrames.length,
          ...(frameUpload ? { framesAdded: frameUpload.added, framesTotal: frameUpload.total } : {}),
          warnings,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  // The headline. A user who ran one command should not have to assemble "did
  // it work, and where is it" out of four key-value lines.
  process.stdout.write(`\nYour agent-ready context for ${JSON.stringify(compiled.manifest.title)} is ready.\n`);
  process.stdout.write(
    `  → local bundle: ${join(bundlePath, "recording.md")}  (point your agent here, or run: clipy context read ${bundlePath})\n`,
  );
  if (synced) {
    process.stdout.write(
      `  → in your Clipy library: filed under ${JSON.stringify(synced.folderName ?? "Knowledge Base")} — searchable, and readable by agents via MCP (read_context_document ${synced.publicId})\n`,
    );
  }
  if (warnings.length > 0) {
    process.stdout.write(
      `  → incomplete: ${warnings.map((w) => w.error).join("; ")}\n     to finish it: ${warnings[0].remediation}\n`,
    );
  }
  process.stdout.write("\n");

  process.stdout.write(`bundle: ${bundlePath}${rewritten ? " (rewritten — source content changed)" : ""}\n`);
  if (synced?.classification) {
    process.stdout.write(
      `classified: ${synced.classification.videoType} (${synced.classification.videoTypeConfidence.toFixed(2)}) · ${synced.classification.frameTimestampsMs.length} visual moment${synced.classification.frameTimestampsMs.length === 1 ? "" : "s"}\n`,
    );
  }
  process.stdout.write(
    `transcript: ${compiled.transcript.segments.length} segments from ${compiled.manifest.transcript.source}\n`,
  );
  if (report) {
    process.stdout.write(
      `sufficiency: ${report.overallScore.toFixed(2)} · recommended profile ${report.recommendedProfile} · ${report.gaps.length} visual gap${report.gaps.length === 1 ? "" : "s"}\n`,
    );
    if (report.recommendedProfile === "visual" && !opts.sync) {
      process.stdout.write(
        `note: this video leans on visuals at ${report.gaps.length} timestamps. Re-run with --sync to have the server classify it and pull the frames that matter.\n`,
      );
    }
  }
  if (uploadedFrames.length > 0) {
    process.stdout.write(
      `frames: ${uploadedFrames.length} extracted into ${bundlePath}/frames${
        frameUpload ? ` · ${frameUpload.added} new on the server (${frameUpload.total} total)` : ""
      }\n`,
    );
  }
  if (synced) {
    process.stdout.write(
      `synced: ${synced.publicId} (private — only you can read it${synced.folderName ? `, filed in ${synced.folderName}` : ""})\n`,
    );
  }
}
