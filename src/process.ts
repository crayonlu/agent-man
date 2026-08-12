import { spawnSync } from "node:child_process";

import { AppError } from "./errors.js";

export interface CommandOptions {
  readonly acceptedExitCodes?: readonly number[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

export interface CommandResult {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  options?: CommandOptions,
) => CommandResult;

function outputText(value: string | Buffer | null): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return value.toString("utf8");
}

export const runCommand: CommandRunner = (command, arguments_, options = {}) => {
  const result = spawnSync(command, [...arguments_], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
  });

  if (result.error !== undefined) {
    throw new AppError(`Could not run ${command}: ${result.error.message}`);
  }

  const status = result.status ?? 1;
  const stdout = outputText(result.stdout);
  const stderr = outputText(result.stderr);
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];

  if (!acceptedExitCodes.includes(status)) {
    const detail = stderr.trim() || stdout.trim() || `exit status ${status}`;
    throw new AppError(`${command} failed: ${detail}`);
  }

  return { status, stderr, stdout };
};
