import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { AppError } from "./errors.js";
import {
  TreeEntry,
  copyManagedEntry,
  managedEntriesEqual,
  managedPathExists,
  pathInside,
  removeManagedPath,
  walkManagedTree,
} from "./files.js";
import { ignoredPaths, trackedPaths } from "./git.js";
import { AppPaths } from "./paths.js";
import { CommandRunner, runCommand } from "./process.js";
import { HARNESS_PROFILES, HarnessProfile, isHardExcluded, liveDirectoryFor } from "./profiles.js";

export type ChangeKind = "added" | "deleted" | "modified";

export interface ProfileChange {
  readonly kind: ChangeKind;
  readonly relativePath: string;
}

export interface ApplyResult {
  readonly backupDirectory?: string;
  readonly copied: number;
  readonly deleted: number;
}

function repositoryPath(profile: HarnessProfile, relativePath: string): string {
  return `${profile.repositoryDirectory}/${relativePath}`;
}

function profileRelativePath(profile: HarnessProfile, repositoryRelativePath: string): string {
  const prefix = `${profile.repositoryDirectory}/`;
  if (!repositoryRelativePath.startsWith(prefix)) {
    throw new AppError(
      `Repository path '${repositoryRelativePath}' is outside profile '${profile.name}'.`,
    );
  }
  return repositoryRelativePath.slice(prefix.length);
}

function filteredEntries(
  repository: string,
  profile: HarnessProfile,
  entries: readonly TreeEntry[],
  runner: CommandRunner,
): readonly TreeEntry[] {
  const candidates = entries.map((entry) => repositoryPath(profile, entry.relativePath));
  const ignored = ignoredPaths(repository, candidates, runner);
  return entries.filter((entry) => !ignored.has(repositoryPath(profile, entry.relativePath)));
}

function entryMap(entries: readonly TreeEntry[]): ReadonlyMap<string, TreeEntry> {
  return new Map(entries.map((entry) => [entry.relativePath, entry]));
}

function entryAt(root: string, relativePath: string): TreeEntry {
  const stat = lstatSync(pathInside(root, relativePath));
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", relativePath };
  }
  if (stat.isFile()) {
    return { kind: "file", relativePath };
  }
  throw new AppError(`Managed path '${relativePath}' is not a regular file or symbolic link.`);
}

function validateTrackedPaths(
  repository: string,
  profile: HarnessProfile,
  runner: CommandRunner,
): readonly string[] {
  const tracked = trackedPaths(repository, profile.repositoryDirectory, runner);
  const hardExcluded = tracked.filter((path) =>
    isHardExcluded(profile, profileRelativePath(profile, path)),
  );
  const gitIgnored = ignoredPaths(repository, tracked, runner);
  const unsafe = new Set([...hardExcluded, ...gitIgnored]);
  if (unsafe.size > 0) {
    throw new AppError(
      [
        `Refusing to sync ${profile.name}: ignored or credential paths are already tracked:`,
        ...[...unsafe].sort().map((path) => `  ${path}`),
        "Remove them from Git history/index before continuing.",
      ].join("\n"),
    );
  }
  return tracked;
}

