#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  console.error("Run this check through 'npm run install:check'.");
  process.exitCode = 1;
} else {
  const root = mkdtempSync(join(tmpdir(), "agent-man-install-"));
  const artifacts = join(root, "artifacts");
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const environment = {
    ...process.env,
    AGENT_MAN_HOME: join(root, "state"),
    GROK_HOME: join(root, "grok"),
    HOME: home,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_prefix: prefix,
    npm_config_userconfig: join(root, "npmrc"),
  };
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(home, { recursive: true });

  function run(arguments_, options = {}) {
    const result = spawnSync(process.execPath, [npmCli, ...arguments_], {
      cwd: options.cwd ?? process.cwd(),
      encoding: "utf8",
      env: environment,
    });
    if (result.status !== 0) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
      throw new Error(`npm ${arguments_.join(" ")} failed: ${detail}`);
    }
    return result.stdout;
  }

  try {
    run(["pack", "--pack-destination", artifacts]);
    const tarballName = readdirSync(artifacts).find((name) => name.endsWith(".tgz"));
    if (tarballName === undefined) {
      throw new Error("npm pack did not produce a tarball.");
    }
    run(["install", "--global", join(artifacts, tarballName)]);

    const executable =
      process.platform === "win32"
        ? join(prefix, "agent-man.cmd")
        : join(prefix, "bin", "agent-man");
    const version = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      env: environment,
    });
    if (version.status !== 0 || version.stdout.trim() !== "agent-man 0.1.0") {
      throw new Error(version.stderr?.trim() || "Installed CLI did not report its version.");
    }

    const packageRoot =
      process.platform === "win32"
        ? join(prefix, "node_modules", "agent-man")
        : join(prefix, "lib", "node_modules", "agent-man");
    const skill = resolve(packageRoot, ".agents", "skills", "agent-man", "SKILL.md");
    if (!existsSync(skill)) {
      throw new Error("The installed package does not contain the agent-man skill.");
    }

    console.log("Installed tarball CLI and bundled Agent Skill verified in an isolated prefix.");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
