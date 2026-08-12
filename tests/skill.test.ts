import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { HARNESS_PROFILES } from "../src/profiles.js";

const skillDirectory = resolve(".agents/skills/agent-man");

test("the bundled Agent Skill has valid discovery metadata and safety guidance", () => {
  const skill = readFileSync(resolve(skillDirectory, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/);
  assert.notEqual(frontmatter, null);
  assert.equal(frontmatter?.[1], "agent-man");
  assert.equal((frontmatter?.[2]?.length ?? 0) <= 1024, true);

  for (const profile of HARNESS_PROFILES) {
    for (const path of [...profile.hardExcludedFiles, ...profile.hardExcludedDirectories]) {
      assert.equal(
        skill.includes(`\`${path}${profile.hardExcludedDirectories.includes(path) ? "/" : ""}\``),
        true,
      );
    }
  }

  assert.match(skill, /never request or print their token/i);
  assert.match(skill, /Do not force-push/);
  assert.match(skill, /live harness files untouched/);
});

test("Codex metadata explicitly invokes the agent-man skill", () => {
  const metadata = readFileSync(resolve(skillDirectory, "agents", "openai.yaml"), "utf8");
  assert.match(metadata, /display_name: "Agent Man"/);
  assert.match(metadata, /default_prompt: "Use \$agent-man /);
});
