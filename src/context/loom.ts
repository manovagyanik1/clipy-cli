/**
 * The CLI's adapter onto the SHARED Loom provider.
 *
 * The transport and the parsers live in `lib/context-core/loom.ts`, which the
 * prebuild syncs into `src/context-core/`. They are shared with the Next.js
 * server (and available to the extension) precisely so there is one Loom
 * implementation rather than two that drift.
 *
 * What is CLI-only, and therefore lives here:
 *   - reading `CLIPY_LOOM_ORIGIN` from the environment. context-core must not
 *     touch `process` (the extension bundles it through Vite), so the origin is
 *     injected, and this is the only place that knows an environment exists.
 *   - mapping Loom's failure vocabulary onto the CLI's stable error codes, which
 *     `importCmd.ts` owns. `LoomFailureKind` is about Loom; `ImportErrorCode` is
 *     a published contract agents branch on, and the two should be free to move
 *     independently.
 */

import {
  fetchLoomMeta as fetchLoomMetaShared,
  fetchLoomTranscript as fetchLoomTranscriptShared,
  type LoomFetchOptions,
  type LoomMeta,
  type LoomTranscript,
} from "../context-core/loom.js";

export {
  LoomError,
  canonicalLoomUrl,
  isLoomHost,
  parseLoomId,
  parseLoomPhrases,
  type LoomFailureKind,
  type LoomMeta,
  type LoomPhraseSegment,
  type LoomTranscript,
} from "../context-core/loom.js";

/** Read per call, never cached: a test sets this per spawned process. */
function envOptions(): LoomFetchOptions {
  const origin = process.env.CLIPY_LOOM_ORIGIN;
  return origin ? { origin } : {};
}

export function fetchLoomMeta(id: string): Promise<LoomMeta> {
  return fetchLoomMetaShared(id, envOptions());
}

export function fetchLoomTranscript(id: string): Promise<LoomTranscript | null> {
  return fetchLoomTranscriptShared(id, envOptions());
}
