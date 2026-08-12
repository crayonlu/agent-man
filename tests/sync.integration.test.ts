import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addHarness, CommandContext, initialize, Output, sync } from "../src/commands.js";
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
  readonly home: string;
}

function makeDevice(root: string, name: string): TestDevice {
  const home = join(root, `${name}-home`);
  const state = join(root, `${name}-state`);
  mkdirSync(home, { recursive: true });
  const environment: NodeJS.ProcessEnv = { AGENT_MAN_HOME: state, HOME: home };
  return {
    context: {
      environment,
      output: new MemoryOutput(),
      paths: resolveAppPaths(environment),
    },
    environment,
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

test("Grok capture uses Git ignore rules and never stores credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-ignore-"));
  try {
    const device = makeDevice(root, "primary");
    initialize({ kind: "local" }, device.context);
    configureGit(device.context.paths.repositoryDirectory);

    const grok = join(device.home, ".grok");
    mkdirSync(join(grok, "sessions"), { recursive: true });
    writeFileSync(join(grok, "config.toml"), '[models]\ndefault = "grok-build"\n');
    writeFileSync(join(grok, "auth.json"), '{"token":"never-sync"}\n');
    writeFileSync(join(grok, "sessions", "session.json"), "runtime state\n");
    writeFileSync(join(grok, "local-only.txt"), "device specific\n");
    appendFileSync(
      join(device.context.paths.repositoryDirectory, ".gitignore"),
      "\n.grok/local-only.txt\n",
    );

    addHarness("grok", device.context);
    sync(device.context);

    const repository = device.context.paths.repositoryDirectory;
    assert.equal(
      readFileSync(join(repository, ".grok", "config.toml"), "utf8"),
      '[models]\ndefault = "grok-build"\n',
    );
    assert.equal(existsSync(join(repository, ".grok", "auth.json")), false);
    assert.equal(existsSync(join(repository, ".grok", "sessions")), false);
    assert.equal(existsSync(join(repository, ".grok", "local-only.txt")), false);
    assert.deepEqual(
      trackedFiles(repository).filter((path) => path.startsWith(".grok/")),
      [".grok/config.toml"],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("two devices exchange native Grok config while preserving local auth and backups", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-devices-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initialize({ kind: "local" }, first.context);
    configureGit(first.context.paths.repositoryDirectory);
    runCommand("git", ["remote", "add", "origin", remote], {
      cwd: first.context.paths.repositoryDirectory,
    });

    const firstGrok = join(first.home, ".grok");
    mkdirSync(firstGrok, { recursive: true });
    writeFileSync(join(firstGrok, "config.toml"), 'theme = "dark"\n');
    writeFileSync(join(firstGrok, "auth.json"), '{"device":"first"}\n');
    addHarness("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    const secondGrok = join(second.home, ".grok");
    mkdirSync(secondGrok, { recursive: true });
    writeFileSync(join(secondGrok, "auth.json"), '{"device":"second"}\n');
    initialize({ kind: "remote", url: remote }, second.context);
    configureGit(second.context.paths.repositoryDirectory);

    assert.equal(readFileSync(join(secondGrok, "config.toml"), "utf8"), 'theme = "dark"\n');
    assert.equal(readFileSync(join(secondGrok, "auth.json"), "utf8"), '{"device":"second"}\n');

    writeFileSync(join(secondGrok, "config.toml"), 'theme = "light"\n');
    sync(second.context);
    sync(first.context);

    assert.equal(readFileSync(join(firstGrok, "config.toml"), "utf8"), 'theme = "light"\n');
    assert.equal(readFileSync(join(firstGrok, "auth.json"), "utf8"), '{"device":"first"}\n');

    const backupDates = readdirSync(first.context.paths.backupDirectory);
    assert.equal(backupDates.length > 0, true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a remote deletion is backed up and removed from another device", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-delete-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initialize({ kind: "local" }, first.context);
    configureGit(first.context.paths.repositoryDirectory);
    runCommand("git", ["remote", "add", "origin", remote], {
      cwd: first.context.paths.repositoryDirectory,
    });
    const firstGrok = join(first.home, ".grok");
    mkdirSync(join(firstGrok, "skills", "demo"), { recursive: true });
    writeFileSync(join(firstGrok, "config.toml"), "enabled = true\n");
    writeFileSync(join(firstGrok, "skills", "demo", "SKILL.md"), "# Demo\n");
    addHarness("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    initialize({ kind: "remote", url: remote }, second.context);
    configureGit(second.context.paths.repositoryDirectory);
    const secondSkill = join(second.home, ".grok", "skills", "demo", "SKILL.md");
    assert.equal(existsSync(secondSkill), true);

    rmSync(join(firstGrok, "skills", "demo", "SKILL.md"));
    sync(first.context);
    sync(second.context);

    assert.equal(existsSync(secondSkill), false);
    assert.equal(existsSync(second.context.paths.backupDirectory), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a path newly ignored upstream remains local when Git stops tracking it", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-unmanaged-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initialize({ kind: "local" }, first.context);
    configureGit(first.context.paths.repositoryDirectory);
    runCommand("git", ["remote", "add", "origin", remote], {
      cwd: first.context.paths.repositoryDirectory,
    });
    const firstGrok = join(first.home, ".grok");
    mkdirSync(firstGrok, { recursive: true });
    writeFileSync(join(firstGrok, "local-only.txt"), "first device\n");
    addHarness("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    initialize({ kind: "remote", url: remote }, second.context);
    configureGit(second.context.paths.repositoryDirectory);
    const secondLocalOnly = join(second.home, ".grok", "local-only.txt");

    appendFileSync(
      join(first.context.paths.repositoryDirectory, ".gitignore"),
      "\n.grok/local-only.txt\n",
    );
    runCommand("git", ["rm", "--cached", ".grok/local-only.txt"], {
      cwd: first.context.paths.repositoryDirectory,
    });
    sync(first.context);
    sync(second.context);

    assert.equal(readFileSync(secondLocalOnly, "utf8"), "first device\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("resolving a delete conflict can remove the last managed profile file", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-delete-conflict-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initialize({ kind: "local" }, first.context);
    configureGit(first.context.paths.repositoryDirectory);
    runCommand("git", ["remote", "add", "origin", remote], {
      cwd: first.context.paths.repositoryDirectory,
    });
    const firstConfig = join(first.home, ".grok", "config.toml");
    mkdirSync(join(first.home, ".grok"), { recursive: true });
    writeFileSync(firstConfig, 'theme = "base"\n');
    addHarness("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    initialize({ kind: "remote", url: remote }, second.context);
    configureGit(second.context.paths.repositoryDirectory);
    const secondConfig = join(second.home, ".grok", "config.toml");

    rmSync(firstConfig);
    sync(first.context);
    writeFileSync(secondConfig, 'theme = "second"\n');
    assert.throws(() => sync(second.context), /live harness files were left unchanged/);

    runCommand("git", ["rm", ".grok/config.toml"], {
      cwd: second.context.paths.repositoryDirectory,
    });
    sync(second.context);

    assert.equal(existsSync(secondConfig), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Git conflicts never write conflict markers into the live harness directory", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-conflict-"));
  try {
    const remote = join(root, "config.git");
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

    const first = makeDevice(root, "first");
    initialize({ kind: "local" }, first.context);
    configureGit(first.context.paths.repositoryDirectory);
    runCommand("git", ["remote", "add", "origin", remote], {
      cwd: first.context.paths.repositoryDirectory,
    });
    const firstConfig = join(first.home, ".grok", "config.toml");
    mkdirSync(join(first.home, ".grok"), { recursive: true });
    writeFileSync(firstConfig, 'theme = "base"\n');
    addHarness("grok", first.context);
    sync(first.context);

    const second = makeDevice(root, "second");
    initialize({ kind: "remote", url: remote }, second.context);
    configureGit(second.context.paths.repositoryDirectory);
    const secondConfig = join(second.home, ".grok", "config.toml");

    writeFileSync(firstConfig, 'theme = "first"\n');
    sync(first.context);
    writeFileSync(secondConfig, 'theme = "second"\n');

    assert.throws(() => sync(second.context), /live harness files were left unchanged/);
    assert.equal(readFileSync(secondConfig, "utf8"), 'theme = "second"\n');
    assert.equal(readFileSync(secondConfig, "utf8").includes("<<<<<<<"), false);

    const storedConfig = join(second.context.paths.repositoryDirectory, ".grok", "config.toml");
    writeFileSync(storedConfig, 'theme = "resolved"\n');
    runCommand("git", ["add", ".grok/config.toml"], {
      cwd: second.context.paths.repositoryDirectory,
    });
    sync(second.context);
    assert.equal(readFileSync(secondConfig, "utf8"), 'theme = "resolved"\n');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
