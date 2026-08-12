import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addProfile, CommandContext, doctor, initialize, Output } from "../src/commands.js";
import { resolveAppPaths } from "../src/paths.js";
import { runCommand } from "../src/process.js";

class SilentOutput implements Output {
  public info(): void {}
}

function contextFor(root: string): CommandContext {
  const home = join(root, "home");
  const environment = { ...process.env, AGENT_MAN_HOME: join(root, "state"), HOME: home };
  mkdirSync(join(home, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");
  return { environment, output: new SilentOutput(), paths: resolveAppPaths(environment) };
}

test("doctor validates a healthy isolated repository without requiring a harness binary", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-doctor-"));
  try {
    const context = contextFor(root);
    initialize({ kind: "local" }, context);
    runCommand("git", ["config", "user.name", "Doctor Test"], {
      cwd: context.paths.repositoryDirectory,
    });
    runCommand("git", ["config", "user.email", "doctor@example.invalid"], {
      cwd: context.paths.repositoryDirectory,
    });
    addProfile("agent-skills", context);

    const report = doctor(context);
    assert.equal(report.ok, true);
    assert.equal(
      report.diagnostics.some((item) => item.code === "REPOSITORY_VALID" && item.level === "ok"),
      true,
    );
    assert.equal(
      report.diagnostics.some(
        (item) => item.code === "PROFILE_VALID" && item.profile === "agent-skills",
      ),
      true,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("doctor reports overly broad state permissions on POSIX", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not authoritative on Windows");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "agent-man-doctor-mode-"));
  try {
    const context = contextFor(root);
    initialize({ kind: "local" }, context);
    chmodSync(context.paths.stateDirectory, 0o755);
    const report = doctor(context);
    assert.equal(
      report.diagnostics.some(
        (item) => item.code === "STATE_PERMISSIONS_OPEN" && item.level === "error",
      ),
      true,
    );
    assert.equal(report.ok, false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
