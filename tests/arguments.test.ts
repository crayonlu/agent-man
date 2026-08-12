import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TEMPLATE, parseArguments } from "../src/arguments.js";
import { resolveGithubRepository } from "../src/commands.js";
import { CommandRunner } from "../src/process.js";

test("init defaults to the private GitHub template flow", () => {
  assert.deepEqual(parseArguments(["init"], {}), {
    action: {
      kind: "init",
      mode: {
        kind: "github",
        repository: "agent-man-config",
        template: DEFAULT_TEMPLATE,
      },
    },
    json: false,
  });
});

test("global JSON mode is accepted before or after a command", () => {
  assert.deepEqual(parseArguments(["--json", "plan"], {}), {
    action: { kind: "plan" },
    json: true,
  });
  assert.deepEqual(parseArguments(["doctor", "--json"], {}), {
    action: { kind: "doctor" },
    json: true,
  });
});

test("init accepts explicit GitHub, remote, and local storage", () => {
  assert.deepEqual(
    parseArguments(
      [
        "init",
        "--github",
        "crayonlu/private-agent-config",
        "--template",
        "crayonlu/custom-template",
      ],
      {},
    ).action,
    {
      kind: "init",
      mode: {
        kind: "github",
        repository: "crayonlu/private-agent-config",
        template: "crayonlu/custom-template",
      },
    },
  );
  assert.deepEqual(parseArguments(["init", "--remote", "git@example.test:config.git"], {}).action, {
    kind: "init",
    mode: { kind: "remote", url: "git@example.test:config.git" },
  });
  assert.deepEqual(parseArguments(["init", "--local"], {}).action, {
    kind: "init",
    mode: { kind: "local" },
  });
});

test("argument conflicts and incomplete commands are rejected", () => {
  assert.throws(() => parseArguments(["init", "--github", "--local"], {}), /Choose only one/);
  assert.throws(() => parseArguments(["add"], {}), /Usage/);
  assert.throws(() => parseArguments(["status", "extra"], {}), /Unknown command/);
  assert.throws(() => parseArguments(["plan", "--json", "--json"], {}), /only once/);
});

test("skill installation target and force options are explicit", () => {
  assert.deepEqual(
    parseArguments(["skill", "install", "--target", "claude", "--force"], {}).action,
    { force: true, kind: "skill-install", target: "claude" },
  );
  assert.deepEqual(parseArguments(["skill", "status"], {}).action, {
    kind: "skill-status",
  });
  assert.throws(
    () => parseArguments(["skill", "install", "--target", "unknown"], {}),
    /agents, claude, or all/,
  );
});

test("a short GitHub repository name is qualified with the authenticated user", () => {
  const runner: CommandRunner = (command, arguments_) => {
    assert.equal(command, "gh");
    assert.deepEqual(arguments_, ["api", "user", "--jq", ".login"]);
    return { status: 0, stderr: "", stdout: "crayonlu\n" };
  };
  assert.equal(resolveGithubRepository("agent-man-config", runner), "crayonlu/agent-man-config");
  assert.equal(
    resolveGithubRepository("someone/agent-man-config", runner),
    "someone/agent-man-config",
  );
});
