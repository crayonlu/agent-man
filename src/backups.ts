import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AppError, errorMessage } from "./errors.js";
import {
  MAX_MANAGED_FILE_BYTES,
  MAX_MANAGED_ENTRIES,
  MAX_MANAGED_TOTAL_BYTES,
  MAX_SYMLINK_TARGET_BYTES,
  TreeEntry,
  copyManagedEntry,
  managedPathExists,
  portableSymlinkTargetReason,
  readManagedFile,
  removeManagedPath,
  resolveManagedRoot,
  validatePortablePathSet,
  validatePortableRelativePath,
  walkPortableTree,
  writeBufferAtomic,
} from "./files.js";
import { AppPaths } from "./paths.js";
import {
  EntryRisk,
  findNativeProfile,
  isNativeSecretsPath,
  isPortablePath,
  isStoredSecretsPath,
  liveDirectoryFor,
} from "./profiles.js";
import { nativeSecretEntry } from "./secrets.js";

const BACKUP_VERSION = 1;
const BACKUP_RETENTION = 10;
const APPLY_JOURNAL_VERSION = 1;

export interface BackupReference {
  readonly currentEntry?: TreeEntry;
  readonly liveRoot: string;
  readonly profile: string;
  readonly repositoryDirectory: string;
  readonly relativePath: string;
}

interface BackupManifestEntry {
  readonly existed: boolean;
  readonly kind?: "file" | "symlink";
  readonly linkTarget?: string;
  readonly linkType?: "directory" | "file";
  readonly mode?: number;
  readonly profile: string;
  readonly repositoryDirectory: string;
  readonly relativePath: string;
  readonly risk?: EntryRisk;
  readonly size?: number;
}

interface BackupManifest {
  readonly createdAt: string;
  readonly host: string;
  readonly id: string;
  readonly entries: readonly BackupManifestEntry[];
  readonly version: number;
}

export interface BackupRecord {
  readonly createdAt: string;
  readonly directory: string;
  readonly entries: number;
  readonly id: string;
}

export interface RestoreResult {
  readonly restored: number;
  readonly safetyBackup?: BackupRecord;
}

interface ApplyJournal {
  readonly backupId: string;
  readonly createdAt: string;
  readonly version: number;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AppError(`Backup path must be a real directory: ${path}`, "BACKUP_DIRECTORY_UNSAFE");
  }
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
  }
}

function resolveRealDirectory(path: string): string {
  if (!managedPathExists(path)) {
    throw new AppError(`Backup directory does not exist: ${path}`, "BACKUP_NOT_FOUND");
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AppError(`Backup path must be a real directory: ${path}`, "BACKUP_DIRECTORY_UNSAFE");
  }
  return resolveManagedRoot(path);
}

function readApplyJournal(paths: AppPaths): ApplyJournal | undefined {
  if (!managedPathExists(paths.pendingApplyPath)) {
    return undefined;
  }
  let value: unknown;
  try {
    const stateRoot = resolveRealDirectory(paths.stateDirectory);
    value = JSON.parse(readManagedFile(stateRoot, "pending-apply.json").toString("utf8"));
  } catch (error) {
    throw new AppError(
      `Could not read the pending apply journal: ${errorMessage(error)}`,
      "APPLY_JOURNAL_INVALID",
    );
  }
  if (
    !isRecord(value) ||
    value.version !== APPLY_JOURNAL_VERSION ||
    typeof value.backupId !== "string" ||
    !validBackupId(value.backupId) ||
    typeof value.createdAt !== "string"
  ) {
    throw new AppError("The pending apply journal has an invalid schema.", "APPLY_JOURNAL_INVALID");
  }
  return {
    backupId: value.backupId,
    createdAt: value.createdAt,
    version: APPLY_JOURNAL_VERSION,
  };
}

export function pendingApplyBackupId(paths: AppPaths): string | undefined {
  return readApplyJournal(paths)?.backupId;
}

export function beginApplyJournal(paths: AppPaths, backup: BackupRecord): void {
  ensurePrivateDirectory(paths.stateDirectory);
  const existing = readApplyJournal(paths);
  if (existing !== undefined) {
    throw new AppError(
      `An unfinished apply transaction already references backup '${existing.backupId}'.`,
      "APPLY_RECOVERY_REQUIRED",
    );
  }
  const journal: ApplyJournal = {
    backupId: backup.id,
    createdAt: new Date().toISOString(),
    version: APPLY_JOURNAL_VERSION,
  };
  writeBufferAtomic(
    paths.stateDirectory,
    "pending-apply.json",
    `${JSON.stringify(journal, null, 2)}\n`,
    0o600,
  );
}

