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
 *
 * Raw CDP (cdpClient.ts), not Playwright: this path attaches only to the two
 * background tabs it opens, so a stuck tab elsewhere in the person's Chrome
 * for Clipy cannot hang it, and it needs no Playwright install.
 */

import { randomUUID } from "node:crypto";
import { CdpConnection, CdpTab } from "./cdpClient.js";
import { clipyExtensionId, startChrome } from "./chromeForClipy.js";

const AGENT_PAGE_PATH = "src/agent/agent.html";
const AGENT_PROTOCOL = 1;
const BUSY_STATES = new Set(["starting", "countdown", "recording", "paused", "uploading"]);

export function extensionStoreUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `https://chromewebstore.google.com/detail/${clipyExtensionId(env)}`;
}

interface AgentResult {
  recordingId: string;
  status: "complete" | "error" | "recovering";
  publicId?: string;
  shareUrl?: string;
  error?: string;
}

interface AgentResponse {
  ok: boolean;
  error?: string;
  signedIn?: boolean;
  user?: { email?: string };
  state?: { status: string; message?: string; startedAt?: number };
  agent?: {
    protocol: number;
    features?: string[];
    version: string;
    activeRecordingId: string | null;
    agentControlled?: boolean;
    result: AgentResult | null;
    lastStart?: { token: string; recordingId: string } | null;
    pendingStart?: string | null;
  };
}

export class ExtensionUnavailableError extends Error {}
/** The extension gave a definite answer (failed upload, recording gone), so
 *  there is nothing left to retry and the session file can go. Any other error
 *  from stop is treated as transient and the file is kept. */
export class ExtensionRecordingEndedError extends Error {}

interface AgentConnection {
  conn: CdpConnection;
  call(expression: string, timeoutMs?: number): Promise<AgentResponse>;
}

/** The extension bounds capture setup (OFFSCREEN_PREPARE) at 120s, so a start
 *  can legitimately take that long; wait past it for the definite answer. */
const AGENT_START_TIMEOUT_MS = 150_000;
// A start that never got going leaves the extension idle; give its access
// check this long to begin before deciding nothing is coming.
const ORPHAN_IDLE_GRACE_MS = 15_000;

/** The agent page is opened in the background: a foreground tab would make
 *  the extension think the person left the recorded tab. */
async function connectAgent(port: number, env: NodeJS.ProcessEnv): Promise<{ conn: CdpConnection; agent: CdpTab }> {
  const conn = await CdpConnection.connect(port);
  let agent: CdpTab;
  try {
    agent = await CdpTab.openBackground(conn, `chrome-extension://${clipyExtensionId(env)}/${AGENT_PAGE_PATH}`);
  } catch (error) {
    conn.close();
    throw error;
  }
  if (!(await agent.waitFor("typeof globalThis.clipyAgent === 'object'", 10_000))) {
    await agent.close();
    conn.close();
    throw new ExtensionUnavailableError(
      `the Clipy extension (with agent support) is not installed in Chrome for Clipy. ` +
        `Run \`clipy chrome setup\`, or install it from ${extensionStoreUrl(env)} in that window.`,
    );
  }
  return { conn, agent };
}

async function withAgent<T>(
  port: number,
  env: NodeJS.ProcessEnv,
  fn: (conn: AgentConnection) => Promise<T>,
): Promise<T> {
  const { conn, agent } = await connectAgent(port, env);
  try {
    return await fn({ conn, call: (expression, timeoutMs) => agent.evaluate<AgentResponse>(`globalThis.clipyAgent.${expression}`, timeoutMs) });
  } finally {
    await agent.close();
    conn.close();
  }
}

