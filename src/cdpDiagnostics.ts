/**
 * Browser bug evidence for recordings Clipy drives itself (`clipy session`
 * with the headless web source): the same v2 browser-diagnostics sidecar the
 * Chrome extension uploads, built from Playwright's page events instead of a
 * page-world script. This is parity with `jam record --cdp`: an agent's
 * verification run carries console errors, failed requests and socket
 * activity alongside the video, readable through the same Evidence tab, AREC
 * section and `get_browser_diagnostics` tool.
 *
 * Source is `cdp`: the browser reported it, page code did not get a say in
 * what was recorded (page-authored text inside it is still untrusted).
 *
 * Privacy: the default tier never reads headers or bodies. With
 * `--network-detail`, cookie and authorization headers are dropped here,
 * before anything leaves the machine, and the server redacts headers, bodies
 * and messages again at ingest exactly as it does for the extension.
 */

export type DiagnosticsLevel = "off" | "errors" | "all";

export interface CdpDiagnosticsOptions {
  level: DiagnosticsLevel;
  networkDetail: boolean;
  /** Epoch ms of the recording's t=0. */
  recordStart: () => number;
}

// Structural slices of Playwright, so the CLI typechecks without it.
interface PwRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  postData(): string | null;
  failure(): { errorText: string } | null;
  response(): Promise<PwResponse | null>;
  allHeaders?(): Promise<Record<string, string>>;
  sizes?(): Promise<{ responseBodySize: number }>;
  timing(): {
    startTime: number;
    domainLookupStart: number;
    domainLookupEnd: number;
    connectStart: number;
    connectEnd: number;
    requestStart: number;
    responseStart: number;
    responseEnd: number;
  };
  frame?(): { parentFrame(): unknown } | null;
}
interface PwResponse {
  status(): number;
  headers(): Record<string, string>;
  allHeaders?(): Promise<Record<string, string>>;
  headerValue?(name: string): Promise<string | null>;
  body(): Promise<Buffer>;
}
interface PwConsole {
  type(): string;
  text(): string;
  location?(): { url?: string; lineNumber?: number; columnNumber?: number };
}
interface PwWebSocket {
  url(): string;
  on(event: string, handler: (arg: never) => void): unknown;
}
interface PwFrameLike {
  url(): string;
  parentFrame(): unknown;
}
interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: never) => void): unknown;
}
export interface DiagnosticsPage {
  on(event: string, handler: (arg: never) => void): unknown;
  /** Chromium only: EventSource traffic has no Playwright event, so it is read
   *  over a CDP session on the same page. */
  context?(): { newCDPSession?(page: unknown): Promise<CdpSessionLike> };
  /** Playwright evaluates a string as an expression in the page. */
  evaluate<R>(expression: string): Promise<R>;
  /** The top-level document's address, when attaching to a page that already
   *  loaded one. */
  url?(): string;
}

/** Runs in the page. A string, because the CLI builds without DOM types. */
const ENVIRONMENT_PROBE = `(() => {
  const c = navigator.connection || {};
  return {
    page_url: location.href,
    platform: navigator.platform || null,
    language: navigator.language || null,
    viewport_width: innerWidth,
    viewport_height: innerHeight,
    device_pixel_ratio: devicePixelRatio || null,
    timezone_offset_minutes: new Date().getTimezoneOffset(),
    user_agent: navigator.userAgent,
    screen_width: screen.width,
    screen_height: screen.height,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    connection_type: c.effectiveType || null,
    downlink_mbps: typeof c.downlink === "number" ? c.downlink : null,
    rtt_ms: typeof c.rtt === "number" ? c.rtt : null,
  };
})()`;

const MAX_EVENTS = 2_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_CHARS = 16_384;
const MAX_REQUEST_BODY_CHARS = 8_192;
const MAX_FRAME_CHARS = 2_048;
const MAX_FRAMES_PER_SOCKET = 200;
/** Never leave the machine, whatever the policy. */
const WITHHELD_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
]);
const DEFAULT_EXCLUDED_ORIGINS = [
  "accounts.google.com",
  "securetoken.googleapis.com",
  "identitytoolkit.googleapis.com",
  "login.microsoftonline.com",
  "login.live.com",
  "*.okta.com",
  "*.auth0.com",
  "*.onelogin.com",
  "*.duosecurity.com",
  "appleid.apple.com",
];