export function completeApplyJournal(paths: AppPaths): void {
  if (!managedPathExists(paths.stateDirectory)) {
    return;
  }
  removeManagedPath(resolveManagedRoot(paths.stateDirectory), "pending-apply.json");
}

export function recoverPendingApply(
  paths: AppPaths,
  environment: NodeJS.ProcessEnv = process.env,
): BackupRecord | undefined {
  const journal = readApplyJournal(paths);
  if (journal === undefined) {
    return undefined;
  }
  const backup = loadBackup(paths, journal.backupId);
  rollbackBackup(paths, backup.record, environment);
  completeApplyJournal(paths);
  return backup.record;
}

function backupId(createdAt: string): string {
  return `${createdAt.replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID().slice(0, 8)}`;
}

function entryFromManifest(entry: BackupManifestEntry): TreeEntry | undefined {
  if (!entry.existed) {
    return undefined;
  }
  if (
    entry.kind === "file" &&
    entry.mode !== undefined &&
    entry.risk !== undefined &&
    entry.size !== undefined
  ) {
    return {
      kind: "file",
      mode: entry.mode,
      relativePath: entry.relativePath,
      risk: entry.risk,
      size: entry.size,
    };
  }
  if (
    entry.kind === "symlink" &&
    entry.linkTarget !== undefined &&
    entry.linkType !== undefined &&
    entry.mode !== undefined &&
    entry.risk !== undefined &&
    entry.size !== undefined
  ) {
    return {
      kind: "symlink",
      linkTarget: entry.linkTarget,
      linkType: entry.linkType,
      mode: entry.mode,
      relativePath: entry.relativePath,
      risk: entry.risk,
      size: entry.size,
    };
  }
  throw new AppError(
    `Backup entry '${entry.profile}/${entry.relativePath}' is incomplete.`,
    "BACKUP_INVALID",
  );
}

function manifestEntry(reference: BackupReference): BackupManifestEntry {
  const entry = reference.currentEntry;
  if (entry === undefined) {
    return {
      existed: false,
      profile: reference.profile,
      repositoryDirectory: reference.repositoryDirectory,
      relativePath: reference.relativePath,
    };
  }
  if (entry.kind === "file") {
    return {
      existed: true,
      kind: entry.kind,
      mode: entry.mode,
      profile: reference.profile,
      repositoryDirectory: reference.repositoryDirectory,
      relativePath: reference.relativePath,
      risk: entry.risk,
      size: entry.size,
    };
  }
  return {
    existed: true,
    kind: entry.kind,
    linkTarget: entry.linkTarget,
    linkType: entry.linkType,
    mode: entry.mode,
    profile: reference.profile,
    repositoryDirectory: reference.repositoryDirectory,
    relativePath: reference.relativePath,
    risk: entry.risk,
    size: entry.size,
  };
}

function uniqueReferences(references: readonly BackupReference[]): readonly BackupReference[] {
  const unique = new Map<string, BackupReference>();
  for (const reference of references) {
    const key = `${reference.profile}\0${reference.relativePath}`;
    const previous = unique.get(key);
    if (previous === undefined || previous.currentEntry === undefined) {
      unique.set(key, reference);
    }
  }
  return [...unique.values()].sort((left, right) => {
    const profileOrder = left.profile.localeCompare(right.profile);
    return profileOrder === 0 ? left.relativePath.localeCompare(right.relativePath) : profileOrder;
  });
}

function pruneBackups(paths: AppPaths, preserveIds: readonly string[] = []): void {
  const records = listBackups(paths);
  const available = new Set(records.map((record) => record.id));
  const preserved = new Set(preserveIds.filter((id) => available.has(id)));
  let retained = 0;
  for (const record of records) {
    if (preserved.has(record.id)) {
      continue;
    }
    retained += 1;
    if (retained <= BACKUP_RETENTION - preserved.size) {
      continue;
    }
    rmSync(record.directory, { force: true, recursive: true });
  }
}

