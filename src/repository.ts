import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

import {
  BackupRecord,
  BackupReference,
  beginApplyJournal,
  completeApplyJournal,
  createBackup,
  rollbackBackup,
} from "./backups.js";
import { AppError, errorMessage } from "./errors.js";
import {
  LinkBinding,
  MAX_MANAGED_ENTRIES,
  MAX_MANAGED_FILE_BYTES,
  MAX_MANAGED_TOTAL_BYTES,
  MAX_SYMLINK_TARGET_BYTES,
  TreeEntry,
  bindingProtectsPath,
  copyManagedEntry,
  managedPathExists,
  pathInside,
  portableSymlinkTargetReason,
  readNativeSymlinkTarget,
  readManagedFile,
  removeManagedPath,
  resolveManagedRoot,
  treeEntriesEqual,
  validatePortablePathSet,
  walkPortableTree,
  writeBufferAtomic,
} from "./files.js";
import {
  GitEntryKind,
  GitTrackedEntry,
  GitTreeEntry,
  ignoredPaths,
  indexFileText,
  objectText,
  stagePaths,
  trackedEntries,
  trackedPaths,
  treeEntries,
} from "./git.js";
import { AppPaths } from "./paths.js";
import {
  EntryRisk,
  NATIVE_PROFILES,
  NativeProfile,
  isPortableFile,
  isPortablePath,
  liveDirectoryFor,
  profileIgnoreContents,
  riskForPath,
  shouldScanForSecrets,
} from "./profiles.js";
import { CommandRunner, runCommand } from "./process.js";

const ROOT_CONTROL_PATHS: readonly string[] = [".gitattributes", ".gitignore", "README.md"];
const PROFILE_CONTROL_PATH = ".gitignore";

export interface RepositoryPathClassification {
  readonly profile?: string;
  readonly risk: EntryRisk | "unmanaged";
}

export type ChangeKind = "added" | "deleted" | "modified";

export interface ProfileChange {
  readonly kind: ChangeKind;
  readonly relativePath: string;
  readonly risk: EntryRisk;
}

export interface ProfileState {
  readonly bindings: readonly LinkBinding[];
  readonly changes: readonly ProfileChange[];
  readonly liveDirectory: string;
  readonly managedEntries: number;
  readonly name: string;
  readonly totalBytes: number;
}

export interface ProfileApplyResult {
  readonly copied: number;
  readonly deleted: number;
  readonly name: string;
  readonly protectedBindings: number;
}

export interface ApplyResult {
  readonly backup?: BackupRecord;
  readonly profiles: readonly ProfileApplyResult[];
}

interface RepositoryTree {
  readonly entries: readonly TreeEntry[];
  readonly root: string;
  readonly trackedRelativePaths: ReadonlySet<string>;
}

interface LogicalProfileEntry {
  readonly kind: GitEntryKind;
  readonly objectId: string;
  readonly path: string;
}

interface LogicalProfileTree {
  readonly directories: ReadonlySet<string>;
  readonly entries: ReadonlyMap<string, LogicalProfileEntry>;
  readonly linkTargets: Map<string, string>;
}

type LinkTargetReader = (entry: LogicalProfileEntry) => string;

interface LogicalTargetResolution {
  readonly kind: "directory" | "file";
  readonly paths: readonly string[];
}

interface PlannedAction {
  readonly affected: readonly TreeEntry[];
  readonly desired?: TreeEntry;
  readonly liveRoot: string;
  readonly operation: "copy" | "delete";
  readonly profile: NativeProfile;
  readonly repositoryRoot: string;
  readonly relativePath: string;
}

function repositoryPath(profile: NativeProfile, relativePath: string): string {
  return `${profile.repositoryDirectory}/${relativePath}`;
}

function profileRelativePath(profile: NativeProfile, repositoryRelativePath: string): string {
  const prefix = `${profile.repositoryDirectory}/`;
  if (!repositoryRelativePath.startsWith(prefix)) {
    throw new AppError(
      `Repository path '${repositoryRelativePath}' is outside profile '${profile.name}'.`,
      "REPOSITORY_PATH_OUTSIDE_PROFILE",
    );
  }
  return repositoryRelativePath.slice(prefix.length);
}

function entryMap(entries: readonly TreeEntry[]): ReadonlyMap<string, TreeEntry> {
  return new Map(entries.map((entry) => [entry.relativePath, entry]));
}

function filteredEntries(
  repository: string,
  profile: NativeProfile,
  entries: readonly TreeEntry[],
  runner: CommandRunner,
): readonly TreeEntry[] {
  const candidates = entries.map((entry) => repositoryPath(profile, entry.relativePath));
  const ignored = ignoredPaths(repository, candidates, runner);
  return entries.filter((entry) => !ignored.has(repositoryPath(profile, entry.relativePath)));
}

function filteredBindings(
  repository: string,
  profile: NativeProfile,
  bindings: readonly LinkBinding[],
  runner: CommandRunner,
): readonly LinkBinding[] {
  const candidates = bindings.map((binding) => repositoryPath(profile, binding.relativePath));
  const ignored = ignoredPaths(repository, candidates, runner);
  return bindings.filter((binding) => !ignored.has(repositoryPath(profile, binding.relativePath)));
}