type Event = Record<string, unknown> & { kind: string; time_ms: number };

const CONSOLE_LEVEL: Record<string, { level: string; method?: string }> = {
  error: { level: "error" },
  warning: { level: "warn" },
  info: { level: "info" },
  log: { level: "log" },
  debug: { level: "debug" },
  trace: { level: "log", method: "trace" },
  table: { level: "log", method: "table" },
  dir: { level: "log", method: "dir" },
  dirxml: { level: "log", method: "dir" },
  count: { level: "log", method: "count" },
  assert: { level: "error", method: "assert" },
};

function excludedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url.replace(/^ws/i, "http")).hostname.toLowerCase();
  } catch {
    return false;
  }
  return DEFAULT_EXCLUDED_ORIGINS.some((pattern) =>
    pattern.startsWith("*.") ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern,
  );
}

function withheldHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key.startsWith(":")) continue; // HTTP/2 pseudo-headers
    out[key] = WITHHELD_HEADERS.has(key) ? "[redacted]" : value;
  }
  return Object.keys(out).length ? out : undefined;
}

function isTextual(mime: string | null): boolean {
  return (
    !mime ||
    /^text\//.test(mime) ||
    /(json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded|csv|yaml|html)/.test(mime)
  );
}

function graphqlOf(url: string, body: string | null): { operation?: string; operation_type?: string } | null {
  try {
    let candidate: unknown = null;
    if (body && /^\s*[{[]/.test(body) && body.length < 512 * 1024) candidate = JSON.parse(body);
    else if (/[?&]query=/.test(url)) {
      const params = new URL(url).searchParams;
      candidate = { query: params.get("query"), operationName: params.get("operationName") };
    }
    const first = (Array.isArray(candidate) ? candidate[0] : candidate) as
      | { query?: unknown; operationName?: unknown; extensions?: { persistedQuery?: unknown } }
      | null;
    if (!first || typeof first !== "object") return null;
    const hasQuery = typeof first.query === "string";
    if (!hasQuery && !first.extensions?.persistedQuery) return null;
    const declared = hasQuery ? /^\s*(query|mutation|subscription)\b\s*([A-Za-z_][A-Za-z0-9_]*)?/.exec(first.query as string) : null;
    const operation = (typeof first.operationName === "string" && first.operationName) || declared?.[2];
    return {
      ...(operation ? { operation } : {}),
      ...(declared?.[1] ? { operation_type: declared[1] } : {}),
    };
  } catch {
    return null;
  }
}

function graphqlErrors(text: string): { errors: number; first_error?: string } | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    let errors = 0;
    let first: string | undefined;
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const list = (item as { errors?: unknown })?.errors;
      if (Array.isArray(list) && list.length) {
        errors += list.length;
        const message = (list[0] as { message?: unknown })?.message;
        first ??= typeof message === "string" ? message.slice(0, 500) : undefined;
      }
    }
    return { errors, ...(first ? { first_error: first } : {}) };
  } catch {
    return null;
  }
}

function span(a: number, b: number): number | undefined {
  return a >= 0 && b >= a ? Math.round(b - a) : undefined;
}

export interface CdpDiagnostics {
  /** The sidecar to upload, or null when capture was off or saw nothing. */
  sidecar(): Record<string, unknown> | null;
  /** Resolves once EventSource listening is in place; await it before the
   *  first navigation so that load's streams are seen. Never rejects. */
  ready: Promise<void>;
  /** Waits for in-flight response-body reads, so the last requests make it. */
  settle(): Promise<void>;
}

/** The server's sidecar limits (lib/browserDiagnostics.ts), with headroom for
 *  the redaction markers its normalizer may add. */
const SIDECAR_BUDGET_BYTES = Math.floor(2 * 1024 * 1024 * 0.9);
const SIDECAR_FULL_DETAIL_BUDGET_BYTES = Math.floor(6 * 1024 * 1024 * 0.9);

