import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initialize, Output, resolveGithubRepository } from "../src/commands.js";
import { resolveAppPaths } from "../src/paths.js";
import { CommandRunner } from "../src/process.js";

class SilentOutput implements Output {
  public info(): void {}
}

test("GitHub initialization creates a private repository from the configured template", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-github-"));
  try {
    const environment: NodeJS.ProcessEnv = {
      AGENT_MAN_HOME: join(root, "state"),
      HOME: join(root, "home"),
    };
    const paths = resolveAppPaths(environment);
    const calls: string[][] = [];
    const runner: CommandRunner = (command, arguments_) => {
      calls.push([command, ...arguments_]);
      if (command === "gh" && arguments_[0] === "repo" && arguments_[1] === "view") {
        return { status: 1, stderr: "not found", stdout: "" };
      }
      if (command === "gh" && arguments_[0] === "repo" && arguments_[1] === "clone") {
        mkdirSync(join(paths.repositoryDirectory, ".git"), { recursive: true });
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    const report = initialize(
      {
        kind: "github",
        repository: "crayonlu/agent-man-config",
        template: "crayonlu/agent-man-config-template",
      },
      { environment, output: new SilentOutput(), paths, runner },
    );

    const create = calls.find(
      (call) => call[0] === "gh" && call[1] === "repo" && call[2] === "create",
    );
    assert.notEqual(create, undefined);
    assert.equal(create?.includes("--private"), true);
    assert.equal(create?.includes("--template"), true);
    assert.equal(create?.includes("crayonlu/agent-man-config-template"), true);
    assert.equal(report.createdGithubRepository, "crayonlu/agent-man-config");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an existing public GitHub repository is rejected before clone", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-public-github-"));
  try {
    const environment: NodeJS.ProcessEnv = {
      AGENT_MAN_HOME: join(root, "state"),
      HOME: join(root, "home"),
    };
    const paths = resolveAppPaths(environment);
    const calls: string[][] = [];
    const runner: CommandRunner = (command, arguments_) => {
      calls.push([command, ...arguments_]);
      if (command === "gh" && arguments_[0] === "repo" && arguments_[1] === "view") {
        return {
          status: 0,
          stderr: "",
          stdout: '{"nameWithOwner":"crayonlu/public-config","visibility":"PUBLIC"}\n',
        };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    assert.throws(
      () =>
        initialize(
          {
            kind: "github",
            repository: "crayonlu/public-config",
            template: "crayonlu/agent-man-config-template",
          },
          { environment, output: new SilentOutput(), paths, runner },
        ),
      /must be private/,
    );
    assert.equal(
      calls.some((call) => call[0] === "gh" && call[1] === "repo" && call[2] === "clone"),
      false,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("GitHub repository arguments cannot be parsed as command options", () => {
  const runner: CommandRunner = () => ({ status: 0, stderr: "", stdout: "" });
  assert.throws(
    () => resolveGithubRepository("-unsafe/repository", runner),
    /Invalid GitHub repository name/,
  );
});

test("initialization never removes a repository path that already existed", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-existing-state-"));
  try {
    const environment = { AGENT_MAN_HOME: join(root, "state"), HOME: join(root, "home") };
    const paths = resolveAppPaths(environment);
    mkdirSync(paths.stateDirectory, { mode: 0o700, recursive: true });
    mkdirSync(paths.repositoryDirectory, { recursive: true });
    const sentinel = join(paths.repositoryDirectory, "keep.txt");
    writeFileSync(sentinel, "keep\n");

    assert.throws(
      () => initialize({ kind: "local" }, { environment, output: new SilentOutput(), paths }),
      /already exists/,
    );
    assert.equal(existsSync(sentinel), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
