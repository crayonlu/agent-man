import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { AppError, errorMessage } from "./errors.js";
import {
  EntryRisk,
  NativeProfile,
  isPortableFile,
  isPortablePath,
  riskForPath,
} from "./profiles.js";

export const MAX_MANAGED_DEPTH = 32;
export const MAX_MANAGED_ENTRIES = 10_000;
export const MAX_MANAGED_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_MANAGED_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_PORTABLE_PATH_BYTES = 4096;
export const MAX_PORTABLE_SEGMENT_BYTES = 255;
export const MAX_SYMLINK_TARGET_BYTES = 4096;

export interface FileTreeEntry {
  readonly kind: "file";
  readonly mode: number;
  readonly relativePath: string;
  readonly risk: EntryRisk;
  readonly size: number;
}

export interface SymlinkTreeEntry {
  readonly kind: "symlink";
  readonly linkTarget: string;
  readonly linkType: "directory" | "file";
  readonly mode: number;
  readonly relativePath: string;
  readonly risk: EntryRisk;
  readonly size: number;
}

export type TreeEntry = FileTreeEntry | SymlinkTreeEntry;

export type LinkBindingReason = "absolute" | "broken" | "external" | "unportable";

export interface LinkBinding {
  readonly reason: LinkBindingReason;
  readonly relativePath: string;
}

export interface TreeScan {
  readonly bindings: readonly LinkBinding[];
  readonly entries: readonly TreeEntry[];
  readonly root: string;
  readonly totalBytes: number;
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function managedPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizedFileSystemRelativePath(path: string): string {
  return path.split(sep).join("/");
}

export function readNativeSymlinkTarget(path: string): string {
  const target = readlinkSync(path);
  return process.platform === "win32" && !isAbsolute(target)
    ? target.replaceAll("\\", "/")
    : target;
}

export function validatePortableRelativePath(relativePath: string): void {
  if (relativePath === "" || isAbsolute(relativePath) || relativePath.startsWith("/")) {
    throw new AppError(
      `Expected a portable relative path, received '${relativePath}'.`,
      "PATH_UNSAFE",
    );
  }
  const normalizedPath = relativePath.replaceAll("\\", "/");
  if (Buffer.byteLength(normalizedPath) > MAX_PORTABLE_PATH_BYTES) {
    throw new AppError(
      `Path '${relativePath}' exceeds the portable path limit of ${MAX_PORTABLE_PATH_BYTES} bytes.`,
      "PATH_TOO_LONG",
    );
  }
  const segments = normalizedPath.split("/");
  if (segments.length > MAX_MANAGED_DEPTH) {
    throw new AppError(
      `Path '${relativePath}' exceeds the maximum depth of ${MAX_MANAGED_DEPTH}.`,
      "PATH_TOO_DEEP",
    );
  }
  for (const segment of segments) {
    if (Buffer.byteLength(segment) > MAX_PORTABLE_SEGMENT_BYTES) {
      throw new AppError(
        `Path '${relativePath}' contains a segment longer than ${MAX_PORTABLE_SEGMENT_BYTES} bytes.`,
        "PATH_TOO_LONG",
      );
    }
    if (segment === "" || segment === "." || segment === "..") {
      throw new AppError(`Path '${relativePath}' contains an unsafe segment.`, "PATH_UNSAFE");
    }
    const hasControlCharacter = /[\p{Cc}\p{Cf}]/u.test(segment);
    if (
      hasControlCharacter ||
      segment.includes("�") ||
      /[<>:"/\\|?*]/u.test(segment) ||
      /[. ]$/u.test(segment)
    ) {
      throw new AppError(
        `Path '${relativePath}' is not portable across supported operating systems.`,
        "PATH_NOT_PORTABLE",
      );
    }
    const stem = segment.split(".")[0]?.toUpperCase();
    if (segment.toLowerCase() === ".git") {
      throw new AppError(
        `Path '${relativePath}' contains Git repository metadata.`,
        "PATH_NOT_PORTABLE",
      );
    }
    if (
      stem === "CON" ||
      stem === "CONIN$" ||
      stem === "CONOUT$" ||
      stem === "PRN" ||
      stem === "AUX" ||
      stem === "NUL" ||
      (stem !== undefined && /^(?:COM|LPT)(?:[1-9¹²³])$/u.test(stem))
    ) {
      throw new AppError(
        `Path '${relativePath}' uses a name reserved by Windows.`,
        "PATH_NOT_PORTABLE",
      );
    }
  }
}

export function validatePortablePathSet(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const relativePath of paths) {
    validatePortableRelativePath(relativePath);
    const segments = relativePath.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = segments.slice(0, length).join("/");
      const key = prefix.normalize("NFC").toLowerCase();
      const previous = seen.get(key);
      if (previous !== undefined && previous !== prefix) {
        throw new AppError(
          `Paths '${previous}' and '${prefix}' collide on a case-insensitive or Unicode-normalizing filesystem.`,
          "PATH_COLLISION",
        );
      }
      seen.set(key, prefix);
    }
  }
}

