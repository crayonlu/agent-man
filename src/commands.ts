import { closeSync, existsSync, lstatSync, mkdirSync, openSync, rmSync } from "node:fs";
import { hostname } from "node:os";

import { AppError, errorMessage } from "./errors.js";
import {
  commit,
  currentHead,
  deletedPathsBetween,
  ensureGitRepository,
  fetchOrigin,
  finishMerge,
  firstParentOfHead,
  hasOrigin,
  hasStagedChanges,
  merge,
  mergeInProgress,
  push,
  repositoryStatus,
  stageAll,
  trackedPaths,
  unmergedPaths,
  upstreamReference,
} from "./git.js";
import { AppPaths } from "./paths.js";
import { CommandRunner, runCommand } from "./process.js";
import { HARNESS_PROFILES, findHarnessProfile, liveDirectoryFor } from "./profiles.js";
import {
  activeProfiles,
  applyProfile,
  captureProfile,
  profileChanges,
  seedTemplateFiles,
} from "./repository.js";

export interface Output {
  info(message: string): void;
}

export interface CommandContext {
  readonly environment?: NodeJS.ProcessEnv;
  readonly output: Output;
  readonly paths: AppPaths;
  readonly runner?: CommandRunner;
}

export type InitMode =
  | { readonly kind: "github"; readonly repository: string; readonly template: string }
  | { readonly kind: "remote"; readonly url: string }
  | { readonly kind: "local" };

function runnerFor(context: CommandContext): CommandRunner {
  return context.runner ?? runCommand;
}

function environmentFor(context: CommandContext): NodeJS.ProcessEnv {
  return context.environment ?? process.env;
}

function ensureFreshRepositoryTarget(paths: AppPaths): void {
  if (existsSync(paths.repositoryDirectory)) {
    throw new AppError(`Configuration repository already exists at ${paths.repositoryDirectory}.`);
  }
  mkdirSync(paths.stateDirectory, { recursive: true });
}

export function resolveGithubRepository(
  repository: string,
  runner: CommandRunner = runCommand,
): string {
  if (repository.includes("/")) {
    return repository;
  }
  const login = runner("gh", ["api", "user", "--jq", ".login"]).stdout.trim();
  if (login === "") {
    throw new AppError("GitHub CLI did not return the authenticated username.");
  }
  return `${login}/${repository}`;
}

function applyExistingProfiles(context: CommandContext): void {
  const runner = runnerFor(context);
  const profiles = activeProfiles(context.paths.repositoryDirectory, runner);
  for (const profile of profiles) {
    const result = applyProfile(context.paths, profile, [], environmentFor(context), runner);
    context.output.info(
      `Applied ${profile.name}: ${result.copied} file(s) copied, ${result.deleted} deleted.`,
    );
    if (result.backupDirectory !== undefined) {
      context.output.info(`Backup: ${result.backupDirectory}`);
    }
  }
}

export function initialize(mode: InitMode, context: CommandContext): void {
  ensureFreshRepositoryTarget(context.paths);
  const runner = runnerFor(context);

  if (mode.kind === "github") {
    runner("gh", ["auth", "status"]);
    const repository = resolveGithubRepository(mode.repository, runner);
    const existing = runner("gh", ["repo", "view", repository, "--json", "nameWithOwner"], {
      acceptedExitCodes: [0, 1],
    });
    if (existing.status !== 0) {
      runner("gh", [
        "repo",
        "create",
        repository,
        "--private",
        "--template",
        mode.template,
        "--disable-issues",
        "--disable-wiki",
        "--description",
        "Private AI harness configuration managed by agent-man",
      ]);
      context.output.info(`Created private GitHub repository ${repository}.`);
    } else {
      context.output.info(`Using existing GitHub repository ${repository}.`);
    }
    runner("gh", ["repo", "clone", repository, context.paths.repositoryDirectory]);
  } else if (mode.kind === "remote") {
    runner("git", ["clone", mode.url, context.paths.repositoryDirectory]);
  } else {
    mkdirSync(context.paths.repositoryDirectory, { recursive: true });
    runner("git", ["init", "-b", "main"], { cwd: context.paths.repositoryDirectory });
  }

  ensureGitRepository(context.paths.repositoryDirectory);
  seedTemplateFiles(context.paths);

  if (mode.kind === "local") {
    stageAll(context.paths.repositoryDirectory, runner);
    if (hasStagedChanges(context.paths.repositoryDirectory, runner)) {
      runner(
        "git",
        [
          "-c",
          "user.name=agent-man",
          "-c",
          "user.email=agent-man@localhost",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "-m",
          "Initialize agent-man configuration",
        ],
        { cwd: context.paths.repositoryDirectory },
      );
    }
  }

  applyExistingProfiles(context);
  context.output.info(`Initialized agent-man at ${context.paths.repositoryDirectory}.`);
}

export function addHarness(name: string, context: CommandContext): void {
  const runner = runnerFor(context);
  const environment = environmentFor(context);
  ensureGitRepository(context.paths.repositoryDirectory);
  const profile = findHarnessProfile(name);
  if (
    trackedPaths(context.paths.repositoryDirectory, profile.repositoryDirectory, runner).length > 0
  ) {
    throw new AppError(`Harness '${name}' is already managed.`);
  }

  const liveDirectory = liveDirectoryFor(profile, context.paths, environment);
  if (!existsSync(liveDirectory) || !lstatSync(liveDirectory).isDirectory()) {
    throw new AppError(`Harness directory does not exist: ${liveDirectory}`);
  }

  const changes = captureProfile(context.paths, profile, environment, runner);
  stageAll(context.paths.repositoryDirectory, runner);
  context.output.info(`Added ${name} from ${liveDirectory} (${changes.length} file change(s)).`);
  context.output.info("Run 'agent-man sync' to commit and push it.");
}

