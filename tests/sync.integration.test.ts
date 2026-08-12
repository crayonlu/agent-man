import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listBackups } from "../src/backups.js";
import {
  addProfile,
  CommandContext,
  initialize,
  Output,
  restore,
  showPlan,
  sync,
} from "../src/commands.js";
import { resolveAppPaths } from "../src/paths.js";
import { runCommand } from "../src/process.js";

class MemoryOutput implements Output {
  public readonly messages: string[] = [];

  public info(message: string): void {
    this.messages.push(message);
  }
}

interface TestDevice {
  readonly context: CommandContext;
  readonly environment: NodeJS.ProcessEnv;
  readonly grok: string;
  readonly home: string;
}

function makeDevice(root: string, name: string): TestDevice {
  const home = join(root, `${name}-home`);
  const state = join(root, `${name}-state`);
  const grok = join(home, ".grok");
  mkdirSync(home, { recursive: true });
  const environment: NodeJS.ProcessEnv = { AGENT_MAN_HOME: state, GROK_HOME: grok, HOME: home };
  return {
    context: {
      environment,
      output: new MemoryOutput(),
      paths: resolveAppPaths(environment),
    },
    environment,
    grok,
    home,
  };
}

function configureGit(repository: string): void {
  runCommand("git", ["config", "user.name", "Agent Man Test"], { cwd: repository });
  runCommand("git", ["config", "user.email", "agent-man-test@example.invalid"], {
    cwd: repository,
  });
  runCommand("git", ["config", "commit.gpgSign", "false"], { cwd: repository });
}

function trackedFiles(repository: string): readonly string[] {
  return runCommand("git", ["ls-files"], { cwd: repository })
    .stdout.trim()
    .split("\n")
    .filter((path) => path !== "");
}

function initializeWithRemote(device: TestDevice, remote: string): void {
  initialize({ kind: "local" }, device.context);
  configureGit(device.context.paths.repositoryDirectory);
  runCommand("git", ["remote", "add", "origin", remote], {
    cwd: device.context.paths.repositoryDirectory,
  });
}

