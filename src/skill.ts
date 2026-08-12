import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { AppError, errorMessage } from "./errors.js";
import { managedPathExists, resolveManagedRoot } from "./files.js";
import { AppPaths } from "./paths.js";

export type SkillInstallTarget = "agents" | "all" | "claude";

export interface SkillLocationStatus {
  readonly location: string;
  readonly state: "different" | "installed" | "linked" | "missing";
  readonly target: "agents" | "claude";
}

export interface SkillInstallResult {
  readonly locations: readonly SkillLocationStatus[];
}

function targetParents(paths: AppPaths): readonly {
  readonly parent: string;
  readonly target: "agents" | "claude";
}[] {
  return [
    { parent: join(paths.homeDirectory, ".agents", "skills"), target: "agents" },
    { parent: join(paths.homeDirectory, ".claude", "skills"), target: "claude" },
  ];
}

function selectedTargets(
  paths: AppPaths,
  target: SkillInstallTarget,
): readonly { readonly parent: string; readonly target: "agents" | "claude" }[] {
  return targetParents(paths).filter(
    (candidate) => target === "all" || candidate.target === target,
  );
}

function collectFiles(root: string): ReadonlyMap<string, Buffer> {
  const files = new Map<string, Buffer>();
  function visit(directory: string): void {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        visit(path);
      } else if (child.isFile()) {
        files.set(relative(root, path).split(sep).join("/"), readFileSync(path));
      } else {
        throw new AppError(
          `Skill contains unsupported entry '${relative(root, path)}'.`,
          "SKILL_ENTRY_UNSUPPORTED",
        );
      }
    }
  }
  visit(root);
  return files;
}

function directoriesEqual(left: string, right: string): boolean {
  const leftFiles = collectFiles(left);
  const rightFiles = collectFiles(right);
  if (leftFiles.size !== rightFiles.size) {
    return false;
  }
  for (const [path, contents] of leftFiles) {
    const candidate = rightFiles.get(path);
    if (candidate === undefined || !candidate.equals(contents)) {
      return false;
    }
  }
  return true;
}

function locationStatus(
  paths: AppPaths,
  candidate: { readonly parent: string; readonly target: "agents" | "claude" },
): SkillLocationStatus {
  const location = join(candidate.parent, "agent-man");
  if (!managedPathExists(location)) {
    return { location, state: "missing", target: candidate.target };
  }
  const stat = lstatSync(location);
  if (stat.isSymbolicLink()) {
    return { location, state: "linked", target: candidate.target };
  }
  if (!stat.isDirectory()) {
    return { location, state: "different", target: candidate.target };
  }
  let matches = false;
  try {
    matches = directoriesEqual(paths.skillSourceDirectory, location);
  } catch {
    matches = false;
  }
  return {
    location,
    state: matches ? "installed" : "different",
    target: candidate.target,
  };
}

export function skillStatus(paths: AppPaths): SkillInstallResult {
  if (
    !existsSync(paths.skillSourceDirectory) ||
    !lstatSync(paths.skillSourceDirectory).isDirectory()
  ) {
    throw new AppError(
      `Bundled agent-man skill is missing: ${paths.skillSourceDirectory}`,
      "SKILL_SOURCE_MISSING",
    );
  }
  return { locations: targetParents(paths).map((candidate) => locationStatus(paths, candidate)) };
}

export function installSkill(
  paths: AppPaths,
  target: SkillInstallTarget,
  force = false,
): SkillInstallResult {
  if (
    !existsSync(paths.skillSourceDirectory) ||
    !lstatSync(paths.skillSourceDirectory).isDirectory()
  ) {
    throw new AppError(
      `Bundled agent-man skill is missing: ${paths.skillSourceDirectory}`,
      "SKILL_SOURCE_MISSING",
    );
  }
  for (const candidate of selectedTargets(paths, target)) {
    mkdirSync(candidate.parent, { mode: 0o700, recursive: true });
    const physicalParent = resolveManagedRoot(candidate.parent);
    const location = join(physicalParent, "agent-man");
    const visibleLocation = join(candidate.parent, "agent-man");
    if (managedPathExists(visibleLocation)) {
      const current = locationStatus(paths, candidate);
      if (current.state === "installed") {
        continue;
      }
      if (!force) {
        throw new AppError(
          `Skill target already exists and differs: ${visibleLocation}. Re-run with --force to replace the entry without following it.`,
          "SKILL_TARGET_EXISTS",
        );
      }
    }
    const temporary = join(physicalParent, `.agent-man-install-${process.pid}-${randomUUID()}`);
    try {
      cpSync(paths.skillSourceDirectory, temporary, {
        dereference: false,
        errorOnExist: true,
        recursive: true,
        verbatimSymlinks: true,
      });
      if (managedPathExists(location)) {
        rmSync(location, { force: true, recursive: true });
      }
      renameSync(temporary, location);
    } catch (error) {
      rmSync(temporary, { force: true, recursive: true });
      throw new AppError(`Could not install skill: ${errorMessage(error)}`, "SKILL_INSTALL_FAILED");
    }
  }
  return {
    locations: selectedTargets(paths, target).map((candidate) => locationStatus(paths, candidate)),
  };
}

export function skillLocationLabel(status: SkillLocationStatus): string {
  return `${status.target}: ${resolve(status.location)} (${status.state})`;
}
