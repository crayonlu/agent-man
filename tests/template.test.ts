import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { resolveAppPaths } from "../src/paths.js";
import { HARNESS_PROFILES } from "../src/profiles.js";

test("the bundled template visibly ignores every hard safety exclusion", () => {
  const template = readFileSync(join(resolveAppPaths({}).templateDirectory, "gitignore"), "utf8");

  for (const profile of HARNESS_PROFILES) {
    for (const file of profile.hardExcludedFiles) {
      assert.match(template, new RegExp(`^${profile.repositoryDirectory}/${file}$`, "m"));
    }
    for (const directory of profile.hardExcludedDirectories) {
      assert.match(template, new RegExp(`^${profile.repositoryDirectory}/${directory}/$`, "m"));
    }
  }
});
