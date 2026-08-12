import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TEMPLATE, parseArguments } from "../src/arguments.js";
import { resolveGithubRepository } from "../src/commands.js";
import { CommandRunner } from "../src/process.js";

test("init defaults to a private GitHub template flow", () => {
  assert.deepEqual(parseArguments(["init"], {}), {
    kind: "init",
    mode: {
      kind: "github",
      repository: "agent-man-config",
      template: DEFAULT_TEMPLATE,
    },
  });
});

test("init accepts an explicit GitHub repository and template", () => {
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
    ),
    {
      kind: "init",
      mode: {
        kind: "github",
        repository: "crayonlu/private-agent-config",
        template: "crayonlu/custom-template",
      },
    },
  );
});

test("init accepts an existing Git remote", () => {
  assert.deepEqual(parseArguments(["init", "--remote", "git@example.test:config.git"], {}), {
    kind: "init",
    mode: { kind: "remote", url: "git@example.test:config.git" },
  });
});

test("init rejects multiple storage modes", () => {
  assert.throws(() => parseArguments(["init", "--github", "--local"], {}), /Choose only one/);
});

test("add requires exactly one harness", () => {
  assert.deepEqual(parseArguments(["add", "grok"], {}), {
    harness: "grok",
    kind: "add",
  });
  assert.throws(() => parseArguments(["add"], {}), /Usage/);
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
