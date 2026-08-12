#!/usr/bin/env node
/**
 * The SHARED Loom provider's parsers and its two portability constraints.
 *
 * The provider lives in lib/context-core and is consumed by the CLI, the
 * Next.js server, and (potentially) the Chrome extension, so this file guards
 * the contract those three share as much as it guards the parsing.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
// Through the CLI adapter, which re-exports the shared module. Asserting here
// proves both that the parsers work and that the re-export is intact.
const { parseLoomId, isLoomHost, canonicalLoomUrl, parseLoomPhrases } = await import(
  pathToFileURL(join(dist, "context", "loom.js")).href
);
const shared = await import(pathToFileURL(join(dist, "context-core", "loom.js")).href);

// --- portability: context-core is bundled by Vite for the extension, where
// `process` does not exist. The origin override must stay injected. ----------
const sharedSource = readFileSync(join(dist, "context-core", "loom.js"), "utf8");
assert.ok(
  !/\bprocess\s*\./.test(sharedSource),
  "lib/context-core/loom.ts must not touch `process` — the extension bundles context-core through Vite. Inject the origin instead.",
);

// --- the injected origin works with no environment variable in sight, which
// is how the server consumes it. --------------------------------------------
{
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push(JSON.parse(body).operationName);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: { getVideo: { __typename: "RegularUserVideo", id: "a".repeat(32), name: "Injected origin", video_properties: { duration: 12 } } },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(process.env.CLIPY_LOOM_ORIGIN, undefined, "this case must not depend on the env seam");
    const meta = await shared.fetchLoomMeta("a".repeat(32), { origin });
    assert.deepEqual(meta, { id: "a".repeat(32), title: "Injected origin", durationMs: 12_000 });
    assert.deepEqual(calls, ["GetVideoSource"]);
  } finally {
    server.close();
  }
}

const ID = "8961c11d90fd42d6a8d1bacc71834c90";

// --- an injected timeout is honoured, and the default is not used ----------
// Loom throttles by STALLING rather than refusing, so an interactive caller
// needs its own ceiling. A server that never answers proves the abort fires on
// the caller's number, not on the 30s default.
{
  const sockets = new Set();
  const server = createServer((req, res) => {
    sockets.add(res.socket);
    // Deliberately never respond.
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const started = Date.now();
    await assert.rejects(
      () => shared.fetchLoomMeta("b".repeat(32), { origin, timeoutMs: 600 }),
      (e) => e.name === "LoomError" && e.kind === "unreachable",
      "a stalled Loom must surface as a retryable unreachable, not hang",
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `aborted after ${elapsed}ms — the injected timeout was ignored`);
    assert.ok(elapsed >= 500, `returned after only ${elapsed}ms — suspiciously early`);
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
}

// A nonsense timeout must fall back to the default, never abort instantly.
for (const timeoutMs of [0, -1, Number.NaN, undefined]) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: { getVideo: { __typename: "RegularUserVideo", id: "c".repeat(32), name: "Fallback", video_properties: { duration: 3 } } },
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const meta = await shared.fetchLoomMeta("c".repeat(32), { origin, timeoutMs });
    assert.equal(meta.title, "Fallback", `timeoutMs=${String(timeoutMs)} should have fallen back to the default`);
  } finally {
    server.close();
  }
}

// --- ids we must recognise -------------------------------------------------
for (const input of [
  `https://www.loom.com/share/${ID}`,
  `https://loom.com/share/${ID}`,
  `https://www.loom.com/embed/${ID}`,
  `https://www.loom.com/share/${ID}?sid=abc-123`,
  `https://www.loom.com/share/${ID}-some-slug`,
  // zsh escapes what it copies; the raw string must still resolve.
  `https://www.loom.com/share/${ID}\\?sid\\=abc`,
  `https://www.loom.com/share/${ID.toUpperCase()}`,
]) {
  assert.equal(parseLoomId(input), ID, `should have parsed ${input}`);
}

// --- and ids we must not invent -------------------------------------------
for (const input of [
  "https://www.loom.com/share/folder/abc123",
  "https://www.loom.com/looms/videos",
  "https://www.loom.com/share/tooshort",
  // Right shape, wrong host: never treat someone else's link as a Loom.
  `https://loom.example.com/share/${ID}`,
  `https://www.youtube.com/watch?v=dQw4w9WgXcQ`,
]) {
  assert.equal(parseLoomId(input), null, `should NOT have parsed ${input}`);
}

assert.equal(isLoomHost("WWW.LOOM.COM"), true);
assert.equal(isLoomHost("loom.com"), true);
assert.equal(isLoomHost("notloom.com"), false);
assert.equal(canonicalLoomUrl(ID), `https://www.loom.com/share/${ID}`);

// --- phrase JSON: a start time and nothing else ----------------------------
// A phrase runs until the next one starts; the last runs to the end of the
// video. Anything else would move a moment the classifier points at.
const phrases = parseLoomPhrases(
  { phrases: [{ ts: 4.5, value: "second  phrase" }, { ts: 0.06, value: " first phrase " }] },
  30_000,
);
assert.deepEqual(phrases, [
  { startMs: 60, endMs: 4500, text: "first phrase" },
  { startMs: 4500, endMs: 30_000, text: "second phrase" },
]);

// With no duration to fall back on, the tail cannot be stretched past its start.
assert.deepEqual(parseLoomPhrases({ phrases: [{ ts: 2, value: "only" }] }, 0), [
  { startMs: 2000, endMs: 2000, text: "only" },
]);

// Junk in, nothing out — never a segment with a fabricated timestamp.
assert.deepEqual(parseLoomPhrases({ phrases: [{ ts: "x", value: "a" }, { ts: 1 }, { ts: -5, value: "b" }, { ts: 2, value: "   " }] }), []);
assert.deepEqual(parseLoomPhrases({}), []);
assert.deepEqual(parseLoomPhrases(null), []);

console.log("context-loom-url: ok");