export function seedTemplateFiles(paths: AppPaths): void {
  mkdirSync(paths.repositoryDirectory, { recursive: true });
  const names = readdirSync(paths.templateDirectory);
  for (const name of names) {
    const targetName = name === "gitignore" ? ".gitignore" : name;
    const target = join(paths.repositoryDirectory, targetName);
    if (!existsSync(target)) {
      const source = join(paths.templateDirectory, name);
      const stat = lstatSync(source);
      if (stat.isDirectory()) {
        cpSync(source, target, { recursive: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(source));
      }
    }
  }
}

export function activeProfiles(
  repository: string,
  runner: CommandRunner = runCommand,
): readonly HarnessProfile[] {
  return HARNESS_PROFILES.filter(
    (profile) =>
      existsSync(join(repository, profile.repositoryDirectory)) ||
      trackedPaths(repository, profile.repositoryDirectory, runner).length > 0,
  );
}

export function profileChanges(
  paths: AppPaths,
  profile: HarnessProfile,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): readonly ProfileChange[] {
  const repositoryRoot = join(paths.repositoryDirectory, profile.repositoryDirectory);
  const liveRoot = liveDirectoryFor(profile, paths, environment);
  validateTrackedPaths(paths.repositoryDirectory, profile, runner);

  const liveEntries = filteredEntries(
    paths.repositoryDirectory,
    profile,
    walkManagedTree(liveRoot, profile),
    runner,
  );
  const repositoryEntries = filteredEntries(
    paths.repositoryDirectory,
    profile,
    walkManagedTree(repositoryRoot, profile),
    runner,
  );
  const live = entryMap(liveEntries);
  const stored = entryMap(repositoryEntries);
  const names = new Set([...live.keys(), ...stored.keys()]);
  const changes: ProfileChange[] = [];

  for (const relativePath of [...names].sort()) {
    const liveEntry = live.get(relativePath);
    const storedEntry = stored.get(relativePath);
    if (liveEntry === undefined) {
      changes.push({ kind: "deleted", relativePath });
    } else if (storedEntry === undefined) {
      changes.push({ kind: "added", relativePath });
    } else if (
      liveEntry.kind !== storedEntry.kind ||
      !managedEntriesEqual(liveRoot, repositoryRoot, liveEntry)
    ) {
      changes.push({ kind: "modified", relativePath });
    }
  }

  return changes;
}

export function captureProfile(
  paths: AppPaths,
  profile: HarnessProfile,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): readonly ProfileChange[] {
  const changes = profileChanges(paths, profile, environment, runner);
  const repositoryRoot = join(paths.repositoryDirectory, profile.repositoryDirectory);
  const liveRoot = liveDirectoryFor(profile, paths, environment);
  mkdirSync(repositoryRoot, { recursive: true });

  const liveEntries = filteredEntries(
    paths.repositoryDirectory,
    profile,
    walkManagedTree(liveRoot, profile),
    runner,
  );
  const live = entryMap(liveEntries);
  const repositoryEntries = filteredEntries(
    paths.repositoryDirectory,
    profile,
    walkManagedTree(repositoryRoot, profile),
    runner,
  );

  for (const entry of repositoryEntries) {
    if (!live.has(entry.relativePath)) {
      removeManagedPath(repositoryRoot, entry.relativePath);
    }
  }
  for (const entry of liveEntries) {
    copyManagedEntry(liveRoot, repositoryRoot, entry);
  }

  return changes;
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function backupExistingPath(liveRoot: string, backupRoot: string, relativePath: string): boolean {
  const source = pathInside(liveRoot, relativePath);
  if (!managedPathExists(source)) {
    return false;
  }
  const target = pathInside(backupRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    force: true,
    preserveTimestamps: true,
    recursive: true,
    verbatimSymlinks: true,
  });
  return true;
}

export function applyProfile(
  paths: AppPaths,
  profile: HarnessProfile,
  deletedRepositoryPaths: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): ApplyResult {
  const repositoryRoot = join(paths.repositoryDirectory, profile.repositoryDirectory);
  const liveRoot = liveDirectoryFor(profile, paths, environment);
  mkdirSync(liveRoot, { recursive: true });

  const tracked = validateTrackedPaths(paths.repositoryDirectory, profile, runner);
  const ignoredDeletedPaths = ignoredPaths(
    paths.repositoryDirectory,
    deletedRepositoryPaths,
    runner,
  );
  const backupRoot = join(paths.backupDirectory, timestamp(), profile.repositoryDirectory);
  let copied = 0;
  let deleted = 0;
  let backedUp = false;

  for (const trackedPath of tracked) {
    const relativePath = profileRelativePath(profile, trackedPath);
    const source = pathInside(repositoryRoot, relativePath);
    if (!managedPathExists(source)) {
      throw new AppError(`Tracked path '${trackedPath}' is missing from the Git worktree.`);
    }
    const entry = entryAt(repositoryRoot, relativePath);
    if (!managedEntriesEqual(repositoryRoot, liveRoot, entry)) {
      backedUp = backupExistingPath(liveRoot, backupRoot, relativePath) || backedUp;
      copyManagedEntry(repositoryRoot, liveRoot, entry);
      copied += 1;
    }
  }

  for (const deletedPath of deletedRepositoryPaths) {
    const prefix = `${profile.repositoryDirectory}/`;
    if (!deletedPath.startsWith(prefix)) {
      continue;
    }
    const relativePath = profileRelativePath(profile, deletedPath);
    if (isHardExcluded(profile, relativePath) || ignoredDeletedPaths.has(deletedPath)) {
      continue;
    }
    if (managedPathExists(pathInside(liveRoot, relativePath))) {
      backedUp = backupExistingPath(liveRoot, backupRoot, relativePath) || backedUp;
      removeManagedPath(liveRoot, relativePath);
      deleted += 1;
    }
  }

  if (backedUp) {
    return { backupDirectory: backupRoot, copied, deleted };
  }
  return { copied, deleted };
}
