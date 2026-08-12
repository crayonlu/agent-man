#!/usr/bin/env node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "agent-man-grok-check-"));
const home = join(root, "home");
const grokHome = join(root, "grok");
const environment = {
  ...process.env,
  AGENT_MAN_HOME: join(root, "state"),
  GROK_HOME: grokHome,
  HOME: home,
  XDG_CACHE_HOME: join(root, "xdg-cache"),
  XDG_CONFIG_HOME: join(root, "xdg-config"),
  XDG_DATA_HOME: join(root, "xdg-data"),
};
delete environment.XAI_API_KEY;

try {
  mkdirSync(home, { recursive: true });
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(
    join(grokHome, "config.toml"),
    '[models]\ndefault = "grok-build"\n\n[model."isolated-check"]\nmodel = "grok-build"\nenv_key = "AGENT_MAN_UNUSED_TEST_KEY"\n',
  );
  const result = spawnSync("grok", ["inspect"], {
    encoding: "utf8",
    env: environment,
  });
  if (result.error !== undefined && result.error.code === "ENOENT") {
    console.log("Grok Build is not installed; isolated native verification skipped.");
  } else if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`grok inspect failed in the isolated environment: ${detail}`);
  } else {
    console.log("grok inspect accepted an isolated agent-man-managed configuration.");
  }
} finally {
  rmSync(root, { force: true, recursive: true });
}
