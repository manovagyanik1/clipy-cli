import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  MCP_ARGS,
  MCP_COMMAND,
  MCP_SERVER_NAME,
  type McpRegistration,
  type SetupEnv,
  type SetupTarget,
} from "./setupTypes.js";

interface ConfigFilePlan {
  candidates: readonly string[];
  root: "mcpServers" | "mcp";
  entry: Record<string, unknown>;
}

interface JsonConfig {
  parsed: Record<string, unknown> | null;
  raw: string | null;
  unparseable: boolean;
}

function configFilePlan(target: SetupTarget, env: SetupEnv): ConfigFilePlan | null {
  const stdio = { command: MCP_COMMAND, args: [...MCP_ARGS] };
  switch (target) {
    case "cursor":
      return { candidates: [join(env.home, ".cursor", "mcp.json")], root: "mcpServers", entry: stdio };
    case "windsurf":
      return {
        candidates: [join(env.home, ".codeium", "windsurf", "mcp_config.json")],
        root: "mcpServers",
        entry: stdio,
      };
    case "opencode": {
      const base = env.env.XDG_CONFIG_HOME?.trim() || join(env.home, ".config");
      return {
        candidates: [join(base, "opencode", "opencode.json"), join(base, "opencode", "opencode.jsonc")],
        root: "mcp",
        entry: { type: "local", command: [MCP_COMMAND, ...MCP_ARGS], enabled: true },
      };
    }
    default:
      return null;
  }
}

export function mcpSnippetFor(target: SetupTarget, env: SetupEnv): string {
  const plan = configFilePlan(target, env);
  const root = plan?.root ?? "mcpServers";
  const entry = plan?.entry ?? { command: MCP_COMMAND, args: [...MCP_ARGS] };
  return JSON.stringify({ [root]: { [MCP_SERVER_NAME]: entry } }, null, 2);
}

function readJsonConfig(path: string): JsonConfig {
  if (!existsSync(path)) return { parsed: null, raw: null, unparseable: false };
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) return { parsed: null, raw: null, unparseable: true };
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return { parsed: {}, raw, unparseable: false };
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { parsed: null, raw, unparseable: true };
    }
    return { parsed: value as Record<string, unknown>, raw, unparseable: false };
  } catch {
    return { parsed: null, raw: null, unparseable: true };
  }
}

function writeAtomicJson(path: string, value: Record<string, unknown>, previousRaw: string | null): void {
  mkdirSync(dirname(path), { recursive: true });
  const currentMode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
  const mode = currentMode & 0o077 ? 0o600 : currentMode || 0o600;
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tempPath, mode);
    if (previousRaw === null) {
      if (existsSync(path)) throw new Error("the config was created by another process during setup");
    } else if (readFileSync(path, "utf8") !== previousRaw) {
      throw new Error("the config changed while setup was running");
    }
    renameSync(tempPath, path);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

export function registerConfigMcpServer(target: SetupTarget, env: SetupEnv): McpRegistration | null {
  const plan = configFilePlan(target, env);
  if (!plan) return null;
  const path = plan.candidates.find((candidate) => existsSync(candidate)) ?? plan.candidates[0];
  let config: JsonConfig;
  try {
    config = readJsonConfig(path);
  } catch (error) {
    return manualResult(target, env, path, (error as Error).message);
  }
  if (config.unparseable) {
    return manualResult(target, env, path, `${path} is not plain JSON or is not a regular file`);
  }

  const parsed = config.parsed ?? {};
  const existingRoot = parsed[plan.root];
  if (existingRoot !== undefined && (!existingRoot || typeof existingRoot !== "object" || Array.isArray(existingRoot))) {
    return manualResult(target, env, path, `the existing ${plan.root} value is not an object`);
  }
  const servers = (existingRoot ?? {}) as Record<string, unknown>;
  if (JSON.stringify(servers[MCP_SERVER_NAME] ?? null) === JSON.stringify(plan.entry)) {
    return { method: "config-file", path, changed: false, alreadyPresent: true };
  }

  const next = { ...parsed, [plan.root]: { ...servers, [MCP_SERVER_NAME]: plan.entry } };
  try {
    writeAtomicJson(path, next, config.raw);
  } catch (error) {
    return manualResult(target, env, path, (error as Error).message);
  }
  return {
    method: "config-file",
    path,
    changed: true,
    alreadyPresent: MCP_SERVER_NAME in servers,
  };
}

function manualResult(target: SetupTarget, env: SetupEnv, path: string, reason: string): McpRegistration {
  return {
    method: "manual",
    path,
    changed: false,
    alreadyPresent: false,
    snippet: mcpSnippetFor(target, env),
    reason,
  };
}
