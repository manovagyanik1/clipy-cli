// GENERATED from lib/context-core — do not edit here
/**
 * The frozen contract for the Clipy context bundle ("any video → agent
 * context").
 *
 * This module — and everything else in lib/context-core — is consumed by three
 * separate builds: the Next.js server, the Chrome extension (Vite) and the CLI
 * (plain tsc, which copies this directory verbatim). It therefore has zero
 * runtime dependencies, imports nothing from node builtins or the rest of the
 * repo, and never touches `process`/`Buffer`. Hashing is always injected or
 * caller-provided.
 */

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export type TranscriptSource =
  | 'creator_captions'
  | 'auto_captions'
  | 'user_file'
  | 'local_stt';

export interface NormalizedTranscript {
  language?: string;
  source: TranscriptSource;
  segments: TranscriptSegment[];
  plaintext: string;
}

export type ContextProfile = 'transcript' | 'visual';

export interface SufficiencyWindow {
  startMs: number;
  endMs: number;
  /** 0 = transcript is blind here, 1 = transcript fully stands alone. */
  score: number;
  deicticCount: number;
  valueTokenCount: number;
  signals: string[];
}

export type VisualGapReason =
  | 'bare_deixis'
  | 'external_reference'
  | 'dashboard_ui'
  | 'garbled_command'
  | 'no_speech';

export interface VisualGap {
  timestampMs: number;
  reason: VisualGapReason;
  excerpt: string;
}

export interface SufficiencyReport {
  overallScore: number;
  recommendedProfile: ContextProfile;
  windows: SufficiencyWindow[];
  gaps: VisualGap[];
}

export interface ContextSource {
  kind: 'youtube' | 'local' | 'url';
  canonicalUrl?: string;
  providerId?: string;
  contentHash?: string;
  /**
   * Basename only, for `kind: 'local'`. Never a directory or an absolute path —
   * the bundle and the upload payload must not leak the user's filesystem
   * layout. Producers are responsible for stripping the directory.
   */
  fileName?: string;
}

/**
 * The server's verdict on a synced bundle. The CLI never classifies locally;
 * this block is only present after a sync round-trip, and its absence means
 * "not classified yet", not "transcript is sufficient".
 */
export interface PlannedMoment {
  tMs: number;
  caption: string;
}

export interface ServerClassification {
  videoType: string;
  videoTypeConfidence: number;
  needsVisual: boolean;
  visualReason?: string;
  frameTimestampsMs: number[];
  /** What the server's planner says is happening at each timestamp. Frames are
   *  cut for these moments, so a frame's caption comes from here. */
  moments?: PlannedMoment[];
  model?: string;
}

export interface ManifestFrame {
  timestampMs: number;
  file: string;
  sha256: string;
  width?: number;
  height?: number;
  /** The planned moment this frame was cut for, when one matched. */
  caption?: string;
}

export interface ArecManifest {
  bundleVersion: 1;
  arecVersion: '0.2-draft';
  title: string;
  source: ContextSource;
  durationMs: number;
  language?: string;
  profile: ContextProfile;
  compiler: { name: string; version: string };
  transcript: { source: TranscriptSource; segmentCount: number };
  sufficiency?: SufficiencyReport;
  serverClassification?: ServerClassification;
  frames?: ManifestFrame[];
  createdAt: string;
}

export interface UploadFrame {
  timestampMs: number;
  mimeType: string;
  base64: string;
  sha256: string;
  width?: number;
  height?: number;
}

export interface UploadContextPayload {
  idempotencyKey: string;
  manifest: ArecManifest;
  arecMarkdown: string;
  transcript: NormalizedTranscript;
  tags?: string[];
  folderName?: string;
  frames?: UploadFrame[];
}
