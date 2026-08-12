#!/usr/bin/env node

import { parseArguments } from "./arguments.js";
import { addHarness, initialize, showStatus, sync } from "./commands.js";
import { AppError, errorMessage } from "./errors.js";
import { resolveAppPaths } from "./paths.js";

const HELP = `agent-man — sync native AI harness configuration with Git

Usage:
  agent-man init [--github [OWNER/REPO]] [--template OWNER/REPO]
  agent-man init --remote <git-url>
  agent-man init --local
  agent-man add <harness>
  agent-man status
  agent-man sync

Harnesses:
  grok    $GROK_HOME or ~/.grok

Environment:
  AGENT_MAN_HOME       local state directory (default: ~/.agent-man)
  AGENT_MAN_TEMPLATE   GitHub template repository
`;

const output = {
  info(message: string): void {
    console.log(message);
  },
};

export function run(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const action = parseArguments(arguments_, environment);
  const context = { environment, output, paths: resolveAppPaths(environment) };

  if (action.kind === "help") {
    output.info(HELP.trimEnd());
  } else if (action.kind === "version") {
    output.info("agent-man 0.1.0");
  } else if (action.kind === "init") {
    initialize(action.mode, context);
  } else if (action.kind === "add") {
    addHarness(action.harness, context);
  } else if (action.kind === "status") {
    showStatus(context);
  } else {
    sync(context);
  }
}

try {
  run(process.argv.slice(2));
} catch (error) {
  console.error(`agent-man: ${errorMessage(error)}`);
  process.exitCode = error instanceof AppError ? error.exitCode : 1;
}
