import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_MANAGED_FILE_BYTES,
  copyManagedEntry,
  validatePortablePathSet,
  walkPortableTree,
} from "../src/files.js";
import { findNativeProfile } from "../src/profiles.js";

const grok = findNativeProfile("grok");

function createLink(target: string, path: string, type: "dir" | "file"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

test("an external symbolic link is recorded as a local binding without walking its target", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-external-link-"));
  try {
    const surface = join(root, "surface");
    const external = join(root, "external");
    mkdirSync(join(surface, "skills"), { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "secret.txt"), "must never be captured\n");
    if (!createLink(external, join(surface, "skills", "local"), "dir")) {
      t.skip("symbolic links are unavailable on this host");
      return;
    }

    const scan = walkPortableTree(surface, grok);
    assert.deepEqual(scan.bindings, [{ reason: "absolute", relativePath: "skills/local" }]);
    assert.equal(
      scan.entries.some((entry) => entry.relativePath.includes("secret")),
      false,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an internal relative directory link is preserved verbatim", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-internal-link-"));
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(join(source, "skills", "shared"), { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "skills", "shared", "SKILL.md"), "# Shared\n");
    if (!createLink("shared", join(source, "skills", "current"), "dir")) {
      t.skip("symbolic links are unavailable on this host");
      return;
    }

    const scan = walkPortableTree(source, grok);
    const link = scan.entries.find((entry) => entry.relativePath === "skills/current");
    assert.notEqual(link, undefined);
    if (link === undefined) {
      return;
    }
    assert.equal(link.kind, "symlink");
    copyManagedEntry(scan.root, target, link);
    assert.equal(readlinkSync(join(target, "skills", "current")), "shared");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an internal link whose target chain escapes is protected as a local binding", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-link-chain-"));
  try {
    const surface = join(root, "surface");
    const external = join(root, "external");
    mkdirSync(join(surface, "skills"), { recursive: true });
    mkdirSync(external, { recursive: true });
    if (
      !createLink("../../../external", join(surface, "skills", "redirect"), "dir") ||
      !createLink("redirect", join(surface, "skills", "current"), "dir")
    ) {
      t.skip("symbolic links are unavailable on this host");
      return;
    }

    const scan = walkPortableTree(surface, grok);
    assert.deepEqual(scan.bindings, [
      { reason: "broken", relativePath: "skills/current" },
      { reason: "external", relativePath: "skills/redirect" },
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("copy refuses a symbolic-link ancestor and does not write through it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-link-ancestor-"));
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    const outside = join(root, "outside");
    mkdirSync(join(source, "skills"), { recursive: true });
    mkdirSync(target, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(source, "skills", "demo.md"), "safe\n");
    if (!createLink(outside, join(target, "skills"), "dir")) {
      t.skip("symbolic links are unavailable on this host");
      return;
    }
    const entry = walkPortableTree(source, grok).entries[0];
    assert.notEqual(entry, undefined);
    if (entry === undefined) {
      return;
    }
    assert.throws(() => copyManagedEntry(source, target, entry), /symbolic-link ancestor/i);
    assert.equal(existsSync(join(outside, "demo.md")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("surface roots may themselves be symbolic links", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-root-link-"));
  try {
    const physical = join(root, "physical");
    const logical = join(root, "logical");
    mkdirSync(physical, { recursive: true });
    writeFileSync(join(physical, "config.toml"), "theme = 'dark'\n");
    if (!createLink(physical, logical, "dir")) {
      t.skip("symbolic links are unavailable on this host");
      return;
    }
    const scan = walkPortableTree(logical, grok);
    assert.equal(scan.root, realpathSync.native(physical));
    assert.equal(scan.entries[0]?.relativePath, "config.toml");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("portable path collisions, reserved names, and oversized files are rejected", () => {
  assert.throws(() => validatePortablePathSet(["skills/Demo", "skills/demo"]), /collide/);
  assert.throws(() => validatePortablePathSet(["skills/CON.txt"]), /reserved/);
  assert.throws(() => validatePortablePathSet(["skills/COM¹.txt"]), /reserved/);
  assert.throws(() => validatePortablePathSet(["skills/CONOUT$.txt"]), /reserved/);
  assert.throws(() => validatePortablePathSet(["skills/demo\u202Etxt"]), /not portable/);
  assert.throws(() => validatePortablePathSet([`skills/${"x".repeat(256)}`]), /longer than/);
  assert.throws(() => validatePortablePathSet(["skills/demo/.git/config"]), /Git repository/);

  const root = mkdtempSync(join(tmpdir(), "agent-man-large-file-"));
  try {
    writeFileSync(join(root, "config.toml"), "");
    truncateSync(join(root, "config.toml"), MAX_MANAGED_FILE_BYTES + 1);
    assert.throws(() => walkPortableTree(root, grok), /exceeds/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("nested Git attributes are rejected before capture", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-live-attributes-"));
  try {
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", ".gitattributes"), "* filter=unsafe\n");
    assert.throws(() => walkPortableTree(root, grok), /outside the configuration surface/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
