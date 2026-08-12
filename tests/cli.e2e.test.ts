import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runCommand } from "../src/process.js";

const cli = resolve("dist/src/cli.js");

interface Device {
  readonly environment: NodeJS.ProcessEnv;
  readonly grok: string;
  readonly home: string;
  readonly state: string;
}

function makeDevice(root: string, name: string): Device {
  const home = join(root, `${name}-home`);
  const grok = join(root, `${name}-grok`);
  const state = join(root, `${name}-state`);
  mkdirSync(home, { recursive: true });
  mkdirSync(grok, { recursive: true });
  return {
    environment: {
      ...process.env,
      AGENT_MAN_HOME: state,
      GIT_AUTHOR_EMAIL: "agent-man-e2e@example.invalid",
      GIT_AUTHOR_NAME: "Agent Man E2E",
      GIT_COMMITTER_EMAIL: "agent-man-e2e@example.invalid",
      GIT_COMMITTER_NAME: "Agent Man E2E",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgSign",
      GIT_CONFIG_VALUE_0: "false",
      GROK_HOME: grok,
      HOME: home,
    },
    grok,
    home,
    state,
  };
}

function agentMan(device: Device, arguments_: readonly string[]): string {
  return runCommand(process.execPath, [cli, ...arguments_], {
    env: device.environment,
  }).stdout;
}

function jsonResult(output: string): Record<string, unknown> {
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null) {
    throw new Error("CLI JSON output is not an object.");
  }
  return Object.fromEntries(Object.entries(value));
}

test("the built CLI exposes stable JSON and synchronizes isolated devices", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-cli-e2e-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    writeFileSync(join(first.grok, "config.toml"), 'theme = "dark"\n');
    writeFileSync(join(first.grok, "auth.json"), '{"token":"first-secret"}\n');

    agentMan(first, ["init", "--local"]);
    runCommand("git", ["remote", "add", "origin", remote], {
      cwd: join(first.state, "repo"),
      env: first.environment,
    });
    agentMan(first, ["add", "grok"]);
    const plan = jsonResult(agentMan(first, ["plan", "--json"]));
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.command, "plan");
    assert.equal(plan.ok, true);
    agentMan(first, ["sync", "--json"]);

    const second = makeDevice(root, "second");
    writeFileSync(join(second.grok, "auth.json"), '{"token":"second-secret"}\n');
    agentMan(second, ["init", "--remote", remote]);

    assert.equal(readFileSync(join(second.grok, "config.toml"), "utf8"), 'theme = "dark"\n');
    assert.equal(
      readFileSync(join(second.grok, "auth.json"), "utf8"),
      '{"token":"second-secret"}\n',
    );
    const status = jsonResult(agentMan(second, ["status", "--json"]));
    assert.equal(status.schemaVersion, 1);
    assert.equal(status.ok, true);

    const tracked = runCommand("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"])
      .stdout.trim()
      .split("\n");
    assert.equal(tracked.includes(".grok/config.toml"), true);
    assert.equal(tracked.includes(".grok/auth.json"), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the built CLI installs its bundled skill without touching the real home", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-cli-skill-"));
  try {
    const device = makeDevice(root, "skill");
    const result = jsonResult(agentMan(device, ["skill", "install", "--target", "all", "--json"]));
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(device.home, ".agents", "skills", "agent-man", "SKILL.md")), true);
    assert.equal(existsSync(join(device.home, ".claude", "skills", "agent-man", "SKILL.md")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
