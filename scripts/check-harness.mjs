#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const harness = process.env.HARNESS_UNDER_TEST;

const definitions = {
  "claude-code": {
    configure(environment, root) {
      const directory = join(root, "claude");
      environment.CLAUDE_CONFIG_DIR = directory;
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "CLAUDE.md"), "Use concise, reviewable changes.\n");
      writeFileSync(
        join(directory, "settings.json"),
        '{"permissions":{"deny":["Read(./.env")]}}\n',
      );
    },
  },
  codex: {
    configure(environment, root) {
      const directory = join(root, "codex");
      environment.CODEX_HOME = directory;
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "config.toml"),
        'approval_policy = "never"\nsandbox_mode = "read-only"\n\n[history]\npersistence = "none"\n',
      );
      writeFileSync(join(directory, "AGENTS.md"), "Use concise, reviewable changes.\n");
      writeFileSync(join(directory, "ci.config.toml"), 'sandbox_mode = "read-only"\n');
    },
  },
  grok: {
    configure(environment, root) {
      const directory = join(root, "grok");
      environment.GROK_HOME = directory;
      environment.GROK_DISABLE_AUTOUPDATER = "1";
      environment.GROK_MEMORY = "0";
      environment.GROK_SUBAGENTS = "0";
      environment.GROK_WEB_FETCH = "0";
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "config.toml"),
        '[models]\ndefault = "grok-build"\n\n[model."isolated-check"]\nmodel = "grok-build"\nenv_key = "AGENT_MAN_UNUSED_TEST_KEY"\n',
      );
      writeFileSync(join(directory, "sandbox.toml"), '[sandbox]\nprofile = "read-only"\n');
    },
  },
  "gemini-cli": {
    configure(environment, root) {
      const home = join(root, "gemini-home");
      const directory = join(home, ".gemini");
      environment.GEMINI_CLI_HOME = home;
      environment.GEMINI_TELEMETRY_ENABLED = "false";
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "settings.json"),
        '{"general":{"defaultApprovalMode":"plan"},"telemetry":{"enabled":false}}\n',
      );
      writeFileSync(join(directory, "GEMINI.md"), "Use concise, reviewable changes.\n");
    },
  },
  opencode: {
    configure(environment, root) {
      const xdg = join(root, "xdg-config");
      const directory = join(xdg, "opencode");
      environment.XDG_CONFIG_HOME = xdg;
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "opencode.json"),
        '{"$schema":"https://opencode.ai/config.json","autoupdate":false}\n',
      );
      writeFileSync(join(directory, "AGENTS.md"), "Use concise, reviewable changes.\n");
    },
  },
  pi: {
    configure(environment, root) {
      const directory = join(root, "pi-agent");
      environment.PI_CODING_AGENT_DIR = directory;
      environment.PI_OFFLINE = "1";
      environment.PI_SKIP_VERSION_CHECK = "1";
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "settings.json"),
        '{"defaultThinkingLevel":"low","enableAnalytics":false}\n',
      );
    },
  },
};

if (harness === undefined || !(harness in definitions)) {
  console.error(`HARNESS_UNDER_TEST must be one of: ${Object.keys(definitions).join(", ")}`);
  process.exitCode = 1;
} else {
  const root = mkdtempSync(join(tmpdir(), `agent-man-${harness}-`));
  const home = join(root, "home");
  const environment = {
    ...process.env,
    AGENT_MAN_HOME: join(root, "state"),
    HOME: home,
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
  };
  delete environment.ANTHROPIC_API_KEY;
  delete environment.OPENAI_API_KEY;
  delete environment.XAI_API_KEY;

  function runAgentMan(arguments_) {
    const result = spawnSync(process.execPath, ["dist/src/cli.js", ...arguments_], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    });
    if (result.error !== undefined || result.status !== 0) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
      throw new Error(`agent-man ${arguments_.join(" ")} failed: ${detail}`);
    }
    if (arguments_.includes("--json")) {
      return JSON.parse(result.stdout);
    }
    return undefined;
  }

  try {
    mkdirSync(home, { recursive: true });
    definitions[harness].configure(environment, root);
    runAgentMan(["init", "--local"]);
    const repository = join(environment.AGENT_MAN_HOME, "repo");
    for (const [key, value] of [
      ["user.name", "agent-man CI"],
      ["user.email", "agent-man-ci@example.invalid"],
      ["commit.gpgSign", "false"],
    ]) {
      const result = spawnSync("git", ["config", key, value], {
        cwd: repository,
        encoding: "utf8",
        env: environment,
      });
      if (result.status !== 0) {
        throw new Error(`git config ${key} failed: ${result.stderr?.trim() ?? "unknown error"}`);
      }
    }
    runAgentMan(["add", harness]);
    const doctor = runAgentMan(["doctor", "--json"]);
    if (doctor?.ok !== true || doctor.result?.ok !== true) {
      throw new Error(`doctor did not verify ${harness}: ${JSON.stringify(doctor)}`);
    }
    runAgentMan(["profiles", "--json"]);
    runAgentMan(["plan", "--json"]);
    runAgentMan(["sync", "--json"]);
    const status = runAgentMan(["status", "--json"]);
    if (status?.ok !== true) {
      throw new Error(`status failed for ${harness}: ${JSON.stringify(status)}`);
    }
    console.log(`Isolated ${harness} installation accepted its native agent-man profile.`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
