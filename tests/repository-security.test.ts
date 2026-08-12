import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initialize, Output } from "../src/commands.js";
import { walkPortableTree } from "../src/files.js";
import { resolveAppPaths } from "../src/paths.js";
import { findNativeProfile, profileIgnoreContents } from "../src/profiles.js";
import { hardenRepository } from "../src/git.js";
import { readNativeSymlinkTarget } from "../src/files.js";
import { runCommand } from "../src/process.js";
import {
  applyProfiles,
  validateReferenceScope,
  validateRepositoryControls,
  validateRepositoryScope,
} from "../src/repository.js";

class SilentOutput implements Output {
  public info(): void {}
}

function configureGit(repository: string): void {
  runCommand("git", ["config", "user.name", "Agent Man Security Test"], { cwd: repository });
  runCommand("git", ["config", "user.email", "security@example.invalid"], { cwd: repository });
  runCommand("git", ["config", "commit.gpgSign", "false"], { cwd: repository });
}

test("a force-tracked path outside a profile allowlist is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-unsafe-track-"));
  try {
    const environment = { AGENT_MAN_HOME: join(root, "state"), HOME: join(root, "home") };
    const paths = resolveAppPaths(environment);
    initialize({ kind: "local" }, { environment, output: new SilentOutput(), paths });
    configureGit(paths.repositoryDirectory);
    mkdirSync(join(paths.repositoryDirectory, ".grok"), { recursive: true });
    writeFileSync(
      join(paths.repositoryDirectory, ".grok", ".gitignore"),
      profileIgnoreContents(findNativeProfile("grok")),
    );
    writeFileSync(join(paths.repositoryDirectory, ".grok", "auth.json"), "{}\n");
    runCommand("git", ["add", "-f", ".grok/.gitignore", ".grok/auth.json"], {
      cwd: paths.repositoryDirectory,
    });

    assert.throws(
      () => validateRepositoryScope(paths.repositoryDirectory),
      /outside the 'grok' allowlist/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("repository-local Git attribute overrides are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-info-attributes-"));
  try {
    runCommand("git", ["init", "-b", "main", root]);
    writeFileSync(join(root, ".git", "info", "attributes"), "*.toml filter=unsafe\n");
    assert.throws(() => hardenRepository(root), /repository-local overrides/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("repository hardening fixes line endings and platform path protections", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-git-hardening-"));
  try {
    runCommand("git", ["init", "-b", "main", root]);
    hardenRepository(root);

    const settings: readonly (readonly [string, string])[] = [
      ["core.autocrlf", "false"],
      ["core.eol", "lf"],
      ["core.protectHFS", "true"],
      ["core.protectNTFS", "true"],
    ];
    for (const [key, expected] of settings) {
      assert.equal(
        runCommand("git", ["config", "--local", "--get", key], { cwd: root }).stdout.trim(),
        expected,
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an unsafe untracked root attributes file is rejected before staging", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-untracked-attributes-"));
  try {
    runCommand("git", ["init", "-b", "main", root]);
    writeFileSync(join(root, ".gitattributes"), "*.toml filter=unsafe\n");

    assert.throws(() => validateRepositoryControls(root), /text and eol behavior/);
    assert.equal(runCommand("git", ["ls-files"], { cwd: root }).stdout, "");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a repository symbolic link that escapes its profile is rejected", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-unsafe-repo-link-"));
  try {
    const environment = { AGENT_MAN_HOME: join(root, "state"), HOME: join(root, "home") };
    const paths = resolveAppPaths(environment);
    initialize({ kind: "local" }, { environment, output: new SilentOutput(), paths });
    configureGit(paths.repositoryDirectory);
    mkdirSync(join(paths.repositoryDirectory, ".grok"), { recursive: true });
    writeFileSync(
      join(paths.repositoryDirectory, ".grok", ".gitignore"),
      profileIgnoreContents(findNativeProfile("grok")),
    );
    writeFileSync(join(paths.repositoryDirectory, "outside.toml"), "safe = false\n");
    try {
      symlinkSync("../outside.toml", join(paths.repositoryDirectory, ".grok", "config.toml"));
    } catch {
      t.skip("symbolic links are unavailable on this host");
      return;
    }
    runCommand("git", ["add", "-f", ".grok/.gitignore", ".grok/config.toml"], {
      cwd: paths.repositoryDirectory,
    });

    assert.throws(
      () => validateRepositoryScope(paths.repositoryDirectory),
      /symbolic-link binding/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Git index mode preserves an internal symlink even when checkout materializes it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-materialized-link-"));
  try {
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    const state = join(root, "state");
    const repository = join(state, "repo");
    const home = join(root, "home");
    runCommand("git", ["init", "-b", "main", source]);
    configureGit(source);
    mkdirSync(join(source, ".grok", "skills", "target"), { recursive: true });
    writeFileSync(
      join(source, ".gitignore"),
      "/*\n!/.gitignore\n!/.gitattributes\n!/README.md\n!/.grok/\n",
    );
    writeFileSync(join(source, ".gitattributes"), "* text=auto\n");
    writeFileSync(join(source, "README.md"), "# Config\n");
    writeFileSync(
      join(source, ".grok", ".gitignore"),
      profileIgnoreContents(findNativeProfile("grok")),
    );
    writeFileSync(join(source, ".grok", "skills", "target", "SKILL.md"), "# Target\n");
    try {
      symlinkSync("target", join(source, ".grok", "skills", "alias"), "dir");
      symlinkSync("alias", join(source, ".grok", "skills", "current"), "dir");
      symlinkSync("alias/SKILL.md", join(source, ".grok", "skills", "current-file"), "file");
    } catch {
      t.skip("symbolic links are unavailable on this host");
      return;
    }
    runCommand("git", ["add", "."], { cwd: source });
    runCommand("git", ["commit", "-m", "Add internal link"], { cwd: source });
    runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);
    runCommand("git", ["remote", "add", "origin", remote], { cwd: source });
    runCommand("git", ["push", "origin", "main"], { cwd: source });

    mkdirSync(state, { recursive: true });
    runCommand("git", ["-c", "core.symlinks=false", "clone", remote, repository]);
    for (const name of ["alias", "current", "current-file"]) {
      assert.equal(lstatSync(join(repository, ".grok", "skills", name)).isFile(), true);
    }

    const environment = { AGENT_MAN_HOME: state, GROK_HOME: join(home, ".grok"), HOME: home };
    const paths = resolveAppPaths(environment);
    validateRepositoryScope(repository);
    const result = applyProfiles(paths, [findNativeProfile("grok")], [], environment);
    assert.equal(result.profiles[0]?.copied, 4);
    assert.equal(readNativeSymlinkTarget(join(home, ".grok", "skills", "alias")), "target");
    assert.equal(readNativeSymlinkTarget(join(home, ".grok", "skills", "current")), "alias");
    assert.equal(
      readNativeSymlinkTarget(join(home, ".grok", "skills", "current-file")),
      "alias/SKILL.md",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a fetched tree is rejected before checkout when attributes can invoke a filter", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-tree-attributes-"));
  try {
    runCommand("git", ["init", "-b", "main", root]);
    configureGit(root);
    writeFileSync(join(root, ".gitattributes"), "*.toml filter=credential-helper\n");
    writeFileSync(join(root, ".gitignore"), "/*\n!/.gitignore\n!/.gitattributes\n");
    runCommand("git", ["add", ".gitattributes", ".gitignore"], { cwd: root });
    runCommand("git", ["commit", "-m", "Unsafe attributes"], { cwd: root });

    assert.throws(() => validateReferenceScope(root, "HEAD"), /text and eol behavior/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("unsafe remote initialization is rejected before checkout and cleans local state", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-unsafe-init-"));
  try {
    const source = join(root, "source");
    runCommand("git", ["init", "-b", "main", source]);
    configureGit(source);
    writeFileSync(join(source, ".gitattributes"), "*.toml filter=credential-helper\n");
    writeFileSync(join(source, ".gitignore"), "/*\n!/.gitignore\n!/.gitattributes\n");
    runCommand("git", ["add", ".gitattributes", ".gitignore"], { cwd: source });
    runCommand("git", ["commit", "-m", "Unsafe attributes"], { cwd: source });

    const environment = { AGENT_MAN_HOME: join(root, "state"), HOME: join(root, "home") };
    const paths = resolveAppPaths(environment);
    assert.throws(
      () =>
        initialize(
          { kind: "remote", url: source },
          { environment, output: new SilentOutput(), paths },
        ),
      /text and eol behavior/,
    );
    assert.equal(existsSync(paths.repositoryDirectory), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("nested Git attributes are rejected even inside an allowlisted skill", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-nested-attributes-"));
  try {
    runCommand("git", ["init", "-b", "main", root]);
    configureGit(root);
    mkdirSync(join(root, ".grok", "skills", "demo"), { recursive: true });
    writeFileSync(
      join(root, ".grok", ".gitignore"),
      profileIgnoreContents(findNativeProfile("grok")),
    );
    writeFileSync(join(root, ".grok", "skills", "demo", ".gitattributes"), "* text\n");
    runCommand("git", ["add", "-f", ".grok/.gitignore", ".grok/skills/demo/.gitattributes"], {
      cwd: root,
    });
    runCommand("git", ["commit", "-m", "Nested attributes"], { cwd: root });

    assert.throws(() => validateReferenceScope(root, "HEAD"), /Nested Git attributes/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a fetched tree is rejected before checkout when it contains inline credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-tree-secret-"));
  try {
    runCommand("git", ["init", "-b", "main", root]);
    configureGit(root);
    mkdirSync(join(root, ".grok"), { recursive: true });
    writeFileSync(
      join(root, ".grok", ".gitignore"),
      profileIgnoreContents(findNativeProfile("grok")),
    );
    writeFileSync(join(root, ".grok", "config.toml"), 'api_key = "must-not-land"\n');
    runCommand("git", ["add", "-f", ".grok/.gitignore", ".grok/config.toml"], { cwd: root });
    runCommand("git", ["commit", "-m", "Unsafe secret"], { cwd: root });

    assert.throws(() => validateReferenceScope(root, "HEAD"), /inline credential field/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("JSON configuration credentials are rejected for native profiles", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-json-secret-"));
  try {
    runCommand("git", ["init", "-b", "main", root]);
    configureGit(root);
    mkdirSync(join(root, ".claude-code"), { recursive: true });
    writeFileSync(
      join(root, ".claude-code", ".gitignore"),
      profileIgnoreContents(findNativeProfile("claude-code")),
    );
    writeFileSync(join(root, ".claude-code", "settings.json"), '{"apiKey":"must-not-land"}\n');
    runCommand("git", ["add", "-f", ".claude-code/.gitignore", ".claude-code/settings.json"], {
      cwd: root,
    });
    runCommand("git", ["commit", "-m", "Unsafe JSON secret"], { cwd: root });

    assert.throws(() => validateReferenceScope(root, "HEAD"), /inline credential field/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Codex named config profiles stay inside the root file pattern", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-codex-pattern-"));
  try {
    const codex = join(root, "codex");
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(codex, "review.config.toml"), 'model = "gpt-5"\n');
    writeFileSync(join(codex, "not-portable.txt"), "local\n");
    const scan = walkPortableTree(codex, findNativeProfile("codex"));
    assert.deepEqual(
      scan.entries.map((entry) => entry.relativePath),
      ["review.config.toml"],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
