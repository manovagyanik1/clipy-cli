/**
 * Recording through the Clipy extension inside Chrome for Clipy, with no click.
 *
 * Chrome for Clipy launches with --allowlisted-extension-id=<Clipy extension>,
 * which lets that extension call chrome.tabCapture without the toolbar click
 * (activeTab) Chrome normally demands. The CLI reaches the extension through
 * its agent page (chrome-extension://<id>/src/agent/agent.html): it opens the
 * page over CDP and evaluates `clipyAgent.*`, each of which is one message to
 * the service worker. The extension then records and uploads exactly as it
 * does for a person, so the recording gets the extension's own pipeline
 * (upload recovery, cursor and click evidence) rather than the CLI's.
 *
 * Nothing is kept in a CLI process between commands: start, stop, abort and
 * status each reconnect, so `session start` can return and the agent can drive
 * the tab with its own tools in between.
 */

import { randomUUID } from "node:crypto";
import {
  clipyExtensionId,
  startChrome,
  type CfcBrowser,
  type CfcChromium,
  type CfcContext,
  type CfcPage,
} from "./chromeForClipy.js";

const AGENT_PAGE_PATH = "src/agent/agent.html";
const AGENT_PROTOCOL = 1;
const BUSY_STATES = new Set(["starting", "countdown", "recording", "paused", "uploading"]);

export function extensionStoreUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `https://chromewebstore.google.com/detail/${clipyExtensionId(env)}`;
}

interface AgentResult {
  recordingId: string;
  status: "complete" | "error";
  publicId?: string;
  shareUrl?: string;
  error?: string;
}

interface AgentResponse {
  ok: boolean;
  error?: string;
  signedIn?: boolean;
  user?: { email?: string };
  state?: { status: string; message?: string };
  agent?: {
    protocol: number;
    version: string;
    activeRecordingId: string | null;
    result: AgentResult | null;
  };
}

export class ExtensionUnavailableError extends Error {}
/** The extension gave a definite answer (failed upload, recording gone), so
 *  there is nothing left to retry and the session file can go. Any other error
 *  from stop is treated as transient and the file is kept. */
export class ExtensionRecordingEndedError extends Error {}

interface AgentConnection {
  browser: CfcBrowser;
  context: CfcContext;
  agent: CfcPage;
  call(expression: string): Promise<AgentResponse>;
  close(): Promise<void>;
}

async function connectAgent(chromium: CfcChromium, port: number, env: NodeJS.ProcessEnv): Promise<AgentConnection> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error("Chrome for Clipy has no browser context to attach to");
  }
  const agent = await context.newPage();
  const close = async () => {
    await agent.close().catch(() => {});
    await browser.close().catch(() => {});
  };
  const missing = () =>
    new ExtensionUnavailableError(
      `the Clipy extension (with agent support) is not installed in Chrome for Clipy. ` +
        `Run \`clipy chrome setup\`, or install it from ${extensionStoreUrl(env)} in that window.`,
    );
  try {
    await agent.goto(`chrome-extension://${clipyExtensionId(env)}/${AGENT_PAGE_PATH}`, {
      waitUntil: "load",
      timeout: 15_000,
    });
    await agent.waitForFunction("typeof globalThis.clipyAgent === 'object'", undefined, { timeout: 10_000 });
  } catch {
    await close();
    throw missing();
  }
  return {
    browser,
    context,
    agent,
    call: (expression) => agent.evaluate<AgentResponse>(`globalThis.clipyAgent.${expression}`),
    close,
  };
}

