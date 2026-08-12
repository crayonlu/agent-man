import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolveAppPaths } from "../src/paths.js";
import { findNativeProfile, liveDirectoryFor } from "../src/profiles.js";

test("blank environment paths never resolve to the working directory", () => {
  const paths = resolveAppPaths({ AGENT_MAN_HOME: "", HOME: "" });
  assert.equal(paths.homeDirectory, resolve(homedir()));
  assert.equal(paths.stateDirectory, join(resolve(homedir()), ".agent-man"));
});

test("a relative harness override is resolved to an explicit absolute root", () => {
  const profile = findNativeProfile("grok");
  assert.equal(
    liveDirectoryFor(profile, resolveAppPaths({ HOME: "/tmp" }), { GROK_HOME: "grok" }),
    resolve("grok"),
  );
});
