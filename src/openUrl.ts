/**
 * Opening a URL in the user's default browser, safely on every platform.
 *
 * The Windows path is the whole reason this module exists. `cmd.exe` parses
 * `&` as a command separator, and Node does NOT escape cmd metacharacters when
 * it builds a command line — it only adds quotes around arguments containing
 * whitespace or quotes. So spawning
 *
 *     cmd /c start "" https://clipy.online/cli/authorize?challenge=A&state=B&port=1234
 *
 * opened `…?challenge=A` and then tried to run `state=B` as a separate command.
 * Every Windows user landed on the "This authorization link is invalid" page,
 * because the approval page requires state/port/name/scopes too.
 *
 * The fix follows the current `open` package approach: pass a Base64-encoded
 * command directly to PowerShell. The URL never enters cmd.exe, and PowerShell
 * decodes it only after command-line parsing, so `&` and percent-encoded values
 * arrive unchanged.
 */

import { spawn } from "node:child_process";

export interface OpenUrlPlan {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly verbatim: boolean;
}

/**
 * Build the spawn plan for a URL. Exported separately from the spawn so tests
 * can assert the Windows command line without running on Windows.
 */
export function planOpenUrl(url: string, platform: NodeJS.Platform): OpenUrlPlan {
  if (platform === "win32") {
    const escapedUrl = url.replace(/'/g, "''");
    const encodedCommand = Buffer.from(`Start-Process '${escapedUrl}'`, "utf16le").toString("base64");
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      verbatim: false,
    };
  }
  return {
    cmd: platform === "darwin" ? "open" : "xdg-open",
    args: [url],
    verbatim: false,
  };
}

/**
 * Fire-and-forget: spawn the OS opener and detach. Never throws — callers
 * always print the URL as a fallback, which is the real safety net when no
 * opener exists (headless boxes, stripped containers).
 */
export function openUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  const plan = planOpenUrl(url, platform);
  try {
    const child = spawn(plan.cmd, plan.args, {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: plan.verbatim,
    });
    child.on("error", () => {}); // opener missing — the printed URL is the fallback
    child.unref();
  } catch {
    // ignore — the caller already printed the URL
  }
}
