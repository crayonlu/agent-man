import { existsSync } from "node:fs";
import { join } from "node:path";

import { AppError } from "./errors.js";
import { CommandRunner, runCommand } from "./process.js";

export function ensureGitRepository(repository: string): void {
  if (!existsSync(join(repository, ".git"))) {
    throw new AppError(
      `agent-man is not initialized. Run 'agent-man init --github' or 'agent-man init --remote <url>' first.`,
    );
  }
}

function splitNullTerminated(value: string): readonly string[] {
  return value.split("\0").filter((entry) => entry !== "");
}

export function trackedPaths(
  repository: string,
  repositoryDirectory: string,
  runner: CommandRunner = runCommand,
): readonly string[] {
  const result = runner("git", ["ls-files", "-z", "--", repositoryDirectory], {
    cwd: repository,
  });
  return splitNullTerminated(result.stdout);
}

export function ignoredPaths(
  repository: string,
  paths: readonly string[],
  runner: CommandRunner = runCommand,
): ReadonlySet<string> {
  if (paths.length === 0) {
    return new Set();
  }
  const result = runner("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
    acceptedExitCodes: [0, 1],
    cwd: repository,
    input: `${paths.join("\0")}\0`,
  });
  return new Set(splitNullTerminated(result.stdout));
}

export function stageAll(repository: string, runner: CommandRunner = runCommand): void {
  runner("git", ["add", "-A"], { cwd: repository });
}

export function hasStagedChanges(repository: string, runner: CommandRunner = runCommand): boolean {
  const result = runner("git", ["diff", "--cached", "--quiet"], {
    acceptedExitCodes: [0, 1],
    cwd: repository,
  });
  return result.status === 1;
}

export function commit(
  repository: string,
  message: string,
  runner: CommandRunner = runCommand,
): void {
  runner("git", ["commit", "-m", message], { cwd: repository });
}

export function currentHead(
  repository: string,
  runner: CommandRunner = runCommand,
): string | undefined {
  const result = runner("git", ["rev-parse", "--verify", "HEAD"], {
    acceptedExitCodes: [0, 128],
    cwd: repository,
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

export function currentBranch(repository: string, runner: CommandRunner = runCommand): string {
  const result = runner("git", ["branch", "--show-current"], { cwd: repository });
  const branch = result.stdout.trim();
  if (branch === "") {
    throw new AppError("The configuration repository is in detached HEAD state.");
  }
  return branch;
}

export function hasOrigin(repository: string, runner: CommandRunner = runCommand): boolean {
  const result = runner("git", ["remote", "get-url", "origin"], {
    acceptedExitCodes: [0, 2, 128],
    cwd: repository,
  });
  return result.status === 0;
}

export function firstParentOfHead(
  repository: string,
  runner: CommandRunner = runCommand,
): string | undefined {
  const result = runner("git", ["rev-parse", "--verify", "HEAD^1"], {
    acceptedExitCodes: [0, 128],
    cwd: repository,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function fetchOrigin(repository: string, runner: CommandRunner = runCommand): void {
  runner("git", ["fetch", "origin"], { cwd: repository });
}

export function upstreamReference(
  repository: string,
  runner: CommandRunner = runCommand,
): string | undefined {
  const configured = runner(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { acceptedExitCodes: [0, 128], cwd: repository },
  );
  if (configured.status === 0) {
    return configured.stdout.trim();
  }

  const fallback = `origin/${currentBranch(repository, runner)}`;
  const exists = runner("git", ["rev-parse", "--verify", "--quiet", fallback], {
    acceptedExitCodes: [0, 1],
    cwd: repository,
  });
  return exists.status === 0 ? fallback : undefined;
}

export function merge(
  repository: string,
  reference: string,
  runner: CommandRunner = runCommand,
): readonly string[] {
  const result = runner("git", ["merge", "--no-edit", reference], {
    acceptedExitCodes: [0, 1],
    cwd: repository,
  });
  const conflicts = unmergedPaths(repository, runner);
  if (result.status !== 0 && conflicts.length === 0) {
    throw new AppError(result.stderr.trim() || result.stdout.trim() || "Git merge failed.");
  }
  return conflicts;
}

export function mergeInProgress(repository: string, runner: CommandRunner = runCommand): boolean {
  const result = runner("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], {
    acceptedExitCodes: [0, 1],
    cwd: repository,
  });
  return result.status === 0;
}

export function unmergedPaths(
  repository: string,
  runner: CommandRunner = runCommand,
): readonly string[] {
  const result = runner("git", ["diff", "--name-only", "--diff-filter=U", "-z"], {
    cwd: repository,
  });
  return splitNullTerminated(result.stdout);
}

export function finishMerge(repository: string, runner: CommandRunner = runCommand): void {
  runner("git", ["commit", "--no-edit"], { cwd: repository });
}

export function push(repository: string, runner: CommandRunner = runCommand): void {
  const upstream = upstreamReference(repository, runner);
  if (upstream === undefined) {
    runner("git", ["push", "--set-upstream", "origin", currentBranch(repository, runner)], {
      cwd: repository,
    });
    return;
  }
  runner("git", ["push"], { cwd: repository });
}

export function repositoryStatus(repository: string, runner: CommandRunner = runCommand): string {
  return runner("git", ["status", "--short"], { cwd: repository }).stdout.trim();
}

export function deletedPathsBetween(
  repository: string,
  from: string | undefined,
  to: string,
  runner: CommandRunner = runCommand,
): readonly string[] {
  if (from === undefined || from === to) {
    return [];
  }
  const result = runner("git", ["diff", "--diff-filter=D", "--name-only", "-z", from, to], {
    cwd: repository,
  });
  return splitNullTerminated(result.stdout);
}
