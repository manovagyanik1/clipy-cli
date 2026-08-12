// GENERATED from lib/context-core — do not edit here
/**
 * Loom share links → title, duration and transcript, over plain HTTPS.
 *
 * Loom publishes both of these free and unauthenticated for a public share
 * link, so the transcript half of a Loom import needs no yt-dlp, no ffmpeg and
 * no browser — two fetches and the bundle compiles. yt-dlp is only reached for
 * later on, and only if the server asks for frames.
 *
 * Everything that comes back is somebody else's content. Loom's own share page
 * embeds instructions aimed at AI agents, so this surface is hostile input by
 * default: titles and transcript text are returned as bounded DATA, never
 * interpolated into a command, a path, or a prompt. Fencing them for an agent is
 * the caller's job, and the caller must use an existing warning rather than
 * writing one: `renderArecMarkdown` in ./arec for an AREC bundle, the
 * `instructions` block in app/api/agent-context/_shared.ts for that JSON shape.
 *
 * Shared by construction. This lives in context-core because the CLI, the
 * Next.js server and the Chrome extension all consume this directory, and two
 * independent Loom fetchers would drift. That constrains it: zero runtime
 * dependencies, no node builtins, and NO `process` — the extension bundles this
 * through Vite, where `process` does not exist. The origin override is therefore
 * injected by the caller rather than read from the environment here.
 */

/** Loom ids are exactly 32 hex chars. Same shape the web app validates. */
const LOOM_ID = /^[a-f0-9]{32}$/i;

const LOOM_HOSTS = new Set(["loom.com", "www.loom.com"]);

const DEFAULT_ORIGIN = "https://www.loom.com";

export interface LoomFetchOptions {
  /**
   * Points the whole provider at a different origin, so a test can stand in for
   * Loom without a network round trip. The CDN allowlist follows it (see
   * `assertFetchableCaptionUrl`); overriding the origin moves the allowlist and
   * never removes it.
   */
  origin?: string;
  /**
   * Per-request ceiling, in ms. Defaults to 30s, which suits a batch caller
   * where waiting beats failing.
   *
   * Interactive callers should set this far lower. Loom throttles repeated
   * calls by STALLING rather than refusing, so a throttled request does not
   * come back fast with an error, it hangs until this fires: a measured
   * 30,352ms request was this timeout, not a slow response. On a page that
   * promises an answer in seconds, a 30s spinner ending in "Loom is
   * unreachable" is worse than failing at 8s.
   *
   * Non-finite or non-positive values fall back to the default rather than
   * aborting instantly.
   */
  timeoutMs?: number;
}

