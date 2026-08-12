import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

import { AppError, errorMessage } from "./errors.js";
import { AppPaths } from "./paths.js";

interface LockOwner {
  readonly createdAt: string;
  readonly host: string;
  readonly pid: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readLock(path: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) {
      return undefined;
    }
    if (
      typeof value.createdAt === "string" &&
      typeof value.host === "string" &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid)
    ) {
      return { createdAt: value.createdAt, host: value.host, pid: value.pid };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

export function ensurePrivateState(paths: AppPaths): void {
  const homeFromState = relative(paths.stateDirectory, paths.homeDirectory);
  if (
    homeFromState === "" ||
    (!isAbsolute(homeFromState) && homeFromState !== ".." && !homeFromState.startsWith(`..${sep}`))
  ) {
    throw new AppError(
      `State path is too broad and contains the home directory: ${paths.stateDirectory}`,
      "STATE_DIRECTORY_TOO_BROAD",
    );
  }
  let existed = true;
  try {
    lstatSync(paths.stateDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      existed = false;
    } else {
      throw error;
    }
  }
  mkdirSync(paths.stateDirectory, { mode: 0o700, recursive: true });
  const stat = lstatSync(paths.stateDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AppError(
      `State path must be a real directory: ${paths.stateDirectory}`,
      "STATE_DIRECTORY_UNSAFE",
    );
  }
  if (process.platform !== "win32") {
    if (existed && (stat.mode & 0o077) !== 0) {
      throw new AppError(
        `State directory permissions are too open; run chmod 700 '${paths.stateDirectory}' before continuing.`,
        "STATE_PERMISSIONS_OPEN",
      );
    }
    if (!existed) {
      chmodSync(paths.stateDirectory, 0o700);
    }
  }
}

function removeStaleLock(paths: AppPaths): boolean {
  const owner = readLock(paths.lockPath);
  if (owner !== undefined && owner.host === hostname() && !processExists(owner.pid)) {
    rmSync(paths.lockPath, { force: true });
    return true;
  }
  return false;
}

export function acquireSyncLock(paths: AppPaths): () => void {
  ensurePrivateState(paths);
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(paths.lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST" &&
        attempt === 0 &&
        removeStaleLock(paths)
      ) {
        continue;
      }
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        const owner = readLock(paths.lockPath);
        const detail =
          owner === undefined
            ? paths.lockPath
            : `${owner.host} pid ${owner.pid}, since ${owner.createdAt}`;
        throw new AppError(`Another agent-man operation holds the lock (${detail}).`, "LOCK_HELD");
      }
      throw new AppError(
        `Could not create sync lock: ${errorMessage(error)}`,
        "LOCK_CREATE_FAILED",
      );
    }
  }
  if (descriptor === undefined) {
    throw new AppError("Could not acquire the agent-man lock.", "LOCK_CREATE_FAILED");
  }
  try {
    const owner: LockOwner = {
      createdAt: new Date().toISOString(),
      host: hostname(),
      pid: process.pid,
    };
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(paths.lockPath, { force: true });
    throw new AppError(
      `Could not initialize sync lock: ${errorMessage(error)}`,
      "LOCK_CREATE_FAILED",
    );
  }
  return () => {
    closeSync(descriptor);
    rmSync(paths.lockPath, { force: true });
  };
}
