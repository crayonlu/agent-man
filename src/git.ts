import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AppError } from "./errors.js";
import { CommandRunner, runCommand } from "./process.js";

export type GitEntryKind = "file" | "symlink" | "unsupported";

export interface GitTrackedEntry {
  readonly kind: GitEntryKind;
  readonly mode: string;
  readonly objectId: string;
  readonly path: string;
  readonly stage: number;
}

export interface GitTreeEntry {
  readonly kind: GitEntryKind;
  readonly mode: string;
  readonly objectId: string;
  readonly path: string;
  readonly size?: number;
}

export interface AheadBehind {
  readonly ahead: number;
  readonly behind: number;
}

const HOOKS_DISABLED: readonly string[] = ["-c", "core.hooksPath=/dev/null"];
const AUTOMATED_COMMIT_CONFIG: readonly string[] = [
  ...HOOKS_DISABLED,
  "-c",
  "user.name=agent-man",
  "-c",
  "user.email=agent-man@localhost",
  "-c",
  "commit.gpgSign=false",
];

export function ensureGitRepository(repository: string): void {
  if (!existsSync(join(repository, ".git"))) {
    throw new AppError(
      "agent-man is not initialized. Run 'agent-man init --github' or 'agent-man init --remote <url>' first.",
      "NOT_INITIALIZED",
    );
  }
}

function splitNullTerminated(value: string): readonly string[] {
  return value.split("\0").filter((entry) => entry !== "");
}

function kindForMode(mode: string): GitEntryKind {
  if (mode === "120000") {
    return "symlink";
  }
  if (mode === "100644" || mode === "100755") {
    return "file";
  }
  return "unsupported";
}

export function trackedEntries(
  repository: string,
  repositoryDirectory?: string,
  runner: CommandRunner = runCommand,
): readonly GitTrackedEntry[] {
  const arguments_ = ["ls-files", "--stage", "-z"];
  if (repositoryDirectory !== undefined) {
    arguments_.push("--", repositoryDirectory);
  }
  const result = runner("git", arguments_, { cwd: repository });
  const entries: GitTrackedEntry[] = [];
  for (const record of splitNullTerminated(result.stdout)) {
    const tab = record.indexOf("\t");
    if (tab < 0) {
      throw new AppError("Git returned an invalid index record.", "GIT_INDEX_INVALID");
    }
    const metadata = record.slice(0, tab).split(" ");
    const mode = metadata[0];
    const objectId = metadata[1];
    const stageText = metadata[2];
    const path = record.slice(tab + 1);
    if (mode === undefined || objectId === undefined || stageText === undefined || path === "") {
      throw new AppError("Git returned an incomplete index record.", "GIT_INDEX_INVALID");
    }
    const stage = Number.parseInt(stageText, 10);
    if (!Number.isInteger(stage)) {
      throw new AppError("Git returned an invalid merge stage.", "GIT_INDEX_INVALID");
    }
    entries.push({ kind: kindForMode(mode), mode, objectId, path, stage });
  }
  return entries;
}

export function treeEntries(
  repository: string,
  reference: string,
  runner: CommandRunner = runCommand,
): readonly GitTreeEntry[] {
  const result = runner("git", ["ls-tree", "-r", "-l", "-z", "--full-tree", reference], {
    cwd: repository,
  });
  const entries: GitTreeEntry[] = [];
  for (const record of splitNullTerminated(result.stdout)) {
    const tab = record.indexOf("\t");
    if (tab < 0) {
      throw new AppError("Git returned an invalid tree record.", "GIT_TREE_INVALID");
    }
    const metadata = record.slice(0, tab).trim().split(/\s+/u);
    const mode = metadata[0];
    const type = metadata[1];
    const objectId = metadata[2];
    const sizeText = metadata[3];
    const path = record.slice(tab + 1);
    if (
      mode === undefined ||
      type === undefined ||
      objectId === undefined ||
      sizeText === undefined ||
      path === ""
    ) {
      throw new AppError("Git returned an incomplete tree record.", "GIT_TREE_INVALID");
    }
    const size = sizeText === "-" ? undefined : Number.parseInt(sizeText, 10);
    if (size !== undefined && (!Number.isInteger(size) || size < 0)) {
      throw new AppError("Git returned an invalid tree object size.", "GIT_TREE_INVALID");
    }
    const entry = { kind: kindForMode(mode), mode, objectId, path };
    entries.push(size === undefined ? entry : { ...entry, size });
  }
  return entries;
}