/** Opens a page in FRONT, for the steps a person has to do (install, sign in). */
export async function openTabForPerson(port: number, url: string): Promise<void> {
  const conn = await CdpConnection.connect(port);
  try {
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url });
    await conn.send("Target.activateTarget", { targetId }).catch(() => {});
  } finally {
    conn.close();
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
  port: number,
  env: NodeJS.ProcessEnv,
): Promise<ExtensionReadiness> {
  try {
    return await withAgent(port, env, async ({ call }) => {
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
async function resolveTabId(target: CdpTab, call: AgentConnection["call"]): Promise<number> {
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
  /** The extension's own start time, so marks line up with the video. */
  startedAtEpochMs: number;
  extensionVersion: string;
  /** What this extension build supports beyond protocol 1 ("name", "narration"). */
  features: string[];
  cdpHttpUrl: string;
  /** Chrome for Clipy's pid; the session lives only as long as it does. */
  chromePid: number;
  /** The CDP port of the instance actually used, which can differ from the
   *  requested one when an instance started with --port is adopted. */
  port: number;
  /** The recorded tab's URL after load, redirects included. */
  pageUrl: string;
  /** The recorded tab's CDP target id. Unambiguous where the URL is not: the
   *  persistent profile can hold other tabs at the same address. */
  targetId: string;
  /** Things the caller asked for that this extension build cannot do. */
  warnings: string[];
}

export async function startExtensionRecording(
  opts: {
    home: string;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    port: number;
    targetUrl: string;
    maxSec: number;
    name?: string;
    /** Record the tab's sound. Off by default: detected speech would replace
     *  the marks as the transcript. */
    tabAudio?: boolean;
    log: (m: string) => void;
  },
): Promise<ExtensionRecordingStarted> {
  const started = await startChrome(opts.home, opts.env, opts.platform, opts.port);
  if (!started.ok) throw new Error(`Chrome for Clipy is not available: ${started.error}`);
  const port = started.state.port;

  return withAgent(port, opts.env, async ({ conn, call }) => {
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
    const features = ready.agent.features ?? [];
    const warnings: string[] = [];
    if (opts.name && !features.includes("name")) {
      warnings.push(`extension ${ready.agent.version} ignores --name; the recording gets an automatic title. Update the Clipy extension.`);
    }
    if (!features.includes("tab-audio")) {
      warnings.push(
        `extension ${ready.agent.version} always records the tab's sound; any speech in it will replace your marks as the transcript. Update the Clipy extension.`,
      );
    }
    if (!features.includes("narration")) {
      warnings.push(`extension ${ready.agent.version} cannot receive marks; clipy mark will not reach this recording. Update the Clipy extension.`);
    }

    // In the background too: the agent drives this tab over CDP while the
    // person keeps using whatever is in front, and tab capture does not need
    // the tab to be visible.
    const target = await CdpTab.openBackground(conn, opts.targetUrl);
    try {
      // A new tab is a complete about:blank before the real page commits.
      if (!(await target.waitFor("location.href !== 'about:blank' && document.readyState === 'complete'", 30_000))) {
        opts.log("target page load timed out; recording its current state anyway");
      }
      const tabId = await resolveTabId(target, call);
      const startToken = randomUUID();
      let res: AgentResponse;
      try {
        res = await call(
          `start(${tabId}, ${Math.round(opts.maxSec)}, ${JSON.stringify(opts.name ?? null)}, ${opts.tabAudio === true}, ${JSON.stringify(startToken)})`,
          AGENT_START_TIMEOUT_MS,
        );
      } catch (error) {
        // No answer from the extension: a start may still have gone through.
        // Cancel it rather than leave an unowned recording to upload.
        const orphan = await cancelOrphanedAgentStart(port, opts.env, opts.log, startToken);
        const message = error instanceof Error ? error.message : String(error);
        if (orphan.uploaded) throw new Error(`${message}; the recording finished and uploaded anyway: ${orphan.uploaded}`);
        if (orphan.unresolved) {
          throw new Error(
            `${message}; recording ${orphan.unresolved.recordingId} may still be running in Chrome for Clipy and could not be cancelled ` +
              `(${orphan.unresolved.error}). Stop it from the Clipy extension in that window.`,
          );
        }
        if (orphan.unchecked) {
          throw new Error(
            `${message}; could not check whether the recording started anyway (${orphan.unchecked}). ` +
              "Look at the Clipy extension in Chrome for Clipy and stop it there if it is recording.",
          );
        }
        throw error;
      }
      if (!res.ok || !res.agent?.activeRecordingId) {
        throw new Error(explainStartError(res.error ?? `recording did not start (state: ${res.state?.status ?? "unknown"})`));
      }
      opts.log(`extension ${res.agent.version} recording tab ${tabId} (${res.agent.activeRecordingId})`);
      return {
        recordingId: res.agent.activeRecordingId,
        startedAtEpochMs: typeof res.state?.startedAt === "number" ? res.state.startedAt : Date.now(),
        extensionVersion: res.agent.version,
        features: res.agent.features ?? [],
        cdpHttpUrl: `http://127.0.0.1:${port}`,
        chromePid: started.state.pid,
        port,
        pageUrl: await target.url().catch(() => opts.targetUrl),
        targetId: target.targetId,
        warnings,
      };
    } catch (error) {
      await target.close().catch(() => {});
      throw error;
    }
  });
}

/** After a start the CLI stopped waiting on: the extension may still be
 *  checking access or preparing capture. Watch on a fresh connection (the old
 *  one may be the thing that failed) and cancel the recording if it appears, so
 *  nothing records or uploads without a session that owns it. The start token
 *  finds this start's recording even after it has finished; if it already
 *  reached the library, its link is returned instead. */
interface OrphanOutcome {
  /** The link, when the recording already reached the library. */
  uploaded?: string;
  /** A recording that may still be running because cancelling it failed. */
  unresolved?: { recordingId: string; error: string };
  /** The extension could not be asked at all, so a late start is unknown. */
  unchecked?: string;
}

async function cancelOrphanedAgentStart(
  port: number,
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
  startToken: string,
): Promise<OrphanOutcome> {
  try {
    return await withAgent(port, env, async ({ call }) => {
      // Retried, then reported: a cancel that silently failed would leave a
      // recording running with no session to stop or collect it.
      const cancel = async (id: string): Promise<OrphanOutcome> => {
        let lastError = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
          const res = await call(`cancel(${JSON.stringify(id)})`, 30_000).catch((error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }) as AgentResponse);
          if (res.ok || /not active/.test(res.error ?? "")) {
            log(`cancelled recording ${id}, which started after the CLI stopped waiting for it`);
            return {};
          }
          if (/^already uploaded: /.test(res.error ?? "")) return { uploaded: res.error!.replace(/^already uploaded: /, "") };
          lastError = res.error ?? "cancel failed";
          if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
        }
        return { unresolved: { recordingId: id, error: lastError } };
      };
      // Refuse the start outright if it has not passed the access check yet
      // (that check has no timeout of its own).
      const first = await call(`abandonStart(${JSON.stringify(startToken)})`, 10_000).catch(() => null);
      const canAbandon = Boolean(first?.agent?.features?.includes("abandon-start"));
      // While the extension is busy starting, keep watching through its whole
      // setup window: a recording can still begin near the end of it.
      const idleDeadline = Date.now() + ORPHAN_IDLE_GRACE_MS;
      const hardDeadline = Date.now() + AGENT_START_TIMEOUT_MS;
      let sawStart = false;
      for (;;) {
        const status = await call("status()", 10_000);
        const mine = status.agent?.lastStart?.token === startToken ? status.agent.lastStart.recordingId : null;
        if (mine) {
          if (status.agent?.activeRecordingId === mine) return await cancel(mine);
          const result = (await call(`status(${JSON.stringify(mine)})`, 10_000)).agent?.result;
          if (result?.status === "complete") return { uploaded: result.shareUrl ?? result.publicId ?? mine };
          // Still retrying the upload: cancelling drops the queued replay. An
          // error result already means nothing was uploaded.
          return result?.status === "recovering" ? await cancel(mine) : {};
        }
        // An extension without start tokens: any agent recording now live is ours.
        if (!status.agent?.features?.includes("start-token")) {
          const id = status.agent?.agentControlled ? status.agent.activeRecordingId : null;
          if (id) return await cancel(id);
        }
        // Our start is still in the extension's hands (possibly its access
        // check): keep watching, since it may yet begin or be refused.
        const pending = status.agent?.pendingStart === startToken;
        const busy = pending || Boolean(status.state && BUSY_STATES.has(status.state.status));
        if (canAbandon && !pending && !mine) return {};
        if (sawStart && !busy) return {};
        sawStart ||= busy;
        const now = Date.now();
        if (now >= hardDeadline || (!busy && now >= idleDeadline)) return {};
        await new Promise((r) => setTimeout(r, 500));
      }
    });
  } catch (error) {
    return { unchecked: error instanceof Error ? error.message : String(error) };
  }
}

export interface ExtensionRecordingResult {
  publicId: string;
  shareUrl: string;
}

/** Stop (or collect an auto-stopped) recording and wait for its upload. */
export async function stopExtensionRecording(
  opts: {
    port: number;
    env: NodeJS.ProcessEnv;
    recordingId: string;
    timeoutMs: number;
    /** Timestamped marks; they become the transcript of the silent recording. */
    notes?: { startMs: number; text: string }[];
  },
): Promise<ExtensionRecordingResult> {
  return withAgent(opts.port, opts.env, async ({ call }) => {
    const id = JSON.stringify(opts.recordingId);
    const narration = opts.notes?.length ? JSON.stringify({ notes: opts.notes }) : "undefined";
    const stopped = await call(`stop(${id}, ${narration})`);
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
      if (Date.now() >= deadline) {
        // Plain Error, not ended: the session is kept so a later stop can collect it.
        throw new Error(
          result?.status === "recovering"
            ? "the extension is still retrying the upload; run `clipy session stop` again shortly to collect the link"
            : "timed out waiting for the extension to finish uploading",
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
      res = await call(`status(${id})`);
    }
  });
}

/** Hands one mark to the extension as it happens, so a recording that stops
 *  on its own (--max) still uploads with it. Best effort: the CLI keeps its own
 *  copy and sends everything again at stop. */
export async function sendExtensionMark(opts: {
  port: number;
  env: NodeJS.ProcessEnv;
  recordingId: string;
  startMs: number;
  text: string;
  /** The running [verification] tally, for a recording that auto-stops. */
  summary?: string;
}): Promise<{ ok: boolean; ended: boolean; error?: string }> {
  return withAgent(opts.port, opts.env, async ({ call }) => {
    const args = [JSON.stringify(opts.recordingId), Math.round(opts.startMs), JSON.stringify(opts.text)];
    if (opts.summary) args.push(JSON.stringify(opts.summary));
    const res = await call(`mark(${args.join(", ")})`);
    // "not active": the recording already stopped on its own (--max) and
    // uploaded, so nothing sent now can reach it.
    return { ok: res.ok, ended: !res.ok && /not active/.test(res.error ?? ""), error: res.error };
  });
}

/** Resolves once the extension has cancelled the recording or confirms it is
 *  no longer active; throws when the extension could not be asked. */
/** The recording reached the library before the abort; `session stop` collects it. */
export class ExtensionAlreadyUploadedError extends Error {}

export async function abortExtensionRecording(
  opts: { port: number; env: NodeJS.ProcessEnv; recordingId: string },
): Promise<void> {
  await withAgent(opts.port, opts.env, async ({ call }) => {
    const res = await call(`cancel(${JSON.stringify(opts.recordingId)})`);
    if (!res.ok && /^already uploaded/.test(res.error ?? "")) throw new ExtensionAlreadyUploadedError(res.error);
    if (!res.ok && !/not active/.test(res.error ?? "")) throw new Error(res.error ?? "cancel failed");
  });
}

export async function extensionRecordingStatus(
  opts: { port: number; env: NodeJS.ProcessEnv; recordingId: string },
): Promise<{ state: string; result: AgentResult | null }> {
  return withAgent(opts.port, opts.env, async ({ call }) => {
    const res = await call(`status(${JSON.stringify(opts.recordingId)})`);
    if (!res.ok || !res.agent) throw new Error(res.error ?? "the extension did not answer");
    const active = res.agent.activeRecordingId === opts.recordingId;
    return { state: active ? res.state?.status ?? "unknown" : res.agent.result ? "ended" : "gone", result: res.agent.result };
  });
}
