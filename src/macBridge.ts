/**
 * Mac bridge client — drives real screen recordings through the running
 * Clipy desktop app over its Unix-socket agent bridge (agent_bridge.rs).
 *
 * Discovery: ~/Library/Application Support/Clipy/agent-bridge.json, written
 * by the app on launch: {socketPath, token, pid, appVersion, protocolVersion}.
 * The file and socket are 0600, and every request carries the per-launch
 * token. Protocol: one JSON request line per connection, one JSON response
 * line back.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

export interface BridgeInfo {
  socketPath: string;
  token: string;
  pid: number;
  appVersion: string;
  protocolVersion: number;
}

export class BridgeUnavailableError extends Error {}

const REQUEST_TIMEOUT_MS = 15_000;
/** stop waits for the streaming upload to hand back the share link. */
const STOP_TIMEOUT_MS = 200_000;

export function bridgeFilePath(): string {
  if (process.env.CLIPY_BRIDGE_FILE?.trim()) return process.env.CLIPY_BRIDGE_FILE;
  return join(homedir(), "Library", "Application Support", "Clipy", "agent-bridge.json");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads + validates the discovery file; throws BridgeUnavailableError with a
 *  friendly one-liner when the app isn't installed or running. */
export function readBridgeInfo(): BridgeInfo {
  if (process.platform !== "darwin" && !process.env.CLIPY_BRIDGE_FILE) {
    throw new BridgeUnavailableError(
      "--source mac-screen records through the Clipy Mac app, which only runs on macOS.",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(bridgeFilePath(), "utf8");
  } catch {
    throw new BridgeUnavailableError(
      "the Clipy app is not running (no agent bridge found). Open Clipy, or install it from https://clipy.online/download",
    );
  }
  let info: BridgeInfo;
  try {
    info = JSON.parse(raw) as BridgeInfo;
  } catch {
    throw new BridgeUnavailableError("agent bridge file is corrupt — restart the Clipy app");
  }
  if (!info.socketPath || !info.token || typeof info.pid !== "number") {
    throw new BridgeUnavailableError("agent bridge file is incomplete — restart the Clipy app");
  }
  if (!pidAlive(info.pid)) {
    throw new BridgeUnavailableError(
      "the Clipy app is not running (stale agent bridge). Open Clipy and try again.",
    );
  }
  return info;
}

interface BridgeOk {
  ok: true;
  data: Record<string, unknown>;
}
interface BridgeErr {
  ok: false;
  error: { code: string; message: string };
}

/** One request line in, one response line out. */
export function bridgeRequest(
  info: BridgeInfo,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = cmd === "stop" ? STOP_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: info.socketPath });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(
          new Error(
            cmd === "stop"
              ? "the Clipy app did not finish the upload in time — check the app; the recording may still complete in the background"
              : `the Clipy app did not answer (${cmd}) — is it responding?`,
          ),
        );
      }
    }, timeoutMs);

    socket.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? new BridgeUnavailableError(
              "the Clipy app is not running (agent bridge socket unavailable). Open Clipy and try again.",
            )
          : e,
      );
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ token: info.token, cmd, ...args })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as BridgeOk | BridgeErr;
        if (parsed.ok) {
          resolvePromise(parsed.data ?? {});
        } else {
          reject(new Error(parsed.error?.message ?? "bridge error"));
        }
      } catch {
        reject(new Error("unparseable response from the Clipy app bridge"));
      }
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("the Clipy app closed the bridge connection unexpectedly"));
      }
    });
  });
}
