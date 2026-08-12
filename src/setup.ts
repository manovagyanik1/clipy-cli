/**
 * `clipy setup <agent>` — one command that wires Clipy into a coding agent.
 *
 * `agents install` writes the skill and deliberately leaves MCP alone. That
 * split is right when a human is choosing, and wrong when an agent is following
 * setup instructions: it turns "connect Clipy" into four commands across three
 * docs. `setup` is the explicit one-shot form — skill + MCP + login, named so
 * the wider blast radius is something the caller asked for rather than a side
 * effect of installing a skill file.
 *
 * Home paths, environment signals, and subprocesses come from SetupEnv so the
 * full matrix is testable against temporary directories.
 */

import { join } from "node:path";
import { mcpSnippetFor, registerConfigMcpServer } from "./setupConfig.js";
import {
  MCP_ARGS,
  MCP_COMMAND,
  MCP_SERVER_NAME,
  type McpRegistration,
  type SetupEnv,
  type SetupTarget,
} from "./setupTypes.js";

export { mcpSnippetFor } from "./setupConfig.js";
export {
  isSetupTarget,
  MCP_ARGS,
  MCP_COMMAND,
  MCP_SERVER_NAME,
  SETUP_TARGETS,
  type CommandResult,
  type McpMethod,
  type McpRegistration,
  type SetupEnv,
  type SetupTarget,
} from "./setupTypes.js";

// ---------------------------------------------------------------------------
// Which agent are we in?
// ---------------------------------------------------------------------------

/**
 * Best-effort detection from the host agent's own environment variables.
 *
 * Deliberately conservative: two different agents' signals firing at once means
 * we are running nested (an agent that spawned another agent's CLI), and
 * guessing there would install into the wrong home directory. Ambiguity returns
 * undefined so the caller asks for an explicit target instead.
 */
export function detectSetupTarget(env: NodeJS.ProcessEnv): SetupTarget | undefined {
  const hits = new Set<SetupTarget>();
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) hits.add("claude");
  if (
    env.CODEX_HOME ||
    env.CODEX_SANDBOX ||
    env.CODEX_CI ||
    env.CODEX_THREAD_ID ||
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
  ) {
    hits.add("codex");
  }
  if (env.CURSOR_TRACE_ID || env.TERM_PROGRAM === "cursor") hits.add("cursor");
  if (env.OPENCODE || env.OPENCODE_BIN_PATH) hits.add("opencode");
  if (env.WINDSURF_USER_ID || env.TERM_PROGRAM === "windsurf") hits.add("windsurf");
  return hits.size === 1 ? [...hits][0] : undefined;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * Where each supported agent reads its global SKILL.md.
 */
export function skillPathFor(target: SetupTarget, env: SetupEnv): string {
  switch (target) {
    case "claude":
      return join(env.home, ".claude", "skills", "clipy", "SKILL.md");
    case "codex":
      return join(env.env.CODEX_HOME?.trim() || join(env.home, ".codex"), "skills", "clipy", "SKILL.md");
    case "cursor":
      return join(env.home, ".cursor", "skills", "clipy", "SKILL.md");
    case "windsurf":
      return join(env.home, ".codeium", "windsurf", "skills", "clipy", "SKILL.md");
    case "opencode": {
      const base = env.env.XDG_CONFIG_HOME?.trim() || join(env.home, ".config");
      return join(base, "opencode", "skills", "clipy", "SKILL.md");
    }
  }
}

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

/** The agent's own MCP subcommand, when it has one that writes a global config. */
function agentCliCommand(target: SetupTarget): readonly string[] | null {
  switch (target) {
    // `--scope user` is what makes Clipy show up in every project; the default
    // `local` scope is why a server "disappears" in another repo.
    case "claude":
      return ["claude", "mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", MCP_COMMAND, ...MCP_ARGS];
    case "codex":
      return ["codex", "mcp", "add", MCP_SERVER_NAME, "--", MCP_COMMAND, ...MCP_ARGS];
    default:
      return null;
  }
}

