// GENERATED from lib/context-core — do not edit here
/**
 * Deterministic transcript-sufficiency classifier.
 *
 * Every signal here comes from docs/research/2026-07-27-video-transcript-
 * sufficiency-study.md: 16 real YouTube videos scored by hand, whose core
 * finding is that genre does not predict whether a transcript stands alone —
 * *verbalization discipline* does. A speaker who dictates values, commands and
 * code aloud produces a self-sufficient transcript; one who defers to the
 * screen ("copy this", "the guide is in the description") does not. Both are
 * detectable from text alone with cheap regexes, per window, with no model.
 */

import type {
  NormalizedTranscript,
  SufficiencyReport,
  SufficiencyWindow,
  VisualGap,
  VisualGapReason,
} from './types.js';

const DEFAULT_WINDOW_MS = 300_000;

/** How far past a deictic phrase a literal value redeems it (~5 tokens). */
const REDEMPTION_CHARS = 45;

const EXCERPT_PAD = 40;

/** Deixis that points at the screen rather than naming what it points at. */
const DEICTIC =
  /\b(?:copy (?:this|that)|paste (?:it|that|this)|right here|over here|like this|as you can see|click (?:on )?(?:this|here)|let me show you|this one here|this right here|down here|up here)\b/gi;

/**
 * Literal values a listener could act on without seeing the screen: numbers
 * with units, hex colours, spoken code syntax, dotted identifiers, flags.
 */
const VALUE_TOKEN =
  /\b\d+(?:\.\d+)?\s?(?:px|%|em|rem|ms|s|mb|gb|kb)\b|#[0-9a-f]{3,8}\b|\b(?:const|let|var|function|return|import|export|async|await|interface|class)\b|=>|\bnpm |\bnpx |\bsudo |\bgit |\bdocker |\bcurl |--[a-z][a-z-]+|\b[a-z_][\w-]*\.[a-z_][\w-]{1,}\b|\b\d+(?:\.\d+){1,}\b/gi;

const EXTERNAL_REFERENCE =
  /\b(?:in the description|linked below|link (?:is )?below|download the (?:guide|file|template|repo)|check my course|grab the (?:file|template))\b/gi;

const DASHBOARD_VOCAB =
  /\b(?:dropdown|drop down|panel|dashboard|click continue|select your plan|sidebar|toolbar|tab)\b/gi;

