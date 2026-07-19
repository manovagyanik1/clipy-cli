/**
 * Browser-approve login for `clipy login` — the `gh auth login` shape.
 *
 * Flow (the wire contract, frozen against the server):
 *   1. Generate a PKCE `verifier` (32 random bytes, base64url), its S256
 *      `challenge` = base64url(sha256(verifier)), and a random `state`.
 *   2. Bind a loopback HTTP listener on 127.0.0.1 with an ephemeral port.
 *   3. Open the browser at {apiUrl}/cli/authorize?challenge&state&port&name&scopes
 *      (and always print the URL so a headless open still has a fallback).
 *   4. The browser redirects to http://127.0.0.1:<port>/callback?code&state on
 *      approve, or ?error=access_denied&state on deny. `state` is checked
 *      strictly — a mismatch is treated as an attack and fails.
 *   5. POST {apiUrl}/api/cli-auth/exchange {code, verifier} → {apiKey, scopes,
 *      email}. Retries once on a network error or 5xx only; a consumed-code 400
 *      is single-use server-side and is never retried.
 *
 * Node stdlib only (http, crypto, os, child_process) — the CLI ships zero deps.
 * Storing + verifying the returned key is the caller's job (index.ts), so this
 * module has no dependency on the config store.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { spawn } from "node:child_process";

export interface BrowserLoginResult {
  apiKey: string;
  scopes: string[];
  email: string;
}

export interface BrowserLoginOptions {
  apiUrl: string;
  /** Scopes requested in the authorize URL. Default: recordings:read,ingest. */
  scopes?: string[];
  /** Overall wall-clock budget for the whole flow. Default 180s. */
  timeoutMs?: number;
  /** Status output (goes to stderr in the CLI). Default: swallow. */
  log?: (message: string) => void;
  /**
   * How to open the authorize URL. Defaults to the OS browser opener (which
   * honors CLIPY_LOGIN_NO_BROWSER=1 to only print the URL). Tests inject a
   * function that fetches the URL itself so no real browser is spawned.
   */
  open?: (url: string) => void | Promise<void>;
  /**
   * Headless copy-code flow: no loopback listener is started, the authorize
   * URL carries mode=manual, and the approved code is read from `promptCode`
   * (a terminal prompt in the CLI; tests inject a resolver).
   */
  manual?: boolean;
  promptCode?: () => Promise<string>;
}

/**
 * True when the loopback redirect can't work and the copy-code flow should be
 * used instead: an SSH session (the browser runs on a different machine than
 * the listener), or Linux with no display server to open a browser on.
 */
export function shouldUseManualLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

const DEFAULT_SCOPES = ["recordings:read", "ingest"];
const DEFAULT_TIMEOUT_MS = 180_000;
const EXCHANGE_TIMEOUT_MS = 20_000;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Spawn the OS browser opener, always printing the URL as a fallback. */
function openBrowser(url: string, log: (m: string) => void): void {
  log("If the browser didn't open, visit:");
  log(`  ${url}`);
  if (process.env.CLIPY_LOGIN_NO_BROWSER) return;
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // opener missing — the printed URL is the fallback
    child.unref();
  } catch {
    // ignore — the URL is already printed
  }
}

export async function browserLogin(opts: BrowserLoginOptions): Promise<BrowserLoginResult> {
  const apiUrl = opts.apiUrl.replace(/\/+$/, "");
  const scopes = opts.scopes && opts.scopes.length ? opts.scopes : DEFAULT_SCOPES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log ?? (() => {});

  const verifier = base64url(randomBytes(32)); // 43-char base64url PKCE verifier
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = base64url(randomBytes(16));
  const clientName = `Clipy CLI — ${hostname()}`.slice(0, 120);

  const buildAuthorizeUrl = (port: number | null): string => {
    const url = new URL(`${apiUrl}/cli/authorize`);
    url.searchParams.set("challenge", challenge);
    url.searchParams.set("state", state);
    if (port === null) {
      url.searchParams.set("mode", "manual");
    } else {
      url.searchParams.set("port", String(port));
    }
    url.searchParams.set("name", clientName);
    url.searchParams.set("scopes", scopes.join(","));
    return url.toString();
  };
  const opener = opts.open ?? ((u: string) => openBrowser(u, log));

  if (opts.manual) {
    // Copy-code flow: the approval page shows the one-time code; the user
    // pastes it here. PKCE still binds the exchange to THIS process — a
    // shoulder-surfed code is useless without the verifier.
    if (!opts.promptCode) throw new Error("manual login requires a code prompt");
    const manualUrl = buildAuthorizeUrl(null);
    if (opts.open) {
      await opts.open(manualUrl); // tests drive the approval themselves
    } else {
      log("Open this URL on any device, sign in, and approve:");
      log(`  ${manualUrl}`);
    }
    const code = (await opts.promptCode()).trim();
    if (!code) throw new Error("no approval code entered");
    return exchangeCode(apiUrl, code, verifier);
  }

  const { code } = await waitForCallback({
    state,
    timeoutMs,
    log,
    open: async (port) => {
      await opener(buildAuthorizeUrl(port));
    },
  });

  return exchangeCode(apiUrl, code, verifier);
}

