import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireSyncLock } from "../src/lock.js";
import { resolveAppPaths } from "../src/paths.js";

test("a dead same-host process lock is recovered safely", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-stale-lock-"));
  try {
    const paths = resolveAppPaths({
      AGENT_MAN_HOME: join(root, "state"),
      HOME: join(root, "home"),
    });
    mkdirSync(paths.stateDirectory, { mode: 0o700, recursive: true });
    writeFileSync(
      paths.lockPath,
      `${JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z", host: hostname(), pid: 999_999_999 })}\n`,
    );

    const release = acquireSyncLock(paths);
    assert.equal(existsSync(paths.lockPath), true);
    release();
    assert.equal(existsSync(paths.lockPath), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a live process lock is never stolen", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-live-lock-"));
  try {
    const paths = resolveAppPaths({
      AGENT_MAN_HOME: join(root, "state"),
      HOME: join(root, "home"),
    });
    mkdirSync(paths.stateDirectory, { mode: 0o700, recursive: true });
    writeFileSync(
      paths.lockPath,
      `${JSON.stringify({ createdAt: new Date().toISOString(), host: hostname(), pid: process.pid })}\n`,
    );
    assert.throws(() => acquireSyncLock(paths), /holds the lock/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a state root cannot be HOME or one of its ancestors", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-broad-state-"));
  try {
    const home = join(root, "home");
    mkdirSync(home, { mode: 0o755, recursive: true });
    const before = lstatSync(home).mode & 0o777;
    const paths = resolveAppPaths({ AGENT_MAN_HOME: home, HOME: home });

    assert.throws(() => acquireSyncLock(paths), /too broad/);
    assert.equal(lstatSync(home).mode & 0o777, before);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an existing state directory with broad permissions is not modified", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not enforced on Windows");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "agent-man-state-mode-"));
  try {
    const paths = resolveAppPaths({
      AGENT_MAN_HOME: join(root, "state"),
      HOME: join(root, "home"),
    });
    mkdirSync(paths.stateDirectory, { recursive: true });
    chmodSync(paths.stateDirectory, 0o755);

    assert.throws(() => acquireSyncLock(paths), /chmod 700/);
    assert.equal(lstatSync(paths.stateDirectory).mode & 0o777, 0o755);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
