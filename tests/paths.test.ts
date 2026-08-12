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

test("native profile roots follow each harness's documented home layout", () => {
  const home = resolve("/tmp/agent-man-home");
  const environment = { HOME: home };
  const paths = resolveAppPaths(environment);
  assert.equal(
    liveDirectoryFor(findNativeProfile("claude-code"), paths, environment),
    join(home, ".claude"),
  );
  assert.equal(
    liveDirectoryFor(findNativeProfile("codex"), paths, environment),
    join(home, ".codex"),
  );
  assert.equal(
    liveDirectoryFor(findNativeProfile("pi"), paths, environment),
    join(home, ".pi", "agent"),
  );
  assert.equal(
    liveDirectoryFor(findNativeProfile("opencode"), paths, environment),
    join(home, ".config", "opencode"),
  );
  assert.equal(
    liveDirectoryFor(findNativeProfile("gemini-cli"), paths, environment),
    join(home, ".gemini"),
  );
});

test("XDG and harness-specific root overrides stay isolated", () => {
  const paths = resolveAppPaths({ HOME: resolve("/tmp/agent-man-home") });
  const xdgConfig = resolve("/tmp/xdg-config");
  assert.equal(
    liveDirectoryFor(findNativeProfile("opencode"), paths, {
      XDG_CONFIG_HOME: xdgConfig,
    }),
    join(xdgConfig, "opencode"),
  );
  assert.equal(
    liveDirectoryFor(findNativeProfile("claude-code"), paths, {
      CLAUDE_CONFIG_DIR: "claude-config",
    }),
    resolve("claude-config"),
  );
  assert.equal(
    liveDirectoryFor(findNativeProfile("codex"), paths, { CODEX_HOME: "codex-home" }),
    resolve("codex-home"),
  );
  assert.equal(
    liveDirectoryFor(findNativeProfile("gemini-cli"), paths, {
      GEMINI_CLI_HOME: resolve("/tmp/gemini-home"),
    }),
    join(resolve("/tmp/gemini-home"), ".gemini"),
  );
  const piAgent = resolve("/tmp/pi-agent");
  assert.equal(
    liveDirectoryFor(findNativeProfile("pi"), paths, {
      PI_CODING_AGENT_DIR: piAgent,
    }),
    piAgent,
  );
});
