import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BackupReference,
  beginApplyJournal,
  createBackup,
  listBackups,
  pendingApplyBackupId,
  recoverPendingApply,
} from "../src/backups.js";
import { walkPortableTree } from "../src/files.js";
import { resolveAppPaths } from "../src/paths.js";
import { findNativeProfile } from "../src/profiles.js";

test("an interrupted multi-file apply is recovered from its journal", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-journal-"));
  try {
    const home = join(root, "home");
    const grok = join(home, ".grok");
    const environment = { AGENT_MAN_HOME: join(root, "state"), GROK_HOME: grok, HOME: home };
    const paths = resolveAppPaths(environment);
    mkdirSync(grok, { recursive: true });
    writeFileSync(join(grok, "config.toml"), 'theme = "before"\n');
    const scan = walkPortableTree(grok, findNativeProfile("grok"));
    const entry = scan.entries.find((candidate) => candidate.relativePath === "config.toml");
    assert.notEqual(entry, undefined);
    if (entry === undefined) {
      return;
    }
    const reference: BackupReference = {
      currentEntry: entry,
      liveRoot: scan.root,
      profile: "grok",
      repositoryDirectory: ".grok",
      relativePath: "config.toml",
    };
    const backup = createBackup(paths, [reference]);
    assert.notEqual(backup, undefined);
    if (backup === undefined) {
      return;
    }
    beginApplyJournal(paths, backup);
    writeFileSync(join(grok, "config.toml"), 'theme = "partially-applied"\n');

    const recovered = recoverPendingApply(paths, environment);
    assert.equal(recovered?.id, backup.id);
    assert.equal(readFileSync(join(grok, "config.toml"), "utf8"), 'theme = "before"\n');
    assert.equal(pendingApplyBackupId(paths), undefined);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("backup retention remains bounded at ten rollback points", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-backup-retention-"));
  try {
    const home = join(root, "home");
    const grok = join(home, ".grok");
    const environment = { AGENT_MAN_HOME: join(root, "state"), GROK_HOME: grok, HOME: home };
    const paths = resolveAppPaths(environment);
    mkdirSync(grok, { recursive: true });
    writeFileSync(join(grok, "config.toml"), 'theme = "stable"\n');
    const scan = walkPortableTree(grok, findNativeProfile("grok"));
    const entry = scan.entries[0];
    assert.notEqual(entry, undefined);
    if (entry === undefined) {
      return;
    }
    const reference: BackupReference = {
      currentEntry: entry,
      liveRoot: scan.root,
      profile: "grok",
      repositoryDirectory: ".grok",
      relativePath: entry.relativePath,
    };
    for (let count = 0; count < 12; count += 1) {
      assert.notEqual(createBackup(paths, [reference]), undefined);
    }
    assert.equal(listBackups(paths).length, 10);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
