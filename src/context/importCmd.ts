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
import { fetchCaptions, fetchVideoMeta, resolveYtDlp } from "./ytdlp.js";
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

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

type Input =
  | { kind: "youtube"; url: string }
  | { kind: "local"; path: string }
  | { kind: "url"; url: string };

function classifyInput(raw: string): Input {
  const trimmed = raw.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }

  if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    const host = parsed.hostname.toLowerCase();
    if (YOUTUBE_HOSTS.has(host)) return { kind: "youtube", url: trimmed };
    return { kind: "url", url: trimmed };
  }

  const path = resolve(trimmed);
  if (existsSync(path) && statSync(path).isFile()) return { kind: "local", path };

  throw new Error(
    `could not read "${raw}" — pass a YouTube URL or the path to a local video file.`,
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
    throw new Error(
      `--transcript ${path} is neither .vtt/.srt nor valid JSON. Supported: WebVTT, SubRip, or Clipy transcript JSON ({"segments":[{"startMs","endMs","text"}]}).`,
    );
  }

  // json3 (YouTube) and Clipy transcript JSON both land here.
  const json3 = parseYoutubeJson3(parsed);
  if (json3.length > 0) return json3;

  const raw = (parsed as ClipyTranscriptJson).segments;
  if (!Array.isArray(raw)) {
    throw new Error(`--transcript ${path} has no usable segments.`);
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
  if (segments.length === 0) throw new Error(`--transcript ${path} has no usable segments.`);
  return segments;
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

async function compileYoutube(url: string, opts: ImportOptions): Promise<Compiled> {
  const bin = await resolveYtDlp(notify);
  notify("Fetching video info…");
  const meta = await fetchVideoMeta(bin, url);
  notify(`Found: "${meta.title}" (${fmtClock(meta.durationMs)})`);
  const langPref = opts.language ?? meta.language ?? "en";

  notify(`Downloading captions (${langPref})…`);
  const captions = await fetchCaptions(bin, url, meta, langPref);
  if (!captions) {
    const available = [...new Set([...meta.subtitleLangs, ...meta.autoCaptionLangs])];
    if (available.length > 0) {
      throw new Error(
        `this video has no captions in "${langPref}". Re-run with --language <code> (e.g. --language ${available.includes("en") ? "en" : available[0]}).`,
      );
    }
    throw new Error(
      "this video has no captions (neither creator-provided nor auto-generated).\n" +
        "  Supply your own with --transcript <file.vtt|file.srt|transcript.json>.\n" +
        "  Local speech-to-text for caption-less videos lands in a future release.",
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
  notify(
    `Got ${transcript.segments.length} caption segments (${
      captions.source === "creator_captions" ? "creator-provided" : "auto-generated"
    }, ${captions.language}).`,
  );

  const source: ContextSource = {
    kind: "youtube",
    ...(meta.id ? { canonicalUrl: `https://www.youtube.com/watch?v=${meta.id}`, providerId: meta.id } : {}),
  };

  return finish({
    title: opts.title ?? meta.title,
    source,
    durationMs: meta.durationMs,
    transcript,
    fingerprint: `youtube:${meta.id || url}`,
    media: { kind: "youtube", url, ytDlpBin: bin, durationMs: meta.durationMs },
    opts,
  });
}

async function compileLocal(path: string, opts: ImportOptions): Promise<Compiled> {
  if (!opts.transcriptPath) {
    throw new Error(
      `local files need a transcript: pass --transcript <file.vtt|file.srt|transcript.json>.\n` +
        "  Local speech-to-text lands in a future release.",
    );
  }
  const transcriptPath = resolve(opts.transcriptPath);
  if (!existsSync(transcriptPath)) throw new Error(`--transcript ${transcriptPath} does not exist.`);

  notify(`Probing ${basename(path)} with ffprobe…`);
  const probe = await probeVideo(path);
  const contentHash = sha256File(path);
  notify(`Reading the transcript from ${basename(transcriptPath)}…`);
  const segments = parseTranscriptFile(transcriptPath);
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
): Compiled {
  const manifest: ArecManifest = {
    ...compiled.manifest,
    profile: frames.length > 0 ? "visual" : compiled.manifest.profile,
    serverClassification: classification,
    ...(frames.length > 0 ? { frames } : {}),
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
    throw new Error(
      `--sync needs an API key. Run \`clipy login\` (or set CLIPY_API_KEY), then re-run.\n` +
        `  Nothing was lost: the local bundle is already written to ${bundlePath}.`,
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
    const intact = `Your local bundle is complete and unaffected: ${bundlePath}`;
    if (status === 401) {
      throw new Error(
        `sync failed while uploading the transcript: ${detail}\n` +
          `  Run \`clipy login\` to set a new key, then re-run.\n  ${intact}`,
      );
    }
    if (status === 409) {
      throw new Error(
        `sync failed while uploading the transcript: ${detail}\n` +
          `  That idempotency key already points at different content — this source changed since the last import.\n` +
          `  Delete the old document in your library, or import from a fresh copy.\n  ${intact}`,
      );
    }
    if (status === 429) {
      throw new Error(
        `sync failed while uploading the transcript: ${detail}\n` +
          `  You have hit today's ingest quota (it resets at 00:00 UTC). Re-run then.\n  ${intact}`,
      );
    }
    throw new Error(`sync failed while uploading the transcript: ${detail}\n  ${intact}`);
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
    throw new Error(
      "direct media URLs are not supported yet — pass a YouTube URL or download the file first and import it locally.",
    );
  }

  let compiled =
    input.kind === "youtube" ? await compileYoutube(input.url, opts) : await compileLocal(input.path, opts);

  const outputDir = resolve(opts.outputDir ?? process.cwd());
  let { path: bundlePath, rewritten } = writeBundle(outputDir, compiled);

  const report = compiled.manifest.sufficiency;
  let synced: SyncResult | null = null;
  let uploadedFrames: ExtractedFrame[] = [];
  let frameUpload: { added: number; total: number } | null = null;

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
          );
          ({ path: bundlePath } = writeBundle(outputDir, compiled, uploadedFrames));
        } finally {
          if (workDir) rmSync(workDir, { recursive: true, force: true });
        }
      }

      // Even with no frames, the verdict itself belongs in the bundle.
      if (uploadedFrames.length === 0) {
        compiled = withVisualEvidence(compiled, classification, []);
        ({ path: bundlePath } = writeBundle(outputDir, compiled));
      }
    }
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          bundlePath,
          profile: compiled.manifest.profile,
          recommendedProfile: report?.recommendedProfile ?? null,
          overallScore: report?.overallScore ?? null,
          gapCount: report?.gaps.length ?? 0,
          ...(synced ? { synced: true, publicId: synced.publicId } : opts.sync ? { synced: false } : {}),
          classification: synced?.classification ?? null,
          frames: uploadedFrames.length,
          ...(frameUpload ? { framesAdded: frameUpload.added, framesTotal: frameUpload.total } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

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
  process.stdout.write(`next: clipy context read ${bundlePath}\n`);
}
