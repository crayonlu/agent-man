import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initialize, Output } from "../src/commands.js";
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

    initialize(
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
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
