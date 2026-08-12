import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { resolveAppPaths } from "../src/paths.js";
import { NATIVE_PROFILES, profileIgnoreContents } from "../src/profiles.js";

test("the bundled repository template is deny-by-default and line-ending explicit", () => {
  const templateDirectory = resolveAppPaths({}).templateDirectory;
  const ignores = readFileSync(join(templateDirectory, "gitignore"), "utf8");
  const attributes = readFileSync(join(templateDirectory, "gitattributes"), "utf8");

  assert.match(ignores, /^\/\*$/mu);
  assert.match(ignores, /^!\/\.gitignore$/mu);
  assert.match(ignores, /^!\/\.gitattributes$/mu);
  for (const profile of NATIVE_PROFILES) {
    assert.equal(ignores.includes(`!/${profile.repositoryDirectory}/`), true);
  }
  assert.match(attributes, /^\* text=auto$/mu);
  assert.match(attributes, /^\*\.sh text eol=lf$/mu);
  assert.match(attributes, /^\*\.cmd text eol=crlf$/mu);
});

test("each generated profile ignore file documents the exact built-in allowlist", () => {
  for (const profile of NATIVE_PROFILES) {
    const contents = profileIgnoreContents(profile);
    assert.match(contents, /^\*$/mu);
    assert.match(contents, /^!\.gitignore$/mu);
    for (const file of profile.portableFiles) {
      assert.equal(contents.includes(`!${file.relativePath}\n`), true);
    }
    for (const directory of profile.portableDirectories) {
      assert.equal(contents.includes(`!${directory.relativePath}/\n`), true);
      assert.equal(contents.includes(`!${directory.relativePath}/**\n`), true);
    }
  }
});
