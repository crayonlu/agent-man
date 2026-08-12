import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { AppError } from "./errors.js";
import { HarnessProfile, isHardExcluded } from "./profiles.js";

export type TreeEntryKind = "file" | "symlink";

export interface TreeEntry {
  readonly kind: TreeEntryKind;
  readonly relativePath: string;
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

function normalizedRelativePath(path: string): string {
  return path.split(sep).join("/");
}

export function pathInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new AppError(`Expected a relative path, received '${relativePath}'`);
  }

  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, ...relativePath.split("/"));
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new AppError(`Path '${relativePath}' escapes managed root '${root}'`);
  }
  return target;
}

export function walkManagedTree(root: string, profile: HarnessProfile): readonly TreeEntry[] {
  if (!existsSync(root)) {
    return [];
  }

  const entries: TreeEntry[] = [];

  function visit(directory: string): void {
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const relativePath = normalizedRelativePath(relative(root, absolutePath));

      if (child.name === ".git" || isHardExcluded(profile, relativePath)) {
        continue;
      }
      if (child.isSymbolicLink()) {
        entries.push({ kind: "symlink", relativePath });
      } else if (child.isDirectory()) {
        visit(absolutePath);
      } else if (child.isFile()) {
        entries.push({ kind: "file", relativePath });
      }
    }
  }

  visit(root);
  return entries;
}

export function removeManagedPath(root: string, relativePath: string): void {
  const target = pathInside(root, relativePath);
  if (!managedPathExists(target)) {
    return;
  }
  rmSync(target, { force: true, recursive: true });
}

export function copyManagedEntry(sourceRoot: string, targetRoot: string, entry: TreeEntry): void {
  const source = pathInside(sourceRoot, entry.relativePath);
  const target = pathInside(targetRoot, entry.relativePath);
  mkdirSync(dirname(target), { recursive: true });

  if (managedPathExists(target)) {
    const targetStat = lstatSync(target);
    const sameKind =
      (entry.kind === "file" && targetStat.isFile()) ||
      (entry.kind === "symlink" && targetStat.isSymbolicLink());
    if (!sameKind || entry.kind === "symlink") {
      rmSync(target, { force: true, recursive: true });
    }
  }

  if (entry.kind === "symlink") {
    symlinkSync(readlinkSync(source), target);
    return;
  }

  copyFileSync(source, target);
  const mode = lstatSync(source).mode & 0o777;
  chmodSync(target, mode);
}

export function managedEntriesEqual(
  leftRoot: string,
  rightRoot: string,
  entry: TreeEntry,
): boolean {
  const left = pathInside(leftRoot, entry.relativePath);
  const right = pathInside(rightRoot, entry.relativePath);
  if (!managedPathExists(left) || !managedPathExists(right)) {
    return false;
  }

  const leftStat = lstatSync(left);
  const rightStat = lstatSync(right);
  if (entry.kind === "symlink") {
    return (
      leftStat.isSymbolicLink() &&
      rightStat.isSymbolicLink() &&
      readlinkSync(left) === readlinkSync(right)
    );
  }
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) {
    return false;
  }
  if ((leftStat.mode & 0o111) !== (rightStat.mode & 0o111)) {
    return false;
  }
  return readFileSync(left).equals(readFileSync(right));
}