function resolveOrigin(opts: LoomFetchOptions | undefined): string {
  return (opts?.origin || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

function resolveTimeout(opts: LoomFetchOptions | undefined): number {
  const requested = opts?.timeoutMs;
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : DEFAULT_TIMEOUT_MS;
}

/** Loom's GraphQL rejects a plain fetch UA. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** Batch-caller default. Overridable per call via `LoomFetchOptions.timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** A transcript is text. Anything past this is not one, and we will not buffer it. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** Loom caps a phrase at roughly a sentence; this is far past any real recording. */
const MAX_PHRASES = 20_000;

export function isLoomHost(host: string): boolean {
  return LOOM_HOSTS.has(host.toLowerCase());
}

/** Shell escaping and stray whitespace are noise, never meaning, in a URL. */
function deEscape(raw: string): string {
  return raw.trim().replace(/\\/g, "").replace(/\s+/g, "");
}

/**
 * The 32-hex video id, or null when this is not a single-video Loom link.
 * `/share/<id>` and `/embed/<id>` are the two forms Loom hands out; folder and
 * workspace URLs deliberately do not match.
 */
export function parseLoomId(raw: string): string | null {
  const cleaned = deEscape(raw);

  let url: URL | null = null;
  try {
    url = new URL(cleaned);
  } catch {
    url = null;
  }

  if (url && isLoomHost(url.hostname)) {
    const segments = url.pathname.split("/").filter(Boolean);
    // Loom appends a slug to some share links (/share/<id>-<slug>); the id is
    // the leading hex run, and everything after the first dash is decoration.
    const candidate = segments.length >= 2 && /^(share|embed)$/i.test(segments[0]) ? segments[1] : null;
    if (candidate) {
      const id = candidate.split("-")[0];
      if (LOOM_ID.test(id)) return id.toLowerCase();
    }
  }

  const loose = /loom\.com\/(?:share|embed)\/([a-f0-9]{32})/i.exec(cleaned);
  return loose ? loose[1].toLowerCase() : null;
}

/** The one URL shape every manifest and every yt-dlp call uses. */
export function canonicalLoomUrl(videoId: string): string {
  return `https://www.loom.com/share/${videoId}`;
}

/** Why a Loom link could not be compiled. Mapped to CLI error codes by the caller. */
export type LoomFailureKind =
  /** Network, DNS, timeout, 5xx — worth another go. */
  | "unreachable"
  /** The video exists but is gated behind a login or a password. */
  | "private"
  /** No such video, or it was deleted. */
  | "not_found";

export class LoomError extends Error {
  readonly kind: LoomFailureKind;
  constructor(kind: LoomFailureKind, message: string) {
    super(message);
    this.name = "LoomError";
    this.kind = kind;
  }
}

async function graphql(
  id: string,
  operationName: string,
  query: string,
  opts: LoomFetchOptions | undefined,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeout(opts));
  let res: Response;
  try {
    res = await fetch(`${resolveOrigin(opts)}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": BROWSER_UA,
        Origin: DEFAULT_ORIGIN,
        Referer: canonicalLoomUrl(id),
      },
      body: JSON.stringify({ operationName, variables: { videoId: id }, query }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new LoomError("unreachable", `could not reach Loom: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new LoomError("unreachable", `Loom returned HTTP ${res.status} for ${operationName}.`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new LoomError("unreachable", `Loom returned a response for ${operationName} that was not JSON.`);
  }
  const data = (parsed as { data?: unknown }).data;
  return (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
}

export interface LoomMeta {
  id: string;
  title: string;
  durationMs: number;
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/**
 * Title + duration only. The same query can hand back a signed media URL, and
 * deliberately is not asked for one: a transcript import downloads no media, so
 * minting a media URL it will never use is surface for nothing.
 */
export async function fetchLoomMeta(id: string, opts?: LoomFetchOptions): Promise<LoomMeta> {
  const data = await graphql(
    id,
    "GetVideoSource",
    "query GetVideoSource($videoId: ID!) { getVideo(id: $videoId) { __typename ... on RegularUserVideo { id name createdAt video_properties { duration width height } } } }",
    opts,
  );

  const video = data.getVideo;
  if (!video || typeof video !== "object") {
    throw new LoomError("not_found", "Loom has no video at that link. It may have been deleted, or the id may be wrong.");
  }

  const typename = (video as Record<string, unknown>).__typename;
  if (typename === "PrivateVideo") {
    throw new LoomError("private", "this Loom video is private. Only public share links can be imported.");
  }
  if (typename === "VideoPasswordMissingOrIncorrect") {
    throw new LoomError("private", "this Loom video is password-protected, which Clipy cannot open.");
  }
  if (typename !== "RegularUserVideo") {
    throw new LoomError("not_found", `Loom returned a video type Clipy does not handle (${String(typename)}).`);
  }

  const props = ((video as Record<string, unknown>).video_properties ?? {}) as Record<string, unknown>;
  const duration = Number(props.duration);

  return {
    id: str((video as Record<string, unknown>).id, 64) ?? id,
    title: str((video as Record<string, unknown>).name, 300) ?? `Loom recording ${id.slice(0, 8)}`,
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0,
  };
}

export interface LoomTranscript {
  /** WebVTT when Loom published captions; phrase JSON is the fallback. */
  format: "vtt" | "phrases";
  text: string;
  language?: string;
}

/**
 * A URL Loom handed us is still a URL off the wire, and the response that
 * carries it is the one thing an attacker who owns the GraphQL answer controls.
 * So the transcript may only be fetched from the same place the answer came
 * from: loom.com and its CDN subdomains normally, and exactly the configured
 * origin's host when one is set. Pointing the origin elsewhere moves the
 * allowlist; it never removes it.
 */
function assertFetchableCaptionUrl(raw: string, opts: LoomFetchOptions | undefined): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LoomError("unreachable", "Loom returned a transcript location Clipy could not parse.");
  }

  const configured = resolveOrigin(opts);
  const allowed =
    configured === DEFAULT_ORIGIN
      ? url.protocol === "https:" && /(^|\.)loom\.com$/i.test(url.hostname)
      : url.host === new URL(configured).host;

  if (!allowed) {
    throw new LoomError(
      "unreachable",
      `Loom returned a transcript location off its own CDN (${url.hostname}). Refusing to fetch it.`,
    );
  }
  return url;
}

async function fetchText(url: URL, opts: LoomFetchOptions | undefined): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeout(opts));
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: controller.signal });
  } catch (e) {
    throw new LoomError("unreachable", `could not download the Loom transcript: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new LoomError("unreachable", `downloading the Loom transcript returned HTTP ${res.status}.`);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TRANSCRIPT_BYTES) {
    throw new LoomError("unreachable", "the Loom transcript is implausibly large. Refusing to buffer it.");
  }
  const body = await res.text();
  if (body.length > MAX_TRANSCRIPT_BYTES) {
    throw new LoomError("unreachable", "the Loom transcript is implausibly large. Refusing to buffer it.");
  }
  return body;
}

/**
 * Loom's own transcript for a public share link, or null when it has none.
 *
 * Verified across 191 production videos: 84% return one, 16% genuinely have no
 * transcript recorded — so null is an ordinary answer here, not a malfunction.
 *
 * WebVTT is preferred over the phrase JSON because its cues carry a real END
 * time. The phrase JSON only has a start, so its segment boundaries have to be
 * inferred, and the sufficiency classifier reads those boundaries.
 */
export async function fetchLoomTranscript(
  id: string,
  opts?: LoomFetchOptions,
): Promise<LoomTranscript | null> {
  const data = await graphql(
    id,
    "FetchVideoTranscript",
    "query FetchVideoTranscript($videoId: ID!) { fetchVideoTranscript(videoId: $videoId) { __typename ... on VideoTranscriptDetails { source_url captions_source_url language } } }",
    opts,
  );

  const details = data.fetchVideoTranscript;
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  // InvalidRequestWarning is what an unknown id gets. The caller has already
  // resolved metadata by this point, so treat it as "no transcript".
  if (d.__typename !== "VideoTranscriptDetails") return null;

  const language = str(d.language, 40);
  const candidates: { format: LoomTranscript["format"]; url: string }[] = [];
  const vttUrl = str(d.captions_source_url, 4000);
  const jsonUrl = str(d.source_url, 4000);
  if (vttUrl) candidates.push({ format: "vtt", url: vttUrl });
  if (jsonUrl) candidates.push({ format: "phrases", url: jsonUrl });

  // Both locations are separately signed and separately expirable, so a dead
  // captions URL falls through to the phrase JSON rather than failing an import
  // whose transcript was sitting right there. The failure is only reported if
  // nothing worked.
  let lastFailure: LoomError | null = null;
  for (const candidate of candidates) {
    try {
      const text = await fetchText(assertFetchableCaptionUrl(candidate.url, opts), opts);
      if (text.trim()) return { format: candidate.format, text, ...(language ? { language } : {}) };
    } catch (e) {
      if (!(e instanceof LoomError)) throw e;
      lastFailure = e;
    }
  }
  if (lastFailure) throw lastFailure;

  return null;
}

export interface LoomPhraseSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Loom's phrase JSON: `{phrases: [{ts, value}]}`, where `ts` is a start in
 * seconds and there is no end. A phrase runs until the next one starts, and the
 * last runs to the end of the video — inferring rather than inventing, because
 * a fabricated end time would move a moment the classifier points at.
 */
export function parseLoomPhrases(json: unknown, durationMs = 0): LoomPhraseSegment[] {
  const phrases = (json as { phrases?: unknown } | null)?.phrases;
  if (!Array.isArray(phrases)) return [];

  const raw: { startMs: number; text: string }[] = [];
  for (const item of phrases.slice(0, MAX_PHRASES)) {
    if (!item || typeof item !== "object") continue;
    const ts = Number((item as Record<string, unknown>).ts);
    const value = (item as Record<string, unknown>).value;
    if (!Number.isFinite(ts) || ts < 0 || typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) continue;
    raw.push({ startMs: Math.round(ts * 1000), text });
  }
  raw.sort((a, b) => a.startMs - b.startMs);

  return raw.map((seg, i) => {
    const next = raw[i + 1]?.startMs;
    const fallback = durationMs > seg.startMs ? durationMs : seg.startMs;
    return {
      startMs: seg.startMs,
      endMs: next !== undefined && next > seg.startMs ? next : fallback,
      text: seg.text,
    };
  });
}
