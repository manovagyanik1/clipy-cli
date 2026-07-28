#!/usr/bin/env node
/**
 * Two field bugs, both offline-testable because both are pure decisions:
 *  1. shell-escaped URLs (`watch\?v\=ID`) must normalise, never reach yt-dlp raw
 *  2. caption selection must fall back past en-only, preferring the video's
 *     ORIGINAL language over YouTube's auto-translations of it
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "context");
const { parseYoutubeId, canonicalYoutubeUrl } = await import(pathToFileURL(join(dist, "youtubeUrl.js")));
const { planCaptionAttempts } = await import(pathToFileURL(join(dist, "ytdlp.js")));

// --- 1. URL normalisation --------------------------------------------------

const ID = "77FB-LS0Bjk";
for (const [input, why] of [
  // The exact string zsh handed the CLI in the owner's run.
  ["https://www.youtube.com/watch\\?v\\=77FB-LS0Bjk", "backslash-escaped ? and ="],
  ["https://www.youtube.com/watch?v=77FB-LS0Bjk", "plain watch URL"],
  ["  https://www.youtube.com/watch?v=77FB-LS0Bjk  ", "surrounding whitespace"],
  ["https://youtu.be/77FB-LS0Bjk", "short link"],
  ["https://youtu.be/77FB-LS0Bjk?t=42", "short link with a start time"],
  ["https://www.youtube.com/shorts/77FB-LS0Bjk", "shorts"],
  ["https://www.youtube.com/live/77FB-LS0Bjk", "live"],
  ["https://www.youtube.com/embed/77FB-LS0Bjk", "embed"],
  ["https://m.youtube.com/watch?v=77FB-LS0Bjk&feature=share", "mobile host + extra params"],
  ["https://music.youtube.com/watch?v=77FB-LS0Bjk", "music host"],
  ["https://www.youtube.com/watch?list=PL123&v=77FB-LS0Bjk", "v= is not the first param"],
  ["https://www.youtube.com/watch\\?v\\=77FB-LS0Bjk\\&list\\=PL123", "fully escaped with a playlist"],
  ["www.youtube.com/watch?v=77FB-LS0Bjk", "no scheme (loose match)"],
]) {
  assert.equal(parseYoutubeId(input), ID, `should extract the id from ${why}: ${input}`);
}

assert.equal(canonicalYoutubeUrl(ID), "https://www.youtube.com/watch?v=77FB-LS0Bjk");

for (const [input, why] of [
  ["https://www.youtube.com/@someChannel", "a channel URL"],
  ["https://www.youtube.com/playlist?list=PL1234567890", "a playlist-only URL"],
  ["https://www.youtube.com/results?search_query=cats", "a search URL"],
  ["https://www.youtube.com/watch?v=tooShort", "an id of the wrong length"],
  ["https://example.com/watch?v=77FB-LS0Bjk", "the right shape on the wrong host"],
]) {
  assert.equal(parseYoutubeId(input), null, `should refuse ${why}: ${input}`);
}

// --- 2. caption language fallback -----------------------------------------

const meta = (over) => ({
  id: ID, title: "t", durationMs: 1000,
  subtitleLangs: [], autoCaptionLangs: [], ...over,
});

// The real 77FB-LS0Bjk shape: no creator subs, a Hindi original, and ~157
// auto-translations including en. en must NOT win over the original.
const hindi = planCaptionAttempts(
  meta({ language: "hi", autoCaptionLangs: ["af", "en", "es", "hi-orig", "zu"] }),
);
assert.equal(hindi[0].track, "hi-orig", "the original-language track must be tried first");
assert.equal(hindi[0].language, "hi", "the -orig suffix is a track name, not a language code");
assert.equal(hindi[0].source, "auto_captions", "the original language is not a translation");
assert.equal(hindi[0].translatedFrom, undefined);
assert.equal(hindi[0].flag, "--write-auto-subs");
assert.equal(hindi[1].track, "en", "en is the second choice, not the first");
assert.equal(hindi[1].source, "auto_captions_translated", "en here is a machine translation of Hindi");
assert.equal(hindi[1].translatedFrom, "hi");

// Original identifiable only from the metadata language field (no -orig track).
const viaMetaLang = planCaptionAttempts(meta({ language: "ja", autoCaptionLangs: ["en", "ja", "ko"] }));
assert.equal(viaMetaLang[0].language, "ja");
assert.equal(viaMetaLang[0].source, "auto_captions");

// Only one language available, and it is not English.
const french = planCaptionAttempts(meta({ autoCaptionLangs: ["fr"] }));
assert.equal(french.length, 1, "a single available language should produce a single attempt");
assert.equal(french[0].language, "fr", "fr must be picked rather than failing on en");
assert.equal(french[0].source, "auto_captions", "with no known original, fr is not assumed to be a translation");

// Creator captions outrank auto captions, in any language.
const creator = planCaptionAttempts(
  meta({ language: "de", subtitleLangs: ["de"], autoCaptionLangs: ["de-orig", "en"] }),
);
assert.equal(creator[0].source, "creator_captions");
assert.equal(creator[0].language, "de");
assert.equal(creator[0].flag, "--write-subs");
assert.ok(creator.slice(1).every((a) => a.source !== "creator_captions"), "one creator attempt is enough");

// An explicit --language is obeyed exactly — never silently widened.
const explicit = planCaptionAttempts(
  meta({ language: "hi", autoCaptionLangs: ["en", "es", "hi-orig"] }),
  "es",
);
assert.equal(explicit.length, 1, "--language must not fall back to other languages");
assert.equal(explicit[0].language, "es");
assert.equal(explicit[0].source, "auto_captions_translated");
assert.equal(explicit[0].translatedFrom, "hi");

// A regional variant satisfies a base-code request.
const regional = planCaptionAttempts(meta({ subtitleLangs: ["en-US"] }), "en");
assert.equal(regional[0].track, "en-US");

// Nothing at all to try.
assert.deepEqual(planCaptionAttempts(meta({})), [], "no caption tracks means no attempts");

process.stdout.write("✓ youtube url normalisation (incl. shell escaping) + caption language fallback chain\n");