const RECAP =
  /\b(?:let'?s recap|to recap|to summari[sz]e|in summary|what we learned|so to review)\b/gi;

/**
 * ASR mangles shell commands ("pseudo mpm install d gpm2" = `sudo npm install
 * -g pm2`). Where one is being spoken, a frame is worth having even though the
 * transcript nominally "contains" the command.
 */
const GARBLED_COMMAND =
  /\b(?:pseudo|p ?s ?e ?u ?d ?o|mpm install|npm install d |engine ?x|yuntu|get clone)\b/gi;

interface WindowSlice {
  startMs: number;
  endMs: number;
  text: string;
  /** Start offset of each segment inside `text`, parallel to `offsetMs`. */
  offsets: number[];
  offsetMs: number[];
}

function sliceWindows(
  t: NormalizedTranscript,
  windowMs: number
): WindowSlice[] {
  const slices: WindowSlice[] = [];
  for (const seg of t.segments) {
    const index = Math.floor(seg.startMs / windowMs);
    let slice = slices[slices.length - 1];
    if (!slice || slice.startMs !== index * windowMs) {
      slice = {
        startMs: index * windowMs,
        endMs: (index + 1) * windowMs,
        text: '',
        offsets: [],
        offsetMs: [],
      };
      slices.push(slice);
    }
    if (slice.text) slice.text += ' ';
    slice.offsets.push(slice.text.length);
    slice.offsetMs.push(seg.startMs);
    slice.text += seg.text;
    slice.endMs = Math.max(slice.endMs, seg.endMs);
  }
  return slices;
}

function timestampAt(slice: WindowSlice, offset: number): number {
  let ms = slice.offsetMs[0] ?? slice.startMs;
  for (let i = 0; i < slice.offsets.length; i += 1) {
    if (slice.offsets[i] > offset) break;
    ms = slice.offsetMs[i];
  }
  return ms;
}

function excerptAt(text: string, start: number, end: number): string {
  return text
    .slice(Math.max(0, start - EXCERPT_PAD), Math.min(text.length, end + EXCERPT_PAD))
    .trim();
}

function matches(re: RegExp, text: string): { index: number; length: number }[] {
  const out: { index: number; length: number }[] = [];
  re.lastIndex = 0;
  let m = re.exec(text);
  while (m) {
    out.push({ index: m.index, length: m[0].length });
    if (m.index === re.lastIndex) re.lastIndex += 1;
    m = re.exec(text);
  }
  return out;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export interface ClassifyOptions {
  windowMs?: number;
}

/**
 * Thresholds below are calibrated against the study corpus (scripts/context-
 * core/selftest.ts asserts the direction on the real transcripts): podcasts and
 * rhetorical talks must land on 'transcript'; the dashboard-heavy VPS deploy
 * walkthrough ("copy this", "guide in the description") must land on 'visual'.
 */
const PENALTY_PER_BARE_DEIXIS = 0.055;
const PENALTY_PER_EXTERNAL_REF = 0.14;
const PENALTY_PER_GARBLED = 0.05;
const PENALTY_DASHBOARD_DENSITY = 0.9;
const REDEEM_PER_VALUE_TOKEN = 0.02;
const REDEEM_CAP = 0.2;
const RECAP_BONUS = 0.08;

const PROFILE_OVERALL_FLOOR = 0.55;
const PROFILE_WINDOW_FLOOR = 0.35;

export function classifyTranscript(
  t: NormalizedTranscript,
  opts: ClassifyOptions = {}
): SufficiencyReport {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const slices = sliceWindows(t, windowMs);

  if (slices.length === 0) {
    return {
      overallScore: 0,
      recommendedProfile: 'visual',
      windows: [],
      gaps: [
        {
          timestampMs: 0,
          reason: 'no_speech',
          excerpt: '',
        },
      ],
    };
  }

  const windows: SufficiencyWindow[] = [];
  const gaps: VisualGap[] = [];

  const pushGap = (
    timestampMs: number,
    reason: VisualGapReason,
    excerpt: string
  ) => {
    const last = gaps[gaps.length - 1];
    // A cluster of "copy this … paste this" inside a few seconds is one gap.
    if (last && last.reason === reason && timestampMs - last.timestampMs < 15_000) {
      return;
    }
    gaps.push({ timestampMs, reason, excerpt });
  };

  for (const slice of slices) {
    const words = slice.text.split(/\s+/).filter(Boolean).length;
    if (words === 0) continue;

    const valueTokens = matches(VALUE_TOKEN, slice.text);
    const deictics = matches(DEICTIC, slice.text);
    const externals = matches(EXTERNAL_REFERENCE, slice.text);
    const dashboards = matches(DASHBOARD_VOCAB, slice.text);
    const recaps = matches(RECAP, slice.text);
    const garbled = matches(GARBLED_COMMAND, slice.text);

    const bare = deictics.filter((d) => {
      const end = d.index + d.length;
      const lookahead = slice.text.slice(end, end + REDEMPTION_CHARS);
      return !matches(VALUE_TOKEN, lookahead).length;
    });

    const per1k = 1000 / words;
    const valueDensity = valueTokens.length * per1k;
    const deicticDensity = bare.length * per1k;
    const dashboardDensity = dashboards.length * per1k;

    // Capped deliberately: dictated values redeem a window that also contains
    // some deixis, but must not be able to fully mask a window that is mostly
    // "copy this" — the study's finding is that both can coexist in one window.
    const redemption = Math.min(REDEEM_CAP, valueDensity * REDEEM_PER_VALUE_TOKEN);
    let score =
      1 +
      redemption +
      (recaps.length > 0 ? RECAP_BONUS : 0) -
      deicticDensity * PENALTY_PER_BARE_DEIXIS -
      externals.length * per1k * PENALTY_PER_EXTERNAL_REF -
      garbled.length * per1k * PENALTY_PER_GARBLED -
      clamp01(dashboardDensity / 20) * PENALTY_DASHBOARD_DENSITY;
    score = clamp01(score);

    const signals: string[] = [];
    if (bare.length) signals.push(`bare_deixis:${bare.length}`);
    if (valueTokens.length) signals.push(`value_tokens:${valueTokens.length}`);
    if (externals.length) signals.push(`external_reference:${externals.length}`);
    if (dashboards.length) signals.push(`dashboard_vocab:${dashboards.length}`);
    if (recaps.length) signals.push(`recap:${recaps.length}`);
    if (garbled.length) signals.push(`garbled_command:${garbled.length}`);

    windows.push({
      startMs: slice.startMs,
      endMs: slice.endMs,
      score,
      deicticCount: bare.length,
      valueTokenCount: valueTokens.length,
      signals,
    });

    const flagged: { index: number; length: number; reason: VisualGapReason }[] = [
      ...bare.map((m) => ({ ...m, reason: 'bare_deixis' as const })),
      ...externals.map((m) => ({ ...m, reason: 'external_reference' as const })),
      ...garbled.map((m) => ({ ...m, reason: 'garbled_command' as const })),
    ].sort((a, b) => a.index - b.index);

    for (const hit of flagged) {
      pushGap(
        timestampAt(slice, hit.index),
        hit.reason,
        excerptAt(slice.text, hit.index, hit.index + hit.length)
      );
    }

    // Dashboard vocabulary only earns a gap when it dominates the window; the
    // word "tab" in passing is not evidence of a screen-bound step.
    if (dashboardDensity >= 8 && dashboards.length >= 3) {
      const hit = dashboards[0];
      pushGap(
        timestampAt(slice, hit.index),
        'dashboard_ui',
        excerptAt(slice.text, hit.index, hit.index + hit.length)
      );
    }
  }

  const totalMs = windows.reduce((sum, w) => sum + (w.endMs - w.startMs), 0);
  const overallScore =
    totalMs > 0
      ? windows.reduce((sum, w) => sum + w.score * (w.endMs - w.startMs), 0) / totalMs
      : 0;

  const worst = windows.reduce((min, w) => Math.min(min, w.score), 1);
  const recommendedProfile =
    overallScore < PROFILE_OVERALL_FLOOR || worst < PROFILE_WINDOW_FLOOR
      ? 'visual'
      : 'transcript';

  return {
    overallScore: Math.round(overallScore * 1000) / 1000,
    recommendedProfile,
    windows,
    gaps: gaps.sort((a, b) => a.timestampMs - b.timestampMs),
  };
}
