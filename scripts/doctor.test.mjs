#!/usr/bin/env node
/**
 * Shape + behavior test for `clipy doctor --json`. No test framework, no deps:
 * a tiny mock server answers the whoami round-trip, and CLIPY_BRIDGE_FILE points
 * the bridge check at a temp discovery file we control (so this runs on any OS,
 * not just macOS). We drive the REAL compiled CLI (../dist/index.js).
 *
 * We assert the manifest shape and the checks that are deterministic here — auth
 * (mock server), bridge (live vs dead pid in the temp file). The `playwright`
 * check is environment-dependent (is Playwright installed where the CLI can load
 * it?), so we only assert it exists with a valid status, not a fixed value.
 *
 * Run: node scripts/doctor.test.mjs   (after `npm run build`)
 */

import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const DIST_INDEX = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const MOCK_KEY = "clipy_sk_live_doctortest_ABC123";
const VALID_STATUSES = ["pass", "warn", "fail", "info", "skip"];

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/v1/recordings")) {
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ recordings: [], pagination: { page: 1, totalPages: 1, total: 0 } }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

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

function writeBridge(fields) {
  const file = join(mkdtempSync(join(tmpdir(), "clipy-doctor-")), "agent-bridge.json");
  writeFileSync(
    file,
    JSON.stringify({
      socketPath: "/tmp/clipy-doctor-test.sock",
      token: "test-token",
      pid: process.pid,
      appVersion: "0.1.41",
      protocolVersion: 1,
      ...fields,
    }),
  );
  return file;
}

function byName(json) {
  return Object.fromEntries(json.checks.map((chk) => [chk.name, chk]));
}

/** A stand-in Clipy agent bridge on a Unix socket that answers `status` with a
 *  given appVersion — lets us exercise doctor's socket + live-handshake checks. */
function startMockBridgeSocket(appVersion) {
  const sockPath = join(mkdtempSync(join(tmpdir(), "clipy-sock-")), "bridge.sock");
  const srv = createNetServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      if (buf.indexOf("\n") === -1) return;
      conn.write(
        JSON.stringify({
          ok: true,
          data: { appVersion, protocolVersion: 1, phase: "Idle", signedIn: true, agentSession: null },
        }) + "\n",
      );
      conn.end();
    });
  });
  return new Promise((resolve) => srv.listen(sockPath, () => resolve({ srv, sockPath })));
}

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

await test("doctor --json: manifest shape + all four checks present with valid status", async () => {
  const bridgeFile = writeBridge({}); // live pid, current version
  const r = await runCli(["doctor", "--json"], {
    CLIPY_API_KEY: MOCK_KEY,
    CLIPY_API_URL: base,
    CLIPY_BRIDGE_FILE: bridgeFile,
    NO_COLOR: "1",
  });
  const j = JSON.parse(r.stdout);
  assert.equal(typeof j.version, "string");
  assert.equal(j.apiUrl, base);
  assert.equal(typeof j.ok, "boolean");
  assert.ok(Array.isArray(j.checks) && j.checks.length >= 4);
  const checks = byName(j);
  for (const n of ["auth", "bridge", "playwright", "install"]) {
    assert.ok(checks[n], `check "${n}" present`);
    assert.ok(VALID_STATUSES.includes(checks[n].status), `"${n}" status "${checks[n].status}" valid`);
    assert.equal(typeof checks[n].detail, "string");
  }
});

await test("doctor --json: auth passes against the mock server; live current bridge passes", async () => {
  const bridgeFile = writeBridge({});
  const r = await runCli(["doctor", "--json"], {
    CLIPY_API_KEY: MOCK_KEY,
    CLIPY_API_URL: base,
    CLIPY_BRIDGE_FILE: bridgeFile,
    NO_COLOR: "1",
  });
  const checks = byName(JSON.parse(r.stdout));
  assert.equal(checks.auth.status, "pass", "auth should pass (mock server returns 200)");
  assert.equal(checks.bridge.status, "pass", "a live, current bridge should pass");
  assert.equal(checks.bridge.data.pidAlive, true);
  assert.equal(checks.bridge.data.appVersion, "0.1.41");
});