type SidecarDraft = {
  policy: { networkDetail: "full" | "off" };
  events: Array<Record<string, unknown> & { kind: string; time_ms: number }>;
  dropped_events: number;
  [key: string]: unknown;
};

/** Same order as the extension's trim: bodies and socket frames of successful
 *  traffic first, then all of them, then the oldest events. A request without
 *  its body is still evidence; an over-budget sidecar is rejected outright. */
export function trimToBudget<T extends SidecarDraft>(sidecar: T): T {
  const budget = sidecar.policy.networkDetail === "full" ? SIDECAR_FULL_DETAIL_BUDGET_BYTES : SIDECAR_BUDGET_BYTES;
  const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (sizeOf(sidecar) <= budget) return sidecar;
  const events = sidecar.events.slice();
  let trimmed: T = { ...sidecar, events };
  for (const keepFailures of [true, false]) {
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const failed = event.outcome !== undefined && event.outcome !== "success";
      if (event.kind === "network" && (event.request_body !== undefined || event.response_body !== undefined)) {
        if (keepFailures && failed) continue;
        const { request_body, response_body, ...rest } = event;
        events[index] = {
          ...rest,
          body_omitted: {
            ...(request_body !== undefined ? { request: "too_large" } : {}),
            ...(response_body !== undefined ? { response: "too_large" } : {}),
          },
        } as typeof event;
      } else if (event.kind === "stream" && event.data !== undefined && (!keepFailures || event.action === "message")) {
        const { data: _data, ...rest } = event;
        events[index] = rest as typeof event;
      }
    }
    trimmed = { ...sidecar, events: events.slice() };
    if (sizeOf(trimmed) <= budget) return trimmed;
  }
  while (trimmed.events.length > 0 && sizeOf(trimmed) > budget) {
    const drop = Math.max(1, Math.ceil(trimmed.events.length / 10));
    trimmed = { ...trimmed, events: trimmed.events.slice(drop), dropped_events: trimmed.dropped_events + drop };
  }
  return trimmed;
}