function inlineSecretDetected(contents: string): boolean {
  for (const sourceLine of contents.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("//")) {
      continue;
    }
    if (/^(?:["']?api[_-]?key["']?)\s*(?:=|:)/iu.test(line) && !line.includes("${")) {
      return true;
    }
    const sensitiveHeader =
      /(?:^|[{,]\s*)["']?(?:authorization|x-api-key|[a-z0-9_]*(?:api[_-]?key|access[_-]?token|secret|password)[a-z0-9_]*)["']?\s*(?:=|:)\s*["'][^"']+["']/iu;
    if (sensitiveHeader.test(line) && !line.includes("${")) {
      return true;
    }
  }
  return false;
}

function validatePortableText(contents: string, path: string, code: string): void {
  if (contents.includes("\0") || contents.includes("�")) {
    throw new AppError(`Text file '${path}' is not valid portable UTF-8.`, code);
  }
}

function validateEntrySecrets(profile: NativeProfile, root: string, entry: TreeEntry): void {
  if (entry.kind !== "file" || !isPortableFile(profile, entry.relativePath)) {
    return;
  }
  const contents = readManagedFile(root, entry.relativePath).toString("utf8");
  validatePortableText(contents, `${profile.name}/${entry.relativePath}`, "CONFIG_TEXT_INVALID");
  if (shouldScanForSecrets(profile, entry.relativePath) && inlineSecretDetected(contents)) {
    throw new AppError(
      `Refusing '${profile.name}/${entry.relativePath}': it contains an inline credential field. Use env_key, bearer_token_env_var, or a \${VAR} reference.`,
      "INLINE_SECRET",
    );
  }
}

function buildLogicalProfileTree(
  profile: NativeProfile,
  sourceEntries: readonly LogicalProfileEntry[],
): LogicalProfileTree {
  const directories = new Set<string>();
  const entries = new Map<string, LogicalProfileEntry>();
  for (const entry of sourceEntries) {
    const relativePath = profileRelativePath(profile, entry.path);
    entries.set(relativePath, entry);
    const segments = relativePath.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return { directories, entries, linkTargets: new Map() };
}

function logicalLinkTarget(
  entry: LogicalProfileEntry,
  tree: LogicalProfileTree,
  readTarget: LinkTargetReader,
): string {
  const cached = tree.linkTargets.get(entry.path);
  if (cached !== undefined) {
    return cached;
  }
  const target = readTarget(entry);
  tree.linkTargets.set(entry.path, target);
  return target;
}

function resolveLogicalTarget(
  repositoryRoot: string,
  profile: NativeProfile,
  sourceRelativePath: string,
  initialLinkTarget: string,
  tree: LogicalProfileTree,
  readTarget: LinkTargetReader,
): LogicalTargetResolution | undefined {
  let target = posix.normalize(posix.join(posix.dirname(sourceRelativePath), initialLinkTarget));
  const paths = new Set<string>();
  for (let hop = 0; hop < 32; hop += 1) {
    if (!isPortablePath(profile, target)) {
      return undefined;
    }
    paths.add(target);
    const segments = target.split("/");
    let redirected = false;
    for (let length = 1; length <= segments.length; length += 1) {
      const current = segments.slice(0, length).join("/");
      const entry = tree.entries.get(current);
      if (entry?.kind === "symlink") {
        const linkTarget = logicalLinkTarget(entry, tree, readTarget);
        if (
          portableSymlinkTargetReason(repositoryRoot, profile, current, linkTarget) !== undefined
        ) {
          return undefined;
        }
        target = posix.normalize(
          posix.join(posix.dirname(current), linkTarget, ...segments.slice(length)),
        );
        redirected = true;
        break;
      }
      if (entry !== undefined) {
        if (entry.kind !== "file" || length < segments.length) {
          return undefined;
        }
        return { kind: "file", paths: [...paths] };
      }
      if (!tree.directories.has(current)) {
        return undefined;
      }
      if (length === segments.length) {
        return { kind: "directory", paths: [...paths] };
      }
    }
    if (!redirected) {
      return undefined;
    }
  }
  return undefined;
}

function validateTrackedEntry(
  repository: string,
  repositoryRoot: string,
  profile: NativeProfile,
  tracked: GitTrackedEntry,
  scanned: ReadonlyMap<string, TreeEntry>,
  index: LogicalProfileTree,
  runner: CommandRunner,
): TreeEntry | undefined {
  if (tracked.stage !== 0) {
    throw new AppError(
      `Repository path '${tracked.path}' is unmerged. Resolve Git conflicts before continuing.`,
      "GIT_CONFLICT",
    );
  }
  const relativePath = profileRelativePath(profile, tracked.path);
  if (relativePath === PROFILE_CONTROL_PATH) {
    if (tracked.kind !== "file" || tracked.mode !== "100644") {
      throw new AppError(
        `Profile control '${tracked.path}' must be a non-executable regular file.`,
        "REPOSITORY_CONTROL_UNSAFE",
      );
    }
    const controlPath = pathInside(repositoryRoot, relativePath);
    if (!managedPathExists(controlPath) || !lstatSync(controlPath).isFile()) {
      throw new AppError(
        `Profile control '${tracked.path}' must be a real regular file in the Git worktree.`,
        "REPOSITORY_CONTROL_UNSAFE",
      );
    }
    validatePortableText(
      readManagedFile(repositoryRoot, relativePath).toString("utf8"),
      tracked.path,
      "REPOSITORY_CONTROL_UNSAFE",
    );
    return undefined;
  }
  if (!isPortablePath(profile, relativePath)) {
    throw new AppError(
      `Tracked path '${tracked.path}' is outside the '${profile.name}' allowlist.`,
      "TRACKED_PATH_UNMANAGED",
    );
  }
  if (tracked.kind === "unsupported") {
    throw new AppError(
      `Tracked path '${tracked.path}' uses unsupported Git mode ${tracked.mode}.`,
      "GIT_MODE_UNSUPPORTED",
    );
  }
  const actual = scanned.get(relativePath);
  if (tracked.kind === "file") {
    if (actual === undefined || actual.kind !== "file") {
      throw new AppError(
        `Tracked file '${tracked.path}' is missing or has changed type in the Git worktree.`,
        "GIT_WORKTREE_TYPE_MISMATCH",
      );
    }
    const entry: TreeEntry = {
      ...actual,
      mode: tracked.mode === "100755" ? 0o755 : 0o644,
    };
    validateEntrySecrets(profile, repositoryRoot, entry);
    return entry;
  }

  const readTarget: LinkTargetReader = (entry) => indexFileText(repository, entry.path, runner);
  const linkTarget = logicalLinkTarget(tracked, index, readTarget);
  const lexicalReason = portableSymlinkTargetReason(
    repositoryRoot,
    profile,
    relativePath,
    linkTarget,
  );
  const resolvedTarget = resolveLogicalTarget(
    repositoryRoot,
    profile,
    relativePath,
    linkTarget,
    index,
    readTarget,
  );
  if (lexicalReason !== undefined || resolvedTarget === undefined) {
    throw new AppError(
      `Tracked symbolic-link binding '${tracked.path}' is ${lexicalReason ?? "broken"}; repositories may contain only reproducible internal relative links.`,
      "TRACKED_SYMLINK_UNSAFE",
    );
  }
  const worktreePath = pathInside(repositoryRoot, relativePath);
  if (!managedPathExists(worktreePath)) {
    throw new AppError(
      `Tracked symbolic link '${tracked.path}' is missing from the Git worktree.`,
      "GIT_WORKTREE_TYPE_MISMATCH",
    );
  }
  const worktreeStat = lstatSync(worktreePath);
  if (worktreeStat.isSymbolicLink() && readNativeSymlinkTarget(worktreePath) !== linkTarget) {
    throw new AppError(
      `Tracked symbolic link '${tracked.path}' differs from the Git index.`,
      "GIT_WORKTREE_TYPE_MISMATCH",
    );
  }
  if (
    worktreeStat.isFile() &&
    readManagedFile(repositoryRoot, relativePath).toString("utf8") !== linkTarget
  ) {
    throw new AppError(
      `Materialized symbolic link '${tracked.path}' differs from the Git index.`,
      "GIT_WORKTREE_TYPE_MISMATCH",
    );
  }
  if (!worktreeStat.isSymbolicLink() && !worktreeStat.isFile()) {
    throw new AppError(
      `Tracked symbolic link '${tracked.path}' has an invalid Git worktree representation.`,
      "GIT_WORKTREE_TYPE_MISMATCH",
    );
  }
  const risk = riskForPath(profile, relativePath);
  if (risk === undefined) {
    throw new AppError(
      `Tracked path '${tracked.path}' is outside the '${profile.name}' allowlist.`,
      "TRACKED_PATH_UNMANAGED",
    );
  }
  return {
    kind: "symlink",
    linkTarget,
    linkType: resolvedTarget.kind,
    mode: 0o777,
    relativePath,
    risk,
    size: Buffer.byteLength(linkTarget),
  };
}

function repositoryTree(
  repository: string,
  profile: NativeProfile,
  runner: CommandRunner,
): RepositoryTree {
  const repositoryDirectory = join(repository, profile.repositoryDirectory);
  const scan = walkPortableTree(repositoryDirectory, profile);
  const tracked = trackedEntries(repository, profile.repositoryDirectory, runner);
  const index = buildLogicalProfileTree(profile, tracked);
  const trackedSymlinks = new Set(
    tracked
      .filter((entry) => entry.kind === "symlink")
      .map((entry) => profileRelativePath(profile, entry.path)),
  );
  const unsafeBindings = filteredBindings(repository, profile, scan.bindings, runner).filter(
    (binding) => !trackedSymlinks.has(binding.relativePath),
  );
  if (unsafeBindings.length > 0) {
    throw new AppError(
      `The Git worktree contains a local symbolic-link binding at '${profile.name}/${unsafeBindings[0]?.relativePath}'. Remove it before syncing.`,
      "REPOSITORY_BINDING_UNSAFE",
    );
  }
  const visibleEntries = filteredEntries(repository, profile, scan.entries, runner);
  const map = new Map(visibleEntries.map((entry) => [entry.relativePath, entry]));
  const ignored = ignoredPaths(
    repository,
    tracked.map((entry) => entry.path),
    runner,
  );
  const trackedRelativePaths = new Set<string>();
  for (const trackedEntry of tracked) {
    if (ignored.has(trackedEntry.path)) {
      continue;
    }
    const validated = validateTrackedEntry(
      repository,
      scan.root,
      profile,
      trackedEntry,
      map,
      index,
      runner,
    );
    if (validated !== undefined) {
      map.set(validated.relativePath, validated);
      trackedRelativePaths.add(validated.relativePath);
    }
  }
  const entries = [...map.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  validatePortablePathSet(entries.map((entry) => entry.relativePath));
  for (const entry of entries) {
    validateEntrySecrets(profile, scan.root, entry);
  }
  return { entries, root: scan.root, trackedRelativePaths };
}

function profileForRepositoryPath(path: string): NativeProfile | undefined {
  return NATIVE_PROFILES.find((profile) => path.startsWith(`${profile.repositoryDirectory}/`));
}

export function classifyRepositoryPath(path: string): RepositoryPathClassification {
  if (ROOT_CONTROL_PATHS.includes(path)) {
    return { risk: "configuration" };
  }
  const profile = profileForRepositoryPath(path);
  if (profile === undefined) {
    return { risk: "unmanaged" };
  }
  const relativePath = profileRelativePath(profile, path);
  if (relativePath === PROFILE_CONTROL_PATH) {
    return { profile: profile.name, risk: "configuration" };
  }
  const risk = riskForPath(profile, relativePath);
  return risk === undefined
    ? { profile: profile.name, risk: "unmanaged" }
    : { profile: profile.name, risk };
}

function validateGitAttributes(contents: string, path: string): void {
  validatePortableText(contents, path, "GIT_ATTRIBUTES_UNSAFE");
  for (const sourceLine of contents.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const fields = line.split(/\s+/u);
    const pattern = fields[0];
    const attributes = fields.slice(1);
    if (
      pattern === undefined ||
      pattern.startsWith("[attr]") ||
      attributes.length === 0 ||
      attributes.some(
        (attribute) =>
          attribute !== "text" &&
          attribute !== "text=auto" &&
          attribute !== "-text" &&
          attribute !== "eol=lf" &&
          attribute !== "eol=crlf",
      )
    ) {
      throw new AppError(
        `Git attributes file '${path}' may define only text and eol behavior. Filters, merge drivers, diff drivers, encodings, macros, and other attributes are refused.`,
        "GIT_ATTRIBUTES_UNSAFE",
      );
    }
  }
}

export function validateRepositoryControls(
  repository: string,
  runner: CommandRunner = runCommand,
): void {
  const repositoryRoot = resolveManagedRoot(repository);
  const tracked = new Map(
    trackedEntries(repository, undefined, runner)
      .filter((entry) => ROOT_CONTROL_PATHS.includes(entry.path))
      .map((entry) => [entry.path, entry]),
  );
  for (const path of ROOT_CONTROL_PATHS) {
    const entry = tracked.get(path);
    const absolutePath = pathInside(repositoryRoot, path);
    if (!managedPathExists(absolutePath)) {
      if (entry !== undefined) {
        throw new AppError(
          `Repository control '${path}' is missing from the worktree.`,
          "REPOSITORY_CONTROL_UNSAFE",
        );
      }
      continue;
    }
    const stat = lstatSync(absolutePath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (entry !== undefined &&
        (entry.kind !== "file" || entry.mode !== "100644" || entry.stage !== 0))
    ) {
      throw new AppError(
        `Repository control '${path}' must be a real non-executable regular file.`,
        "REPOSITORY_CONTROL_UNSAFE",
      );
    }
    const contents = readManagedFile(repositoryRoot, path).toString("utf8");
    if (path === ".gitattributes") {
      validateGitAttributes(contents, path);
    } else {
      validatePortableText(contents, path, "REPOSITORY_CONTROL_UNSAFE");
    }
  }
}

function treeObjectText(
  repository: string,
  entry: GitTreeEntry,
  cache: Map<string, string>,
  runner: CommandRunner,
): string {
  const cached = cache.get(entry.objectId);
  if (cached !== undefined) {
    return cached;
  }
  const contents = objectText(repository, entry.objectId, runner);
  if (
    entry.size === undefined ||
    Buffer.byteLength(contents) !== entry.size ||
    contents.includes("�") ||
    contents.includes("\0")
  ) {
    throw new AppError(
      `Git object for '${entry.path}' is not valid portable UTF-8 text.`,
      "GIT_OBJECT_INVALID",
    );
  }
  cache.set(entry.objectId, contents);
  return contents;
}

export function validateReferenceScope(
  repository: string,
  reference: string,
  runner: CommandRunner = runCommand,
): void {
  const entries = treeEntries(repository, reference, runner);
  if (entries.length > MAX_MANAGED_ENTRIES) {
    throw new AppError(
      `Git tree '${reference}' exceeds ${MAX_MANAGED_ENTRIES} entries.`,
      "SURFACE_TOO_MANY_ENTRIES",
    );
  }
  validatePortablePathSet(entries.map((entry) => entry.path));
  const byProfile = new Map<string, GitTreeEntry[]>();
  const textCache = new Map<string, string>();
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.kind === "unsupported" || entry.size === undefined) {
      throw new AppError(
        `Git tree path '${entry.path}' uses unsupported mode ${entry.mode}.`,
        "GIT_MODE_UNSUPPORTED",
      );
    }
    if (entry.size > MAX_MANAGED_FILE_BYTES) {
      throw new AppError(
        `Git tree path '${entry.path}' exceeds ${MAX_MANAGED_FILE_BYTES} bytes.`,
        "FILE_TOO_LARGE",
      );
    }
    if (entry.kind === "symlink" && entry.size > MAX_SYMLINK_TARGET_BYTES) {
      throw new AppError(
        `Git tree symbolic link '${entry.path}' exceeds ${MAX_SYMLINK_TARGET_BYTES} target bytes.`,
        "SYMLINK_TARGET_TOO_LONG",
      );
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_MANAGED_TOTAL_BYTES) {
      throw new AppError(
        `Git tree '${reference}' exceeds ${MAX_MANAGED_TOTAL_BYTES} bytes.`,
        "SURFACE_TOO_LARGE",
      );
    }
    if (
      posix.basename(entry.path).toLowerCase() === ".gitattributes" &&
      entry.path !== ".gitattributes"
    ) {
      throw new AppError(
        `Nested Git attributes file '${entry.path}' is outside the repository control surface.`,
        "GIT_ATTRIBUTES_UNSAFE",
      );
    }
    if (ROOT_CONTROL_PATHS.includes(entry.path)) {
      if (entry.kind !== "file" || entry.mode !== "100644") {
        throw new AppError(
          `Repository control '${entry.path}' must be a non-executable regular file.`,
          "REPOSITORY_CONTROL_UNSAFE",
        );
      }
      const contents = treeObjectText(repository, entry, textCache, runner);
      if (entry.path === ".gitattributes") {
        validateGitAttributes(contents, entry.path);
      } else {
        validatePortableText(contents, entry.path, "REPOSITORY_CONTROL_UNSAFE");
      }
      continue;
    }
    const profile = profileForRepositoryPath(entry.path);
    if (profile === undefined) {
      throw new AppError(
        `Git tree path '${entry.path}' is outside every built-in profile.`,
        "TRACKED_PATH_UNMANAGED",
      );
    }
    const relativePath = profileRelativePath(profile, entry.path);
    if (relativePath === PROFILE_CONTROL_PATH) {
      if (entry.kind !== "file" || entry.mode !== "100644") {
        throw new AppError(
          `Profile control '${entry.path}' must be a non-executable regular file.`,
          "REPOSITORY_CONTROL_UNSAFE",
        );
      }
      treeObjectText(repository, entry, textCache, runner);
    } else if (!isPortablePath(profile, relativePath)) {
      throw new AppError(
        `Git tree path '${entry.path}' is outside the '${profile.name}' allowlist.`,
        "TRACKED_PATH_UNMANAGED",
      );
    }
    if (entry.kind === "file" && isPortableFile(profile, relativePath)) {
      const contents = treeObjectText(repository, entry, textCache, runner);
      if (shouldScanForSecrets(profile, relativePath) && inlineSecretDetected(contents)) {
        throw new AppError(
          `Refusing '${profile.name}/${relativePath}': it contains an inline credential field. Use env_key, bearer_token_env_var, or a \${VAR} reference.`,
          "INLINE_SECRET",
        );
      }
    }
    const profileEntries = byProfile.get(profile.name) ?? [];
    profileEntries.push(entry);
    byProfile.set(profile.name, profileEntries);
  }

  for (const profile of NATIVE_PROFILES) {
    const profileEntries = byProfile.get(profile.name);
    if (profileEntries === undefined) {
      continue;
    }
    if (
      !profileEntries.some((entry) => entry.path === repositoryPath(profile, PROFILE_CONTROL_PATH))
    ) {
      throw new AppError(
        `Git tree profile '${profile.name}' is missing its .gitignore control file.`,
        "REPOSITORY_CONTROL_MISSING",
      );
    }
    const tree = buildLogicalProfileTree(profile, profileEntries);
    const readTarget: LinkTargetReader = (logicalEntry) => {
      const entry = tree.entries.get(profileRelativePath(profile, logicalEntry.path));
      if (entry === undefined) {
        throw new AppError("Git tree link target metadata is missing.", "GIT_TREE_INVALID");
      }
      const source = profileEntries.find((candidate) => candidate.path === entry.path);
      if (source === undefined) {
        throw new AppError("Git tree link object is missing.", "GIT_TREE_INVALID");
      }
      return treeObjectText(repository, source, textCache, runner);
    };
    const repositoryRoot = join(repository, profile.repositoryDirectory);
    for (const entry of profileEntries) {
      if (entry.kind !== "symlink") {
        continue;
      }
      const relativePath = profileRelativePath(profile, entry.path);
      const linkTarget = treeObjectText(repository, entry, textCache, runner);
      const lexicalReason = portableSymlinkTargetReason(
        repositoryRoot,
        profile,
        relativePath,
        linkTarget,
      );
      const resolvedTarget = resolveLogicalTarget(
        repositoryRoot,
        profile,
        relativePath,
        linkTarget,
        tree,
        readTarget,
      );
      if (lexicalReason !== undefined || resolvedTarget === undefined) {
        throw new AppError(
          `Git tree symbolic-link binding '${entry.path}' is ${lexicalReason ?? "broken"}; only reproducible internal relative links are accepted.`,
          "TRACKED_SYMLINK_UNSAFE",
        );
      }
    }
  }
}

export function validateRepositoryScope(
  repository: string,
  runner: CommandRunner = runCommand,
): void {
  const tracked = trackedEntries(repository, undefined, runner);
  validatePortablePathSet(tracked.map((entry) => entry.path));
  const trackedPathsSet = new Set(tracked.map((entry) => entry.path));
  for (const profile of NATIVE_PROFILES) {
    const prefix = `${profile.repositoryDirectory}/`;
    if (
      tracked.some((entry) => entry.path.startsWith(prefix)) &&
      !trackedPathsSet.has(repositoryPath(profile, PROFILE_CONTROL_PATH))
    ) {
      throw new AppError(
        `Profile '${profile.name}' is missing its .gitignore control file.`,
        "REPOSITORY_CONTROL_MISSING",
      );
    }
  }
  validateRepositoryControls(repository, runner);
  for (const entry of tracked) {
    if (entry.stage !== 0) {
      throw new AppError(
        `Repository path '${entry.path}' is unmerged. Resolve Git conflicts before continuing.`,
        "GIT_CONFLICT",
      );
    }
    if (
      posix.basename(entry.path).toLowerCase() === ".gitattributes" &&
      entry.path !== ".gitattributes"
    ) {
      throw new AppError(
        `Nested Git attributes file '${entry.path}' is outside the repository control surface.`,
        "GIT_ATTRIBUTES_UNSAFE",
      );
    }
  }
  const ignoredTracked = ignoredPaths(
    repository,
    tracked.map((entry) => entry.path),
    runner,
  );
  for (const entry of tracked) {
    if (ROOT_CONTROL_PATHS.includes(entry.path)) {
      if (ignoredTracked.has(entry.path)) {
        throw new AppError(
          `Tracked repository control '${entry.path}' is ignored. Restore the template allow rule before syncing.`,
          "TRACKED_PATH_IGNORED",
        );
      }
      if (entry.kind !== "file") {
        throw new AppError(
          `Repository control '${entry.path}' must be a regular file.`,
          "REPOSITORY_CONTROL_UNSAFE",
        );
      }
      continue;
    }
    const profile = profileForRepositoryPath(entry.path);
    if (profile === undefined) {
      throw new AppError(
        `Tracked path '${entry.path}' is outside every built-in profile.`,
        "TRACKED_PATH_UNMANAGED",
      );
    }
    const relativePath = profileRelativePath(profile, entry.path);
    if (relativePath !== PROFILE_CONTROL_PATH && !isPortablePath(profile, relativePath)) {
      throw new AppError(
        `Tracked path '${entry.path}' is outside the '${profile.name}' allowlist.`,
        "TRACKED_PATH_UNMANAGED",
      );
    }
    if (ignoredTracked.has(entry.path)) {
      throw new AppError(
        `Tracked path '${entry.path}' is now ignored. Run agent-man sync to stop managing it while preserving the live file.`,
        "TRACKED_PATH_IGNORED",
      );
    }
  }
  for (const profile of activeProfiles(repository, runner)) {
    repositoryTree(repository, profile, runner);
  }
}

export function seedTemplateFiles(paths: AppPaths): void {
  const repositoryRoot = resolveManagedRoot(paths.repositoryDirectory, true);
  for (const name of readdirSync(paths.templateDirectory)) {
    const targetName =
      name === "gitignore" ? ".gitignore" : name === "gitattributes" ? ".gitattributes" : name;
    const target = join(repositoryRoot, targetName);
    if (!existsSync(target)) {
      const source = join(paths.templateDirectory, name);
      if (!lstatSync(source).isFile()) {
        throw new AppError(`Template entry '${name}' is not a regular file.`, "TEMPLATE_INVALID");
      }
      writeBufferAtomic(repositoryRoot, targetName, readFileSync(source), 0o644);
    }
  }
}

export function ensureProfileControl(repository: string, profile: NativeProfile): void {
  const repositoryRoot = resolveManagedRoot(repository, true);
  const controlPath = `${profile.repositoryDirectory}/${PROFILE_CONTROL_PATH}`;
  const absoluteControl = pathInside(repositoryRoot, controlPath);
  if (managedPathExists(absoluteControl)) {
    if (!lstatSync(absoluteControl).isFile() || lstatSync(absoluteControl).isSymbolicLink()) {
      throw new AppError(
        `Profile control '${controlPath}' must be a regular file.`,
        "REPOSITORY_CONTROL_UNSAFE",
      );
    }
    return;
  }
  writeBufferAtomic(repositoryRoot, controlPath, profileIgnoreContents(profile), 0o644);
}

export function activeProfiles(
  repository: string,
  runner: CommandRunner = runCommand,
): readonly NativeProfile[] {
  return NATIVE_PROFILES.filter((profile) => {
    const control = join(repository, profile.repositoryDirectory, PROFILE_CONTROL_PATH);
    return (
      existsSync(control) ||
      trackedPaths(repository, profile.repositoryDirectory, runner).length > 0
    );
  });
}

function scanLiveProfile(
  paths: AppPaths,
  profile: NativeProfile,
  environment: NodeJS.ProcessEnv,
  runner: CommandRunner,
): {
  readonly bindings: readonly LinkBinding[];
  readonly entries: readonly TreeEntry[];
  readonly root: string;
  readonly totalBytes: number;
} {
  const scan = walkPortableTree(liveDirectoryFor(profile, paths, environment), profile);
  const entries = filteredEntries(paths.repositoryDirectory, profile, scan.entries, runner);
  for (const entry of entries) {
    validateEntrySecrets(profile, scan.root, entry);
  }
  return {
    bindings: filteredBindings(paths.repositoryDirectory, profile, scan.bindings, runner),
    entries,
    root: scan.root,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}

export function profileState(
  paths: AppPaths,
  profile: NativeProfile,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): ProfileState {
  const live = scanLiveProfile(paths, profile, environment, runner);
  const storedTree = repositoryTree(paths.repositoryDirectory, profile, runner);
  const storedEntries = filteredEntries(
    paths.repositoryDirectory,
    profile,
    storedTree.entries,
    runner,
  ).filter((entry) => !bindingProtectsPath(live.bindings, entry.relativePath));
  const liveEntries = live.entries.filter(
    (entry) => !bindingProtectsPath(live.bindings, entry.relativePath),
  );
  const liveMap = entryMap(liveEntries);
  const storedMap = entryMap(storedEntries);
  const names = new Set([...liveMap.keys(), ...storedMap.keys()]);
  const changes: ProfileChange[] = [];
  for (const relativePath of [...names].sort()) {
    const liveEntry = liveMap.get(relativePath);
    const storedEntry = storedMap.get(relativePath);
    if (liveEntry === undefined && storedEntry !== undefined) {
      changes.push({ kind: "deleted", relativePath, risk: storedEntry.risk });
    } else if (liveEntry !== undefined && storedEntry === undefined) {
      changes.push({ kind: "added", relativePath, risk: liveEntry.risk });
    } else if (
      liveEntry !== undefined &&
      storedEntry !== undefined &&
      !treeEntriesEqual(live.root, liveEntry, storedTree.root, storedEntry)
    ) {
      changes.push({ kind: "modified", relativePath, risk: liveEntry.risk });
    }
  }
  return {
    bindings: live.bindings,
    changes,
    liveDirectory: liveDirectoryFor(profile, paths, environment),
    managedEntries: liveEntries.length,
    name: profile.name,
    totalBytes: live.totalBytes,
  };
}

export function profileChanges(
  paths: AppPaths,
  profile: NativeProfile,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): readonly ProfileChange[] {
  return profileState(paths, profile, environment, runner).changes;
}

export function captureProfile(
  paths: AppPaths,
  profile: NativeProfile,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): readonly ProfileChange[] {
  validateRepositoryControls(paths.repositoryDirectory, runner);
  const liveDirectory = liveDirectoryFor(profile, paths, environment);
  if (!managedPathExists(liveDirectory)) {
    throw new AppError(
      `Managed profile root is missing: ${liveDirectory}. Restore it or remove the profile deliberately from the configuration repository.`,
      "PROFILE_ROOT_MISSING",
    );
  }
  ensureProfileControl(paths.repositoryDirectory, profile);
  const tracked = trackedEntries(paths.repositoryDirectory, profile.repositoryDirectory, runner);
  const ignored = ignoredPaths(
    paths.repositoryDirectory,
    tracked.map((entry) => entry.path),
    runner,
  );
  const newlyIgnored = tracked
    .filter(
      (entry) =>
        ignored.has(entry.path) &&
        profileRelativePath(profile, entry.path) !== PROFILE_CONTROL_PATH,
    )
    .map((entry) => entry.path);
  if (newlyIgnored.length > 0) {
    runner("git", ["rm", "-f", "--", ...newlyIgnored], {
      cwd: paths.repositoryDirectory,
    });
  }
  const state = profileState(paths, profile, environment, runner);
  const live = scanLiveProfile(paths, profile, environment, runner);
  const stored = repositoryTree(paths.repositoryDirectory, profile, runner);
  const liveMap = entryMap(live.entries);
  const storedEntries = filteredEntries(paths.repositoryDirectory, profile, stored.entries, runner);

  for (const entry of storedEntries) {
    if (
      !liveMap.has(entry.relativePath) &&
      !bindingProtectsPath(live.bindings, entry.relativePath)
    ) {
      removeManagedPath(stored.root, entry.relativePath);
    }
  }
  for (const entry of live.entries) {
    copyManagedEntry(live.root, stored.root, entry);
  }
  return state.changes;
}

export function managedStagePaths(
  repository: string,
  runner: CommandRunner = runCommand,
): readonly string[] {
  const tracked = new Set(trackedEntries(repository, undefined, runner).map((entry) => entry.path));
  const paths: string[] = [];
  for (const control of ROOT_CONTROL_PATHS) {
    if (existsSync(join(repository, control)) || tracked.has(control)) {
      paths.push(control);
    }
  }
  for (const profile of NATIVE_PROFILES) {
    if (
      existsSync(join(repository, profile.repositoryDirectory)) ||
      [...tracked].some((path) => path.startsWith(`${profile.repositoryDirectory}/`))
    ) {
      paths.push(profile.repositoryDirectory);
    }
  }
  return paths;
}

export function stageManagedRepository(
  repository: string,
  runner: CommandRunner = runCommand,
): void {
  stagePaths(repository, managedStagePaths(repository, runner), runner);
}

function affectedEntries(
  entries: readonly TreeEntry[],
  relativePath: string,
): readonly TreeEntry[] {
  return entries.filter(
    (entry) =>
      entry.relativePath === relativePath || entry.relativePath.startsWith(`${relativePath}/`),
  );
}

function blockingAncestor(
  entries: readonly TreeEntry[],
  relativePath: string,
): TreeEntry | undefined {
  return entries.find((entry) => relativePath.startsWith(`${entry.relativePath}/`));
}

function planProfileApply(
  paths: AppPaths,
  profile: NativeProfile,
  deletedRepositoryPaths: readonly string[],
  environment: NodeJS.ProcessEnv,
  runner: CommandRunner,
): { readonly actions: readonly PlannedAction[]; readonly protectedBindings: number } {
  const repositoryTreeResult = repositoryTree(paths.repositoryDirectory, profile, runner);
  const desiredEntries = repositoryTreeResult.entries.filter((entry) =>
    repositoryTreeResult.trackedRelativePaths.has(entry.relativePath),
  );
  const liveDirectory = liveDirectoryFor(profile, paths, environment);
  const liveScan = walkPortableTree(liveDirectory, profile);
  const liveRoot = managedPathExists(liveDirectory)
    ? liveScan.root
    : resolveManagedRoot(liveDirectory, true);
  const liveEntries = filteredEntries(paths.repositoryDirectory, profile, liveScan.entries, runner);
  const bindings = filteredBindings(paths.repositoryDirectory, profile, liveScan.bindings, runner);
  const desiredMap = entryMap(desiredEntries);
  const desiredLogicalEntries: LogicalProfileEntry[] = desiredEntries.map((entry) => ({
    kind: entry.kind,
    objectId: entry.relativePath,
    path: repositoryPath(profile, entry.relativePath),
  }));
  const desiredTree = buildLogicalProfileTree(profile, desiredLogicalEntries);
  const readDesiredTarget: LinkTargetReader = (logicalEntry) => {
    const entry = desiredMap.get(profileRelativePath(profile, logicalEntry.path));
    if (entry === undefined || entry.kind !== "symlink") {
      throw new AppError("Stored symbolic-link metadata is incomplete.", "APPLY_PLAN_INVALID");
    }
    return entry.linkTarget;
  };
  const deletedPrefix = `${profile.repositoryDirectory}/`;
  const candidateDeleted = deletedRepositoryPaths.filter((path) => path.startsWith(deletedPrefix));
  const ignoredDeleted = ignoredPaths(paths.repositoryDirectory, candidateDeleted, runner);
  const actions: PlannedAction[] = [];
  const protectedBindingPaths = new Set<string>();

  function protectBindings(relativePath: string): boolean {
    const matching = bindings.filter(
      (binding) =>
        relativePath === binding.relativePath ||
        relativePath.startsWith(`${binding.relativePath}/`) ||
        binding.relativePath.startsWith(`${relativePath}/`),
    );
    for (const binding of matching) {
      protectedBindingPaths.add(binding.relativePath);
    }
    return matching.length > 0;
  }

  for (const deletedPath of candidateDeleted) {
    if (ignoredDeleted.has(deletedPath)) {
      continue;
    }
    const relativePath = profileRelativePath(profile, deletedPath);
    if (!isPortablePath(profile, relativePath)) {
      continue;
    }
    if (protectBindings(relativePath)) {
      continue;
    }
    const affected = affectedEntries(liveEntries, relativePath);
    if (affected.length > 0 || managedPathExists(pathInside(liveRoot, relativePath))) {
      actions.push({
        affected,
        liveRoot,
        operation: "delete",
        profile,
        repositoryRoot: repositoryTreeResult.root,
        relativePath,
      });
    }
  }

  const deletionPaths = new Set(
    actions.filter((action) => action.operation === "delete").map((action) => action.relativePath),
  );
  const liveMap = entryMap(liveEntries);
  for (const desired of desiredEntries) {
    if (protectBindings(desired.relativePath)) {
      continue;
    }
    if (desired.kind === "symlink") {
      const target = resolveLogicalTarget(
        repositoryTreeResult.root,
        profile,
        desired.relativePath,
        desired.linkTarget,
        desiredTree,
        readDesiredTarget,
      );
      if (target === undefined) {
        throw new AppError(
          `Stored symbolic link '${profile.name}/${desired.relativePath}' no longer has a reproducible internal target.`,
          "TRACKED_SYMLINK_UNSAFE",
        );
      }
      const targetBinding = bindings.find((binding) =>
        target.paths.some((path) => bindingProtectsPath([binding], path)),
      );
      if (targetBinding !== undefined) {
        throw new AppError(
          `Stored symbolic link '${profile.name}/${desired.relativePath}' resolves through protected local binding '${targetBinding.relativePath}'; live profiles were left unchanged.`,
          "LOCAL_BINDING_TARGET_CONFLICT",
        );
      }
    }
    const current = liveMap.get(desired.relativePath);
    if (
      current !== undefined &&
      treeEntriesEqual(repositoryTreeResult.root, desired, liveRoot, current)
    ) {
      continue;
    }
    const blocker = blockingAncestor(liveEntries, desired.relativePath);
    if (blocker !== undefined && !deletionPaths.has(blocker.relativePath)) {
      throw new AppError(
        `Cannot apply '${profile.name}/${desired.relativePath}' through existing leaf '${blocker.relativePath}'.`,
        "SURFACE_SHAPE_CONFLICT",
      );
    }
    actions.push({
      affected: affectedEntries(liveEntries, desired.relativePath),
      desired,
      liveRoot,
      operation: "copy",
      profile,
      repositoryRoot: repositoryTreeResult.root,
      relativePath: desired.relativePath,
    });
  }
  return { actions, protectedBindings: protectedBindingPaths.size };
}

function backupReferences(actions: readonly PlannedAction[]): readonly BackupReference[] {
  const references: BackupReference[] = [];
  for (const action of actions) {
    const hasExact = action.affected.some((entry) => entry.relativePath === action.relativePath);
    if (!hasExact) {
      references.push({
        liveRoot: action.liveRoot,
        profile: action.profile.name,
        repositoryDirectory: action.profile.repositoryDirectory,
        relativePath: action.relativePath,
      });
    }
    for (const entry of action.affected) {
      references.push({
        currentEntry: entry,
        liveRoot: action.liveRoot,
        profile: action.profile.name,
        repositoryDirectory: action.profile.repositoryDirectory,
        relativePath: entry.relativePath,
      });
    }
  }
  return references;
}

function executeActions(actions: readonly PlannedAction[]): void {
  const deletions = actions
    .filter((action) => action.operation === "delete")
    .sort(
      (left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length,
    );
  for (const action of deletions) {
    removeManagedPath(action.liveRoot, action.relativePath);
  }
  const copies = actions
    .filter((action) => action.operation === "copy")
    .sort(
      (left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length,
    );
  for (const action of copies) {
    const desired = action.desired;
    if (desired === undefined) {
      throw new AppError(
        "Apply plan contains a copy without a source entry.",
        "APPLY_PLAN_INVALID",
      );
    }
    copyManagedEntry(action.repositoryRoot, action.liveRoot, desired);
  }
}

export function applyProfiles(
  paths: AppPaths,
  profiles: readonly NativeProfile[],
  deletedRepositoryPaths: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): ApplyResult {
  validateRepositoryScope(paths.repositoryDirectory, runner);
  const actions: PlannedAction[] = [];
  const protectedByProfile = new Map<string, number>();
  for (const profile of profiles) {
    const plan = planProfileApply(paths, profile, deletedRepositoryPaths, environment, runner);
    actions.push(...plan.actions);
    protectedByProfile.set(profile.name, plan.protectedBindings);
  }
  const backup = createBackup(paths, backupReferences(actions));
  if (backup !== undefined) {
    beginApplyJournal(paths, backup);
  }
  try {
    executeActions(actions);
    if (backup !== undefined) {
      completeApplyJournal(paths);
    }
  } catch (error) {
    if (backup !== undefined) {
      try {
        rollbackBackup(paths, backup, environment);
        completeApplyJournal(paths);
      } catch (rollbackError) {
        throw new AppError(
          `Apply failed and automatic rollback also failed: ${errorMessage(error)}; rollback: ${errorMessage(rollbackError)}`,
          "APPLY_ROLLBACK_FAILED",
        );
      }
    }
    throw new AppError(`Apply failed and was rolled back: ${errorMessage(error)}`, "APPLY_FAILED");
  }
  const results = profiles.map((profile) => ({
    copied: actions.filter(
      (action) => action.profile.name === profile.name && action.operation === "copy",
    ).length,
    deleted: actions.filter(
      (action) => action.profile.name === profile.name && action.operation === "delete",
    ).length,
    name: profile.name,
    protectedBindings: protectedByProfile.get(profile.name) ?? 0,
  }));
  return backup === undefined ? { profiles: results } : { backup, profiles: results };
}