export async function registerMcpServer(target: SetupTarget, env: SetupEnv): Promise<McpRegistration> {
  const argv = agentCliCommand(target);
  if (argv) {
    const printable = argv.join(" ");
    const result = await env.run(argv[0], argv.slice(1));
    if (result.spawnError) {
      return {
        method: "manual",
        path: null,
        changed: false,
        alreadyPresent: false,
        command: printable,
        reason: `the \`${argv[0]}\` command is not on PATH, so Clipy could not register the MCP server for you`,
      };
    }
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) {
      // Re-running setup is expected (a version bump, a second project), and an
      // agent that treats "already there" as failure will loop on it.
      if (/already exists|already configured/i.test(output)) {
        const verified = await verifyAgentCliRegistration(target, env);
        if (verified) {
          return { method: "agent-cli", path: null, changed: false, alreadyPresent: true, command: printable };
        }
        return {
          method: "manual",
          path: null,
          changed: false,
          alreadyPresent: true,
          command: replacementCommand(target, printable),
          reason: "an existing Clipy MCP entry uses a different command or could not be verified",
        };
      }
      return {
        method: "manual",
        path: null,
        changed: false,
        alreadyPresent: false,
        command: printable,
        reason: (result.stderr || result.stdout).trim().split("\n")[0] || `\`${printable}\` exited ${result.code}`,
      };
    }
    return { method: "agent-cli", path: null, changed: true, alreadyPresent: false, command: printable };
  }

  const configured = registerConfigMcpServer(target, env);
  if (configured) return configured;

  return {
    method: "manual",
    path: null,
    changed: false,
    alreadyPresent: false,
    snippet: mcpSnippetFor(target, env),
    reason: "this agent has no known MCP config location",
  };
}

function replacementCommand(target: SetupTarget, addCommand: string): string {
  const removeCommand =
    target === "claude"
      ? `claude mcp remove ${MCP_SERVER_NAME} --scope user`
      : `codex mcp remove ${MCP_SERVER_NAME}`;
  return `${removeCommand} && ${addCommand}`;
}

async function verifyAgentCliRegistration(target: SetupTarget, env: SetupEnv): Promise<boolean> {
  const args = target === "codex" ? ["mcp", "get", MCP_SERVER_NAME, "--json"] : ["mcp", "get", MCP_SERVER_NAME];
  const result = await env.run(target, args);
  if (result.code !== 0 || result.spawnError) return false;
  if (target === "claude") {
    const scope = result.stdout.match(/^\s*Scope:\s*(.+)\s*$/im)?.[1]?.trim();
    const transport = result.stdout.match(/^\s*Type:\s*(.+)\s*$/im)?.[1]?.trim();
    const command = result.stdout.match(/^\s*Command:\s*(.+)\s*$/im)?.[1]?.trim();
    const cliArgs = result.stdout.match(/^\s*Args:\s*(.+)\s*$/im)?.[1]?.trim().split(/\s+/);
    return (
      scope?.startsWith("User config") === true &&
      transport === "stdio" &&
      command === MCP_COMMAND &&
      JSON.stringify(cliArgs) === JSON.stringify(MCP_ARGS)
    );
  }
  try {
    return containsOfficialCommand(JSON.parse(result.stdout) as unknown);
  } catch {
    return false;
  }
}

function containsOfficialCommand(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsOfficialCommand);
  const record = value as Record<string, unknown>;
  if (
    record.type === "stdio" &&
    record.command === MCP_COMMAND &&
    JSON.stringify(record.args) === JSON.stringify(MCP_ARGS)
  ) {
    return true;
  }
  return Object.values(record).some(containsOfficialCommand);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** `/Users/x/.cursor/mcp.json` → `~/.cursor/mcp.json`, so the box stays readable. */
export function shortPath(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const BOX_MAX_WIDTH = 76;

/** Rows must be plain text -- an ANSI escape would break the alignment. */
function boxLine(text: string, width: number): string {
  const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  const pad = Math.max(0, width - clipped.length);
  return `│  ${clipped}${" ".repeat(pad)}  │`;
}

export function renderSetupBox(title: string, rows: readonly string[]): string {
  const width = Math.min(BOX_MAX_WIDTH, Math.max(title.length, ...rows.map((r) => r.length), 44));
  const top = `┌─ ${title} ${"─".repeat(Math.max(0, width - title.length + 1))}┐`;
  const bottom = `└${"─".repeat(width + 4)}┘`;
  return [top, ...rows.map((r) => boxLine(r, width)), bottom].join("\n");
}
