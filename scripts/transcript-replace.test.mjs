#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const revision = "a".repeat(64);
const dir = mkdtempSync(join(tmpdir(), "clipy-transcript-replace-"));
const replacement = join(dir, "replacement.json");
writeFileSync(replacement, JSON.stringify({ plaintext: "corrected transcript" }));

let requests = 0;
let lastBody = null;
let responseStatus = 200;
const server = createServer(async (req, res) => {
  if (req.method !== "PUT" || req.url !== "/api/v1/recordings/public-1/transcript") {
    res.writeHead(404).end();
    return;
  }
  requests += 1;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  res
    .writeHead(responseStatus, { "content-type": "application/json" })
    .end(
      JSON.stringify(
        responseStatus === 200
          ? { status: "ready", revision: "b".repeat(64) }
          : { error: "Transcript changed since editing began. Refresh and try again." },
      ),
    );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        CLIPY_API_KEY: "clipy_sk_test",
        CLIPY_API_URL: apiUrl,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  const guide = await run(["guide", "--json"]);
  assert.equal(guide.code, 0, guide.stderr);
  const transcriptGuide = JSON.parse(guide.stdout).commands.find(
    (command) => command.name === "transcript",
  );
  assert.match(transcriptGuide.usage, /--replace .* --revision <sha256>/);
  assert.ok(transcriptGuide.flags.includes("--revision <sha256>"));

  const missing = await run(["transcript", "public-1", "--replace", replacement]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--revision is required/);
  assert.equal(requests, 0, "missing revision must fail before issuing a write");

  const replaced = await run([
    "transcript",
    "public-1",
    "--replace",
    replacement,
    "--revision",
    revision,
  ]);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(requests, 1);
  assert.deepEqual(lastBody, {
    plaintext: "corrected transcript",
    expectedRevision: revision,
  });

  responseStatus = 409;
  const stale = await run([
    "transcript",
    "public-1",
    "--replace",
    replacement,
    "--revision",
    revision,
  ]);
  assert.notEqual(stale.code, 0);
  assert.match(stale.stderr, /Transcript changed since editing began/);

  console.log("ok: transcript help, validation, and replacement carry the caller revision");
} finally {
  server.close();
}