export function objectText(
  repository: string,
  objectId: string,
  runner: CommandRunner = runCommand,
): string {
  return runner("git", ["cat-file", "blob", objectId], { cwd: repository }).stdout;
}

export function objectBytes(
  repository: string,
  objectId: string,
  runner: CommandRunner = runCommand,
): Buffer {
  const result = runner("git", ["cat-file", "blob", objectId], { cwd: repository });
  return result.stdoutBytes ?? Buffer.from(result.stdout, "utf8");
}

export function trackedPaths(
  repository: string,
  repositoryDirectory: string,
  runner: CommandRunner = runCommand,
): readonly string[] {
  return [
    ...new Set(trackedEntries(repository, repositoryDirectory, runner).map((entry) => entry.path)),
  ];
}

export function indexFileText(
  repository: string,
  repositoryPath: string,
  runner: CommandRunner = runCommand,
): string {
  return runner("git", ["show", `:${repositoryPath}`], { cwd: repository }).stdout;
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

export function stagePaths(
  repository: string,
  paths: readonly string[],
  runner: CommandRunner = runCommand,
): void {
  if (paths.length === 0) {
    return;
  }
  runner("git", ["add", "-A", "--", ...paths], { cwd: repository });
}

export function unstagePaths(
  repository: string,
  paths: readonly string[],
  runner: CommandRunner = runCommand,
): void {
  if (paths.length === 0) {
    return;
  }
  const head = runner("git", ["rev-parse", "--verify", "HEAD"], {
    acceptedExitCodes: [0, 128],
    cwd: repository,
  });
  if (head.status === 0) {
    runner("git", ["reset", "--", ...paths], { cwd: repository });
    return;
  }
  runner("git", ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...paths], {
    cwd: repository,
  });
}