export function pathInside(root: string, relativePath: string): string {
  validatePortableRelativePath(relativePath);
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, ...relativePath.replaceAll("\\", "/").split("/"));
  if (!absolutePathInside(normalizedRoot, target)) {
    throw new AppError(`Path '${relativePath}' escapes managed root '${root}'.`, "PATH_ESCAPE");
  }
  return target;
}

function absolutePathInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

export function resolveManagedRoot(root: string, create = false): string {
  if (!managedPathExists(root)) {
    if (!create) {
      return resolve(root);
    }
    mkdirSync(root, { mode: 0o700, recursive: true });
  }
  let physicalRoot: string;
  try {
    physicalRoot = realpathSync.native(root);
  } catch (error) {
    throw new AppError(
      `Managed root '${root}' cannot be resolved: ${errorMessage(error)}`,
      "ROOT_UNRESOLVABLE",
    );
  }
  if (!statSync(physicalRoot).isDirectory()) {
    throw new AppError(`Managed root is not a directory: ${root}`, "ROOT_NOT_DIRECTORY");
  }
  return physicalRoot;
}

export function assertNoSymlinkAncestors(root: string, relativePath: string): void {
  validatePortableRelativePath(relativePath);
  const segments = relativePath.split("/");
  let current = resolve(root);
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (!managedPathExists(current)) {
      return;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new AppError(
        `Refusing to traverse symbolic-link ancestor '${normalizedFileSystemRelativePath(relative(root, current))}'.`,
        "SYMLINK_ANCESTOR",
      );
    }
    if (!stat.isDirectory()) {
      throw new AppError(
        `Managed path ancestor is not a directory: ${normalizedFileSystemRelativePath(relative(root, current))}`,
        "PATH_ANCESTOR_NOT_DIRECTORY",
      );
    }
  }
}

function ensureParentDirectories(root: string, relativePath: string): void {
  assertNoSymlinkAncestors(root, relativePath);
  const segments = relativePath.split("/");
  let current = resolve(root);
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (!managedPathExists(current)) {
      mkdirSync(current, { mode: 0o700 });
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AppError(
        `Refusing unsafe managed path ancestor '${normalizedFileSystemRelativePath(relative(root, current))}'.`,
        "SYMLINK_ANCESTOR",
      );
    }
  }
}

interface ResolvedTarget {
  readonly kind: "directory" | "file";
}

