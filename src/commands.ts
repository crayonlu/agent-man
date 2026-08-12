import { existsSync, lstatSync, rmSync } from "node:fs";
import { hostname } from "node:os";

import {
  BackupRecord,
  listBackups,
  pendingApplyBackupId,
  recoverPendingApply,
  restoreBackup,
} from "./backups.js";
import { AppError, errorCode, errorMessage } from "./errors.js";
import { managedPathExists, resolveManagedRoot } from "./files.js";
import {
  AheadBehind,
  aheadBehind,
  changedPathsBetween,
  checkoutHead,
  commit,
  currentHead,
  deletedPathsBetween,
  ensureGitRepository,
  fetchOrigin,
  finishMerge,
  firstParentOfHead,
  gitVersion,
  hardenRepository,
  hasOrigin,
  hasStagedChanges,
  merge,
  mergeBase,
  mergeInProgress,
  originUrl,
  push,
  repositoryStatus,
  stagePaths,
  trackedPaths,
  unstagePaths,
  unmergedPaths,
  upstreamReference,
  workingTreeChangedPaths,
} from "./git.js";
import { acquireSyncLock, ensurePrivateState } from "./lock.js";
import { AppPaths } from "./paths.js";
import { NATIVE_PROFILES, NativeProfile, findNativeProfile, liveDirectoryFor } from "./profiles.js";
import { CommandRunner, executableAvailable, runCommand } from "./process.js";
import {
  ProfileApplyResult,
  ProfileState,
  activeProfiles,
  applyProfiles,
  captureProfile,
  classifyRepositoryPath,
  profileState,
  seedTemplateFiles,
  stageManagedRepository,
  validateReferenceScope,
  validateRepositoryControls,
  validateRepositoryScope,
} from "./repository.js";
import {
  SkillInstallResult,
  SkillInstallTarget,
  installSkill,
  skillLocationLabel,
  skillStatus,
} from "./skill.js";

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

export interface InitReport {
  readonly appliedProfiles: readonly ProfileApplyResult[];
  readonly createdGithubRepository?: string;
  readonly repositoryDirectory: string;
}

export interface AddReport {
  readonly capturedChanges: number;
  readonly liveDirectory: string;
  readonly profile: string;
}

export interface StatusReport {
  readonly git: {
    readonly aheadBehind?: AheadBehind;
    readonly status: string;
  };
  readonly profiles: readonly ProfileState[];
  readonly repositoryDirectory: string;
  readonly unmanagedProfiles: readonly string[];
}

export interface PlanChange {
  readonly operation: "capture-add" | "capture-delete" | "capture-modify";
  readonly path: string;
  readonly risk: "active" | "configuration";
}

export interface RemotePlanChange {
  readonly operation: "apply-add-or-modify" | "apply-delete";
  readonly path: string;
  readonly profile?: string;
  readonly risk: "active" | "configuration" | "unmanaged";
}

export interface RepositoryPlanChange {
  readonly operation: "commit-change";
  readonly path: string;
  readonly profile?: string;
  readonly risk: "active" | "configuration" | "unmanaged";
}

export interface PlanReport {
  readonly git: StatusReport["git"];
  readonly profiles: readonly {
    readonly bindings: ProfileState["bindings"];
    readonly changes: readonly PlanChange[];
    readonly liveDirectory: string;
    readonly name: string;
  }[];
  readonly repositoryChanges: readonly RepositoryPlanChange[];
  readonly remoteChanges: readonly RemotePlanChange[];
  readonly repositoryDirectory: string;
}

export type DiagnosticLevel = "error" | "ok" | "warning";

export interface Diagnostic {
  readonly code: string;
  readonly level: DiagnosticLevel;
  readonly message: string;
  readonly profile?: string;
}

export interface DoctorReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly ok: boolean;
}

export interface SyncReport {
  readonly backup?: BackupRecord;
  readonly head: string;
  readonly profiles: readonly ProfileApplyResult[];
}

export interface RestoreReport {
  readonly restored: number;
  readonly safetyBackup?: BackupRecord;
}

function runnerFor(context: CommandContext): CommandRunner {
  return context.runner ?? runCommand;
}

function environmentFor(context: CommandContext): NodeJS.ProcessEnv {
  return context.environment ?? process.env;
}

