#!/usr/bin/env node
/**
 * `clipy setup` — agent wiring.
 *
 * Covers the cases that would silently break somebody's editor: merging into an
 * existing MCP config without dropping their other servers, refusing to rewrite
 * a config we cannot parse, and reporting "manual" instead of a false success
 * when the agent's own CLI is missing.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  detectSetupTarget,
  isSetupTarget,
  mcpSnippetFor,
  registerMcpServer,
  renderSetupBox,
  shortPath,
  skillPathFor,
  SETUP_TARGETS,
} = await import("../dist/setup.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function makeEnv(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "clipy-setup-"));
  return {
    home,
    env: {},
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

// --- target resolution ------------------------------------------------------

test("detects the host agent from its own env var", () => {
  assert.equal(detectSetupTarget({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectSetupTarget({ CODEX_HOME: "/x/.codex" }), "codex");
  assert.equal(detectSetupTarget({ TERM_PROGRAM: "cursor" }), "cursor");
  assert.equal(detectSetupTarget({ CODEX_CI: "1" }), "codex");
  assert.equal(detectSetupTarget({ CODEX_THREAD_ID: "thread-1" }), "codex");
});

test("refuses to guess when two agents' signals are both present", () => {
  // Nested runs are real (an agent shelling out to another agent's CLI), and
  // guessing there installs into the wrong home directory.
  assert.equal(detectSetupTarget({ CLAUDECODE: "1", CODEX_HOME: "/x/.codex" }), undefined);
  assert.equal(detectSetupTarget({}), undefined);
});

test("isSetupTarget accepts every published target and nothing else", () => {
  for (const t of SETUP_TARGETS) assert.equal(isSetupTarget(t), true);
  assert.equal(isSetupTarget("emacs"), false);
  assert.equal(isSetupTarget(undefined), false);
});

test("skill paths cover every supported agent", () => {
  const env = makeEnv();
  assert.equal(skillPathFor("claude", env), join(env.home, ".claude/skills/clipy/SKILL.md"));
  assert.equal(skillPathFor("cursor", env), join(env.home, ".cursor/skills/clipy/SKILL.md"));
  assert.equal(skillPathFor("windsurf", env), join(env.home, ".codeium/windsurf/skills/clipy/SKILL.md"));
  assert.equal(skillPathFor("opencode", env), join(env.home, ".config/opencode/skills/clipy/SKILL.md"));
  env.env = { XDG_CONFIG_HOME: join(env.home, "xdg") };
  assert.equal(skillPathFor("opencode", env), join(env.home, "xdg/opencode/skills/clipy/SKILL.md"));
});

test("codex honours CODEX_HOME", () => {
  const env = makeEnv({ env: { CODEX_HOME: "/custom/codex" } });
  assert.equal(skillPathFor("codex", env), "/custom/codex/skills/clipy/SKILL.md");
});

// --- config-file agents -----------------------------------------------------

test("cursor: creates the config when none exists", async () => {
  const env = makeEnv();
  const result = await registerMcpServer("cursor", env);
  assert.equal(result.method, "config-file");
  assert.equal(result.changed, true);
  assert.equal(result.alreadyPresent, false);
  const config = JSON.parse(readFileSync(result.path, "utf8"));
  assert.deepEqual(config.mcpServers.clipy, { command: "npx", args: ["-y", "@clipy/mcp@latest"] });
  assert.equal(statSync(result.path).mode & 0o777, 0o600);
});

test("cursor: merges alongside other servers instead of replacing them", async () => {
  const env = makeEnv();
  const path = join(env.home, ".cursor", "mcp.json");
  mkdirSync(join(env.home, ".cursor"), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: { linear: { command: "linear-mcp" } }, other: 1 }));

  await registerMcpServer("cursor", env);
  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(config.mcpServers.linear, { command: "linear-mcp" }, "unrelated server must survive");
  assert.equal(config.other, 1, "unrelated top-level keys must survive");
  assert.ok(config.mcpServers.clipy);
});

test("re-running reports no change rather than rewriting", async () => {
  const env = makeEnv();
  const first = await registerMcpServer("cursor", env);
  assert.equal(first.changed, true);
  const second = await registerMcpServer("cursor", env);
  assert.equal(second.changed, false);
  assert.equal(second.alreadyPresent, true);
});

test("an outdated clipy entry is updated in place", async () => {
  const env = makeEnv();
  const path = join(env.home, ".cursor", "mcp.json");
  mkdirSync(join(env.home, ".cursor"), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: { clipy: { command: "npx", args: ["-y", "@clipy/mcp@0.1.0"] } } }));

  const result = await registerMcpServer("cursor", env);
  assert.equal(result.changed, true);
  assert.equal(result.alreadyPresent, true, "it was present, just stale");
  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(config.mcpServers.clipy.args, ["-y", "@clipy/mcp@latest"]);
});

test("opencode uses its own local-transport shape under XDG_CONFIG_HOME", async () => {
  const env = makeEnv();
  const xdg = join(env.home, "xdg");
  env.env = { XDG_CONFIG_HOME: xdg };

  const result = await registerMcpServer("opencode", env);
  assert.equal(result.path, join(xdg, "opencode", "opencode.json"));
  const config = JSON.parse(readFileSync(result.path, "utf8"));
  assert.deepEqual(config.mcp.clipy, {
    type: "local",
    command: ["npx", "-y", "@clipy/mcp@latest"],
    enabled: true,
  });
});

test("opencode writes into an existing .jsonc rather than creating a second file", async () => {
  const env = makeEnv();
  const dir = join(env.home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode.jsonc"), JSON.stringify({ theme: "dark" }));

  const result = await registerMcpServer("opencode", env);
  assert.equal(result.path, join(dir, "opencode.jsonc"));
  assert.equal(existsSync(join(dir, "opencode.json")), false);
  assert.equal(JSON.parse(readFileSync(result.path, "utf8")).theme, "dark");
});

test("an unparseable config is left untouched and reported as manual", async () => {
  const env = makeEnv();
  const dir = join(env.home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.jsonc");
  const original = '{\n  // a comment JSON.parse cannot read\n  "theme": "dark"\n}';
  writeFileSync(path, original);

  const result = await registerMcpServer("opencode", env);
  assert.equal(result.method, "manual");
  assert.equal(result.changed, false);
  assert.equal(readFileSync(path, "utf8"), original, "must not clobber a config it cannot parse");
  assert.match(result.snippet, /"type": "local"/);
  assert.match(result.reason, /not plain JSON/);
});

test("a non-object MCP root is left untouched and reported as manual", async () => {
  const env = makeEnv();
  const dir = join(env.home, ".cursor");
  const path = join(dir, "mcp.json");
  mkdirSync(dir, { recursive: true });
  const original = JSON.stringify({ mcpServers: "preserve-me", other: 7 });
  writeFileSync(path, original);

  const result = await registerMcpServer("cursor", env);
  assert.equal(result.method, "manual");
  assert.equal(result.changed, false);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.match(result.reason, /mcpServers/);
});

test("a symlinked MCP config is refused without touching its target", async () => {
  const env = makeEnv();
  const dir = join(env.home, ".cursor");
  const path = join(dir, "mcp.json");
  const target = join(env.home, "target.json");
  const original = JSON.stringify({ keep: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, original);
  symlinkSync(target, path);

  const result = await registerMcpServer("cursor", env);
  assert.equal(result.method, "manual");
  assert.equal(readFileSync(target, "utf8"), original);
});

// --- agent-CLI agents -------------------------------------------------------

test("claude/codex register through the agent's own mcp add", async () => {
  const calls = [];
  const env = makeEnv({
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { code: 0, stdout: "Added stdio MCP server clipy", stderr: "" };
    },
  });

  const claude = await registerMcpServer("claude", env);
  assert.equal(claude.method, "agent-cli");
  assert.equal(claude.changed, true);
  assert.equal(calls[0], "claude mcp add --scope user clipy -- npx -y @clipy/mcp@latest");

  await registerMcpServer("codex", env);
  assert.equal(calls[1], "codex mcp add clipy -- npx -y @clipy/mcp@latest");
});

test("a missing agent binary falls back to manual with the exact command", async () => {
  const env = makeEnv({
    run: async () => ({ code: -1, stdout: "", stderr: "", spawnError: "spawn claude ENOENT" }),
  });
  const result = await registerMcpServer("claude", env);
  assert.equal(result.method, "manual");
  assert.equal(result.command, "claude mcp add --scope user clipy -- npx -y @clipy/mcp@latest");
  assert.match(result.reason, /not on PATH/);
});

test("'already exists' is accepted only after verifying the official command", async () => {
  const calls = [];
  const env = makeEnv({
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[1] === "add") return { code: 1, stdout: "", stderr: "MCP server clipy already exists in user config" };
      return {
        code: 0,
        stdout: "clipy\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: npx\n  Args: -y @clipy/mcp@latest",
        stderr: "",
      };
    },
  });
  const result = await registerMcpServer("claude", env);
  assert.equal(result.method, "agent-cli");
  assert.equal(result.alreadyPresent, true);
  assert.equal(result.changed, false);
  assert.equal(calls[1], "claude mcp get clipy");
});

test("a conflicting existing agent-CLI entry is reported as manual", async () => {
  const env = makeEnv({
    run: async (_command, args) =>
      args[1] === "add"
        ? { code: 1, stdout: "", stderr: "MCP server clipy already exists" }
        : { code: 0, stdout: "clipy\n  Command: node\n  Args: unexpected.js", stderr: "" },
  });
  const result = await registerMcpServer("claude", env);
  assert.equal(result.method, "manual");
  assert.match(result.reason, /different command/);
  assert.equal(
    result.command,
    "claude mcp remove clipy --scope user && claude mcp add --scope user clipy -- npx -y @clipy/mcp@latest",
  );
});

test("an existing Codex entry is verified as global stdio JSON", async () => {
  const calls = [];
  const env = makeEnv({
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[1] === "add") return { code: 1, stdout: "", stderr: "MCP server clipy already exists" };
      return {
        code: 0,
        stdout: JSON.stringify({
          name: "clipy",
          transport: { type: "stdio", command: "npx", args: ["-y", "@clipy/mcp@latest"] },
        }),
        stderr: "",
      };
    },
  });
  const result = await registerMcpServer("codex", env);
  assert.equal(result.method, "agent-cli");
  assert.equal(result.alreadyPresent, true);
  assert.equal(calls[1], "codex mcp get clipy --json");
});

// --- command contract -------------------------------------------------------

function runCli(args, env = {}, prepare) {
  const home = mkdtempSync(join(tmpdir(), "clipy-setup-command-"));
  prepare?.(home);
  const result = spawnSync(process.execPath, [join(process.cwd(), "dist", "index.js"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: join(home, ".config"),
      ...env,
    },
  });
  return { ...result, home };
}

test("setup --json returns a stable error object for an invalid target", () => {
  const result = runCli(["setup", "emacs", "--json"]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(body).sort(), ["code", "error", "ok", "partial", "remediation"].sort());
  assert.equal(body.ok, false);
  assert.equal(body.code, "invalid_target");
});

test("setup --json returns a stable error object when target detection is ambiguous", () => {
  const result = runCli(["setup", "--json"], { CLAUDECODE: "1", CODEX_HOME: "/tmp/codex" });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.code, "target_detection_failed");
});

test("setup --json requires authentication before writing agent state", () => {
  const result = runCli(["setup", "cursor", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.code, "authentication_required");
  assert.equal(existsSync(join(result.home, ".cursor", "mcp.json")), false);
  assert.equal(existsSync(join(result.home, ".cursor", "skills", "clipy", "SKILL.md")), false);
});

test("authenticated setup --json reports one complete truthful result", () => {
  const result = runCli(["setup", "cursor", "--json"], { CLIPY_API_KEY: "clipy_sk_live_test" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.authenticated, true);
  assert.equal(body.skill.installed, true);
  assert.equal(body.mcp.method, "config-file");
});

test("setup --json reports manual MCP work as incomplete without installing the skill", () => {
  const original = JSON.stringify({ mcpServers: "preserve-me" });
  const result = runCli(
    ["setup", "cursor", "--json"],
    { CLIPY_API_KEY: "clipy_sk_live_test" },
    (home) => {
      const dir = join(home, ".cursor");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mcp.json"), original);
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.code, "mcp_registration_incomplete");
  assert.equal(body.partial.mcp.method, "manual");
  assert.equal(body.partial.skill.installed, false);
  assert.equal(readFileSync(join(result.home, ".cursor", "mcp.json"), "utf8"), original);
  assert.equal(existsSync(join(result.home, ".cursor", "skills", "clipy", "SKILL.md")), false);
});

test("the skill-only agents command supports Windsurf and OpenCode", () => {
  const windsurf = runCli(["agents", "install", "windsurf", "--json"]);
  assert.equal(windsurf.status, 0, windsurf.stderr);
  assert.equal(JSON.parse(windsurf.stdout).target, "windsurf");
  assert.equal(existsSync(join(windsurf.home, ".codeium", "windsurf", "skills", "clipy", "SKILL.md")), true);

  const opencode = runCli(["agents", "install", "opencode", "--json"]);
  assert.equal(opencode.status, 0, opencode.stderr);
  assert.equal(JSON.parse(opencode.stdout).target, "opencode");
  assert.equal(existsSync(join(opencode.home, ".config", "opencode", "skills", "clipy", "SKILL.md")), true);
});

test("the machine-readable guide publishes all five skill-only agent targets", () => {
  const result = runCli(["guide", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const guide = JSON.parse(result.stdout);
  const agents = guide.commands.find((command) => command.name === "agents");
  assert.equal(
    agents.usage,
    "clipy agents <status|install|uninstall> <claude|codex|cursor|windsurf|opencode>",
  );
});

test("a genuine agent-cli failure surfaces its reason, not a false success", async () => {
  const env = makeEnv({
    run: async () => ({ code: 1, stdout: "", stderr: "error: config file is read-only\n" }),
  });
  const result = await registerMcpServer("claude", env);
  assert.equal(result.method, "manual");
  assert.match(result.reason, /read-only/);
});

// --- presentation -----------------------------------------------------------

test("snippet matches the shape each agent actually reads", () => {
  const env = makeEnv();
  assert.deepEqual(JSON.parse(mcpSnippetFor("cursor", env)).mcpServers.clipy, {
    command: "npx",
    args: ["-y", "@clipy/mcp@latest"],
  });
  assert.equal(JSON.parse(mcpSnippetFor("opencode", env)).mcp.clipy.type, "local");
});

test("shortPath collapses the home directory", () => {
  assert.equal(shortPath("/Users/x/.cursor/mcp.json", "/Users/x"), "~/.cursor/mcp.json");
  assert.equal(shortPath("/etc/mcp.json", "/Users/x"), "/etc/mcp.json");
});

test("the completion box stays rectangular", () => {
  const lines = renderSetupBox("Clipy setup complete", ["a", "a much longer row than the first one"]).split("\n");
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(widths.size, 1, `every line must be the same width, got ${[...widths].join(",")}`);
});

test("an over-long row is clipped, not allowed to blow out the box", () => {
  const lines = renderSetupBox("t", ["x".repeat(400)]).split("\n");
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(widths.size, 1);
  assert.ok([...widths][0] < 100, "box must stay terminal-sized");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`  ✗ ${name}\n    ${e.message}\n`);
  }
}
process.stdout.write(failed ? `\n${failed} failing\n` : `\n${tests.length} passing\n`);
process.exit(failed ? 1 : 0);