export function createBackup(
  paths: AppPaths,
  references: readonly BackupReference[],
  preserveIds: readonly string[] = [],
): BackupRecord | undefined {
  const selected = uniqueReferences(references);
  if (selected.length === 0) {
    return undefined;
  }
  ensurePrivateDirectory(paths.backupDirectory);
  const createdAt = new Date().toISOString();
  const id = backupId(createdAt);
  const pending = join(paths.backupDirectory, `.pending-${id}`);
  const finalDirectory = join(paths.backupDirectory, id);
  ensurePrivateDirectory(pending);

  try {
    for (const reference of selected) {
      const entry = reference.currentEntry;
      if (entry === undefined) {
        continue;
      }
      const dataRoot = resolveManagedRoot(
        join(pending, "data", reference.repositoryDirectory),
        true,
      );
      copyManagedEntry(reference.liveRoot, dataRoot, entry);
    }
    const manifest: BackupManifest = {
      createdAt,
      entries: selected.map(manifestEntry),
      host: hostname(),
      id,
      version: BACKUP_VERSION,
    };
    writeBufferAtomic(pending, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    renameSync(pending, finalDirectory);
  } catch (error) {
    rmSync(pending, { force: true, recursive: true });
    throw new AppError(`Could not create backup: ${errorMessage(error)}`, "BACKUP_CREATE_FAILED");
  }
  const record = { createdAt, directory: finalDirectory, entries: selected.length, id };
  pruneBackups(paths, [...preserveIds, id]);
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseManifestEntry(value: unknown): BackupManifestEntry {
  if (!isRecord(value)) {
    throw new AppError("Backup manifest contains a non-object entry.", "BACKUP_INVALID");
  }
  const existed = value.existed;
  const profile = value.profile;
  const repositoryDirectory = value.repositoryDirectory;
  const relativePath = value.relativePath;
  if (
    typeof existed !== "boolean" ||
    typeof profile !== "string" ||
    typeof repositoryDirectory !== "string" ||
    typeof relativePath !== "string"
  ) {
    throw new AppError("Backup manifest entry is missing required fields.", "BACKUP_INVALID");
  }
  if (!existed) {
    return { existed, profile, repositoryDirectory, relativePath };
  }
  const kind = value.kind;
  const mode = value.mode;
  const risk = value.risk;
  const size = value.size;
  if (
    (kind !== "file" && kind !== "symlink") ||
    typeof mode !== "number" ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 0o777 ||
    (risk !== "active" && risk !== "configuration") ||
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > MAX_MANAGED_FILE_BYTES
  ) {
    throw new AppError("Backup manifest entry has invalid file metadata.", "BACKUP_INVALID");
  }
  if (kind === "file") {
    return { existed, kind, mode, profile, repositoryDirectory, relativePath, risk, size };
  }
  const linkTarget = value.linkTarget;
  const linkType = value.linkType;
  if (typeof linkTarget !== "string" || (linkType !== "directory" && linkType !== "file")) {
    throw new AppError("Backup manifest symlink metadata is invalid.", "BACKUP_INVALID");
  }
  return {
    existed,
    kind,
    linkTarget,
    linkType,
    mode,
    profile,
    repositoryDirectory,
    relativePath,
    risk,
    size,
  };
}

function readManifest(directory: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(
      readManagedFile(resolveRealDirectory(directory), "manifest.json").toString("utf8"),
    );
  } catch (error) {
    throw new AppError(`Could not read backup manifest: ${errorMessage(error)}`, "BACKUP_INVALID");
  }
  if (!isRecord(value)) {
    throw new AppError("Backup manifest is not an object.", "BACKUP_INVALID");
  }
  const version = value.version;
  const id = value.id;
  const createdAt = value.createdAt;
  const host = value.host;
  const entries = value.entries;
  if (
    version !== BACKUP_VERSION ||
    typeof id !== "string" ||
    typeof createdAt !== "string" ||
    typeof host !== "string" ||
    !Array.isArray(entries)
  ) {
    throw new AppError("Backup manifest has an unsupported schema.", "BACKUP_INVALID");
  }
  const manifest = { createdAt, entries: entries.map(parseManifestEntry), host, id, version };
  if (
    !validBackupId(id) ||
    host === "" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    manifest.entries.length > MAX_MANAGED_ENTRIES
  ) {
    throw new AppError("Backup manifest metadata is invalid.", "BACKUP_INVALID");
  }
  const keys = new Set<string>();
  const portableKeys: string[] = [];
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    validateManifestEntry(entry);
    const key = `${entry.profile}/${entry.relativePath}`;
    if (keys.has(key)) {
      throw new AppError(`Backup manifest repeats '${key}'.`, "BACKUP_INVALID");
    }
    keys.add(key);
    portableKeys.push(`${entry.repositoryDirectory}/${entry.relativePath}`);
    if (entry.existed && entry.size !== undefined) {
      totalBytes += entry.size;
    }
    if (
      entry.kind === "symlink" &&
      (entry.linkTarget === undefined ||
        entry.size !== Buffer.byteLength(entry.linkTarget) ||
        entry.size > MAX_SYMLINK_TARGET_BYTES)
    ) {
      throw new AppError(
        `Backup symbolic link '${key}' has invalid size metadata.`,
        "BACKUP_INVALID",
      );
    }
  }
  validatePortablePathSet(portableKeys);
  if (totalBytes > MAX_MANAGED_TOTAL_BYTES) {
    throw new AppError("Backup manifest exceeds the managed size limit.", "BACKUP_INVALID");
  }
  return manifest;
}

