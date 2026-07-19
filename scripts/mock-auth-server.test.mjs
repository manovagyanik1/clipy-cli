#!/usr/bin/env node
/**
 * Protocol test for the browser-approve login flow. No test framework, no deps:
 * a mock server implements the frozen wire contract and drives the REAL compiled
 * browserLogin (../dist/browserLogin.js) against it, plus one subprocess run of
 * the compiled CLI to prove the key is stored.
 *
 *   /cli/authorize          — "approves" by fetching the loopback /callback with
 *                             a code (or a wrong state / a denial, per scenario).
 *   /api/cli-auth/exchange  — validates sha256(verifier) === challenge, enforces
 *                             single-use codes, and fails per scenario.
 *   /api/v1/recordings      — the whoami verify the CLI runs after storing.
 *
 * Run: npm run test:auth   (or, after `npm run build`, `node scripts/mock-auth-server.test.mjs`)
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const DIST_LOGIN = new URL("../dist/browserLogin.js", import.meta.url);
const DIST_INDEX = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let browserLogin;
try {
  ({ browserLogin } = await import(DIST_LOGIN));
} catch {
  console.error("Could not load ../dist/browserLogin.js — run `npm run build` first.");
  process.exit(1);
}

const MOCK_KEY = "clipy_sk_live_mocktest_ABC123";
const MOCK_EMAIL = "dev@example.com";
const MOCK_SCOPES = ["recordings:read", "ingest"];

// Mutable per-test knobs the handlers read.
let scenario = { approve: "match", exchange: "ok" };
let exchangeCalls = 0;
const codes = new Map(); // code -> { challenge, used }

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = { "Content-Type": "application/json" };

  if (url.pathname === "/cli/authorize") {
    const challenge = url.searchParams.get("challenge");
    const state = url.searchParams.get("state");
    const port = url.searchParams.get("port");
    const code = `code_${randomBytes(8).toString("hex")}`;
    codes.set(code, { challenge, used: false });
    // Manual (copy-code) flow: no loopback exists — the approval page displays
    // the code. The mock returns it in the body for the test's promptCode.
    if (url.searchParams.get("mode") === "manual") {
      res.writeHead(200, json).end(JSON.stringify({ code }));
      return;
    }
    let cb;
    if (scenario.approve === "deny") {
      cb = `http://127.0.0.1:${port}/callback?error=access_denied&state=${encodeURIComponent(state)}`;
    } else if (scenario.approve === "mismatch") {
      cb = `http://127.0.0.1:${port}/callback?code=${code}&state=${encodeURIComponent(state)}_TAMPERED`;
    } else {
      cb = `http://127.0.0.1:${port}/callback?code=${code}&state=${encodeURIComponent(state)}`;
    }
    // Simulate the browser being redirected to the loopback listener.
    fetch(cb).catch(() => {});
    res.writeHead(200, { "Content-Type": "text/plain" }).end("approved");
    return;
  }

  if (url.pathname === "/api/cli-auth/exchange" && req.method === "POST") {
    exchangeCalls += 1;
    const body = JSON.parse((await readBody(req)) || "{}");
    // A single-use code that's already been consumed always 400s — the client
    // must NOT retry this.
    if (scenario.exchange === "consumed") {
      res.writeHead(400, json).end(JSON.stringify({ error: "authorization code already used" }));
      return;
    }
    // First attempt is a transient 5xx; the retry (attempt 2) succeeds.
    if (scenario.exchange === "fail-then-ok" && exchangeCalls === 1) {
      res.writeHead(500, json).end(JSON.stringify({ error: "temporary server error" }));
      return;
    }
    const rec = codes.get(body.code);
    if (!rec || rec.used) {
      res.writeHead(400, json).end(JSON.stringify({ error: "invalid or used code" }));
      return;
    }
    const computed = createHash("sha256").update(String(body.verifier)).digest("base64url");
    if (computed !== rec.challenge) {
      res.writeHead(400, json).end(JSON.stringify({ error: "PKCE verifier mismatch" }));
      return;
    }
    rec.used = true;
    res.writeHead(200, json).end(JSON.stringify({ apiKey: MOCK_KEY, scopes: MOCK_SCOPES, email: MOCK_EMAIL }));
    return;
  }

  if (url.pathname.startsWith("/api/v1/recordings")) {
    res.writeHead(200, json).end(JSON.stringify({ recordings: [], pagination: { page: 1, totalPages: 1, total: 0 } }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// The browser-open stub: fetch the authorize URL ourselves instead of spawning
// a real browser. The mock's /cli/authorize then fires the loopback callback.
const openViaFetch = (u) => {
  fetch(u).catch(() => {});
};

const loginOpts = { apiUrl: base, open: openViaFetch, timeoutMs: 8000, log: () => {} };

// --- Test runner ------------------------------------------------------------

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${e && e.message ? e.message : e}`);
  }
}

await test("happy path returns apiKey + scopes + email", async () => {
  scenario = { approve: "match", exchange: "ok" };
  exchangeCalls = 0;
  const res = await browserLogin(loginOpts);
  assert.equal(res.apiKey, MOCK_KEY);
  assert.deepEqual(res.scopes, MOCK_SCOPES);
  assert.equal(res.email, MOCK_EMAIL);
  assert.equal(exchangeCalls, 1);
});

await test("state mismatch on the callback fails the flow", async () => {
  scenario = { approve: "mismatch", exchange: "ok" };
  await assert.rejects(browserLogin(loginOpts), /state mismatch/i);
});

await test("denied approval fails cleanly", async () => {
  scenario = { approve: "deny", exchange: "ok" };
  await assert.rejects(browserLogin(loginOpts), /cancelled/i);
});

await test("consumed-code 400 is NOT retried", async () => {
  scenario = { approve: "match", exchange: "consumed" };
  exchangeCalls = 0;
  await assert.rejects(browserLogin(loginOpts), /already used|400|code/i);
  assert.equal(exchangeCalls, 1, "exchange must be called exactly once on a 400");
});

await test("transient 5xx on exchange is retried once", async () => {
  scenario = { approve: "match", exchange: "fail-then-ok" };
  exchangeCalls = 0;
  const res = await browserLogin(loginOpts);
  assert.equal(res.apiKey, MOCK_KEY);
  assert.equal(exchangeCalls, 2, "exchange should retry exactly once after a 5xx");
});

await test("stray path on the listener does not resolve (404s)", async () => {
  // Drive a login, but before approving, hit a wrong path — it must 404 and the
  // flow must still complete on the real /callback.
  scenario = { approve: "match", exchange: "ok" };
  exchangeCalls = 0;
  const res = await browserLogin({
    ...loginOpts,
    open: async (u) => {
      const port = new URL(u).searchParams.get("port");
      const stray = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
      assert.equal(stray.status, 404, "stray path should 404");
      fetch(u).catch(() => {}); // now really approve
    },
  });
  assert.equal(res.apiKey, MOCK_KEY);
});

await test("manual (copy-code) flow: URL has mode=manual + no port, pasted code exchanges", async () => {
  scenario = { approve: "match", exchange: "ok" };
  exchangeCalls = 0;
  let manualCode = null;
  const res = await browserLogin({
    ...loginOpts,
    manual: true,
    open: async (u) => {
      const parsed = new URL(u);
      assert.equal(parsed.searchParams.get("mode"), "manual");
      assert.equal(parsed.searchParams.get("port"), null, "manual URL must not carry a port");
      assert.ok(parsed.searchParams.get("challenge"), "challenge present");
      assert.ok(parsed.searchParams.get("state"), "state present");
      const r = await fetch(u); // the "user" approving on another device
      manualCode = (await r.json()).code;
    },
    promptCode: async () => manualCode,
  });
  assert.equal(res.apiKey, MOCK_KEY);
  assert.deepEqual(res.scopes, MOCK_SCOPES);
  assert.equal(exchangeCalls, 1);
});

await test("manual flow: a wrong pasted code fails without retry", async () => {
  scenario = { approve: "match", exchange: "ok" };
  exchangeCalls = 0;
  await assert.rejects(
    browserLogin({
      ...loginOpts,
      manual: true,
      open: async (u) => {
        await fetch(u); // approval happens, but the user pastes garbage
      },
      promptCode: async () => "code_wrong",
    }),
    /invalid|used|code/i,
  );
  assert.equal(exchangeCalls, 1, "a 400 on a pasted code must not be retried");
});

await test("clipy login stores the key via the config path (subprocess)", async () => {
  scenario = { approve: "match", exchange: "ok" };
  const configHome = mkdtempSync(join(tmpdir(), "clipy-auth-test-"));
  // Non-TTY stdout routes `clipy login` to the paste path, so feed the key with
  // --key; this exercises the same store+verify wiring the browser path uses.
  const stored = await runCli(["login", "--key", MOCK_KEY, "--api-url", base], {
    XDG_CONFIG_HOME: configHome,
    NO_COLOR: "1",
  });
  assert.equal(stored.code, 0, `login exited ${stored.code}: ${stored.stderr}`);
  assert.match(stored.stdout, /logged in/i);
  const cfg = JSON.parse(readFileSync(join(configHome, "clipy", "config.json"), "utf8"));
  assert.equal(cfg.apiKey, MOCK_KEY, "the API key should be persisted to config.json");
});

function runCli(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_INDEX, ...args], {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

server.close();
if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall auth protocol tests passed");
