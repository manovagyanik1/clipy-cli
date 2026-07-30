#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const requests = [];
const response = {
  query: "authentication flow",
  degraded: false,
  semantic: { status: "ok" },
  count: 2,
  tookMs: 18,
  results: [
    {
      kind: "recording",
      sourceId: "video-1",
      publicId: "recording123",
      title: "Login walkthrough",
      startMs: 12000,
      endMs: 18000,
      resolution: "refined",
      snippet: "The user opens the authentication screen.",
      score: 0.91,
      url: "https://clipy.online/video/recording123?t=12",
    },
    {
      kind: "context",
      sourceId: "context-1",
      publicId: "context123",
      title: "OAuth talk",
      startMs: 50000,
      endMs: 100000,
      resolution: "window",
      snippet: "This section compares OAuth device flows.",
      score: 0.8,
      url: "https://clipy.online/knowledge/context123",
    },
  ],
};

const server = createServer((req, res) => {
  requests.push({
    url: req.url,
    authorization: req.headers.authorization,
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(response));
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert.ok(address && typeof address === "object");
const apiUrl = `http://127.0.0.1:${address.port}`;
const cli = resolve("dist/index.js");

function run(args) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [cli, ...args, "--api-url", apiUrl, "--key", "clipy_test"],
      {
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

try {
  const json = await run([
    "memory",
    "search",
    "authentication",
    "flow",
    "--kind",
    "recording",
    "--kind",
    "context",
    "--limit",
    "7",
    "--json",
  ]);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), response);
  assert.equal(requests[0].authorization, "Bearer clipy_test");
  const requested = new URL(requests[0].url, apiUrl);
  assert.equal(requested.pathname, "/api/v1/search");
  assert.equal(requested.searchParams.get("q"), "authentication flow");
  assert.equal(requested.searchParams.get("kinds"), "recording,context");
  assert.equal(requested.searchParams.get("limit"), "7");

  const text = await run(["memory", "search", "authentication flow"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /semantic: ok/);
  assert.match(text.stdout, /\[recording\] Login walkthrough · 0:12 · refined/);
  assert.match(text.stdout, /\[context\] OAuth talk · 0:50–1:40 · window/);
  assert.match(text.stdout, /https:\/\/clipy\.online\/knowledge\/context123/);

  const invalid = await run(["memory", "search", "authentication flow", "--kind", "videos"]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /--kind must be recording or context/);
  assert.equal(requests.length, 2, "invalid kinds must fail before an API request");

  process.stdout.write("memory search: ok\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