export function hasStagedChanges(repository: string, runner: CommandRunner = runCommand): boolean {
  const result = runner("git", ["diff", "--no-ext-diff", "--cached", "--quiet"], {
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
  runner("git", [...AUTOMATED_COMMIT_CONFIG, "commit", "-m", message], { cwd: repository });
}

export function hardenRepository(repository: string, runner: CommandRunner = runCommand): void {
  for (const [key, value] of [
    ["core.autocrlf", "false"],
    ["core.hooksPath", "/dev/null"],
    ["core.attributesFile", "/dev/null"],
    ["core.eol", "lf"],
    ["core.excludesFile", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.protectHFS", "true"],
    ["core.protectNTFS", "true"],
    ["fetch.fsckObjects", "true"],
    ["transfer.fsckObjects", "true"],
    ["submodule.recurse", "false"],
  ]) {
    if (key !== undefined && value !== undefined) {
      runner("git", ["config", "--local", key, value], { cwd: repository });
    }
  }
  for (const [name, path] of [
    ["attributes", join(repository, ".git", "info", "attributes")],
    ["exclude", join(repository, ".git", "info", "exclude")],
  ]) {
    if (name === undefined || path === undefined || !existsSync(path)) {
      continue;
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AppError(
        `Git info/${name} must be a real regular file in agent-man's private repository.`,
        "GIT_METADATA_UNSAFE",
      );
    }
    const contents = readFileSync(path, "utf8");
    const active = contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (contents.includes("\0") || contents.includes("�") || active.length > 0) {
      throw new AppError(
        `Git info/${name} may contain comments only; repository-local overrides would make synchronization device-dependent.`,
        "GIT_METADATA_UNSAFE",
      );
    }
  }
}

export function checkoutHead(repository: string, runner: CommandRunner = runCommand): void {
  runner("git", [...HOOKS_DISABLED, "checkout", "HEAD", "--", "."], { cwd: repository });
}

export function currentHead(
  repository: string,
  runner: CommandRunner = runCommand,
): string | undefined {
  const result = runner("git", ["rev-parse", "--verify", "HEAD"], {
    acceptedExitCodes: [0, 128],
    cwd: repository,
  });
  const head = result.stdout.trim();
  return result.status === 0 && head !== "" ? head : undefined;
}

export function currentBranch(repository: string, runner: CommandRunner = runCommand): string {
  const result = runner("git", ["branch", "--show-current"], { cwd: repository });
  const branch = result.stdout.trim();
  if (branch === "") {
    throw new AppError(
      "The configuration repository is in detached HEAD state.",
      "GIT_DETACHED_HEAD",
    );
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

export function originUrl(
  repository: string,
  runner: CommandRunner = runCommand,
): string | undefined {
  const result = runner("git", ["remote", "get-url", "origin"], {
    acceptedExitCodes: [0, 2, 128],
    cwd: repository,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
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
  runner(
    "git",
    [
      ...HOOKS_DISABLED,
      "-c",
      "fetch.fsckObjects=true",
      "fetch",
      "--no-recurse-submodules",
      "origin",
    ],
    { cwd: repository },
  );
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

export function aheadBehind(
  repository: string,
  runner: CommandRunner = runCommand,
): AheadBehind | undefined {
  const upstream = upstreamReference(repository, runner);
  if (upstream === undefined || currentHead(repository, runner) === undefined) {
    return undefined;
  }
  const result = runner("git", ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], {
    cwd: repository,
  });
  const values = result.stdout.trim().split(/\s+/u);
  const ahead = Number.parseInt(values[0] ?? "", 10);
  const behind = Number.parseInt(values[1] ?? "", 10);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    throw new AppError("Git returned invalid ahead/behind counts.", "GIT_OUTPUT_INVALID");
  }
  return { ahead, behind };
}

export function mergeBase(
  repository: string,
  left: string,
  right: string,
  runner: CommandRunner = runCommand,
): string | undefined {
  const result = runner("git", ["merge-base", left, right], {
    acceptedExitCodes: [0, 1],
    cwd: repository,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function changedPathsBetween(
  repository: string,
  from: string,
  to: string,
  runner: CommandRunner = runCommand,
): readonly string[] {
  const result = runner("git", ["diff", "--no-ext-diff", "--name-only", "-z", from, to], {
    cwd: repository,
  });
  return splitNullTerminated(result.stdout);
}

export function merge(
  repository: string,
  reference: string,
  runner: CommandRunner = runCommand,
): readonly string[] {
  const result = runner("git", [...AUTOMATED_COMMIT_CONFIG, "merge", "--no-edit", reference], {
    acceptedExitCodes: [0, 1],
    cwd: repository,
  });
  const conflicts = unmergedPaths(repository, runner);
  if (result.status !== 0 && conflicts.length === 0) {
    throw new AppError(
      result.stderr.trim() || result.stdout.trim() || "Git merge failed.",
      "GIT_MERGE_FAILED",
    );
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
  const result = runner("git", ["diff", "--no-ext-diff", "--name-only", "--diff-filter=U", "-z"], {
    cwd: repository,
  });
  return splitNullTerminated(result.stdout);
}

export function finishMerge(repository: string, runner: CommandRunner = runCommand): void {
  runner("git", [...AUTOMATED_COMMIT_CONFIG, "commit", "--no-edit"], { cwd: repository });
}

export function push(repository: string, runner: CommandRunner = runCommand): void {
  const upstream = upstreamReference(repository, runner);
  if (upstream === undefined) {
    runner(
      "git",
      [...HOOKS_DISABLED, "push", "--set-upstream", "origin", currentBranch(repository, runner)],
      {
        cwd: repository,
      },
    );
    return;
  }
  runner("git", [...HOOKS_DISABLED, "push"], { cwd: repository });
}

export function repositoryStatus(repository: string, runner: CommandRunner = runCommand): string {
  return runner("git", ["status", "--short"], { cwd: repository }).stdout.trim();
}

export function workingTreeChangedPaths(
  repository: string,
  runner: CommandRunner = runCommand,
): readonly string[] {
  const paths = new Set<string>();
  if (currentHead(repository, runner) !== undefined) {
    const changed = runner("git", ["diff", "--no-ext-diff", "--name-only", "-z", "HEAD"], {
      cwd: repository,
    });
    for (const path of splitNullTerminated(changed.stdout)) {
      paths.add(path);
    }
  } else {
    for (const entry of trackedEntries(repository, undefined, runner)) {
      paths.add(entry.path);
    }
  }
  const untracked = runner("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repository,
  });
  for (const path of splitNullTerminated(untracked.stdout)) {
    paths.add(path);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
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
  const result = runner(
    "git",
    ["diff", "--no-ext-diff", "--diff-filter=D", "--name-only", "-z", from, to],
    { cwd: repository },
  );
  return splitNullTerminated(result.stdout);
}

export function gitVersion(runner: CommandRunner = runCommand): string {
  return runner("git", ["--version"]).stdout.trim();
}
