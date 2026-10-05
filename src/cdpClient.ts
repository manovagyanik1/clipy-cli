/**
 * A minimal Chrome DevTools Protocol client for Chrome for Clipy.
 *
 * Playwright's connectOverCDP attaches to EVERY target in the browser before
 * it returns, so one stuck tab (a hung renderer, an embedded view, another
 * extension's page) blocks it indefinitely. Chrome for Clipy is long-lived and
 * full of the person's own tabs, so the extension path talks to the browser
 * endpoint directly and attaches only to the tabs it creates.
 *
 * Uses the global WebSocket where Node has one (22+) and otherwise a small
 * RFC 6455 client over node:http, so the CLI keeps its Node 18 floor and its
 * zero runtime dependencies.
 */

import { request } from "node:http";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";

type Json = Record<string, unknown>;

interface Transport {
  send(text: string): void;
  close(): void;
}

function openWithGlobalWebSocket(
  url: string,
  onMessage: (text: string) => void,
  onClose: (reason: string) => void,
  signal: AbortSignal,
): Promise<Transport> {
  const WS = (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket;
  const ws = new WS(url);
  signal.addEventListener("abort", () => ws.close(), { once: true });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send: (t) => ws.send(t), close: () => ws.close() });
    ws.onerror = () => reject(new Error(`could not open ${url}`));
    ws.onmessage = (e) => onMessage(String(e.data));
    ws.onclose = () => onClose("socket closed");
  });
}

interface WebSocketLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(text: string): void;
  close(): void;
}

/** Client side of RFC 6455: masked text frames out; text, continuation,
 *  ping and close frames in. Enough for CDP, which sends JSON text frames. */
function openWithHttpUpgrade(
  url: string,
  onMessage: (text: string) => void,
  onClose: (reason: string) => void,
  signal: AbortSignal,
): Promise<Transport> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    // A stalled handshake must not keep the process alive after its timeout.
    signal.addEventListener("abort", () => req.destroy(), { once: true });
    const req = request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });
    req.on("error", reject);
    req.on("response", (res) => reject(new Error(`websocket upgrade refused (${res.statusCode})`)));
    req.on("upgrade", (_res, socket: Socket, head: Buffer) => {
      if (signal.aborted) {
        socket.destroy();
        return;
      }
      let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
      let fragments: Buffer[] = [];
      const writeFrame = (opcode: number, payload: Buffer) => {
        const mask = randomBytes(4);
        const len = payload.length;
        const header =
          len < 126
            ? Buffer.from([0x80 | opcode, 0x80 | len])
            : len < 65536
              ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff])
              : (() => {
                  const h = Buffer.alloc(10);
                  h[0] = 0x80 | opcode;
                  h[1] = 0x80 | 127;
                  h.writeBigUInt64BE(BigInt(len), 2);
                  return h;
                })();
        const masked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
        socket.write(Buffer.concat([header, mask, masked]));
      };
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) return;
          const fin = (buffer[0] & 0x80) !== 0;
          const opcode = buffer[0] & 0x0f;
          let len = buffer[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buffer.length < 4) return;
            len = buffer.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buffer.length < 10) return;
            len = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffer.length < offset + len) return;
          const payload = buffer.subarray(offset, offset + len);
          buffer = buffer.subarray(offset + len);
          if (opcode === 0x8) {
            socket.end();
            return;
          }
          if (opcode === 0x9) {
            writeFrame(0xa, Buffer.from(payload));
            continue;
          }
          if (opcode === 0x1 || opcode === 0x0) {
            fragments.push(Buffer.from(payload));
            if (fin) {
              onMessage(Buffer.concat(fragments).toString("utf8"));
              fragments = [];
            }
          }
        }
      });
      socket.on("close", () => onClose("socket closed"));
      socket.on("error", () => onClose("socket error"));
      resolve({
        send: (text) => writeFrame(0x1, Buffer.from(text, "utf8")),
        close: () => {
          try {
            writeFrame(0x8, Buffer.alloc(0));
          } catch {
            // already gone
          }
          socket.end();
        },
      });
    });
    req.end();
  });
}

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private closedReason: string | null = null;

  private constructor(private transport: Transport | null) {}

  static async connect(port: number, timeoutMs = 10_000): Promise<CdpConnection> {
    const version = (await (
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    ).json()) as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) throw new Error("Chrome for Clipy did not report a debugger endpoint");
    const conn = new CdpConnection(null);
    const onMessage = (text: string) => conn.dispatch(text);
    const onClose = (reason: string) => conn.failAll(reason);
    const open = typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function"
      ? openWithGlobalWebSocket
      : openWithHttpUpgrade;
    const abort = new AbortController();
    try {
      conn.transport = await withTimeout(
        open(version.webSocketDebuggerUrl, onMessage, onClose, abort.signal),
        timeoutMs,
        "connecting to Chrome for Clipy",
      );
    } catch (error) {
      abort.abort();
      throw error;
    }
    return conn;
  }

  private dispatch(text: string): void {
    let msg: { id?: number; result?: Json; error?: { message?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message ?? "CDP error"));
    else waiter.resolve(msg.result ?? {});
  }

  private failAll(reason: string): void {
    this.closedReason = reason;
    for (const waiter of this.pending.values()) waiter.reject(new Error(`Chrome for Clipy connection lost (${reason})`));
    this.pending.clear();
  }

  send<T extends Json = Json>(method: string, params: Json = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closedReason || !this.transport) {
      return Promise.reject(new Error(`Chrome for Clipy connection lost (${this.closedReason ?? "not open"})`));
    }
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: Json) => void, reject });
    });
    this.transport.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return withTimeout(result, timeoutMs, method).finally(() => this.pending.delete(id));
  }

  close(): void {
    this.transport?.close();
    this.failAll("closed");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A tab this client created and attached to, and only that tab. */
export class CdpTab {
  private constructor(
    private conn: CdpConnection,
    readonly targetId: string,
    private sessionId: string,
  ) {}

  /** Opens `url` as a background tab (never activated) and attaches to it. */
  static async openBackground(conn: CdpConnection, url: string): Promise<CdpTab> {
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url, background: true });
    try {
      const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      return new CdpTab(conn, targetId, sessionId);
    } catch (error) {
      await conn.send("Target.closeTarget", { targetId }).catch(() => {});
      throw error;
    }
  }

  /** Evaluates an expression in the page, awaiting a returned promise. A
   *  navigation can swap the document mid-call; that is retried, not failed. */
  async evaluate<T = unknown>(expression: string, timeoutMs = 30_000): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.evaluateOnce<T>(expression, timeoutMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 4 || !/context was destroyed|Cannot find context|Inspected target navigated/i.test(message)) throw error;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  }

  private async evaluateOnce<T>(expression: string, timeoutMs: number): Promise<T> {
    const res = await this.conn.send<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
      timeoutMs,
    );
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluation failed");
    }
    return res.result?.value as T;
  }

  /** Polls until `expression` is truthy; false if it never became so in time. */
  async waitFor(expression: string, timeoutMs: number, intervalMs = 200): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await this.evaluate<boolean>(`Boolean(${expression})`, 5_000)) return true;
      } catch {
        // the document may be mid-navigation; keep polling
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  url(): Promise<string> {
    return this.evaluate<string>("location.href", 5_000);
  }

  async close(): Promise<void> {
    await this.conn.send("Target.closeTarget", { targetId: this.targetId }, undefined, 5_000).catch(() => {});
  }
}
