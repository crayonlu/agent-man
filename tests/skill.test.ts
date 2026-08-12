import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolveAppPaths } from "../src/paths.js";
import { NATIVE_PROFILES } from "../src/profiles.js";
import { installSkill, skillStatus } from "../src/skill.js";

const skillDirectory = resolve(".agents/skills/agent-man");

test("the bundled Agent Skill has minimal discovery metadata and matches the CLI safety model", () => {
  const skill = readFileSync(resolve(skillDirectory, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/);
  assert.notEqual(frontmatter, null);
  assert.equal(frontmatter?.[1], "agent-man");
  assert.equal((frontmatter?.[2]?.length ?? 0) <= 1024, true);

  for (const profile of NATIVE_PROFILES) {
    assert.equal(skill.includes(profile.name), true);
  }
  assert.match(skill, /doctor --json/);
  assert.match(skill, /plan --json/);
  assert.match(skill, /Internal relative symbolic links/);
  assert.match(skill, /Do not force-push/);
  assert.match(skill, /never request or print a\s+token/i);
  assert.match(skill, /live profile files untouched/);
});

test("Codex metadata explicitly invokes the agent-man skill", () => {
  const metadata = readFileSync(resolve(skillDirectory, "agents", "openai.yaml"), "utf8");
  assert.match(metadata, /display_name: "Agent Man"/);
  assert.match(metadata, /default_prompt: "Use \$agent-man /);
});

test("the bundled skill installs into isolated common and Claude directories", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-skill-"));
  try {
    const paths = resolveAppPaths({
      AGENT_MAN_HOME: join(root, "state"),
      HOME: join(root, "home"),
    });
    const before = skillStatus(paths);
    assert.equal(
      before.locations.every((location) => location.state === "missing"),
      true,
    );

    const installed = installSkill(paths, "all");
    assert.equal(
      installed.locations.every((location) => location.state === "installed"),
      true,
    );
    assert.equal(
      existsSync(join(root, "home", ".agents", "skills", "agent-man", "SKILL.md")),
      true,
    );
    assert.equal(
      existsSync(join(root, "home", ".claude", "skills", "agent-man", "SKILL.md")),
      true,
    );
    assert.equal(installSkill(paths, "all").locations.length, 2);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