async function withAgent<T>(
  chromium: CfcChromium,
  port: number,
  env: NodeJS.ProcessEnv,
  fn: (conn: AgentConnection) => Promise<T>,
): Promise<T> {
  const conn = await connectAgent(chromium, port, env);
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

export interface ExtensionReadiness {
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  email: string | null;
  recorderState: string | null;
  error?: string;
}

/** Read-only: is the extension installed, current enough, and signed in? */
export async function extensionReadiness(
  chromium: CfcChromium,
  port: number,
  env: NodeJS.ProcessEnv,
): Promise<ExtensionReadiness> {
  try {
    return await withAgent(chromium, port, env, async ({ call }) => {
      const res = await call("status(undefined, true)");
      if (!res.ok || !res.agent) {
        return { installed: true, version: null, signedIn: false, email: null, recorderState: null, error: res.error ?? "the extension did not answer" };
      }
      if (res.agent.protocol !== AGENT_PROTOCOL) {
        return {
          installed: true,
          version: res.agent.version,
          signedIn: Boolean(res.signedIn),
          email: res.user?.email ?? null,
          recorderState: res.state?.status ?? null,
          error: `extension ${res.agent.version} speaks agent protocol ${res.agent.protocol}; this CLI needs ${AGENT_PROTOCOL}. Update the CLI or the extension.`,
        };
      }
      return {
        installed: true,
        version: res.agent.version,
        signedIn: Boolean(res.signedIn),
        email: res.user?.email ?? null,
        recorderState: res.state?.status ?? null,
      };
    });
  } catch (error) {
    if (error instanceof ExtensionUnavailableError) {
      return { installed: false, version: null, signedIn: false, email: null, recorderState: null, error: error.message };
    }
    throw error;
  }
}

function explainStartError(message: string): string {
  if (/not been invoked|activeTab|cannot be captured/i.test(message)) {
    return (
      `Chrome refused tab capture without a click (${message}). Chrome for Clipy must run with ` +
      `--allowlisted-extension-id; \`clipy chrome stop && clipy chrome start\` relaunches it with the flag. ` +
      `If it still fails, this Chrome version may no longer honour the flag: use --source chrome-for-clipy instead.`
    );
  }
  return message;
}

/** CDP target ids and chrome.tabs ids are unrelated, so the target is named by
 *  a one-off title token the extension can see, then the title is restored. */
async function resolveTabId(target: CfcPage, call: AgentConnection["call"]): Promise<number> {
  const token = JSON.stringify(`clipy-agent-${randomUUID()}`);
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await target.evaluate(
        `(() => { globalThis.__clipyOriginalTitle ??= document.title; document.title = ${token}; })()`,
      );
      const tabId = (await call(`findTabByTitle(${token})`)) as unknown as number | null;
      if (typeof tabId === "number") return tabId;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    throw new Error("could not identify the recording tab in Chrome for Clipy (does the page keep rewriting its title?)");
  } finally {
    await target
      .evaluate(
        `(() => { if (document.title === ${token}) document.title = globalThis.__clipyOriginalTitle ?? ""; delete globalThis.__clipyOriginalTitle; })()`,
      )
      .catch(() => {});
  }
}

export interface ExtensionRecordingStarted {
  recordingId: string;
  startedAtEpochMs: number;
  extensionVersion: string;
  cdpHttpUrl: string;
  /** Chrome for Clipy's pid; the session lives only as long as it does. */
  chromePid: number;
  /** The CDP port of the instance actually used, which can differ from the
   *  requested one when an instance started with --port is adopted. */
  port: number;
  /** The recorded tab's URL after load, redirects included. */
  pageUrl: string;
}