await test("doctor --json: dead-pid bridge fails and doctor exits non-zero", async () => {
  // 2147483000 is above every OS's pid_max, so it can never be a live process.
  const bridgeFile = writeBridge({ pid: 2147483000 });
  const r = await runCli(["doctor", "--json"], {
    CLIPY_API_KEY: MOCK_KEY,
    CLIPY_API_URL: base,
    CLIPY_BRIDGE_FILE: bridgeFile,
    NO_COLOR: "1",
  });
  const j = JSON.parse(r.stdout);
  const checks = byName(j);
  assert.equal(checks.bridge.status, "fail", "dead pid → bridge fail");
  assert.equal(checks.bridge.data.pidAlive, false);
  assert.equal(j.ok, false);
  assert.equal(r.code, 1, "a failed check makes doctor exit non-zero");
});

await test("doctor --json: outdated bridge appVersion fails with an update hint", async () => {
  const bridgeFile = writeBridge({ appVersion: "0.1.40" }); // < MIN (0.1.41), live pid
  const r = await runCli(["doctor", "--json"], {
    CLIPY_API_KEY: MOCK_KEY,
    CLIPY_API_URL: base,
    CLIPY_BRIDGE_FILE: bridgeFile,
    NO_COLOR: "1",
  });
  const checks = byName(JSON.parse(r.stdout));
  assert.equal(checks.bridge.status, "fail", "appVersion < MIN → bridge fail");
  assert.match(checks.bridge.hint || "", /clipy\.online\/download/);
});

await test("doctor --json: no key → auth fails", async () => {
  const bridgeFile = writeBridge({});
  const r = await runCli(["doctor", "--json"], {
    CLIPY_API_URL: base,
    CLIPY_API_KEY: "", // explicitly unset
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "clipy-empty-")), // no stored key
    CLIPY_BRIDGE_FILE: bridgeFile,
    NO_COLOR: "1",
  });
  const checks = byName(JSON.parse(r.stdout));
  assert.equal(checks.auth.status, "fail", "no key → auth fail");
  assert.match(checks.auth.hint || "", /clipy login/);
});

await test("doctor --json: live socket handshake passes when versions match", async () => {
  const { srv, sockPath } = await startMockBridgeSocket("0.1.41");
  try {
    const bridgeFile = writeBridge({ socketPath: sockPath, appVersion: "0.1.41" });
    const r = await runCli(["doctor", "--json"], {
      CLIPY_API_KEY: MOCK_KEY,
      CLIPY_API_URL: base,
      CLIPY_BRIDGE_FILE: bridgeFile,
      NO_COLOR: "1",
    });
    const checks = byName(JSON.parse(r.stdout));
    assert.equal(checks["bridge"].status, "pass", "file check passes");
    assert.ok(checks["bridge mtime"], "mtime line present");
    assert.equal(checks["bridge socket"].status, "pass", "socket openable");
    assert.equal(checks["bridge handshake"].status, "pass", "handshake ok, versions match");
  } finally {
    srv.close();
  }
});

await test("doctor --json: handshake version mismatch is a stale-artifact failure", async () => {
  const { srv, sockPath } = await startMockBridgeSocket("0.1.99"); // app reports a different version
  try {
    const bridgeFile = writeBridge({ socketPath: sockPath, appVersion: "0.1.41" });
    const r = await runCli(["doctor", "--json"], {
      CLIPY_API_KEY: MOCK_KEY,
      CLIPY_API_URL: base,
      CLIPY_BRIDGE_FILE: bridgeFile,
      NO_COLOR: "1",
    });
    const j = JSON.parse(r.stdout);
    const checks = byName(j);
    assert.equal(checks["bridge socket"].status, "pass", "socket opens");
    assert.equal(checks["bridge handshake"].status, "fail", "version mismatch → handshake fail");
    assert.match(checks["bridge handshake"].detail, /stale bridge artifact/);
    assert.equal(j.ok, false);
    assert.equal(r.code, 1);
  } finally {
    srv.close();
  }
});

await test("record --type <bogus> is a usage error (exit 2) with the accepted list", async () => {
  const r = await runCli(["record", "--url", "http://127.0.0.1:1/x", "--type", "definitely-not-a-kind", "--api-url", base], {
    CLIPY_API_KEY: MOCK_KEY,
    NO_COLOR: "1",
  });
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /not a recording kind/);
  assert.match(r.stderr, /bug_report/);
});

await test("record --note with a malformed pass directive is a usage error (exit 2)", async () => {
  const r = await runCli(["record", "--url", "http://127.0.0.1:1/x", "--note", "pass2 no colon here", "--api-url", base], {
    CLIPY_API_KEY: MOCK_KEY,
    NO_COLOR: "1",
  });
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /pass-scoped notes/);
});

server.close();
if (failures > 0) {
  console.error(`\n${failures} doctor test(s) failed`);
  process.exit(1);
}
console.log("\nall doctor tests passed");
