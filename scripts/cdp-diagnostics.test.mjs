// Browser evidence for Clipy-driven sessions (src/cdpDiagnostics.ts), against
// the scripted bug playground in a real Chromium.
//
// Needs playwright-core (CLIPY_PLAYWRIGHT_CORE or a normal import) and the
// monorepo's extension/test-harness/bug-playground; without either it prints
// SKIP and exits 0 (the published CLI mirror has no playground).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attachCdpDiagnostics, trimToBudget } from "../dist/cdpDiagnostics.js";

// The sidecar is cut to the server's budget before upload (no browser needed).
{
  const body = "x".repeat(60_000);
  const events = Array.from({ length: 200 }, (_, i) => ({
    kind: "network", time_ms: i, method: "GET", url: `https://a.example/${i}`, status: i % 10 === 0 ? 500 : 200,
    outcome: i % 10 === 0 ? "http_error" : "success", request_body: body, response_body: body,
  }));
  const trimmed = trimToBudget({ policy: { networkDetail: "full" }, events, dropped_events: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= 6 * 1024 * 1024, "trimmed under the full-detail budget");
  assert.equal(trimmed.events.length, 200, "bodies go before events");
  assert.ok(trimmed.events.every((e) => e.outcome === "success" ? e.response_body === undefined : e.response_body === body), "failures keep their bodies first");
  assert.deepEqual(trimmed.events[1].body_omitted, { request: "too_large", response: "too_large" });
  const small = { policy: { networkDetail: "off" }, events: events.slice(0, 1).map(({ request_body, response_body, ...e }) => e), dropped_events: 0 };
  assert.equal(trimToBudget(small), small, "an in-budget sidecar is returned untouched");
  console.log("cdp diagnostics trim tests passed");
}

// Streams still open at stop are closed out within the 2,000-event cap.
{
  const handlers = {};
  const sessionHandlers = {};
  const page = {
    on: (event, handler) => { handlers[event] = handler; },
    evaluate: async () => ({}),
    context: () => ({
      newCDPSession: async () => ({
        on: (event, handler) => { sessionHandlers[event] = handler; },
        send: async () => undefined,
      }),
    }),
  };
  const evidence = attachCdpDiagnostics(page, { level: "all", networkDetail: false, recordStart: () => Date.now() });
  await evidence.ready;
  for (let i = 0; i < 2_100; i++) handlers.console({ type: () => "log", text: () => `line ${i}`, location: () => ({}) });
  for (let i = 0; i < 3; i++) sessionHandlers["Network.requestWillBeSent"]({ requestId: `r${i}`, type: "EventSource", request: { url: `https://app.example/sse${i}` } });
  await evidence.settle();
  const capped = evidence.sidecar();
  assert.ok(capped.events.length <= 2_000, `event cap respected: ${capped.events.length}`);
  assert.ok(capped.dropped_events >= 103, `overflow counted as dropped: ${capped.dropped_events}`);
  console.log("cdp diagnostics cap tests passed");
}

// WebSockets and EventSources still open at stop get totals, stamped at stop.
{
  const handlers = {};
  const sessionHandlers = {};
  const page = {
    on: (event, handler) => { handlers[event] = handler; },
    evaluate: async () => ({}),
    context: () => ({
      newCDPSession: async () => ({
        on: (event, handler) => { sessionHandlers[event] = handler; },
        send: async () => undefined,
      }),
    }),
  };
  const started = Date.now() - 5_000;
  const evidence = attachCdpDiagnostics(page, { level: "all", networkDetail: false, recordStart: () => started });
  await evidence.ready;
  const socketHandlers = {};
  handlers.websocket({ url: () => "wss://app.example/live", on: (event, handler) => { socketHandlers[event] = handler; } });
  socketHandlers.framereceived({ payload: "hello" });
  socketHandlers.framereceived({ payload: "\u{1F44D}" });
  sessionHandlers["Network.requestWillBeSent"]({ requestId: "s1", type: "EventSource", request: { url: "https://app.example/sse" } });
  handlers.console({ type: () => "error", text: () => "boom", location: () => ({}) });
  await evidence.settle();
  const snapshot = evidence.sidecar();
  const closes = snapshot.events.filter((event) => event.kind === "stream" && event.action === "close");
  const ws = closes.find((event) => event.protocol === "websocket");
  assert.ok(ws, "open WebSocket closed out in the snapshot");
  assert.equal(ws.messages_received, 2);
  assert.equal(ws.bytes_received, 9, "text frames counted in UTF-8 bytes");
  assert.ok(closes.every((event) => event.time_ms >= 4_900), `closes stamped at stop: ${closes.map((event) => event.time_ms)}`);
  console.log("cdp diagnostics open-stream tests passed");
}

// Failures-only capture spends no slot on a healthy open stream, and
// metadata capture never enumerates response headers.
{
  const handlers = {};
  const page = { on: (event, handler) => { handlers[event] = handler; }, evaluate: async () => ({}) };
  const evidence = attachCdpDiagnostics(page, { level: "errors", networkDetail: false, recordStart: () => Date.now() - 1_000 });
  await evidence.ready;
  const socketHandlers = {};
  handlers.websocket({ url: () => "wss://app.example/live", on: (event, handler) => { socketHandlers[event] = handler; } });
  let enumerated = false;
  const response = {
    status: () => 500,
    headers: () => { enumerated = true; return { "content-type": "application/json" }; },
    allHeaders: async () => { enumerated = true; return {}; },
    headerValue: async (name) => (name === "content-type" ? "application/json; charset=utf-8" : null),
    body: async () => Buffer.from("{}"),
  };
  handlers.requestfinished({
    url: () => "https://app.example/api/thing",
    resourceType: () => "fetch",
    response: async () => response,
    timing: () => ({ startTime: Date.now(), responseEnd: 5, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, connectEnd: -1, requestStart: -1, responseStart: -1 }),
    failure: () => null,
    method: () => "GET",
    postData: () => null,
    headers: () => ({}),
    allHeaders: async () => ({}),
  });
  let bodyRead = false;
  handlers.requestfinished({
    url: () => "https://app.example/graphql",
    resourceType: () => "fetch",
    response: async () => ({
      status: () => 200,
      headers: () => ({}),
      headerValue: async (name) => (name === "content-type" ? "application/json" : null),
      body: async () => { bodyRead = true; return Buffer.from('{"errors":[{"message":"x"}]}'); },
    }),
    timing: () => ({ startTime: Date.now(), responseEnd: 5, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, connectEnd: -1, requestStart: -1, responseStart: -1 }),
    failure: () => null,
    method: () => "POST",
    postData: () => null,
    headers: () => ({}),
  });
  handlers.console({ type: () => "error", text: () => "boom", location: () => ({}) });
  await evidence.settle();
  const snapshot = evidence.sidecar();
  assert.equal(bodyRead, false, "a body of unknown size is never buffered");
  assert.ok(!snapshot.events.some((event) => event.kind === "stream"), "no synthesized healthy close under failures capture");
  const request = snapshot.events.find((event) => event.kind === "network");
  assert.equal(request?.response_type, "application/json");
  assert.equal(enumerated, false, "metadata capture never enumerates response headers");
  console.log("cdp diagnostics metadata-header tests passed");
}

// While the top-level page is an excluded site, nothing is recorded.
{
  const handlers = {};
  const page = { on: (event, handler) => { handlers[event] = handler; }, evaluate: async () => ({}) };
  const evidence = attachCdpDiagnostics(page, { level: "all", networkDetail: false, recordStart: () => Date.now() - 1_000 });
  await evidence.ready;
  const main = (url) => ({ url: () => url, parentFrame: () => null });
  handlers.framenavigated(main("https://accounts.google.com/signin"));
  handlers.console({ type: () => "error", text: () => "SIGNIN-SECRET", location: () => ({}) });
  handlers.pageerror(new Error("SIGNIN-ERROR"));
  handlers.framenavigated(main("https://app.example/home"));
  handlers.console({ type: () => "error", text: () => "APP-ERROR", location: () => ({}) });
  await evidence.settle();
  const json = JSON.stringify(evidence.sidecar());
  assert.ok(!json.includes("SIGNIN"), "an excluded page's console and errors are not recorded");
  assert.ok(json.includes("APP-ERROR") && json.includes("app.example/home"), "recording resumes once the page leaves the excluded site");
}

// A request is judged by the page that started it, not the one it finishes on.
{
  const handlers = {};
  const page = { on: (event, handler) => { handlers[event] = handler; }, evaluate: async () => ({}) };
  const evidence = attachCdpDiagnostics(page, { level: "all", networkDetail: false, recordStart: () => Date.now() - 1_000 });
  await evidence.ready;
  const main = (url) => ({ url: () => url, parentFrame: () => null });
  const request = (url) => ({
    url: () => url,
    resourceType: () => "fetch",
    response: async () => ({ status: () => 500, headers: () => ({}), headerValue: async () => null, body: async () => Buffer.from("") }),
    timing: () => ({ startTime: Date.now(), responseEnd: 5, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, connectEnd: -1, requestStart: -1, responseStart: -1 }),
    failure: () => null,
    method: () => "POST",
    postData: () => null,
    headers: () => ({}),
  });
  handlers.framenavigated(main("https://accounts.google.com/signin"));
  const fromSignIn = request("https://telemetry.example/from-signin");
  handlers.request(fromSignIn);
  handlers.framenavigated(main("https://app.example/home"));
  const fromApp = request("https://app.example/api/from-app");
  handlers.request(fromApp);
  handlers.requestfinished(fromSignIn);
  handlers.framenavigated(main("https://accounts.google.com/signin"));
  handlers.requestfinished(fromApp);
  await evidence.settle();
  const json = JSON.stringify(evidence.sidecar());
  assert.ok(!json.includes("from-signin"), "a request started on an excluded page is not recorded after leaving it");
  assert.ok(json.includes("from-app"), "a request started on an allowed page is kept when it finishes on an excluded one");
  console.log("cdp diagnostics request-origin tests passed");
}

// On an excluded page, an iframe's document stays excluded; only the tab's own
// navigation away from the page is judged by its new address.
{
  const handlers = {};
  const page = { on: (event, handler) => { handlers[event] = handler; }, evaluate: async () => ({}) };
  const evidence = attachCdpDiagnostics(page, { level: "all", networkDetail: false, recordStart: () => Date.now() - 1_000 });
  await evidence.ready;
  const main = (url) => ({ url: () => url, parentFrame: () => null });
  const child = { url: () => "https://widget.example/embed", parentFrame: () => main("https://accounts.google.com/signin") };
  const documentRequest = (url, frame) => ({
    url: () => url,
    resourceType: () => "document",
    frame: () => frame,
    response: async () => ({ status: () => 200, headers: () => ({}), headerValue: async () => null, body: async () => Buffer.from("") }),
    timing: () => ({ startTime: Date.now(), responseEnd: 5, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, connectEnd: -1, requestStart: -1, responseStart: -1 }),
    failure: () => null,
    method: () => "GET",
    postData: () => null,
    headers: () => ({}),
  });
  handlers.framenavigated(main("https://accounts.google.com/signin"));
  const iframeDoc = documentRequest("https://widget.example/embed-in-signin", child);
  handlers.request(iframeDoc);
  handlers.requestfinished(iframeDoc);
  const leaving = documentRequest("https://app.example/after-signin", main("https://app.example/after-signin"));
  handlers.request(leaving);
  handlers.requestfinished(leaving);
  await evidence.settle();
  const json = JSON.stringify(evidence.sidecar());
  assert.ok(!json.includes("embed-in-signin"), "an iframe document on an excluded page is not recorded");
  assert.ok(json.includes("after-signin"), "the tab's navigation away from an excluded page is recorded");
  console.log("cdp diagnostics excluded-iframe tests passed");
  console.log("cdp diagnostics excluded-page tests passed");
}

const here = dirname(fileURLToPath(import.meta.url));
const playgroundServer = join(here, "../../extension/test-harness/bug-playground/server.mjs");
const require = createRequire(import.meta.url);
let playwright = null;
for (const candidate of [process.env.CLIPY_PLAYWRIGHT_CORE, "playwright-core", "playwright"].filter(Boolean)) {
  try {
    playwright = require(candidate);
    break;
  } catch {}
}
if (!playwright || !existsSync(playgroundServer)) {
  console.log("SKIP cdp-diagnostics: playwright-core or the bug playground is not available");
  process.exit(0);
}

const { startPlayground } = await import(pathToFileURL(playgroundServer).href);
const server = await startPlayground(0);
const origin = `http://127.0.0.1:${server.address().port}`;

async function run(options) {
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.CLIPY_CHROMIUM_PATH ? { executablePath: process.env.CLIPY_CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage();
  let recordStart = 0;
  const evidence = attachCdpDiagnostics(page, { ...options, recordStart: () => recordStart });
  recordStart = Date.now();
  await page.goto(`${origin}/`);
  await page.waitForTimeout(300);
  await page.fill("#email", "qa@example.com");
  await page.fill("#password", "hunter2-SECRET");
  await page.click("#loginBtn");
  await page.waitForTimeout(300);
  await page.click("#applyCoupon");
  await page.waitForTimeout(300);
  await page.click("#gql");
  await page.waitForTimeout(300);
  await page.click("#ws");
  await page.waitForTimeout(900);
  await page.evaluate(() => fetch("/api/large").then((r) => r.text()));
  await page.click("#crash");
  await page.waitForTimeout(300);
  await evidence.settle();
  await page.close();
  await browser.close();
  return evidence.sidecar();
}

try {
  const off = await run({ level: "off", networkDetail: false });
  assert.equal(off, null, "level off records nothing");

  const errors = await run({ level: "errors", networkDetail: false });
  assert.equal(errors.source, "cdp");
  assert.equal(errors.policy.networkDetail, "off");
  const kinds = new Set(errors.events.map((e) => e.kind));
  assert.ok(kinds.has("console") && kinds.has("error") && kinds.has("network"), [...kinds].join(","));
  assert.ok(errors.events.some((e) => e.kind === "network" && e.status === 500 && e.url.includes("/api/cart")), "500 captured");
  assert.ok(errors.events.some((e) => e.kind === "network" && e.status === 404 && e.url.includes("missing-chunk.js")), "failed script captured");
  assert.ok(errors.events.some((e) => e.kind === "network" && e.outcome === "graphql_error" && e.url.includes("/graphql")), "GraphQL error captured");
  assert.ok(!errors.events.some((e) => e.kind === "network" && e.graphql?.operation), "no request body read for a GraphQL operation name without --network-detail");
  assert.ok(!errors.events.some((e) => e.kind === "network" && e.outcome === "success"), "successes not kept at errors level");
  assert.ok(errors.events.some((e) => e.kind === "error" && /undefinedFunctionCall/.test(e.message)), "uncaught error captured");
  assert.ok(errors.events.some((e) => e.kind === "console" && e.level === "error" && e.message.includes("NullPointerException")), "logged error body kept");
  assert.ok(!JSON.stringify(errors).includes('"response_body"'), "no bodies without --network-detail");
  assert.ok(errors.environment?.user_agent, "environment captured");

  const full = await run({ level: "all", networkDetail: true });
  const login = full.events.find((e) => e.kind === "network" && e.url.endsWith("/api/login"));
  assert.ok(login?.request_body?.includes("hunter2"), "request body kept for the server to redact");
  assert.ok(login?.response_body?.includes("token"), "response body kept");
  const profile = full.events.find((e) => e.kind === "network" && e.url.endsWith("/api/profile"));
  assert.equal(profile?.request_headers?.authorization, "[redacted]", "authorization never leaves the machine");
  assert.ok(!JSON.stringify(full).includes("SESSIONCOOKIE123"), "cookies never leave the machine");
  assert.ok(full.events.some((e) => e.kind === "stream" && e.action === "message" && e.direction === "sent"), "socket frames kept");
  const sse = full.events.filter((e) => e.kind === "stream" && e.protocol === "eventsource");
  assert.ok(sse.some((e) => e.action === "open") && sse.some((e) => e.action === "message" && e.data?.includes("tick")), `EventSource open and messages captured: ${JSON.stringify(sse)}`);
  assert.ok(sse.some((e) => e.action === "close" && e.messages_received >= 1), "EventSource totals reported");
  assert.ok(full.events.some((e) => e.kind === "network" && e.outcome === "success"), "all level keeps successes");
  assert.ok(full.events.some((e) => e.kind === "network" && e.outcome === "graphql_error" && e.graphql?.operation === "Product"), "full detail names the GraphQL operation");
  const large = full.events.find((e) => e.kind === "network" && e.url.endsWith("/api/large"));
  assert.equal(large?.body_omitted?.response, "too_large", `oversized response is not read: ${JSON.stringify(large)}`);
  assert.equal(large?.response_body, undefined);
  console.log("cdp diagnostics tests passed");
} finally {
  server.close();
}
