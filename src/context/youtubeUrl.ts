/**
 * YouTube URL → video id, tolerantly.
 *
 * The motivating failure: zsh users copy a URL and escape it, so the CLI is
 * handed `https://www.youtube.com/watch\?v\=77FB-LS0Bjk` with literal
 * backslashes. Passed through verbatim, yt-dlp does not error on that — it
 * resolves it to a placeholder video ("Press Subscribe to continue", 0:00) and
 * the user gets a bundle for a video they never asked for. So nothing raw ever
 * reaches yt-dlp: we extract the id and rebuild the canonical URL ourselves.
 */

/** YouTube ids are exactly 11 chars of base64url. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Shell escaping and stray whitespace are noise, never meaning, in a URL. */
function deEscape(raw: string): string {
  return raw.trim().replace(/\\/g, "").replace(/\s+/g, "");
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
]);

/** The path forms that carry the id as their first segment. */
const PATH_PREFIXES = ["shorts", "live", "embed", "v"];

export function isYoutubeHost(host: string): boolean {
  return YOUTUBE_HOSTS.has(host.toLowerCase());
}

/**
 * Returns the 11-char video id, or null if this is not a recognisable
 * single-video YouTube URL (a channel, a playlist-only link, or garbage).
 */
export function parseYoutubeId(raw: string): string | null {
  const cleaned = deEscape(raw);

  let url: URL | null = null;
  try {
    url = new URL(cleaned);
  } catch {
    url = null;
  }

  if (url && isYoutubeHost(url.hostname)) {
    const v = url.searchParams.get("v");
    if (v && VIDEO_ID.test(v)) return v;

    const segments = url.pathname.split("/").filter(Boolean);
    if (url.hostname.toLowerCase().endsWith("youtu.be")) {
      if (segments[0] && VIDEO_ID.test(segments[0])) return segments[0];
    }
    if (segments.length >= 2 && PATH_PREFIXES.includes(segments[0].toLowerCase())) {
      if (VIDEO_ID.test(segments[1])) return segments[1];
    }
  }

  // Last resort for input too mangled to parse as a URL at all (a lost scheme,
  // a doubled query separator). Anchored on the YouTube-specific markers so a
  // random 11-char word in an unrelated string can never match.
  const loose =
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(
      cleaned,
    );
  return loose ? loose[1] : null;
}

/** The one URL shape every yt-dlp call and every manifest uses. */
export function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