function validBackupId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) && !id.includes("..");
}

function loadBackup(
  paths: AppPaths,
  id: string,
): { directory: string; manifest: BackupManifest; record: BackupRecord } {
  if (!validBackupId(id)) {
    throw new AppError(`Invalid backup id '${id}'.`, "BACKUP_ID_INVALID");
  }
  const directory = join(paths.backupDirectory, id);
  resolveRealDirectory(directory);
  const manifest = readManifest(directory);
  if (manifest.id !== id) {
    throw new AppError(`Backup '${id}' has a mismatched manifest id.`, "BACKUP_INVALID");
  }
  return {
    directory,
    manifest,
    record: {
      createdAt: manifest.createdAt,
      directory,
      entries: manifest.entries.length,
      id: manifest.id,
    },
  };
}

function validateManifestEntry(entry: BackupManifestEntry): void {
  const profile = findNativeProfile(entry.profile);
  if (entry.repositoryDirectory !== profile.repositoryDirectory) {
    throw new AppError(
      `Backup entry '${entry.profile}/${entry.relativePath}' has an invalid repository directory.`,
      "BACKUP_INVALID",
    );
  }
  validatePortableRelativePath(entry.relativePath);
  if (
    (!isPortablePath(profile, entry.relativePath) &&
      !isNativeSecretsPath(profile, entry.relativePath)) ||
    isStoredSecretsPath(profile, entry.relativePath)
  ) {
    throw new AppError(
      `Backup entry '${entry.profile}/${entry.relativePath}' is outside the current profile allowlist.`,
      "BACKUP_INVALID",
    );
  }
}

