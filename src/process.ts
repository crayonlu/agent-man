import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

import { AppError } from "./errors.js";

const MAX_COMMAND_OUTPUT_BYTES = 70 * 1024 * 1024;

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
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });

  if (result.error !== undefined) {
    const code = "code" in result.error ? result.error.code : undefined;
    throw new AppError(
      `Could not run ${command}: ${result.error.message}`,
      code === "ENOENT" ? "COMMAND_NOT_FOUND" : "COMMAND_FAILED",
    );
  }

  const status = result.status ?? 1;
  const stdout = outputText(result.stdout);
  const stderr = outputText(result.stderr);
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];

  if (!acceptedExitCodes.includes(status)) {
    const detail = stderr.trim() || stdout.trim() || `exit status ${status}`;
    throw new AppError(`${command} failed: ${detail}`, "COMMAND_FAILED");
  }

  return { status, stderr, stdout };
};

export function executableAvailable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const extensions =
    process.platform === "win32" ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const hasExtension = extname(command) !== "";
  const candidates =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [command]
      : (environment.PATH ?? "")
          .split(delimiter)
          .filter((directory) => directory !== "")
          .flatMap((directory) =>
            extensions.map((extension) =>
              join(directory, `${command}${hasExtension ? "" : extension}`),
            ),
          );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
