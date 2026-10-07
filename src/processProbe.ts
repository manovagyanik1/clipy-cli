/**
 * Host process probes for Chrome for Clipy's ownership checks: which process
 * listens on a TCP port, what argv a process was launched with, and how to stop
 * one. Ownership is load-bearing (a PID or port can be reused by an unrelated
 * process), so a probe that cannot run says so (`supported: false`) instead of
 * answering "not ours". The caller turns that into an explicit error rather
 * than a misleading "not owned" or, worse, adopting a process it never verified.
 *
 * The probes dispatch on the HOST (`process.platform`), never on a platform
 * argument: they spawn real host tools.
 *
 *   macOS / Linux: `lsof` for the listener, `ps` for the command line.
 *   Windows:       `netstat -ano` for the listener (parsed by shape, not by the
 *                  localized state word), `Get-CimInstance Win32_Process` for the
 *                  command line (wmic is deprecated and absent on new installs),
 *                  `taskkill` for the process tree.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type Probe<T> = { supported: true; value: T } | { supported: false; reason: string };

const PROBE_TIMEOUT_MS = 10_000;

function systemTool(relative: string, fallback: string): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  // An absolute System32 path keeps a same-named file on PATH from answering.
  return root ? join(root, "System32", relative) : fallback;
}

function run(
  cmd: string,
  args: string[],
): { ok: true; stdout: string; stderr: string; status: number | null } | { ok: false; reason: string } {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? `\`${cmd}\` is not installed` : `\`${cmd}\` failed: ${result.error.message}` };
  }
  return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

// ---------------------------------------------------------------------------
// Listening socket owner
// ---------------------------------------------------------------------------

/** The PID listening on `port`, or null when nothing listens there. */
export function listenerPid(port: number): Probe<number | null> {
  if (process.platform === "win32") {
    const out = run(systemTool("netstat.exe", "netstat"), ["-ano"]);
    if (!out.ok) return { supported: false, reason: out.reason };
    if (out.status !== 0) return { supported: false, reason: `netstat exited with status ${out.status}` };
    return { supported: true, value: parseNetstatListener(out.stdout, port) };
  }
  const out = run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
  if (!out.ok) return { supported: false, reason: out.reason };
  const pid = Number.parseInt(out.stdout.trim().split("\n")[0] ?? "", 10);
  if (Number.isInteger(pid) && pid > 0) return { supported: true, value: pid };
  // lsof exits 1 both for "nothing matched" (silent) and for real errors
  // (a diagnostic on stderr). Its routine "WARNING: can't stat …" lines for
  // unrelated mounts are not errors.
  const diagnostic = out.stderr.split("\n").map((l) => l.trim()).filter((l) => l && !/WARNING/i.test(l));
  if (out.status !== 0 && (out.status !== 1 || diagnostic.length > 0)) {
    return { supported: false, reason: `lsof exited with status ${out.status}${diagnostic[0] ? `: ${diagnostic[0]}` : ""}` };
  }
  return { supported: true, value: null };
}

/**
 * Picks the listener for `port` out of `netstat -ano`. The state column is
 * localized ("LISTENING", "ABHÖREN", …), so a row is recognised as a listener
 * by its shape: a TCP socket whose foreign end is port 0 (`0.0.0.0:0`,
 * `[::]:0`). Connected sockets always carry a real foreign port.
 */