interface CallbackArgs {
  state: string;
  timeoutMs: number;
  log: (m: string) => void;
  open: (port: number) => void | Promise<void>;
}

/** Bind the loopback listener, open the browser, and resolve with the code. */
function waitForCallback(args: CallbackArgs): Promise<{ code: string }> {
  const { state, timeoutMs, log, open } = args;
  return new Promise<{ code: string }>((resolve, reject) => {
    let settled = false;
    const server = createServer(handleRequest);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("SIGINT", onSigint);
      server.close();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser approval`,
          ),
        ),
      );
    }, timeoutMs);

    const onSigint = (): void => finish(() => reject(new Error("login cancelled")));
    process.once("SIGINT", onSigint);

    function handleRequest(req: IncomingMessage, res: ServerResponse): void {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (url.pathname !== "/callback") {
        // Stray request (favicon probes, scanners) — 404 and keep waiting.
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      if (settled) {
        // Double callback — first one already won; just render a friendly page.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(pageSuccess());
        return;
      }
      if (url.searchParams.get("state") !== state) {
        // State mismatch = possible CSRF/injection. Fail the whole flow.
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(pageError());
        finish(() => reject(new Error("state mismatch on the login callback — aborting for safety")));
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(pageDenied());
        finish(() =>
          reject(
            new Error(
              error === "access_denied"
                ? "login was cancelled in the browser"
                : `login failed: ${error}`,
            ),
          ),
        );
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(pageError());
        finish(() => reject(new Error("login callback was missing the authorization code")));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(pageSuccess());
      finish(() => resolve({ code }));
    }

    server.on("error", (e: NodeJS.ErrnoException) => {
      finish(() =>
        reject(new Error(`could not start the local login listener (${e.code ?? e.message})`)),
      );
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === "string") {
        finish(() => reject(new Error("could not determine the local login listener port")));
        return;
      }
      Promise.resolve(open(addr.port)).catch((e: Error) => {
        // A failed opener isn't fatal — the URL was printed. Keep waiting.
        log(`could not open the browser automatically (${e.message}) — open the URL above`);
      });
    });
  });
}

/** POST the code + PKCE verifier for the API key. One retry on network/5xx. */
async function exchangeCode(
  apiUrl: string,
  code: string,
  verifier: string,
): Promise<BrowserLoginResult> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${apiUrl}/api/cli-auth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code, verifier }),
        signal: controller.signal,
      });
    } catch (e) {
      // Network error / abort → retry once, then give up.
      lastError = new Error(
        (e as Error).name === "AbortError" ? "the key exchange timed out" : (e as Error).message,
      );
      if (attempt === 1) continue;
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
    // 5xx is transient → retry once. 4xx (consumed-code 400, rate-limit 429)
    // is terminal — the code is single-use, so retrying can only ever 400.
    if (res.status >= 500 && attempt === 1) {
      lastError = new Error(`the key exchange failed (HTTP ${res.status})`);
      continue;
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (!res.ok) {
      const msg =
        typeof body.error === "string" && body.error
          ? body.error
          : `the key exchange failed (HTTP ${res.status})`;
      throw new Error(msg);
    }
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    if (!apiKey) throw new Error("the login response did not include an API key");
    return { apiKey, scopes: normalizeScopes(body.scopes), email: typeof body.email === "string" ? body.email : "" };
  }
  throw lastError ?? new Error("the key exchange failed");
}

function normalizeScopes(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

// --- Loopback response pages (served to the browser, then it can be closed) ---

function htmlPage(title: string, glyph: string, accent: string, heading: string, sub: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#e8e8ea;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.card{max-width:26rem;margin:1.5rem;padding:2.5rem 2rem;text-align:center;background:#15151b;border:1px solid #26262f;border-radius:14px}
.mark{width:48px;height:48px;margin:0 auto 1.25rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.6rem;background:${accent}22;color:${accent}}
h1{margin:0 0 .5rem;font-size:1.35rem}
p{margin:0;color:#a1a1aa}
</style></head><body><div class="card"><div class="mark">${glyph}</div><h1>${heading}</h1><p>${sub}</p></div></body></html>`;
}

function pageSuccess(): string {
  return htmlPage(
    "Clipy — logged in",
    "✓",
    "#ff7a45",
    "You're logged in",
    "Return to your terminal — you can close this tab.",
  );
}

function pageDenied(): string {
  return htmlPage(
    "Clipy — login cancelled",
    "×",
    "#a1a1aa",
    "Login cancelled",
    "You can close this tab and run the command again.",
  );
}

function pageError(): string {
  return htmlPage(
    "Clipy — login error",
    "!",
    "#f87171",
    "Something went wrong",
    "This login request was invalid. Return to your terminal and try again.",
  );
}