function resolveInternalTarget(
  root: string,
  profile: NativeProfile,
  initialTarget: string,
): ResolvedTarget | undefined {
  let target = initialTarget;
  for (let hop = 0; hop < MAX_MANAGED_DEPTH; hop += 1) {
    if (!absolutePathInside(root, target)) {
      return undefined;
    }
    const targetFromRoot = relative(root, target);
    const portableTarget = normalizedFileSystemRelativePath(targetFromRoot);
    if (portableTarget === "" || !isPortablePath(profile, portableTarget)) {
      return undefined;
    }
    const segments = targetFromRoot === "" ? [] : targetFromRoot.split(sep);
    let current = root;
    let redirected = false;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        continue;
      }
      current = join(current, segment);
      if (!managedPathExists(current)) {
        return undefined;
      }
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const linkTarget = readNativeSymlinkTarget(current);
        const currentRelativePath = normalizedFileSystemRelativePath(relative(root, current));
        if (
          portableSymlinkTargetReason(root, profile, currentRelativePath, linkTarget) !== undefined
        ) {
          return undefined;
        }
        const remainder = segments.slice(index + 1);
        target = resolve(dirname(current), linkTarget, ...remainder);
        redirected = true;
        break;
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        return undefined;
      }
    }
    if (!redirected) {
      const finalStat = lstatSync(target);
      if (finalStat.isDirectory()) {
        return { kind: "directory" };
      }
      if (finalStat.isFile()) {
        return { kind: "file" };
      }
      return undefined;
    }
  }
  return undefined;
}

type ClassifiedLink = { readonly binding: LinkBinding } | { readonly entry: SymlinkTreeEntry };

export function portableSymlinkTargetReason(
  root: string,
  profile: NativeProfile,
  relativePath: string,
  linkTarget: string,
): LinkBindingReason | undefined {
  if (linkTarget === "") {
    return "broken";
  }
  if (isAbsolute(linkTarget)) {
    return "absolute";
  }
  if (linkTarget.includes("\\")) {
    return "unportable";
  }
  const linkPath = pathInside(root, relativePath);
  const lexicalTarget = resolve(dirname(linkPath), linkTarget);
  if (!absolutePathInside(root, lexicalTarget)) {
    return "external";
  }
  const targetRelativePath = normalizedFileSystemRelativePath(relative(root, lexicalTarget));
  if (targetRelativePath === "" || !isPortablePath(profile, targetRelativePath)) {
    return "unportable";
  }
  return undefined;
}

export function classifyPortableSymlink(
  root: string,
  profile: NativeProfile,
  relativePath: string,
  linkTarget: string,
): ClassifiedLink {
  const risk = riskForPath(profile, relativePath);
  if (risk === undefined) {
    return { binding: { reason: "unportable", relativePath } };
  }
  const lexicalReason = portableSymlinkTargetReason(root, profile, relativePath, linkTarget);
  if (lexicalReason !== undefined) {
    return { binding: { reason: lexicalReason, relativePath } };
  }
  const linkPath = pathInside(root, relativePath);
  const lexicalTarget = resolve(dirname(linkPath), linkTarget);
  const resolved = resolveInternalTarget(root, profile, lexicalTarget);
  if (resolved === undefined) {
    return { binding: { reason: "broken", relativePath } };
  }
  return {
    entry: {
      kind: "symlink",
      linkTarget,
      linkType: resolved.kind,
      mode: 0o777,
      relativePath,
      risk,
      size: Buffer.byteLength(linkTarget),
    },
  };
}

function pushEntry(
  entries: TreeEntry[],
  entry: TreeEntry,
  totals: { count: number; size: number },
): void {
  totals.count += 1;
  totals.size += entry.size;
  if (totals.count > MAX_MANAGED_ENTRIES) {
    throw new AppError(
      `Managed surface exceeds ${MAX_MANAGED_ENTRIES} entries.`,
      "SURFACE_TOO_MANY_ENTRIES",
    );
  }
  if (entry.size > MAX_MANAGED_FILE_BYTES) {
    throw new AppError(
      `Managed file '${entry.relativePath}' exceeds ${MAX_MANAGED_FILE_BYTES} bytes.`,
      "FILE_TOO_LARGE",
    );
  }
  if (entry.kind === "symlink" && entry.size > MAX_SYMLINK_TARGET_BYTES) {
    throw new AppError(
      `Symbolic link '${entry.relativePath}' exceeds ${MAX_SYMLINK_TARGET_BYTES} target bytes.`,
      "SYMLINK_TARGET_TOO_LONG",
    );
  }
  if (totals.size > MAX_MANAGED_TOTAL_BYTES) {
    throw new AppError(
      `Managed surface exceeds ${MAX_MANAGED_TOTAL_BYTES} bytes.`,
      "SURFACE_TOO_LARGE",
    );
  }
  entries.push(entry);
}

