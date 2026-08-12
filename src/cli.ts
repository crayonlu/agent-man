#!/usr/bin/env node

import { CliAction, parseArguments } from "./arguments.js";
import {
  addProfile,
  doctor,
  initialize,
  installBundledSkill,
  listProfiles,
  restore,
  showBackups,
  showPlan,
  showSkillStatus,
  showStatus,
  sync,
} from "./commands.js";
import { AppError, errorCode, errorMessage } from "./errors.js";
import { resolveAppPaths } from "./paths.js";
import { VERSION } from "./version.js";

const HELP = `agent-man — safely sync native AI agent configuration surfaces with Git

Usage:
  agent-man init [--github [OWNER/REPO]] [--template OWNER/REPO]
  agent-man init --remote <git-url>
  agent-man init --local
  agent-man profiles
  agent-man add <profile>
  agent-man status [--json]
  agent-man plan [--json]
  agent-man doctor [--json]
  agent-man sync [--json]
  agent-man backups [--json]
  agent-man restore <backup-id> [--json]
  agent-man skill status [--json]
  agent-man skill install [--target agents|claude|all] [--force] [--json]

Profiles:
  grok           $GROK_HOME or ~/.grok: authored config, rules, agents, personas, skills, hooks
  claude-code    $CLAUDE_CONFIG_DIR or ~/.claude: authored instructions, settings, skills, agents
  codex          $CODEX_HOME or ~/.codex: config.toml, AGENTS.md, named config profiles
  opencode       $XDG_CONFIG_HOME/opencode or ~/.config/opencode: config, agents, commands, skills
  pi             $PI_CODING_AGENT_DIR or ~/.pi/agent: settings, extensions, skills, prompts, themes
  gemini-cli     $GEMINI_CLI_HOME/.gemini or ~/.gemini: settings, context, agents, policies, skills
  agent-skills   ~/.agents: skills/, commands/

Semantics:
  Built-in profile allowlists define what can ever sync; .gitignore may only narrow them.
  Internal relative symlinks are preserved. Absolute, external, and broken links stay local.
  Credentials, sessions, history, logs, caches, trust state, and unknown paths never sync.

Environment:
  AGENT_MAN_HOME       private local state directory (default: ~/.agent-man)
  AGENT_MAN_TEMPLATE   GitHub template repository
`;

interface JsonEnvelope {
  readonly command: string;
  readonly ok: boolean;
  readonly result: unknown;
  readonly schemaVersion: number;
}

function actionName(action: CliAction): string {
  return action.kind;
}

function dispatch(action: CliAction, environment: NodeJS.ProcessEnv, json: boolean): unknown {
  const output = {
    info(message: string): void {
      if (!json) {
        console.log(message);
      }
    },
  };
  const context = { environment, output, paths: resolveAppPaths(environment) };
  if (action.kind === "help") {
    if (!json) {
      output.info(HELP.trimEnd());
    }
    return { text: HELP.trimEnd() };
  }
  if (action.kind === "version") {
    const version = `agent-man ${VERSION}`;
    output.info(version);
    return { version };
  }
  if (action.kind === "init") {
    return initialize(action.mode, context);
  }
  if (action.kind === "add") {
    return addProfile(action.profile, context);
  }
  if (action.kind === "status") {
    return showStatus(context);
  }
  if (action.kind === "plan") {
    return showPlan(context);
  }
  if (action.kind === "doctor") {
    const report = doctor(context);
    if (!report.ok) {
      process.exitCode = 2;
    }
    return report;
  }
  if (action.kind === "sync") {
    return sync(context);
  }
  if (action.kind === "backups") {
    return showBackups(context);
  }
  if (action.kind === "restore") {
    return restore(action.id, context);
  }
  if (action.kind === "profiles") {
    return listProfiles(context);
  }
  if (action.kind === "skill-status") {
    return showSkillStatus(context);
  }
  return installBundledSkill(action.target, action.force, context);
}

export function run(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const request = parseArguments(arguments_, environment);
  const result = dispatch(request.action, environment, request.json);
  if (request.json) {
    const envelope: JsonEnvelope = {
      command: actionName(request.action),
      ok: process.exitCode === undefined || process.exitCode === 0,
      result,
      schemaVersion: 1,
    };
    console.log(JSON.stringify(envelope, null, 2));
  }
}

try {
  run(process.argv.slice(2));
} catch (error) {
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          error: { code: errorCode(error), message: errorMessage(error) },
          ok: false,
          schemaVersion: 1,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`agent-man: ${errorMessage(error)}`);
  }
  process.exitCode = error instanceof AppError ? error.exitCode : 1;
}