export function listBackups(paths: AppPaths): readonly BackupRecord[] {
  if (!managedPathExists(paths.backupDirectory)) {
    return [];
  }
  resolveRealDirectory(paths.backupDirectory);
  const records: BackupRecord[] = [];
  for (const child of readdirSync(paths.backupDirectory, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name.startsWith(".pending-") || !validBackupId(child.name)) {
      continue;
    }
    const directory = join(paths.backupDirectory, child.name);
    try {
      const manifest = readManifest(directory);
      if (!validBackupId(manifest.id) || manifest.id !== child.name) {
        continue;
      }
      records.push({
        createdAt: manifest.createdAt,
        directory,
        entries: manifest.entries.length,
        id: manifest.id,
      });
    } catch {
      // Invalid backups remain on disk for manual recovery but are not offered for automatic restore.
    }
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function applyManifest(
  paths: AppPaths,
  directory: string,
  manifest: BackupManifest,
  environment: NodeJS.ProcessEnv,
): number {
  const roots = new Map<string, string>();
  function liveRoot(profileName: string): string {
    const cached = roots.get(profileName);
    if (cached !== undefined) {
      return cached;
    }
    const profile = findNativeProfile(profileName);
    const root = resolveManagedRoot(liveDirectoryFor(profile, paths, environment), true);
    roots.set(profileName, root);
    return root;
  }

  const shallowFirst = [...manifest.entries].sort(
    (left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length,
  );
  for (const entry of shallowFirst) {
    validateManifestEntry(entry);
    if (entry.kind === "symlink" && entry.linkTarget !== undefined) {
      const profile = findNativeProfile(entry.profile);
      const reason = portableSymlinkTargetReason(
        liveRoot(entry.profile),
        profile,
        entry.relativePath,
        entry.linkTarget,
      );
      if (reason !== undefined) {
        throw new AppError(
          `Backup symbolic link '${entry.profile}/${entry.relativePath}' is ${reason}.`,
          "BACKUP_INVALID",
        );
      }
    }
    removeManagedPath(liveRoot(entry.profile), entry.relativePath);
  }
  let restored = 0;
  const existing = manifest.entries.filter((entry) => entry.existed);
  for (const manifestItem of existing) {
    validateManifestEntry(manifestItem);
    const entry = entryFromManifest(manifestItem);
    if (entry === undefined) {
      continue;
    }
    const sourceRoot = resolveRealDirectory(
      join(directory, "data", manifestItem.repositoryDirectory),
    );
    copyManagedEntry(sourceRoot, liveRoot(manifestItem.profile), entry);
    restored += 1;
  }
  const verifiedProfiles = new Map<string, ReturnType<typeof walkPortableTree>>();
  for (const manifestItem of existing) {
    if (manifestItem.kind !== "symlink") {
      continue;
    }
    let scan = verifiedProfiles.get(manifestItem.profile);
    if (scan === undefined) {
      const profile = findNativeProfile(manifestItem.profile);
      scan = walkPortableTree(liveDirectoryFor(profile, paths, environment), profile);
      verifiedProfiles.set(manifestItem.profile, scan);
    }
    const restoredLink = scan.entries.find(
      (entry) => entry.relativePath === manifestItem.relativePath,
    );
    if (
      restoredLink === undefined ||
      restoredLink.kind !== "symlink" ||
      restoredLink.linkTarget !== manifestItem.linkTarget ||
      restoredLink.linkType !== manifestItem.linkType
    ) {
      throw new AppError(
        `Restored symbolic link '${manifestItem.profile}/${manifestItem.relativePath}' does not resolve through its original internal target chain.`,
        "BACKUP_INVALID",
      );
    }
  }
  return restored;
}

export function rollbackBackup(
  paths: AppPaths,
  backup: BackupRecord,
  environment: NodeJS.ProcessEnv,
): void {
  const loaded = loadBackup(paths, backup.id);
  applyManifest(paths, loaded.directory, loaded.manifest, environment);
}

function currentReferencesForRestore(
  paths: AppPaths,
  manifest: BackupManifest,
  environment: NodeJS.ProcessEnv,
): readonly BackupReference[] {
  const references: BackupReference[] = [];
  const scans = new Map<string, ReturnType<typeof walkPortableTree>>();
  for (const desired of manifest.entries) {
    const profile = findNativeProfile(desired.profile);
    let scan = scans.get(profile.name);
    if (scan === undefined) {
      scan = walkPortableTree(liveDirectoryFor(profile, paths, environment), profile);
      scans.set(profile.name, scan);
    }
    validateManifestEntry(desired);
    if (
      scan.bindings.some(
        (binding) =>
          desired.relativePath === binding.relativePath ||
          desired.relativePath.startsWith(`${binding.relativePath}/`) ||
          binding.relativePath.startsWith(`${desired.relativePath}/`),
      )
    ) {
      throw new AppError(
        `Backup restore would overwrite local symbolic-link binding '${profile.name}/${desired.relativePath}'.`,
        "LOCAL_BINDING_PROTECTED",
      );
    }
    const secretEntry = isNativeSecretsPath(profile, desired.relativePath)
      ? nativeSecretEntry(scan.root, profile)
      : undefined;
    const affected =
      secretEntry === undefined
        ? scan.entries.filter(
            (entry) =>
              entry.relativePath === desired.relativePath ||
              entry.relativePath.startsWith(`${desired.relativePath}/`),
          )
        : [secretEntry];
    const exact = affected.some((entry) => entry.relativePath === desired.relativePath);
    if (!exact) {
      references.push({
        liveRoot: scan.root,
        profile: profile.name,
        repositoryDirectory: profile.repositoryDirectory,
        relativePath: desired.relativePath,
      });
    }
    for (const entry of affected) {
      references.push({
        currentEntry: entry,
        liveRoot: scan.root,
        profile: profile.name,
        repositoryDirectory: profile.repositoryDirectory,
        relativePath: entry.relativePath,
      });
    }
  }
  return references;
}

export function restoreBackup(
  paths: AppPaths,
  id: string,
  environment: NodeJS.ProcessEnv = process.env,
): RestoreResult {
  const loaded = loadBackup(paths, id);
  const current = currentReferencesForRestore(paths, loaded.manifest, environment);
  const safetyBackup = createBackup(paths, current, [id]);
  if (safetyBackup !== undefined) {
    beginApplyJournal(paths, safetyBackup);
  }
  try {
    const restored = applyManifest(paths, loaded.directory, loaded.manifest, environment);
    if (safetyBackup !== undefined) {
      completeApplyJournal(paths);
    }
    pruneBackups(paths);
    return safetyBackup === undefined ? { restored } : { restored, safetyBackup };
  } catch (error) {
    if (safetyBackup !== undefined) {
      try {
        rollbackBackup(paths, safetyBackup, environment);
        completeApplyJournal(paths);
      } catch (rollbackError) {
        throw new AppError(
          `Restore failed and automatic rollback also failed: ${errorMessage(error)}; rollback: ${errorMessage(rollbackError)}`,
          "RESTORE_ROLLBACK_FAILED",
        );
      }
    }
    pruneBackups(paths);
    throw new AppError(`Restore failed: ${errorMessage(error)}`, "RESTORE_FAILED");
  }
}
