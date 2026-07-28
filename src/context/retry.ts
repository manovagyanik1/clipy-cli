/**
 * Which yt-dlp failures are worth trying again.
 *
 * YouTube hands out media URLs that expire, and it throttles bursts. Both show
 * up as an HTTP 403 on a command that succeeds verbatim a few seconds later —
 * so a single attempt turns a hiccup into "frames could not be extracted".
 * Against that, a genuinely unavailable video must fail on the first try:
 * retrying a private video three times just makes the user wait longer for the
 * same answer.
 */

export type FailureKind =
  /** Expired media URL or throttling. Retry, and if it persists it is worth
   *  trying a different innertube client. */
  | "forbidden"
  /** Server-side or network flakiness. Retry, but the client trick won't help. */
  | "transient"
  /** The video is what it is. Retrying changes nothing. */
  | "fatal";

/**
 * Failures no client change or retry can fix. Checked FIRST, ahead of the 403
 * test, because YouTube sometimes wraps these in a 403 — and retrying a bot
 * check or an age gate burns the user's IP reputation for nothing.
 */
const FATAL_MARKERS = [
  /Sign in to confirm you.?re not a bot/i,
  /Sign in to confirm your age/i,
  /This video is unavailable/i,
  /Video unavailable/i,
  /Private video/i,
  /members-only/i,
  /age.?restricted/i,
];

const FORBIDDEN = /HTTP Error 403|\b403 Forbidden\b/i;
const TRANSIENT = [
  /HTTP Error 5\d\d/i,
  /HTTP Error 429/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /connection reset/i,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/,
  /temporary failure/i,
  /unable to connect/i,
  /remote end closed connection/i,
];

/**
 * Classifies yt-dlp's stderr. Only ever called on yt-dlp's OWN output — our
 * local aborts (the size ceiling, our 20-minute cap) are fatal by construction
 * and must not be routed through here, or a slow link would be retried for an
 * hour.
 */
export function classifyFailure(stderr: string): FailureKind {
  if (FATAL_MARKERS.some((re) => re.test(stderr))) return "fatal";
  if (FORBIDDEN.test(stderr)) return "forbidden";
  if (TRANSIENT.some((re) => re.test(stderr))) return "transient";
  return "fatal";
}

export function isRetriable(kind: FailureKind): boolean {
  return kind !== "fatal";
}

/**
 * A stale binary and a transient 403 look nothing alike once you know where to
 * look: a 403 fails mid-transfer with formats already resolved, while an
 * outdated yt-dlp fails during EXTRACTION — it cannot solve the signature
 * challenge or is being forced onto SABR. Only the second is fixed by updating,
 * so only the second should suggest it.
 */
const STALE_BINARY_MARKERS = [
  /unable to extract/i,
  /Only images are available/i,
  /Signature extraction failed/i,
  /n challenge/i,
  /nsig extraction failed/i,
  /forcing SABR/i,
  /Requested format is not available/i,
  /no video formats found/i,
];

export function looksLikeStaleBinary(stderr: string): boolean {
  return STALE_BINARY_MARKERS.some((re) => re.test(stderr));
}

/** How a retry is announced, so every caller says it the same way. */
export function retryNotice(stderr: string, kind: FailureKind, attempt: number, total: number): string {
  const what =
    kind === "forbidden"
      ? "Download blocked (HTTP 403)"
      : `Download failed (${firstUsefulLine(stderr)})`;
  return `${what} — retrying (${attempt}/${total})…`;
}

function firstUsefulLine(stderr: string): string {
  const line = stderr.trim().split("\n").filter(Boolean).pop() ?? "unknown error";
  return line.replace(/^ERROR:\s*/i, "").slice(0, 120);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Backoff between attempts 1→2 and 2→3. The observed recovery window for an
 *  expired media URL is "a minute later", so these are deliberately unhurried. */
export const RETRY_BACKOFF_MS = [3_000, 8_000];
export const MAX_ATTEMPTS = 3;

/**
 * On every attempt. Letting yt-dlp retry a mid-transfer 403 in-process is far
 * cheaper than re-running the binary, and pacing the extraction burst is what
 * keeps a residential IP from reading as automation. Concurrency stays at 1 —
 * we fetch one bounded rendition once, so there is nothing to win by raising it
 * and a rate-limit to lose.
 */
export const BASELINE_DOWNLOAD_ARGS = [
  "--retries", "5",
  "--fragment-retries", "5",
  "--extractor-retries", "3",
  "--retry-sleep", "http:exp=1:30",
  "--retry-sleep", "fragment:exp=1:30",
  "--sleep-requests", "0.75",
  "--concurrent-fragments", "1",
];

/**
 * The client fallback, used only after the defaults have failed repeatedly.
 *
 * These three need no PO token and (for tv/android_vr) no JS runtime, unlike
 * `android`, which is PO-token-gated and is NOT in yt-dlp's default set —
 * falling back to it moves away from token-free clients rather than toward
 * them. See docs/research/2026-07-29-ytdlp-403-fallbacks.md §2.
 */
export const TOKEN_FREE_CLIENT_ARGS = [
  "--extractor-args",
  "youtube:player_client=tv,android_vr,web_embedded",
];

/**
 * Last resort: a pre-muxed progressive file is served as one conventional HTTP
 * download, sidestepping both adaptive-fragment 403s and SABR. Format 18 is
 * 360p — worse than our 720p target, and far better than no frames at all.
 */
export const PROGRESSIVE_FALLBACK = {
  format: "b[height<=720]/18",
  extraArgs: ["--extractor-args", "youtube:player_client=tv,android_vr"],
};

export const DEFAULT_FORMAT = "bv*[height<=720]/b[height<=720]";
