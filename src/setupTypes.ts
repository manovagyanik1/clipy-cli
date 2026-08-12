export const SETUP_TARGETS = ["claude", "codex", "cursor", "windsurf", "opencode"] as const;
export type SetupTarget = (typeof SETUP_TARGETS)[number];

export function isSetupTarget(value: string | undefined): value is SetupTarget {
  return !!value && (SETUP_TARGETS as readonly string[]).includes(value);
}

export const MCP_SERVER_NAME = "clipy";
export const MCP_COMMAND = "npx";
export const MCP_ARGS = ["-y", "@clipy/mcp@latest"] as const;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

export interface SetupEnv {
  home: string;
  env: NodeJS.ProcessEnv;
  run: (command: string, args: readonly string[]) => Promise<CommandResult>;
}

export type McpMethod = "agent-cli" | "config-file" | "manual";

export interface McpRegistration {
  method: McpMethod;
  path: string | null;
  changed: boolean;
  alreadyPresent: boolean;
  command?: string;
  snippet?: string;
  reason?: string;
}