export async function startExtensionRecording(
  chromium: CfcChromium,
  opts: {
    home: string;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    port: number;
    targetUrl: string;
    maxSec: number;
    log: (m: string) => void;
  },
): Promise<ExtensionRecordingStarted> {
  const started = await startChrome(opts.home, opts.env, opts.platform, opts.port);
  if (!started.ok) throw new Error(`Chrome for Clipy is not available: ${started.error}`);
  const port = started.state.port;

  return withAgent(chromium, port, opts.env, async ({ context, call }) => {
    const ready = await call("status(undefined, true)");
    if (!ready.ok || !ready.agent) throw new Error(ready.error ?? "the Clipy extension did not answer");
    if (ready.agent.protocol !== AGENT_PROTOCOL) {
      throw new Error(`extension ${ready.agent.version} speaks agent protocol ${ready.agent.protocol}; this CLI needs ${AGENT_PROTOCOL}`);
    }
    if (!ready.signedIn) {
      throw new Error("the Clipy extension in Chrome for Clipy is signed out. Sign in at clipy.online in that window (or run `clipy chrome setup`).");
    }
    if (ready.state && BUSY_STATES.has(ready.state.status)) {
      throw new Error(`the Clipy extension is already ${ready.state.status}; stop or abort that recording first`);
    }

    const target = await context.newPage();
    try {
      try {
        await target.goto(opts.targetUrl, { waitUntil: "load", timeout: 30_000 });
      } catch {
        opts.log("target page load timed out; recording its current state anyway");
      }
      await target.bringToFront().catch(() => {});
      const tabId = await resolveTabId(target, call);
      const res = await call(`start(${tabId}, ${Math.round(opts.maxSec)})`);
      if (!res.ok || !res.agent?.activeRecordingId) {
        throw new Error(explainStartError(res.error ?? `recording did not start (state: ${res.state?.status ?? "unknown"})`));
      }
      opts.log(`extension ${res.agent.version} recording tab ${tabId} (${res.agent.activeRecordingId})`);
      return {
        recordingId: res.agent.activeRecordingId,
        startedAtEpochMs: Date.now(),
        extensionVersion: res.agent.version,
        cdpHttpUrl: `http://127.0.0.1:${port}`,
        chromePid: started.state.pid,
        port,
        pageUrl: target.url(),
      };
    } catch (error) {
      await target.close().catch(() => {});
      throw error;
    }
  });
}

export interface ExtensionRecordingResult {
  publicId: string;
  shareUrl: string;
}

/** Stop (or collect an auto-stopped) recording and wait for its upload. */
export async function stopExtensionRecording(
  chromium: CfcChromium,
  opts: { port: number; env: NodeJS.ProcessEnv; recordingId: string; timeoutMs: number },
): Promise<ExtensionRecordingResult> {
  return withAgent(chromium, opts.port, opts.env, async ({ call }) => {
    const id = JSON.stringify(opts.recordingId);
    const stopped = await call(`stop(${id})`);
    if (!stopped.ok) {
      const message = stopped.error ?? "the extension refused to stop the recording";
      throw /not active/.test(message) ? new ExtensionRecordingEndedError(message) : new Error(message);
    }
    const deadline = Date.now() + opts.timeoutMs;
    let res = stopped;
    for (;;) {
      const result = res.agent?.result;
      if (result?.status === "complete" && result.publicId && result.shareUrl) {
        return { publicId: result.publicId, shareUrl: result.shareUrl };
      }
      if (result?.status === "error") {
        throw new ExtensionRecordingEndedError(`the extension's upload failed: ${result.error ?? "unknown error"}`);
      }
      if (res.agent && res.agent.activeRecordingId !== opts.recordingId && !result) {
        const reason = res.state?.status === "error" && res.state.message ? `: ${res.state.message}` : "";
        throw new ExtensionRecordingEndedError(`the recording ended without an upload${reason}`);
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for the extension to finish uploading");
      await new Promise((r) => setTimeout(r, 1000));
      res = await call(`status(${id})`);
    }
  });
}

/** Resolves once the extension has cancelled the recording or confirms it is
 *  no longer active; throws when the extension could not be asked. */
export async function abortExtensionRecording(
  chromium: CfcChromium,
  opts: { port: number; env: NodeJS.ProcessEnv; recordingId: string },
): Promise<void> {
  await withAgent(chromium, opts.port, opts.env, async ({ call }) => {
    const res = await call(`cancel(${JSON.stringify(opts.recordingId)})`);
    if (!res.ok && !/not active/.test(res.error ?? "")) throw new Error(res.error ?? "cancel failed");
  });
}

export async function extensionRecordingStatus(
  chromium: CfcChromium,
  opts: { port: number; env: NodeJS.ProcessEnv; recordingId: string },
): Promise<{ state: string; result: AgentResult | null }> {
  return withAgent(chromium, opts.port, opts.env, async ({ call }) => {
    const res = await call(`status(${JSON.stringify(opts.recordingId)})`);
    if (!res.ok || !res.agent) throw new Error(res.error ?? "the extension did not answer");
    const active = res.agent.activeRecordingId === opts.recordingId;
    return { state: active ? res.state?.status ?? "unknown" : res.agent.result ? "ended" : "gone", result: res.agent.result };
  });
}