export function parseNetstatListener(output: string, port: number): number | null {
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0]?.toUpperCase() !== "TCP") continue;
    const local = cols[1] ?? "";
    const foreign = cols[2] ?? "";
    if (portOf(local) !== port || portOf(foreign) !== 0) continue;
    const pid = Number.parseInt(cols[cols.length - 1] ?? "", 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function portOf(address: string): number | null {
  const idx = address.lastIndexOf(":");
  if (idx < 0) return null;
  const tail = address.slice(idx + 1);
  return /^\d+$/.test(tail) ? Number(tail) : null;
}

// ---------------------------------------------------------------------------
// Launch arguments
// ---------------------------------------------------------------------------

/** Answers "was `pid` launched with every one of these arguments?" for one
 *  process, reading its command line once. Null `value` = no such process. A
 *  live process whose command line cannot be read (an elevated process, blocked
 *  inspection) is unsupported, not "not ours": callers must not treat a browser
 *  that may still be recording as gone. */
export type ArgMatcher = (args: readonly string[]) => boolean;

export function processArgs(pid: number): Probe<ArgMatcher | null> {
  if (process.platform === "win32") {
    // The pid is a validated integer; nothing user-controlled reaches the script.
    if (!Number.isInteger(pid) || pid <= 0) return { supported: true, value: null };
    const script =
      "$ErrorActionPreference='Stop';" +
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      `$p=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}';` +
      "if($p -and $p.CommandLine){[Console]::Out.Write($p.CommandLine)}";
    const out = run(systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe"), "powershell"), [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ]);
    if (!out.ok) return { supported: false, reason: out.reason };
    if (out.status !== 0) return { supported: false, reason: `Get-CimInstance Win32_Process exited with status ${out.status}` };
    const line = out.stdout.trim();
    if (!line) return unreadable(pid, "its command line is not readable");
    // Tokens compare exactly, so a profile path with spaces (quoted on the
    // command line) still matches the argument we passed to spawn.
    const argv = new Set(splitWindowsCommandLine(line));
    return { supported: true, value: (args) => args.every((arg) => argv.has(arg)) };
  }
  const out = run("ps", ["-ww", "-p", String(pid), "-o", "command="]);
  if (!out.ok) return { supported: false, reason: out.reason };
  const command = out.stdout.trim();
  if (out.status !== 0 || !command) return unreadable(pid, `ps exited with status ${out.status}`);
  // ps joins argv with spaces, so it cannot be split back unambiguously; match
  // each whole argument (spaces included) bounded by whitespace instead.
  return {
    supported: true,
    value: (args) => args.every((arg) => {
      const escaped = arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(command);
    }),
  };
}

function unreadable(pid: number, reason: string): Probe<ArgMatcher | null> {
  return processExists(pid)
    ? { supported: false, reason: `pid ${pid} is running but ${reason}` }
    : { supported: true, value: null };
}

/**
 * Splits a Windows command line into argv using the MSVC runtime rules that
 * CommandLineToArgvW follows and that libuv's quoting (Node's spawn) targets:
 * the program name ends at the first unquoted whitespace and takes quotes
 * literally around it; afterwards, 2n backslashes before a quote yield n and
 * toggle quoting, 2n+1 yield n plus a literal quote, `""` inside quotes is a
 * literal quote, and backslashes elsewhere are literal.
 */
export function splitWindowsCommandLine(line: string): string[] {
  const argv: string[] = [];
  let i = 0;
  const n = line.length;
  const isSpace = (ch: string | undefined) => ch === " " || ch === "\t";

  // Program name: no escape processing.
  while (i < n && isSpace(line[i])) i++;
  if (i < n) {
    let prog = "";
    let quoted = false;
    for (; i < n; i++) {
      const ch = line[i]!;
      if (ch === '"') quoted = !quoted;
      else if (isSpace(ch) && !quoted) break;
      else prog += ch;
    }
    argv.push(prog);
  }

  while (i < n) {
    while (i < n && isSpace(line[i])) i++;
    if (i >= n) break;
    let arg = "";
    let quoted = false;
    while (i < n) {
      const ch = line[i]!;
      if (ch === "\\") {
        let slashes = 0;
        while (i < n && line[i] === "\\") {
          slashes++;
          i++;
        }
        if (line[i] === '"') {
          arg += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 1) {
            arg += '"';
            i++;
          }
        } else {
          arg += "\\".repeat(slashes);
        }
        continue;
      }
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          arg += '"';
          i += 2;
          continue;
        }
        quoted = !quoted;
        i++;
        continue;
      }
      if (isSpace(ch) && !quoted) break;
      arg += ch;
      i++;
    }
    argv.push(arg);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/**
 * Asks a process to exit (`force: false`) or kills it (`force: true`).
 *
 * POSIX: SIGTERM / SIGKILL to the pid, exactly as before.
 * Windows: there are no signals. `process.kill` maps every signal to
 * TerminateProcess on that ONE pid, which hard-kills Chrome's browser process
 * (unflushed profile writes, such as a fresh sign-in, can be lost) and orphans
 * its helpers. A graceful stop is `taskkill` without /F on the browser pid: it
 * posts WM_CLOSE, and Chrome shuts its own helpers down. (Adding /T would aim
 * WM_CLOSE at windowless helpers too, which always "fails".) The escalation is
 * `/T /F`, which takes the whole tree.
 *
 * Throws when the request could not be delivered (no such process, access
 * denied), matching process.kill so callers keep one error path.
 */
/** Liveness without a signal. On Windows process.kill(pid, 0) opens the process
 *  and reports, which is exactly what is wanted here. */
export function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function terminateProcess(pid: number, force: boolean): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`);
  if (process.platform !== "win32") {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return;
  }
  const out = run(systemTool("taskkill.exe", "taskkill"), ["/PID", String(pid), ...(force ? ["/T", "/F"] : [])]);
  if (!out.ok) {
    // No taskkill (a stripped image): TerminateProcess on the pid is still a stop.
    process.kill(pid, "SIGTERM");
    return;
  }
  if (out.status !== 0) {
    // Gone already: report it the way process.kill does (ESRCH).
    if (!processExists(pid)) throw Object.assign(new Error(`no such process ${pid}`), { code: "ESRCH" });
    // Alive but nothing to close (e.g. mid-startup, no window yet): only /F stops it.
    if (!force) return terminateProcess(pid, true);
    throw new Error(`taskkill could not stop pid ${pid} (status ${out.status})`);
  }
}