export function walkPortableTree(root: string, profile: NativeProfile): TreeScan {
  if (!managedPathExists(root)) {
    return { bindings: [], entries: [], root: resolve(root), totalBytes: 0 };
  }
  const physicalRoot = resolveManagedRoot(root);
  const bindings: LinkBinding[] = [];
  const entries: TreeEntry[] = [];
  const totals = { count: 0, size: 0 };

  function visit(relativePath: string, expectedDirectory: boolean): void {
    validatePortableRelativePath(relativePath);
    if (relativePath.split("/").at(-1)?.toLowerCase() === ".gitattributes") {
      throw new AppError(
        `Nested Git attributes file '${relativePath}' is outside the configuration surface.`,
        "GIT_ATTRIBUTES_UNSAFE",
      );
    }
    const absolutePath = pathInside(physicalRoot, relativePath);
    if (!managedPathExists(absolutePath)) {
      return;
    }
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      const classified = classifyPortableSymlink(
        physicalRoot,
        profile,
        relativePath,
        readNativeSymlinkTarget(absolutePath),
      );
      if ("binding" in classified) {
        bindings.push(classified.binding);
      } else {
        pushEntry(entries, classified.entry, totals);
      }
      return;
    }
    if (stat.isFile()) {
      if (expectedDirectory) {
        throw new AppError(
          `Portable directory '${relativePath}' is a regular file.`,
          "SURFACE_TYPE_MISMATCH",
        );
      }
      const risk = riskForPath(profile, relativePath);
      if (risk === undefined) {
        throw new AppError(
          `Path '${relativePath}' is outside the profile allowlist.`,
          "PATH_UNMANAGED",
        );
      }
      pushEntry(
        entries,
        { kind: "file", mode: stat.mode & 0o777, relativePath, risk, size: stat.size },
        totals,
      );
      return;
    }
    if (!stat.isDirectory()) {
      throw new AppError(
        `Managed path '${relativePath}' is not a regular file, directory, or symbolic link.`,
        "SURFACE_UNSUPPORTED_TYPE",
      );
    }
    if (!expectedDirectory) {
      throw new AppError(
        `Portable file '${relativePath}' is a directory.`,
        "SURFACE_TYPE_MISMATCH",
      );
    }
    const children = readdirSync(absolutePath, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const child of children) {
      visit(`${relativePath}/${child.name}`, child.isDirectory());
    }
  }

  for (const file of profile.portableFiles) {
    visit(file.relativePath, false);
  }
  for (const directory of profile.portableDirectories) {
    visit(directory.relativePath, true);
  }
  if (profile.portableFilePatterns !== undefined) {
    for (const child of readdirSync(physicalRoot)) {
      if (isPortableFile(profile, child)) {
        visit(child, false);
      }
    }
  }
  validatePortablePathSet([
    ...entries.map((entry) => entry.relativePath),
    ...bindings.map((binding) => binding.relativePath),
  ]);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  bindings.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { bindings, entries, root: physicalRoot, totalBytes: totals.size };
}

export function bindingProtectsPath(
  bindings: readonly LinkBinding[],
  relativePath: string,
): boolean {
  return bindings.some(
    (binding) =>
      relativePath === binding.relativePath || relativePath.startsWith(`${binding.relativePath}/`),
  );
}

export function readManagedFile(root: string, relativePath: string): Buffer {
  assertNoSymlinkAncestors(root, relativePath);
  const path = pathInside(root, relativePath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new AppError(
        `Managed path '${relativePath}' is not a regular file.`,
        "SURFACE_TYPE_MISMATCH",
      );
    }
    if (stat.size > MAX_MANAGED_FILE_BYTES) {
      throw new AppError(
        `Managed file '${relativePath}' exceeds ${MAX_MANAGED_FILE_BYTES} bytes.`,
        "FILE_TOO_LARGE",
      );
    }
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function removeLeafIfNeeded(target: string): void {
  if (!managedPathExists(target)) {
    return;
  }
  const stat = lstatSync(target);
  if (process.platform === "win32" || stat.isDirectory()) {
    rmSync(target, { force: true, recursive: true });
  }
}

function replaceWithTemporary(target: string, temporary: string): void {
  removeLeafIfNeeded(target);
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true, recursive: true });
    throw error;
  }
}

