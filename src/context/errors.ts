/**
 * Machine-legible outcomes.
 *
 * The primary operator of this command is an agent inside Claude Code or Codex,
 * not a person reading a terminal. An agent cannot act on prose: it needs a
 * stable code to branch on and a remediation string it can run verbatim. So
 * every failure carries all three — what broke (`code`), what happened in
 * English (`error`), and the exact next action (`remediation`).
 *
 * Codes are API surface. Renaming one silently breaks any agent branching on
 * it, so treat this union the way you would treat a public enum.
 */
export type ImportErrorCode =
  | "invalid_url"
  | "no_captions"
  /** Loom itself could not be reached, or answered with something unusable. */
  | "loom_unreachable"
  /** The video exists but is private or password-protected, so it cannot be read. */
  | "source_private"
  | "no_video_stream"
  | "ytdlp_missing"
  | "ytdlp_download_403"
  | "ffmpeg_missing"
  | "auth_required"
  | "wrong_scope"
  | "quota_exceeded"
  | "frames_upload_failed"
  | "server_unreachable"
  | "transcript_unreadable"
  | "source_unreadable"
  | "content_conflict"
  | "unknown";

export interface ImportWarning {
  code: ImportErrorCode;
  error: string;
  remediation: string;
}

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly remediation: string;
  /** What survived, when something did. Non-null makes this a partial failure. */
  readonly partial: Record<string, unknown> | null;

  constructor(
    code: ImportErrorCode,
    message: string,
    remediation: string,
    partial: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.remediation = remediation;
    this.partial = partial;
  }
}

export function isImportError(e: unknown): e is ImportError {
  return e instanceof Error && e.name === "ImportError";
}

/**
 * The one JSON object a failed `--json` run prints. Exactly one object per run,
 * success or failure, so an agent can always `JSON.parse` stdout.
 */
export function errorEnvelope(e: unknown): Record<string, unknown> {
  if (isImportError(e)) {
    return {
      ok: false,
      code: e.code,
      error: e.message,
      remediation: e.remediation,
      partial: e.partial,
    };
  }
  return {
    ok: false,
    code: "unknown" as ImportErrorCode,
    error: e instanceof Error ? e.message : String(e),
    remediation: "Re-run the command; if it fails again, report this output as a bug.",
    partial: null,
  };
}