function recoverInterruptedApply(context: CommandContext): void {
  const recovered = recoverPendingApply(context.paths, environmentFor(context));
  if (recovered !== undefined) {
    context.output.info(
      `Recovered unfinished apply transaction from backup ${recovered.id}; continuing from the pre-apply native state.`,
    );
  }
}

function assertNoPendingApply(context: CommandContext): void {
  const backupId = pendingApplyBackupId(context.paths);
  if (backupId !== undefined) {
    throw new AppError(
      `An interrupted apply transaction must be recovered from backup '${backupId}'. Run 'agent-man sync' or 'agent-man restore <backup-id>'.`,
      "APPLY_RECOVERY_REQUIRED",
    );
  }
}

function ensureFreshRepositoryTarget(paths: AppPaths): void {
  if (managedPathExists(paths.repositoryDirectory)) {
    throw new AppError(
      `Configuration repository already exists at ${paths.repositoryDirectory}.`,
      "REPOSITORY_ALREADY_EXISTS",
    );
  }
  ensurePrivateState(paths);
}

export function resolveGithubRepository(
  repository: string,
  runner: CommandRunner = runCommand,
): string {
  let resolved = repository;
  if (!repository.includes("/")) {
    const login = runner("gh", ["api", "user", "--jq", ".login"]).stdout.trim();
    if (login === "") {
      throw new AppError(
        "GitHub CLI did not return the authenticated username.",
        "GITHUB_IDENTITY_MISSING",
      );
    }
    resolved = `${login}/${repository}`;
  }
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u.test(resolved) ||
    resolved.includes("..")
  ) {
    throw new AppError(
      `Invalid GitHub repository name '${resolved}'; expected OWNER/REPO.`,
      "GITHUB_REPOSITORY_INVALID",
    );
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function githubVisibility(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed) && typeof parsed.visibility === "string") {
      return parsed.visibility;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function applyExistingProfiles(context: CommandContext): ProfileApplyResult[] {
  const runner = runnerFor(context);
  const profiles = activeProfiles(context.paths.repositoryDirectory, runner);
  if (profiles.length === 0) {
    validateRepositoryScope(context.paths.repositoryDirectory, runner);
    return [];
  }
  const result = applyProfiles(context.paths, profiles, [], environmentFor(context), runner);
  for (const profile of result.profiles) {
    context.output.info(
      `Applied ${profile.name}: ${profile.copied} copied, ${profile.deleted} deleted, ${profile.protectedBindings} local binding(s) protected.`,
    );
  }
  if (result.backup !== undefined) {
    context.output.info(`Backup: ${result.backup.id}`);
  }
  return [...result.profiles];
}

function initializeFresh(mode: InitMode, context: CommandContext): InitReport {
  const runner = runnerFor(context);
  let createdGithubRepository: string | undefined;

  if (mode.kind === "github") {
    runner("gh", ["auth", "status"]);
    const repository = resolveGithubRepository(mode.repository, runner);
    const template = resolveGithubRepository(mode.template, runner);
    const existing = runner(
      "gh",
      ["repo", "view", repository, "--json", "nameWithOwner,visibility"],
      { acceptedExitCodes: [0, 1] },
    );
    if (existing.status !== 0) {
      runner("gh", [
        "repo",
        "create",
        repository,
        "--private",
        "--template",
        template,
        "--disable-issues",
        "--disable-wiki",
        "--description",
        "Private native agent configuration managed by agent-man",
      ]);
      createdGithubRepository = repository;
      context.output.info(`Created private GitHub repository ${repository}.`);
    } else {
      const visibility = githubVisibility(existing.stdout);
      if (visibility !== "PRIVATE") {
        throw new AppError(
          `Refusing GitHub repository ${repository}: configuration repositories must be private (reported visibility: ${visibility ?? "unknown"}).`,
          "GITHUB_REPOSITORY_NOT_PRIVATE",
        );
      }
      context.output.info(`Using existing private GitHub repository ${repository}.`);
    }
    runner("gh", [
      "repo",
      "clone",
      repository,
      context.paths.repositoryDirectory,
      "--",
      "--no-checkout",
      "--no-recurse-submodules",
      "--config",
      "transfer.fsckObjects=true",
      "--config",
      "fetch.fsckObjects=true",
    ]);
  } else if (mode.kind === "remote") {
    runner("git", [
      "-c",
      "transfer.fsckObjects=true",
      "-c",
      "fetch.fsckObjects=true",
      "clone",
      "--no-checkout",
      "--no-recurse-submodules",
      "--",
      mode.url,
      context.paths.repositoryDirectory,
    ]);
  } else {
    runner("git", ["init", "-b", "main", context.paths.repositoryDirectory]);
  }

  ensureGitRepository(context.paths.repositoryDirectory);
  hardenRepository(context.paths.repositoryDirectory, runner);
  const initialHead = currentHead(context.paths.repositoryDirectory, runner);
  if (mode.kind !== "local" && initialHead !== undefined) {
    validateReferenceScope(context.paths.repositoryDirectory, initialHead, runner);
    checkoutHead(context.paths.repositoryDirectory, runner);
  }
  seedTemplateFiles(context.paths);

  if (mode.kind === "local") {
    validateRepositoryControls(context.paths.repositoryDirectory, runner);
    stageManagedRepository(context.paths.repositoryDirectory, runner);
    validateRepositoryScope(context.paths.repositoryDirectory, runner);
    if (hasStagedChanges(context.paths.repositoryDirectory, runner)) {
      commit(context.paths.repositoryDirectory, "Initialize agent-man configuration", runner);
    }
  }

  const appliedProfiles = applyExistingProfiles(context);
  context.output.info(`Initialized agent-man at ${context.paths.repositoryDirectory}.`);
  const report: InitReport = {
    appliedProfiles,
    repositoryDirectory: context.paths.repositoryDirectory,
  };
  return createdGithubRepository === undefined ? report : { ...report, createdGithubRepository };
}

function initializeLocked(mode: InitMode, context: CommandContext): InitReport {
  ensureFreshRepositoryTarget(context.paths);
  try {
    return initializeFresh(mode, context);
  } catch (error) {
    if (managedPathExists(context.paths.repositoryDirectory)) {
      rmSync(context.paths.repositoryDirectory, { force: true, recursive: true });
    }
    throw error;
  }
}

export function initialize(mode: InitMode, context: CommandContext): InitReport {
  const release = acquireSyncLock(context.paths);
  try {
    recoverInterruptedApply(context);
    return initializeLocked(mode, context);
  } finally {
    release();
  }
}

function addProfileLocked(name: string, context: CommandContext): AddReport {
  const runner = runnerFor(context);
  const environment = environmentFor(context);
  ensureGitRepository(context.paths.repositoryDirectory);
  hardenRepository(context.paths.repositoryDirectory, runner);
  const profile = findNativeProfile(name);
  if (
    activeProfiles(context.paths.repositoryDirectory, runner).some(
      (candidate) => candidate.name === profile.name,
    )
  ) {
    throw new AppError(`Profile '${name}' is already managed.`, "PROFILE_ALREADY_MANAGED");
  }

  const liveDirectory = liveDirectoryFor(profile, context.paths, environment);
  if (!managedPathExists(liveDirectory)) {
    throw new AppError(
      `Profile directory does not exist: ${liveDirectory}`,
      "PROFILE_ROOT_MISSING",
    );
  }
  resolveManagedRoot(liveDirectory);
  const repositoryProfileDirectory = `${context.paths.repositoryDirectory}/${profile.repositoryDirectory}`;
  if (managedPathExists(repositoryProfileDirectory)) {
    throw new AppError(
      `Refusing to overwrite an inactive repository path: ${repositoryProfileDirectory}`,
      "PROFILE_REPOSITORY_PATH_EXISTS",
    );
  }
  let profileStaged = false;
  let changes: ReturnType<typeof captureProfile>;
  try {
    changes = captureProfile(context.paths, profile, environment, runner);
    stagePaths(context.paths.repositoryDirectory, [profile.repositoryDirectory], runner);
    profileStaged = true;
    validateRepositoryScope(context.paths.repositoryDirectory, runner);
  } catch (error) {
    let rollbackError: unknown;
    if (profileStaged) {
      try {
        unstagePaths(context.paths.repositoryDirectory, [profile.repositoryDirectory], runner);
      } catch (candidate) {
        rollbackError = candidate;
      }
    }
    rmSync(repositoryProfileDirectory, { force: true, recursive: true });
    if (rollbackError !== undefined) {
      throw new AppError(
        `Profile add failed (${errorMessage(error)}) and its Git index rollback also failed (${errorMessage(rollbackError)}). Inspect the private repository before retrying.`,
        "PROFILE_ADD_ROLLBACK_FAILED",
      );
    }
    throw error;
  }
  context.output.info(
    `Added ${name} from ${liveDirectory} (${changes.length} change(s) captured).`,
  );
  context.output.info("Run 'agent-man plan', then 'agent-man sync'.");
  return { capturedChanges: changes.length, liveDirectory, profile: name };
}

export function addProfile(name: string, context: CommandContext): AddReport {
  const release = acquireSyncLock(context.paths);
  try {
    recoverInterruptedApply(context);
    return addProfileLocked(name, context);
  } finally {
    release();
  }
}

function buildStatusReport(context: CommandContext): StatusReport {
  assertNoPendingApply(context);
  const runner = runnerFor(context);
  const environment = environmentFor(context);
  ensureGitRepository(context.paths.repositoryDirectory);
  const profiles = activeProfiles(context.paths.repositoryDirectory, runner);
  const states = profiles.map((profile) =>
    profileState(context.paths, profile, environment, runner),
  );
  const activeNames = new Set(profiles.map((profile) => profile.name));
  const gitAheadBehind = aheadBehind(context.paths.repositoryDirectory, runner);
  const git = {
    status: repositoryStatus(context.paths.repositoryDirectory, runner),
  };
  return {
    git: gitAheadBehind === undefined ? git : { ...git, aheadBehind: gitAheadBehind },
    profiles: states,
    repositoryDirectory: context.paths.repositoryDirectory,
    unmanagedProfiles: NATIVE_PROFILES.filter((profile) => !activeNames.has(profile.name)).map(
      (profile) => profile.name,
    ),
  };
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

export function showStatus(context: CommandContext): StatusReport {
  const report = buildStatusReport(context);
  if (report.profiles.length === 0) {
    context.output.info(
      "No profile is managed. Run 'agent-man profiles' and 'agent-man add <profile>'.",
    );
  }
  for (const profile of report.profiles) {
    context.output.info(
      `${profile.name} (${profile.liveDirectory}): ${profile.changes.length === 0 ? "clean" : "changes"}`,
    );
    for (const change of profile.changes) {
      context.output.info(`  ${changeMarker(change.kind)} [${change.risk}] ${change.relativePath}`);
    }
    for (const binding of profile.bindings) {
      context.output.info(`  = [local binding: ${binding.reason}] ${binding.relativePath}`);
    }
  }
  for (const profile of report.unmanagedProfiles) {
    const definition = findNativeProfile(profile);
    context.output.info(
      `${profile} (${liveDirectoryFor(definition, context.paths, environmentFor(context))}): unmanaged`,
    );
  }
  if (report.git.status !== "") {
    context.output.info("Git worktree:");
    for (const line of report.git.status.split("\n")) {
      context.output.info(`  ${line}`);
    }
  }
  if (report.git.aheadBehind !== undefined) {
    context.output.info(
      `Git upstream: ${report.git.aheadBehind.ahead} ahead, ${report.git.aheadBehind.behind} behind (last fetched state).`,
    );
  }
  return report;
}

function planOperation(kind: "added" | "deleted" | "modified"): PlanChange["operation"] {
  if (kind === "added") {
    return "capture-add";
  }
  if (kind === "deleted") {
    return "capture-delete";
  }
  return "capture-modify";
}

function remotePlanChanges(repository: string, runner: CommandRunner): readonly RemotePlanChange[] {
  const head = currentHead(repository, runner);
  const upstream = upstreamReference(repository, runner);
  if (head === undefined || upstream === undefined) {
    return [];
  }
  const base = mergeBase(repository, head, upstream, runner);
  if (base === undefined) {
    throw new AppError(
      "The local and remote configuration histories are unrelated; refusing to preview or merge them.",
      "GIT_HISTORY_UNRELATED",
    );
  }
  const deleted = new Set(deletedPathsBetween(repository, base, upstream, runner));
  return changedPathsBetween(repository, base, upstream, runner).map((path) => {
    const classification = classifyRepositoryPath(path);
    const change: RemotePlanChange = {
      operation: deleted.has(path) ? "apply-delete" : "apply-add-or-modify",
      path,
      risk: classification.risk,
    };
    return classification.profile === undefined
      ? change
      : { ...change, profile: classification.profile };
  });
}

function repositoryPlanChanges(
  repository: string,
  runner: CommandRunner,
): readonly RepositoryPlanChange[] {
  return workingTreeChangedPaths(repository, runner).map((path) => {
    const classification = classifyRepositoryPath(path);
    const change: RepositoryPlanChange = {
      operation: "commit-change",
      path,
      risk: classification.risk,
    };
    return classification.profile === undefined
      ? change
      : { ...change, profile: classification.profile };
  });
}

export function showPlan(context: CommandContext): PlanReport {
  const release = acquireSyncLock(context.paths);
  try {
    const runner = runnerFor(context);
    const repository = context.paths.repositoryDirectory;
    ensureGitRepository(repository);
    assertNoPendingApply(context);
    hardenRepository(repository, runner);
    if (hasOrigin(repository, runner)) {
      fetchOrigin(repository, runner);
      const upstream = upstreamReference(repository, runner);
      if (upstream !== undefined) {
        validateReferenceScope(repository, upstream, runner);
      }
    }
    const status = buildStatusReport(context);
    const report: PlanReport = {
      git: status.git,
      profiles: status.profiles.map((profile) => ({
        bindings: profile.bindings,
        changes: profile.changes.map((change) => ({
          operation: planOperation(change.kind),
          path: change.relativePath,
          risk: change.risk,
        })),
        liveDirectory: profile.liveDirectory,
        name: profile.name,
      })),
      repositoryChanges: repositoryPlanChanges(repository, runner),
      remoteChanges: remotePlanChanges(repository, runner),
      repositoryDirectory: status.repositoryDirectory,
    };
    if (report.profiles.length === 0) {
      context.output.info("Plan is empty: no profile is managed.");
    }
    for (const profile of report.profiles) {
      context.output.info(`${profile.name}: ${profile.changes.length} capture operation(s)`);
      for (const change of profile.changes) {
        context.output.info(`  ${change.operation} [${change.risk}] ${change.path}`);
      }
      for (const binding of profile.bindings) {
        context.output.info(`  protect-local-binding [${binding.reason}] ${binding.relativePath}`);
      }
    }
    context.output.info(
      `Internal repository commit preview: ${report.repositoryChanges.length} path(s)`,
    );
    for (const change of report.repositoryChanges) {
      const profile = change.profile === undefined ? "repository" : change.profile;
      context.output.info(`  ${change.operation} [${change.risk}] ${profile}:${change.path}`);
    }
    context.output.info(`Remote apply preview: ${report.remoteChanges.length} path(s)`);
    for (const change of report.remoteChanges) {
      const profile = change.profile === undefined ? "repository" : change.profile;
      context.output.info(`  ${change.operation} [${change.risk}] ${profile}:${change.path}`);
    }
    if (report.remoteChanges.length > 0) {
      context.output.info(
        "Remote objects were validated before merge and are fully revalidated after merge before any live configuration is changed.",
      );
    }
    return report;
  } finally {
    release();
  }
}

function diagnostic(
  diagnostics: Diagnostic[],
  code: string,
  level: DiagnosticLevel,
  message: string,
  profile?: string,
): void {
  const item: Diagnostic = { code, level, message };
  diagnostics.push(profile === undefined ? item : { ...item, profile });
}

function githubRepositoryFromRemote(url: string): string | undefined {
  const match = url.match(/(?:github\.com[/:])([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/iu);
  const owner = match?.[1];
  const repository = match?.[2];
  return owner === undefined || repository === undefined ? undefined : `${owner}/${repository}`;
}

function diagnoseRemote(
  context: CommandContext,
  diagnostics: Diagnostic[],
  runner: CommandRunner,
  environment: NodeJS.ProcessEnv,
): void {
  const url = originUrl(context.paths.repositoryDirectory, runner);
  if (url === undefined) {
    diagnostic(
      diagnostics,
      "REMOTE_MISSING",
      "warning",
      "No origin remote is configured; synchronization is local only.",
    );
    return;
  }
  const githubRepository = githubRepositoryFromRemote(url);
  if (githubRepository === undefined) {
    diagnostic(
      diagnostics,
      "REMOTE_PRIVACY_UNVERIFIED",
      "warning",
      "The non-GitHub remote's privacy cannot be verified automatically.",
    );
    return;
  }
  if (!executableAvailable("gh", environment)) {
    diagnostic(
      diagnostics,
      "GITHUB_PRIVACY_UNVERIFIED",
      "warning",
      "GitHub CLI is unavailable, so repository privacy could not be verified.",
    );
    return;
  }
  const view = runner("gh", ["repo", "view", githubRepository, "--json", "visibility"], {
    acceptedExitCodes: [0, 1],
    env: environment,
  });
  const visibility = view.status === 0 ? githubVisibility(view.stdout) : undefined;
  if (visibility === "PRIVATE") {
    diagnostic(
      diagnostics,
      "GITHUB_REPOSITORY_PRIVATE",
      "ok",
      "GitHub configuration repository is private.",
    );
  } else {
    diagnostic(
      diagnostics,
      "GITHUB_REPOSITORY_NOT_PRIVATE",
      visibility === undefined ? "warning" : "error",
      `GitHub repository privacy is ${visibility?.toLowerCase() ?? "unverified"}.`,
    );
  }
}

function diagnoseProfile(
  context: CommandContext,
  diagnostics: Diagnostic[],
  profile: NativeProfile,
  runner: CommandRunner,
  environment: NodeJS.ProcessEnv,
): void {
  const liveDirectory = liveDirectoryFor(profile, context.paths, environment);
  if (!managedPathExists(liveDirectory)) {
    diagnostic(
      diagnostics,
      "PROFILE_ROOT_MISSING",
      "error",
      `Managed profile root is missing: ${liveDirectory}`,
      profile.name,
    );
    return;
  }
  try {
    const state = profileState(context.paths, profile, environment, runner);
    diagnostic(
      diagnostics,
      "PROFILE_VALID",
      "ok",
      `${state.managedEntries} portable entries validated (${state.totalBytes} bytes).`,
      profile.name,
    );
    for (const binding of state.bindings) {
      diagnostic(
        diagnostics,
        "LOCAL_BINDING_PROTECTED",
        "warning",
        `Local symbolic-link binding is protected and unsynchronized: ${binding.relativePath} (${binding.reason}).`,
        profile.name,
      );
    }
  } catch (error) {
    diagnostic(diagnostics, errorCode(error), "error", errorMessage(error), profile.name);
    return;
  }
  const verification = profile.verificationCommand;
  if (verification === undefined) {
    return;
  }
  if (!executableAvailable(verification.command, environment)) {
    diagnostic(
      diagnostics,
      "HARNESS_NOT_INSTALLED",
      "warning",
      `${profile.displayName} executable '${verification.command}' is not installed; native verification was skipped.`,
      profile.name,
    );
    return;
  }
  try {
    runner(verification.command, verification.arguments, { env: environment });
    diagnostic(
      diagnostics,
      "HARNESS_VERIFIED",
      "ok",
      `${verification.command} ${verification.arguments.join(" ")} succeeded.`,
      profile.name,
    );
  } catch {
    diagnostic(
      diagnostics,
      "HARNESS_VERIFICATION_FAILED",
      "error",
      `${verification.command} ${verification.arguments.join(" ")} failed; run it directly for harness diagnostics.`,
      profile.name,
    );
  }
}

export function doctor(context: CommandContext): DoctorReport {
  const diagnostics: Diagnostic[] = [];
  const runner = runnerFor(context);
  const environment = environmentFor(context);
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  diagnostic(
    diagnostics,
    "NODE_VERSION",
    Number.isInteger(nodeMajor) && nodeMajor >= 22 ? "ok" : "error",
    `Node.js ${process.versions.node} (22 or newer required).`,
  );
  try {
    diagnostic(diagnostics, "GIT_AVAILABLE", "ok", gitVersion(runner));
  } catch (error) {
    diagnostic(diagnostics, errorCode(error), "error", "Git is unavailable.");
  }

  try {
    const pending = pendingApplyBackupId(context.paths);
    if (pending !== undefined) {
      diagnostic(
        diagnostics,
        "APPLY_RECOVERY_REQUIRED",
        "error",
        `An interrupted apply transaction references backup '${pending}'; run agent-man sync to recover it.`,
      );
    }
  } catch (error) {
    diagnostic(diagnostics, errorCode(error), "error", errorMessage(error));
  }

  if (existsSync(context.paths.stateDirectory)) {
    const stateStat = lstatSync(context.paths.stateDirectory);
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
      diagnostic(
        diagnostics,
        "STATE_DIRECTORY_UNSAFE",
        "error",
        `State path must be a real directory: ${context.paths.stateDirectory}`,
      );
    } else if (process.platform !== "win32" && (stateStat.mode & 0o077) !== 0) {
      diagnostic(
        diagnostics,
        "STATE_PERMISSIONS_OPEN",
        "error",
        `State directory permissions are too open; expected 0700: ${context.paths.stateDirectory}`,
      );
    } else {
      diagnostic(diagnostics, "STATE_DIRECTORY_PRIVATE", "ok", "State directory is private.");
    }
  } else {
    diagnostic(
      diagnostics,
      "STATE_DIRECTORY_MISSING",
      "warning",
      "State directory does not exist yet; run agent-man init.",
    );
  }

  if (!existsSync(context.paths.repositoryDirectory)) {
    diagnostic(
      diagnostics,
      "NOT_INITIALIZED",
      "error",
      "Configuration repository is not initialized.",
    );
  } else {
    try {
      ensureGitRepository(context.paths.repositoryDirectory);
      if (mergeInProgress(context.paths.repositoryDirectory, runner)) {
        diagnostic(
          diagnostics,
          "GIT_MERGE_IN_PROGRESS",
          "error",
          "A Git merge is in progress in the internal repository.",
        );
      }
      validateRepositoryScope(context.paths.repositoryDirectory, runner);
      diagnostic(
        diagnostics,
        "REPOSITORY_VALID",
        "ok",
        "Tracked repository paths and Git modes match built-in profile allowlists.",
      );
      diagnoseRemote(context, diagnostics, runner, environment);
      const profiles = activeProfiles(context.paths.repositoryDirectory, runner);
      if (profiles.length === 0) {
        diagnostic(
          diagnostics,
          "PROFILE_MISSING",
          "warning",
          "No native configuration profile is managed.",
        );
      }
      for (const profile of profiles) {
        diagnoseProfile(context, diagnostics, profile, runner, environment);
      }
    } catch (error) {
      diagnostic(diagnostics, errorCode(error), "error", errorMessage(error));
    }
  }
  for (const item of diagnostics) {
    context.output.info(
      `${item.level.toUpperCase()} ${item.code}${item.profile === undefined ? "" : ` [${item.profile}]`}: ${item.message}`,
    );
  }
  return { diagnostics, ok: !diagnostics.some((item) => item.level === "error") };
}

function conflictError(paths: AppPaths, conflicts: readonly string[]): AppError {
  return new AppError(
    [
      "Git found configuration conflicts; live profile files were left unchanged.",
      ...conflicts.map((path) => `  ${path}`),
      `Resolve them in ${paths.repositoryDirectory}, run 'git add' there, then rerun 'agent-man sync'.`,
    ].join("\n"),
    "GIT_CONFLICT",
  );
}

function profilesForApply(
  repository: string,
  deleted: readonly string[],
  runner: CommandRunner,
): readonly NativeProfile[] {
  const profiles = [...activeProfiles(repository, runner)];
  for (const profile of NATIVE_PROFILES) {
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

function reportApply(context: CommandContext, result: ReturnType<typeof applyProfiles>): void {
  for (const profile of result.profiles) {
    context.output.info(
      `${profile.name}: ${profile.copied} applied, ${profile.deleted} deleted, ${profile.protectedBindings} local binding(s) protected.`,
    );
  }
  if (result.backup !== undefined) {
    context.output.info(`Backup: ${result.backup.id}`);
  }
}

function syncReport(head: string, result: ReturnType<typeof applyProfiles>): SyncReport {
  const report: SyncReport = { head, profiles: result.profiles };
  return result.backup === undefined ? report : { ...report, backup: result.backup };
}

export function sync(context: CommandContext): SyncReport {
  const release = acquireSyncLock(context.paths);
  try {
    const runner = runnerFor(context);
    const environment = environmentFor(context);
    const repository = context.paths.repositoryDirectory;
    ensureGitRepository(repository);
    hardenRepository(repository, runner);
    recoverInterruptedApply(context);

    if (mergeInProgress(repository, runner)) {
      const conflicts = unmergedPaths(repository, runner);
      if (conflicts.length > 0) {
        throw conflictError(context.paths, conflicts);
      }
      validateRepositoryScope(repository, runner);
      finishMerge(repository, runner);
      const head = currentHead(repository, runner);
      if (head === undefined) {
        throw new AppError("Git merge completed without a valid HEAD commit.", "GIT_HEAD_MISSING");
      }
      const deleted = deletedPathsBetween(
        repository,
        firstParentOfHead(repository, runner),
        head,
        runner,
      );
      const result = applyProfiles(
        context.paths,
        profilesForApply(repository, deleted, runner),
        deleted,
        environment,
        runner,
      );
      reportApply(context, result);
      if (hasOrigin(repository, runner)) {
        push(repository, runner);
      }
      context.output.info("Sync complete.");
      return syncReport(head, result);
    }

    const beforeProfiles = activeProfiles(repository, runner);
    if (beforeProfiles.length === 0) {
      throw new AppError(
        "No profile is managed. Run 'agent-man profiles' and 'agent-man add <profile>' first.",
        "PROFILE_MISSING",
      );
    }
    for (const profile of beforeProfiles) {
      captureProfile(context.paths, profile, environment, runner);
    }
    stageManagedRepository(repository, runner);
    validateRepositoryScope(repository, runner);
    if (hasStagedChanges(repository, runner)) {
      commit(repository, `Sync from ${hostname()} at ${new Date().toISOString()}`, runner);
    }
    const localHead = currentHead(repository, runner);

    if (hasOrigin(repository, runner)) {
      fetchOrigin(repository, runner);
      const upstream = upstreamReference(repository, runner);
      if (upstream !== undefined) {
        validateReferenceScope(repository, upstream, runner);
        const conflicts = merge(repository, upstream, runner);
        if (conflicts.length > 0) {
          throw conflictError(context.paths, conflicts);
        }
      }
    }

    validateRepositoryScope(repository, runner);
    const finalHead = currentHead(repository, runner);
    if (finalHead === undefined) {
      throw new AppError(
        "The configuration repository has no commits to apply.",
        "GIT_HEAD_MISSING",
      );
    }
    const deleted = deletedPathsBetween(repository, localHead, finalHead, runner);
    const profiles = [...beforeProfiles];
    for (const profile of profilesForApply(repository, deleted, runner)) {
      if (!profiles.some((candidate) => candidate.name === profile.name)) {
        profiles.push(profile);
      }
    }
    const result = applyProfiles(context.paths, profiles, deleted, environment, runner);
    reportApply(context, result);
    if (hasOrigin(repository, runner)) {
      push(repository, runner);
    }
    context.output.info("Sync complete.");
    return syncReport(finalHead, result);
  } finally {
    release();
  }
}

export function showBackups(context: CommandContext): readonly BackupRecord[] {
  const backups = listBackups(context.paths);
  if (backups.length === 0) {
    context.output.info("No backups.");
  }
  for (const backup of backups) {
    context.output.info(`${backup.id}  ${backup.entries} path(s)  ${backup.createdAt}`);
  }
  return backups;
}

export function restore(id: string, context: CommandContext): RestoreReport {
  const release = acquireSyncLock(context.paths);
  try {
    recoverInterruptedApply(context);
    const result = restoreBackup(context.paths, id, environmentFor(context));
    context.output.info(`Restored ${result.restored} path(s) from ${id}.`);
    if (result.safetyBackup !== undefined) {
      context.output.info(`Pre-restore safety backup: ${result.safetyBackup.id}`);
      return { restored: result.restored, safetyBackup: result.safetyBackup };
    }
    return { restored: result.restored };
  } finally {
    release();
  }
}

export function listProfiles(context: CommandContext): readonly NativeProfile[] {
  for (const profile of NATIVE_PROFILES) {
    const files = profile.portableFiles.map((entry) => entry.relativePath);
    const directories = profile.portableDirectories.map((entry) => `${entry.relativePath}/`);
    context.output.info(`${profile.name}: ${profile.description}`);
    context.output.info(
      `  native root: ${liveDirectoryFor(profile, context.paths, environmentFor(context))}`,
    );
    context.output.info(`  allowlist: ${[...files, ...directories].join(", ")}`);
  }
  return NATIVE_PROFILES;
}

export function showSkillStatus(context: CommandContext): SkillInstallResult {
  const result = skillStatus(context.paths);
  for (const location of result.locations) {
    context.output.info(skillLocationLabel(location));
  }
  return result;
}

export function installBundledSkill(
  target: SkillInstallTarget,
  force: boolean,
  context: CommandContext,
): SkillInstallResult {
  const release = acquireSyncLock(context.paths);
  try {
    const result = installSkill(context.paths, target, force);
    for (const location of result.locations) {
      context.output.info(skillLocationLabel(location));
    }
    return result;
  } finally {
    release();
  }
}