test("Grok capture is allowlist-first and Git ignore rules can only narrow it", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-allowlist-"));
  try {
    const device = makeDevice(root, "primary");
    initialize({ kind: "local" }, device.context);
    configureGit(device.context.paths.repositoryDirectory);

    mkdirSync(join(device.grok, "sessions"), { recursive: true });
    mkdirSync(join(device.grok, "skills", "public"), { recursive: true });
    mkdirSync(join(device.grok, "skills", "private"), { recursive: true });
    writeFileSync(join(device.grok, "config.toml"), '[models]\ndefault = "grok-build"\n');
    writeFileSync(join(device.grok, "auth.json"), '{"token":"never-sync"}\n');
    writeFileSync(join(device.grok, "sessions", "session.json"), "runtime state\n");
    writeFileSync(join(device.grok, "unknown.txt"), "outside allowlist\n");
    writeFileSync(join(device.grok, "skills", "public", "SKILL.md"), "# Public\n");
    writeFileSync(join(device.grok, "skills", "private", "SKILL.md"), "# Private\n");

    addProfile("grok", device.context);
    appendFileSync(
      join(device.context.paths.repositoryDirectory, ".grok", ".gitignore"),
      "\nskills/private/**\n",
    );
    sync(device.context);

    const repository = device.context.paths.repositoryDirectory;
    assert.equal(
      readFileSync(join(repository, ".grok", "config.toml"), "utf8"),
      '[models]\ndefault = "grok-build"\n',
    );
    assert.equal(existsSync(join(repository, ".grok", "auth.json")), false);
    assert.equal(existsSync(join(repository, ".grok", "sessions")), false);
    assert.equal(existsSync(join(repository, ".grok", "unknown.txt")), false);
    assert.equal(existsSync(join(repository, ".grok", "skills", "private", "SKILL.md")), false);
    assert.equal(existsSync(join(repository, ".grok", "skills", "public", "SKILL.md")), true);
    assert.deepEqual(
      trackedFiles(repository).filter((path) => path.startsWith(".grok/")),
      [".grok/.gitignore", ".grok/config.toml", ".grok/skills/public/SKILL.md"],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an inline credential in Grok config is rejected without printing its value", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-secret-"));
  try {
    const device = makeDevice(root, "primary");
    initialize({ kind: "local" }, device.context);
    configureGit(device.context.paths.repositoryDirectory);
    mkdirSync(device.grok, { recursive: true });
    writeFileSync(
      join(device.grok, "config.toml"),
      'env = { OPENAI_API_KEY = "super-secret-value" }\n',
    );

    let message = "";
    try {
      addProfile("grok", device.context);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /inline credential field/);
    assert.equal(message.includes("super-secret-value"), false);
    assert.equal(existsSync(join(device.context.paths.repositoryDirectory, ".grok")), false);

    writeFileSync(
      join(device.grok, "config.toml"),
      'headers = { "Authorization" = "Bearer ${OPENAI_API_KEY}" }\n',
    );
    assert.equal(addProfile("grok", device.context).profile, "grok");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a failed profile add rolls back its worktree and staged index entries", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-add-rollback-"));
  try {
    const device = makeDevice(root, "primary");
    initialize({ kind: "local" }, device.context);
    configureGit(device.context.paths.repositoryDirectory);
    mkdirSync(device.grok, { recursive: true });
    writeFileSync(join(device.grok, "config.toml"), 'theme = "dark"\n');
    writeFileSync(
      join(device.context.paths.repositoryDirectory, ".gitattributes"),
      "* filter=unexpected\n",
    );

    assert.throws(() => addProfile("grok", device.context), /text and eol behavior/);
    assert.equal(existsSync(join(device.context.paths.repositoryDirectory, ".grok")), false);
    assert.equal(
      runCommand("git", ["diff", "--cached", "--name-only"], {
        cwd: device.context.paths.repositoryDirectory,
      }).stdout,
      "",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("two devices exchange native config transactionally and a backup can be restored", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-devices-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initializeWithRemote(first, remote);
    mkdirSync(first.grok, { recursive: true });
    writeFileSync(join(first.grok, "config.toml"), 'theme = "dark"\n');
    writeFileSync(join(first.grok, "auth.json"), '{"device":"first"}\n');
    addProfile("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    mkdirSync(second.grok, { recursive: true });
    writeFileSync(join(second.grok, "auth.json"), '{"device":"second"}\n');
    initialize({ kind: "remote", url: remote }, second.context);
    configureGit(second.context.paths.repositoryDirectory);

    assert.equal(readFileSync(join(second.grok, "config.toml"), "utf8"), 'theme = "dark"\n');
    assert.equal(readFileSync(join(second.grok, "auth.json"), "utf8"), '{"device":"second"}\n');

    writeFileSync(join(second.grok, "config.toml"), 'theme = "light"\n');
    sync(second.context);
    const plan = showPlan(first.context);
    assert.deepEqual(plan.remoteChanges, [
      {
        operation: "apply-add-or-modify",
        path: ".grok/config.toml",
        profile: "grok",
        risk: "configuration",
      },
    ]);
    sync(first.context);

    assert.equal(readFileSync(join(first.grok, "config.toml"), "utf8"), 'theme = "light"\n');
    assert.equal(readFileSync(join(first.grok, "auth.json"), "utf8"), '{"device":"first"}\n');
    const backup = listBackups(first.context.paths)[0];
    assert.notEqual(backup, undefined);
    if (backup !== undefined) {
      const result = restore(backup.id, first.context);
      assert.equal(result.restored > 0, true);
      assert.equal(readFileSync(join(first.grok, "config.toml"), "utf8"), 'theme = "dark"\n');
      assert.notEqual(result.safetyBackup, undefined);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("remote deletion is backed up and removed from another device", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-delete-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initializeWithRemote(first, remote);
    mkdirSync(join(first.grok, "skills", "demo"), { recursive: true });
    writeFileSync(join(first.grok, "config.toml"), "enabled = true\n");
    writeFileSync(join(first.grok, "skills", "demo", "SKILL.md"), "# Demo\n");
    addProfile("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    initialize({ kind: "remote", url: remote }, second.context);
    configureGit(second.context.paths.repositoryDirectory);
    const secondSkill = join(second.grok, "skills", "demo", "SKILL.md");
    assert.equal(existsSync(secondSkill), true);

    rmSync(join(first.grok, "skills", "demo", "SKILL.md"));
    sync(first.context);
    sync(second.context);

    assert.equal(existsSync(secondSkill), false);
    assert.equal(listBackups(second.context.paths).length > 0, true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an external skill symlink on one device is a protected local override", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-binding-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initializeWithRemote(first, remote);
    mkdirSync(join(first.grok, "skills", "demo"), { recursive: true });
    writeFileSync(join(first.grok, "skills", "demo", "SKILL.md"), "# Remote\n");
    addProfile("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    const localSkill = join(root, "local-skill");
    mkdirSync(join(second.grok, "skills"), { recursive: true });
    mkdirSync(localSkill, { recursive: true });
    writeFileSync(join(localSkill, "SKILL.md"), "# Local\n");
    try {
      symlinkSync(localSkill, join(second.grok, "skills", "demo"), "dir");
    } catch {
      t.skip("symbolic links are unavailable on this host");
      return;
    }

    const report = initialize({ kind: "remote", url: remote }, second.context);
    assert.equal(readFileSync(join(localSkill, "SKILL.md"), "utf8"), "# Local\n");
    assert.equal(report.appliedProfiles[0]?.protectedBindings, 1);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a stored link cannot resolve through a device-local binding", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-binding-chain-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initializeWithRemote(first, remote);
    mkdirSync(join(first.grok, "skills", "target"), { recursive: true });
    writeFileSync(join(first.grok, "skills", "target", "SKILL.md"), "# Remote\n");
    try {
      symlinkSync("target", join(first.grok, "skills", "current"), "dir");
    } catch {
      t.skip("symbolic links are unavailable on this host");
      return;
    }
    addProfile("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    const localTarget = join(root, "local-target");
    mkdirSync(join(second.grok, "skills"), { recursive: true });
    mkdirSync(localTarget, { recursive: true });
    writeFileSync(join(localTarget, "SKILL.md"), "# Local\n");
    symlinkSync(localTarget, join(second.grok, "skills", "target"), "dir");

    assert.throws(
      () => initialize({ kind: "remote", url: remote }, second.context),
      /resolves through protected local binding/,
    );
    assert.equal(readFileSync(join(localTarget, "SKILL.md"), "utf8"), "# Local\n");
    assert.equal(existsSync(join(second.grok, "skills", "current")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Git conflicts never write conflict markers into the live profile", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-conflict-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initializeWithRemote(first, remote);
    mkdirSync(first.grok, { recursive: true });
    const firstConfig = join(first.grok, "config.toml");
    writeFileSync(firstConfig, 'theme = "base"\n');
    addProfile("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    initialize({ kind: "remote", url: remote }, second.context);
    configureGit(second.context.paths.repositoryDirectory);
    const secondConfig = join(second.grok, "config.toml");

    writeFileSync(firstConfig, 'theme = "first"\n');
    sync(first.context);
    writeFileSync(secondConfig, 'theme = "second"\n');

    assert.throws(() => sync(second.context), /live profile files were left unchanged/);
    assert.equal(readFileSync(secondConfig, "utf8"), 'theme = "second"\n');
    assert.equal(readFileSync(secondConfig, "utf8").includes("<<<<<<<"), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the shared agent-skills profile stores only native skills and commands", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-agent-skills-"));
  try {
    const device = makeDevice(root, "primary");
    initialize({ kind: "local" }, device.context);
    configureGit(device.context.paths.repositoryDirectory);
    const agents = join(device.home, ".agents");
    mkdirSync(join(agents, "skills", "demo"), { recursive: true });
    mkdirSync(join(agents, "commands"), { recursive: true });
    mkdirSync(join(agents, "runtime"), { recursive: true });
    writeFileSync(join(agents, "skills", "demo", "SKILL.md"), "# Demo\n");
    writeFileSync(join(agents, "commands", "review.md"), "Review this.\n");
    writeFileSync(join(agents, "runtime", "state.json"), "{}\n");

    addProfile("agent-skills", device.context);
    sync(device.context);

    const repository = device.context.paths.repositoryDirectory;
    assert.equal(existsSync(join(repository, ".agents", "skills", "demo", "SKILL.md")), true);
    assert.equal(existsSync(join(repository, ".agents", "commands", "review.md")), true);
    assert.equal(existsSync(join(repository, ".agents", "runtime")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