function changeMarker(kind: "added" | "deleted" | "modified"): string {
  if (kind === "added") {
    return "A";
  }
  if (kind === "deleted") {
    return "D";
  }
  return "M";
}

export function showStatus(context: CommandContext): void {
  const runner = runnerFor(context);
  const environment = environmentFor(context);
  ensureGitRepository(context.paths.repositoryDirectory);
  const profiles = activeProfiles(context.paths.repositoryDirectory, runner);

  if (profiles.length === 0) {
    context.output.info("No harness is managed. Run 'agent-man add grok'.");
  }

  for (const profile of profiles) {
    const changes = profileChanges(context.paths, profile, environment, runner);
    context.output.info(`${profile.name}: ${changes.length === 0 ? "clean" : ""}`.trimEnd());
    for (const change of changes) {
      context.output.info(`  ${changeMarker(change.kind)} ${change.relativePath}`);
    }
  }

  const status = repositoryStatus(context.paths.repositoryDirectory, runner);
  if (status !== "") {
    context.output.info("Git worktree:");
    for (const line of status.split("\n")) {
      context.output.info(`  ${line}`);
    }
  }
}

function lock(context: CommandContext): () => void {
  mkdirSync(context.paths.stateDirectory, { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(context.paths.lockPath, "wx");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new AppError(`Another agent-man sync is running (${context.paths.lockPath}).`);
    }
    throw new AppError(`Could not create sync lock: ${errorMessage(error)}`);
  }
  return () => {
    closeSync(descriptor);
    rmSync(context.paths.lockPath, { force: true });
  };
}

function conflictError(paths: AppPaths, conflicts: readonly string[]): AppError {
  return new AppError(
    [
      "Git found configuration conflicts; live harness files were left unchanged.",
      ...conflicts.map((path) => `  ${path}`),
      `Resolve them in ${paths.repositoryDirectory}, run 'git add' there, then rerun 'agent-man sync'.`,
    ].join("\n"),
  );
}

function applyAndReport(
  context: CommandContext,
  deleted: readonly string[],
  profiles = profilesForApply(context.paths.repositoryDirectory, deleted, runnerFor(context)),
): void {
  const runner = runnerFor(context);
  for (const profile of profiles) {
    const result = applyProfile(context.paths, profile, deleted, environmentFor(context), runner);
    context.output.info(
      `${profile.name}: ${result.copied} file(s) applied, ${result.deleted} deleted.`,
    );
    if (result.backupDirectory !== undefined) {
      context.output.info(`Backup: ${result.backupDirectory}`);
    }
  }
}

function profilesForApply(
  repository: string,
  deleted: readonly string[],
  runner: CommandRunner,
): readonly ReturnType<typeof activeProfiles>[number][] {
  const profiles = [...activeProfiles(repository, runner)];
  for (const profile of HARNESS_PROFILES) {
    const prefix = `${profile.repositoryDirectory}/`;
    if (
      deleted.some((path) => path.startsWith(prefix)) &&
      !profiles.some((candidate) => candidate.name === profile.name)
    ) {
      profiles.push(profile);
    }
  }
  return profiles;
}

export function sync(context: CommandContext): void {
  const release = lock(context);
  try {
    const runner = runnerFor(context);
    const environment = environmentFor(context);
    const repository = context.paths.repositoryDirectory;
    ensureGitRepository(repository);

    if (mergeInProgress(repository, runner)) {
      const conflicts = unmergedPaths(repository, runner);
      if (conflicts.length > 0) {
        throw conflictError(context.paths, conflicts);
      }
      finishMerge(repository, runner);
      const head = currentHead(repository, runner);
      if (head === undefined) {
        throw new AppError("Git merge completed without a valid HEAD commit.");
      }
      applyAndReport(
        context,
        deletedPathsBetween(repository, firstParentOfHead(repository, runner), head, runner),
      );
      if (hasOrigin(repository, runner)) {
        push(repository, runner);
      }
      context.output.info("Sync complete.");
      return;
    }

    const beforeProfiles = activeProfiles(repository, runner);
    if (beforeProfiles.length === 0) {
      throw new AppError("No harness is managed. Run 'agent-man add grok' first.");
    }
    for (const profile of beforeProfiles) {
      captureProfile(context.paths, profile, environment, runner);
    }
    stageAll(repository, runner);
    if (hasStagedChanges(repository, runner)) {
      commit(repository, `Sync from ${hostname()} at ${new Date().toISOString()}`, runner);
    }
    const localHead = currentHead(repository, runner);

    if (hasOrigin(repository, runner)) {
      fetchOrigin(repository, runner);
      const upstream = upstreamReference(repository, runner);
      if (upstream !== undefined) {
        const conflicts = merge(repository, upstream, runner);
        if (conflicts.length > 0) {
          throw conflictError(context.paths, conflicts);
        }
      }
    }

    const finalHead = currentHead(repository, runner);
    if (finalHead === undefined) {
      throw new AppError("The configuration repository has no commits to apply.");
    }
    const afterProfiles = activeProfiles(repository, runner);
    const profiles = [...beforeProfiles];
    for (const profile of afterProfiles) {
      if (!profiles.some((candidate) => candidate.name === profile.name)) {
        profiles.push(profile);
      }
    }
    applyAndReport(
      context,
      deletedPathsBetween(repository, localHead, finalHead, runner),
      profiles,
    );

    if (hasOrigin(repository, runner)) {
      push(repository, runner);
    }
    context.output.info("Sync complete.");
  } finally {
    release();
  }
}
