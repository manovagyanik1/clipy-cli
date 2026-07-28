// GENERATED from lib/context-core — do not edit here
/**
 * Caption parsers. Every one produces raw `TranscriptSegment[]`; run the
 * result through `normalizeSegments` (or `buildNormalizedTranscript`) before
 * anything else consumes it.
 */

import type {
  NormalizedTranscript,
  TranscriptSegment,
  TranscriptSource,
} from './types.js';

/** Shortest fragment worth keeping on its own; anything below merges. */
const MIN_SEGMENT_MS = 300;

const TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function parseTimestamp(raw: string): number | null {
  const m = TIMESTAMP.exec(raw.trim());
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number(m[4].padEnd(3, '0'));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** Strips inline karaoke markup (`<c>`, `<00:00:01.000>`) and entities. */
function cleanCueText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * YouTube auto-captions ship a rolling window: each cue repeats the tail of the
 * previous one and appends a new line. Emitting them verbatim triples the
 * transcript, so a cue that merely re-states what we already emitted is
 * trimmed to its new remainder (and dropped entirely if there is none).
 */
function dedupeRolling(text: string, previous: string): string {
  if (!text) return '';
  if (!previous) return text;
  if (text === previous) return '';
  if (text.startsWith(previous)) return text.slice(previous.length).trim();
  if (previous.endsWith(text)) return '';

  // Partial overlap: the longest suffix of `previous` that prefixes `text`.
  const max = Math.min(previous.length, text.length);
  for (let len = max; len >= 8; len -= 1) {
    if (previous.endsWith(text.slice(0, len))) return text.slice(len).trim();
  }
  return text;
}

export function parseVtt(text: string): TranscriptSegment[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const segments: TranscriptSegment[] = [];
  let previous = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('-->')) continue;

    const [rawStart, rawRest] = line.split('-->');
    const startMs = parseTimestamp(rawStart);
    // Cue settings (align:, position:, …) trail the end timestamp.
    const endMs = parseTimestamp(rawRest ?? '');
    if (startMs === null || endMs === null) continue;

    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim() || next.includes('-->')) break;
      body.push(next);
    }
    i = j - 1;

    const cleaned = cleanCueText(body.join(' '));
    const deduped = dedupeRolling(cleaned, previous);
    if (cleaned) previous = cleaned;
    if (!deduped) continue;

    segments.push({ startMs, endMs, text: deduped });
  }

  return segments;
}

export function parseSrt(text: string): TranscriptSegment[] {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  const segments: TranscriptSegment[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;

    const [rawStart, rawEnd] = lines[timingIndex].split('-->');
    const startMs = parseTimestamp(rawStart);
    const endMs = parseTimestamp(rawEnd ?? '');
    if (startMs === null || endMs === null) continue;

    const body = cleanCueText(lines.slice(timingIndex + 1).join(' '));
    if (!body) continue;
    segments.push({ startMs, endMs, text: body });
  }

  return segments;
}

interface Json3Seg {
  utf8?: unknown;
}
interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: unknown;
}

export function parseYoutubeJson3(json: unknown): TranscriptSegment[] {
  if (!json || typeof json !== 'object') return [];
  const events = (json as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];

  const segments: TranscriptSegment[] = [];
  for (const raw of events as Json3Event[]) {
    if (!raw || typeof raw !== 'object') continue;
    const startMs = Number(raw.tStartMs);
    if (!Number.isFinite(startMs)) continue;
    const durationMs = Number(raw.dDurationMs);
    if (!Array.isArray(raw.segs)) continue;

    const body = cleanCueText(
      (raw.segs as Json3Seg[])
        .map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : ''))
        .join('')
    );
    // Newline-only events are paragraph breaks, not speech.
    if (!body) continue;

    segments.push({
      startMs,
      endMs: startMs + (Number.isFinite(durationMs) ? durationMs : 0),
      text: body,
    });
  }

  return segments;
}

export interface NormalizeOptions {
  durationMs?: number;
}

export interface NormalizeResult {
  segments: TranscriptSegment[];
  plaintext: string;
}

export function normalizeSegments(
  segments: TranscriptSegment[],
  opts: NormalizeOptions = {}
): NormalizeResult {
  const duration = opts.durationMs;

  const cleaned = segments
    .map((seg) => ({
      startMs: Math.max(0, Math.round(seg.startMs)),
      endMs: Math.max(0, Math.round(seg.endMs)),
      text: seg.text.replace(/\s+/g, ' ').trim(),
    }))
    .filter((seg) => seg.text.length > 0)
    .map((seg) => {
      const startMs = duration ? Math.min(seg.startMs, duration) : seg.startMs;
      let endMs = duration ? Math.min(seg.endMs, duration) : seg.endMs;
      if (endMs < startMs) endMs = startMs;
      return { startMs, endMs, text: seg.text };
    })
    .sort((a, b) => a.startMs - b.startMs);

  const merged: TranscriptSegment[] = [];
  for (const seg of cleaned) {
    const previous = merged[merged.length - 1];
    const tiny = seg.endMs - seg.startMs < MIN_SEGMENT_MS;
    // Only fold a fragment into a neighbour it actually abuts — merging across
    // a gap would attribute speech to a timestamp where none happened.
    if (previous && tiny && seg.startMs - previous.endMs <= MIN_SEGMENT_MS) {
      merged[merged.length - 1] = {
        startMs: previous.startMs,
        endMs: Math.max(previous.endMs, seg.endMs),
        text: `${previous.text} ${seg.text}`,
      };
      continue;
    }
    merged.push(seg);
  }

  return {
    segments: merged,
    plaintext: merged.map((s) => s.text).join(' ').trim(),
  };
}

export function buildNormalizedTranscript(
  segments: TranscriptSegment[],
  opts: { language?: string; source: TranscriptSource; durationMs?: number }
): NormalizedTranscript {
  const { segments: normalized, plaintext } = normalizeSegments(segments, {
    durationMs: opts.durationMs,
  });
  return {
    ...(opts.language ? { language: opts.language } : {}),
    source: opts.source,
    segments: normalized,
    plaintext,
  };
}