export function attachCdpDiagnostics(page: DiagnosticsPage, opts: CdpDiagnosticsOptions): CdpDiagnostics {
  const events: Event[] = [];
  let dropped = 0;
  let environment: Record<string, unknown> | null = null;
  let firstNavigation = true;
  // While the top-level page is an excluded site (a sign-in provider), nothing
  // is recorded at all: its console, errors and requests to other hosts carry
  // no page origin the server could filter them by afterwards.
  let pageExcluded = (() => {
    try {
      const url = page.url?.() ?? "";
      return /^https?:/i.test(url) && excludedHost(url);
    } catch {
      return false;
    }
  })();
  let socketCounter = 0;
  const pending: Array<Promise<void>> = [];
  const all = opts.level === "all";

  // `startedOnAllowedPage`: a request decides by the page that started it,
  // not by the page that is current when it finishes.
  const push = (event: Omit<Event, "time_ms">, atMs = Date.now(), startedOnAllowedPage = false) => {
    if (pageExcluded && !startedOnAllowedPage) return;
    if (events.length >= MAX_EVENTS) {
      dropped++;
      return;
    }
    // Anything before the recording's t=0 (the first page load can land just
    // before it) is pinned to 0 rather than given an epoch-sized offset.
    const start = opts.recordStart();
    events.push({ ...event, time_ms: start > 0 ? Math.max(0, atMs - start) : 0 } as Event);
  };
  const guard = (fn: () => void | Promise<void>) => {
    try {
      const result = fn();
      if (result instanceof Promise) pending.push(result.catch(() => undefined));
    } catch {
      // Evidence capture must never take the recording down.
    }
  };

  if (opts.level === "off") return { sidecar: () => null, ready: Promise.resolve(), settle: async () => undefined };

  page.on("console", ((msg: PwConsole) =>
    guard(() => {
      const mapped = CONSOLE_LEVEL[msg.type()] ?? { level: "log" };
      if (!all && mapped.level !== "error" && mapped.level !== "warn") return;
      const location = msg.location?.();
      const where = location?.url ? `at ${location.url}:${(location.lineNumber ?? 0) + 1}:${(location.columnNumber ?? 0) + 1}` : undefined;
      push({
        kind: "console",
        level: mapped.level,
        message: msg.text() || "(empty)",
        ...(mapped.method ? { method: mapped.method } : {}),
        ...(where && (mapped.level === "error" || mapped.level === "warn" || mapped.method === "trace") ? { stack: where } : {}),
      });
    })) as never);

  page.on("pageerror", ((error: Error) =>
    guard(() => {
      push({ kind: "error", message: `${error.name}: ${error.message}`, ...(error.stack ? { stack: error.stack } : {}) });
    })) as never);

  page.on("framenavigated", ((frame: PwFrameLike) =>
    guard(() => {
      if (frame.parentFrame() !== null) return;
      const url = frame.url();
      pageExcluded = /^https?:/i.test(url) && excludedHost(url);
      if (!/^https?:/i.test(url) || pageExcluded) return;
      push({ kind: "navigation", navigation: firstNavigation ? "initial" : "push_state", url });
      if (firstNavigation) {
        firstNavigation = false;
        pending.push(
          page
            .evaluate<Record<string, unknown>>(ENVIRONMENT_PROBE)
            .then((env) => {
              const ua = String(env.user_agent ?? "");
              const chrome = /(?:HeadlessChrome|Chrome)\/([\d.]+)/.exec(ua);
              environment = {
                ...env,
                browser_name: chrome ? (ua.includes("HeadlessChrome") ? "Chrome (headless)" : "Chrome") : null,
                browser_version: chrome?.[1] ?? null,
                os_name: process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux",
              };
            })
            .catch(() => undefined),
        );
      }
    })) as never);

  // A document loaded into the tab's main frame (not an iframe's).
  const isTopLevelDocument = (request: PwRequest): boolean => {
    if (request.resourceType() !== "document") return false;
    try {
      const frame = request.frame?.();
      return !!frame && frame.parentFrame() === null;
    } catch {
      return false;
    }
  };
  // Whether the top-level page was an excluded site when each request began.
  const startedExcluded = new WeakMap<object, boolean>();
  page.on("request", ((request: PwRequest) => guard(() => void startedExcluded.set(request, pageExcluded))) as never);

  const onRequestDone = (request: PwRequest, failed: boolean) =>
    guard(async () => {
      const finishedAt = Date.now();
      const url = request.url();
      if (!/^https?:/i.test(url) || excludedHost(url)) return;
      const type = request.resourceType();
      if (type === "websocket") return;
      // A request started on an excluded page is never read, even if it
      // finishes after the tab has moved on; one started on an allowed page
      // is kept even if it finishes after the tab reached an excluded one.
      // A top-level navigation is judged by its own address (checked above):
      // it is the tab leaving the excluded page. A frame's document is part of
      // the page that holds it, so it keeps that page's exclusion.
      const begunExcluded = isTopLevelDocument(request) ? false : startedExcluded.get(request) ?? pageExcluded;
      if (begunExcluded) return;
      // A failed request can still have a response: Chrome reports a 404
      // script as net::ERR_ABORTED after the 404 arrived. The status wins.
      const response = await request.response().catch(() => null);
      const status = response ? response.status() : null;
      const timing = request.timing();
      const duration = timing.responseEnd >= 0 ? timing.responseEnd : Math.max(0, finishedAt - timing.startTime);
      const transport =
        type === "fetch" || type === "xhr" ? type : type === "document" ? "document" : "resource";
      // Metadata mode never materializes what the page submitted. An address
      // naming GraphQL still marks the request as one, without an operation
      // name, so its reply is checked for errors.
      const postData = opts.networkDetail ? request.postData() : null;
      const graphql =
        transport === "fetch" || transport === "xhr"
          ? graphqlOf(url, postData) ?? (/graphql/i.test(url) ? {} : null)
          : null;
      const failure = request.failure();
      const aborted = failed && /ERR_ABORTED/.test(failure?.errorText ?? "");
      let outcome =
        status !== null && status >= 400
          ? "http_error"
          : failed
            ? aborted
              ? "aborted"
              : "network_error"
            : "success";
      // The header map is full-detail evidence. Metadata reads only the two
      // values it needs: the content type it reports, and the length that
      // keeps an oversized body from being read.
      const headerOf = async (name: string): Promise<string | undefined> => {
        if (!response) return undefined;
        if (response.headerValue) return (await response.headerValue(name).catch(() => null)) ?? undefined;
        return opts.networkDetail ? response.headers()[name] : undefined;
      };
      const contentType = await headerOf("content-type");
      const contentLength = await headerOf("content-length");
      const mime = (contentType ?? "").split(";")[0].trim().toLowerCase() || null;
      const readBody =
        response &&
        status !== null &&
        !(status >= 300 && status < 400) &&
        isTextual(mime) &&
        mime !== "text/event-stream" &&
        // Failures-only capture never reads a successful body for its own
        // sake; only the GraphQL check may look at one.
        ((opts.networkDetail && (all || outcome !== "success")) || (graphql && /json/.test(mime ?? "json")));
      let bodyText: string | undefined;
      let bodySize: number | undefined;
      let bodyOmitted: "too_large" | "unreadable" | undefined;
      // response.body() buffers the whole payload, so it is only called once
      // the size is known to fit: the declared length, or else the size the
      // browser received. A body whose size cannot be known is not read.
      let knownSize: number | undefined =
        contentLength !== undefined && Number.isFinite(Number(contentLength)) ? Number(contentLength) : undefined;
      if (readBody && knownSize === undefined) {
        const sizes = await request.sizes?.().catch(() => null);
        if (sizes && Number.isFinite(sizes.responseBodySize) && sizes.responseBodySize >= 0) knownSize = sizes.responseBodySize;
      }
      if (readBody && knownSize === undefined) {
        bodyOmitted = "unreadable";
        if (graphql && !all && outcome === "success") dropped++;
      } else if (readBody && knownSize !== undefined && knownSize > MAX_BODY_BYTES) {
        // Never materialize a body larger than the cap just to cut it.
        bodySize = knownSize;
        bodyOmitted = "too_large";
        // A GraphQL reply too large to check for errors[] would pass as a
        // success and vanish under failures-only capture: a capture gap.
        if (graphql && !all && outcome === "success") dropped++;
      } else if (readBody) {
        const body = await response.body().catch(() => null);
        if (body) {
          bodySize = body.length;
          bodyText = body.subarray(0, MAX_BODY_BYTES).toString("utf8");
        } else {
          bodyOmitted = "unreadable";
          // The GraphQL check could not run: a gap, not a silent success.
          if (graphql && !all && outcome === "success") dropped++;
        }
      }
      let graphqlSummary: Record<string, unknown> | null = graphql;
      if (graphql && bodyText) {
        const errors = graphqlErrors(bodyText);
        if (errors && errors.errors > 0) {
          graphqlSummary = { ...graphql, ...errors };
          if (outcome === "success") outcome = "graphql_error";
        }
      }
      if (!all && outcome === "success") return;
      const detail: Record<string, unknown> = {};
      if (opts.networkDetail) {
        detail.full_url = url;
        const requestHeaders = withheldHeaders(await request.allHeaders?.().catch(() => undefined));
        const responseHeaders = withheldHeaders(
          response ? await (response.allHeaders?.() ?? Promise.resolve(response.headers())).catch(() => response.headers()) : undefined,
        );
        if (requestHeaders) detail.request_headers = requestHeaders;
        if (responseHeaders) detail.response_headers = responseHeaders;
        if (postData) detail.request_body = postData.slice(0, MAX_REQUEST_BODY_CHARS * 4);
        if (bodyText) detail.response_body = bodyText.slice(0, MAX_BODY_CHARS * 4);
        else if (bodyOmitted) detail.body_omitted = { response: bodyOmitted };
        else if (response && !isTextual(mime)) detail.body_omitted = { response: "binary" };
        else if (mime === "text/event-stream") detail.body_omitted = { response: "streaming" };
      }
      push(
        {
          kind: "network",
          transport,
          method: request.method(),
          url,
          status,
          duration_ms: Math.max(0, Math.round(duration)),
          outcome,
          ...(failure && !aborted && status === null ? { error: failure.errorText } : {}),
          ...(transport === "resource" || transport === "document" ? { resource_type: type } : {}),
          ...(mime ? { response_type: mime } : {}),
          ...(bodySize !== undefined ? { response_size: bodySize } : {}),
          ...(postData ? { request_body_size: Buffer.byteLength(postData) } : {}),
          ...(graphqlSummary && Object.keys(graphqlSummary).length ? { graphql: graphqlSummary } : {}),
          timing: {
            ...(span(timing.domainLookupStart, timing.domainLookupEnd) ? { dns_ms: span(timing.domainLookupStart, timing.domainLookupEnd) } : {}),
            ...(span(timing.connectStart, timing.connectEnd) ? { connect_ms: span(timing.connectStart, timing.connectEnd) } : {}),
            ...(span(timing.requestStart, timing.responseStart) !== undefined ? { ttfb_ms: span(timing.requestStart, timing.responseStart) } : {}),
            ...(span(timing.responseStart, timing.responseEnd) !== undefined ? { download_ms: span(timing.responseStart, timing.responseEnd) } : {}),
          },
          ...detail,
        },
        finishedAt,
        true,
      );
    });

  page.on("requestfinished", ((request: PwRequest) => onRequestDone(request, false)) as never);
  page.on("requestfailed", ((request: PwRequest) => onRequestDone(request, true)) as never);

  // EventSource: open, messages and errors from the Network domain. A stream
  // still open at the snapshot gets its totals in sidecar(), as the
  // extension reports them at stop.
  type SseState = { connection: string; url: string; messages_received: number; bytes_received: number; frames: number };
  const eventSources = new Map<string, SseState>();
  let sseCounter = 0;
  const sseClose = (state: SseState, extra: Record<string, unknown> = {}) => ({
    kind: "stream",
    protocol: "eventsource",
    connection: state.connection,
    action: "close",
    url: state.url,
    messages_received: state.messages_received,
    bytes_received: state.bytes_received,
    ...extra,
  });
  const ready = (async () => {
    const context = page.context?.();
    if (!context?.newCDPSession) return;
    const session = await context.newCDPSession(page);
    session.on("Network.requestWillBeSent", ((p: { requestId: string; type?: string; request?: { url?: string } }) =>
      guard(() => {
        const url = p.request?.url;
        if (p.type !== "EventSource" || !url || excludedHost(url) || pageExcluded) return;
        const state: SseState = { connection: `sse-${++sseCounter}`, url, messages_received: 0, bytes_received: 0, frames: 0 };
        eventSources.set(p.requestId, state);
        if (all) push({ kind: "stream", protocol: "eventsource", connection: state.connection, action: "open", url });
      })) as never);
    session.on("Network.eventSourceMessageReceived", ((p: { requestId: string; data?: string }) =>
      guard(() => {
        const state = eventSources.get(p.requestId);
        if (!state) return;
        const data = String(p.data ?? "");
        const size = Buffer.byteLength(data);
        state.messages_received++;
        state.bytes_received += size;
        if (!opts.networkDetail) return;
        if (state.frames >= MAX_FRAMES_PER_SOCKET) {
          dropped++;
          return;
        }
        state.frames++;
        push({
          kind: "stream",
          protocol: "eventsource",
          connection: state.connection,
          action: "message",
          direction: "received",
          url: state.url,
          size,
          data: data.slice(0, MAX_FRAME_CHARS * 2),
        });
      })) as never);
    session.on("Network.loadingFailed", ((p: { requestId: string; errorText?: string; canceled?: boolean }) =>
      guard(() => {
        const state = eventSources.get(p.requestId);
        if (!state) return;
        eventSources.delete(p.requestId);
        // The page calling close() cancels the request; that is not a failure.
        if (!p.canceled) {
          // Totals ride on the error too: failures-only capture keeps this
          // row and drops the close.
          push({
            kind: "stream",
            protocol: "eventsource",
            connection: state.connection,
            action: "error",
            url: state.url,
            reason: String(p.errorText ?? "stream failed").slice(0, 300),
            messages_received: state.messages_received,
            bytes_received: state.bytes_received,
          });
        }
        push(sseClose(state));
      })) as never);
    session.on("Network.loadingFinished", ((p: { requestId: string }) =>
      guard(() => {
        const state = eventSources.get(p.requestId);
        if (!state) return;
        eventSources.delete(p.requestId);
        push(sseClose(state));
      })) as never);
    await session.send("Network.enable");
  })().catch(() => undefined);

  // WebSockets still open at the snapshot get their totals there too.
  const openSockets = new Map<string, { url: string; totals: Record<string, number> }>();
  page.on("websocket", ((socket: PwWebSocket) =>
    guard(() => {
      const url = socket.url();
      if (excludedHost(url) || pageExcluded) return;
      const connection = `ws-${++socketCounter}`;
      const totals = { messages_sent: 0, messages_received: 0, bytes_sent: 0, bytes_received: 0 };
      let frames = 0;
      openSockets.set(connection, { url, totals });
      if (all) push({ kind: "stream", protocol: "websocket", connection, action: "open", url });
      const frame = (direction: "sent" | "received") =>
        ((data: { payload: string | Buffer }) =>
          guard(() => {
            const size = typeof data.payload === "string" ? Buffer.byteLength(data.payload) : data.payload.length;
            if (direction === "sent") {
              totals.messages_sent++;
              totals.bytes_sent += size;
            } else {
              totals.messages_received++;
              totals.bytes_received += size;
            }
            if (!opts.networkDetail) return;
            if (frames >= MAX_FRAMES_PER_SOCKET) {
              dropped++;
              return;
            }
            frames++;
            push({
              kind: "stream",
              protocol: "websocket",
              connection,
              action: "message",
              url,
              direction,
              size,
              data: typeof data.payload === "string" ? data.payload.slice(0, MAX_FRAME_CHARS * 2) : `[binary ${size} bytes]`,
            });
          })) as never;
      socket.on("framesent", frame("sent"));
      socket.on("framereceived", frame("received"));
      socket.on("socketerror", ((error: string) =>
        // Totals ride on the error: failures-only capture keeps it and drops
        // the code-less close Playwright reports after it.
        guard(() => push({ kind: "stream", protocol: "websocket", connection, action: "error", url, reason: String(error).slice(0, 300), ...totals }))) as never);
      socket.on("close", (() =>
        guard(() => {
          openSockets.delete(connection);
          push({ kind: "stream", protocol: "websocket", connection, action: "close", url, ...totals });
        })) as never);
    })) as never);

  return {
    sidecar() {
      if (events.length === 0 && environment === null) return null;
      // Streams still open now: their totals, stamped with the stop time so
      // the connection's duration runs to the end of the recording, within
      // the event cap (the rest count as dropped below).
      const start = opts.recordStart();
      const stoppedAt = start > 0 ? Math.max(0, Date.now() - start) : 0;
      const stillOpen = "still open when the recording stopped";
      // Only full capture keeps a healthy connection; failures-only capture
      // drops it at ingest like a successful request, so it takes no slot.
      // A failed one already reported its totals on the error row.
      const open = !all ? [] : [
        ...[...eventSources.values()].map((state) => sseClose(state, { reason: stillOpen })),
        ...[...openSockets.entries()].map(([connection, socket]) => ({
          kind: "stream",
          protocol: "websocket",
          connection,
          action: "close",
          url: socket.url,
          reason: stillOpen,
          ...socket.totals,
        })),
      ];
      const room = Math.max(0, MAX_EVENTS - events.length);
      return trimToBudget({
        schema_version: 2,
        source: "cdp",
        policy: {
          console: all ? "all" : "errors",
          network: all ? "all" : "failures",
          navigation: true,
          urls: "route",
          text: "standard",
          excludedOrigins: DEFAULT_EXCLUDED_ORIGINS,
          networkDetail: opts.networkDetail ? "full" : "off",
          // Playwright drives the clicks; they are already the agent's marks.
          actions: false,
        },
        environment,
        events: [...events, ...open.slice(0, room).map((row) => ({ ...row, time_ms: stoppedAt }))].sort(
          (a, b) => a.time_ms - b.time_ms,
        ),
        dropped_events: dropped + Math.max(0, open.length - room),
      });
    },
    ready,
    async settle() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}