export function writeBufferAtomic(
  root: string,
  relativePath: string,
  contents: string | Uint8Array,
  mode = 0o600,
): void {
  ensureParentDirectories(root, relativePath);
  const target = pathInside(root, relativePath);
  const temporary = join(dirname(target), `.agent-man-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode & 0o777);
    replaceWithTemporary(target, temporary);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function removeManagedPath(root: string, relativePath: string): void {
  assertNoSymlinkAncestors(root, relativePath);
  const target = pathInside(root, relativePath);
  if (managedPathExists(target)) {
    rmSync(target, { force: true, recursive: true });
  }
}

export function copyManagedEntry(sourceRoot: string, targetRoot: string, entry: TreeEntry): void {
  assertNoSymlinkAncestors(sourceRoot, entry.relativePath);
  ensureParentDirectories(targetRoot, entry.relativePath);
  const source = pathInside(sourceRoot, entry.relativePath);
  const target = pathInside(targetRoot, entry.relativePath);

  if (entry.kind === "file") {
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== entry.size) {
      throw new AppError(
        `Managed source '${entry.relativePath}' changed while it was being copied.`,
        "SOURCE_CHANGED",
      );
    }
    const contents = readManagedFile(sourceRoot, entry.relativePath);
    if (contents.byteLength !== entry.size) {
      throw new AppError(
        `Managed source '${entry.relativePath}' changed while it was being copied.`,
        "SOURCE_CHANGED",
      );
    }
    writeBufferAtomic(targetRoot, entry.relativePath, contents, entry.mode);
    return;
  }

  const temporary = join(dirname(target), `.agent-man-link-${process.pid}-${randomUUID()}`);
  try {
    symlinkSync(entry.linkTarget, temporary, entry.linkType === "directory" ? "dir" : "file");
    replaceWithTemporary(target, temporary);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new AppError(
      `Could not create symbolic link '${entry.relativePath}'. Enable symbolic-link support on this device or replace it with a portable file: ${errorMessage(error)}`,
      "SYMLINK_CREATE_FAILED",
    );
  }
}

export function managedEntryEquals(
  expectedRoot: string,
  actualRoot: string,
  entry: TreeEntry,
): boolean {
  assertNoSymlinkAncestors(expectedRoot, entry.relativePath);
  assertNoSymlinkAncestors(actualRoot, entry.relativePath);
  const actual = pathInside(actualRoot, entry.relativePath);
  if (!managedPathExists(actual)) {
    return false;
  }
  const actualStat = lstatSync(actual);
  if (entry.kind === "symlink") {
    return actualStat.isSymbolicLink() && readNativeSymlinkTarget(actual) === entry.linkTarget;
  }
  if (!actualStat.isFile() || actualStat.isSymbolicLink() || actualStat.size !== entry.size) {
    return false;
  }
  if (process.platform !== "win32" && (actualStat.mode & 0o111) !== (entry.mode & 0o111)) {
    return false;
  }
  return readManagedFile(expectedRoot, entry.relativePath).equals(
    readManagedFile(actualRoot, entry.relativePath),
  );
}

export function treeEntriesEqual(
  leftRoot: string,
  left: TreeEntry,
  rightRoot: string,
  right: TreeEntry,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.linkTarget === right.linkTarget;
  }
  if (left.kind !== "file" || right.kind !== "file") {
    return false;
  }
  if (left.size !== right.size) {
    return false;
  }
  if (process.platform !== "win32" && (left.mode & 0o111) !== (right.mode & 0o111)) {
    return false;
  }
  return readManagedFile(leftRoot, left.relativePath).equals(
    readManagedFile(rightRoot, right.relativePath),
  );
}
