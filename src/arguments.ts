import { AppError } from "./errors.js";

export const DEFAULT_TEMPLATE = "crayonlu/agent-man-config-template";

export type CliAction =
  | { readonly kind: "add"; readonly harness: string }
  | { readonly kind: "help" }
  | { readonly kind: "init"; readonly mode: InitArgumentMode }
  | { readonly kind: "status" }
  | { readonly kind: "sync" }
  | { readonly kind: "version" };

export type InitArgumentMode =
  | { readonly kind: "github"; readonly repository: string; readonly template: string }
  | { readonly kind: "remote"; readonly url: string }
  | { readonly kind: "local" };

function optionValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new AppError(`${option} requires a value.`);
  }
  return value;
}

function parseInit(arguments_: readonly string[], environment: NodeJS.ProcessEnv): CliAction {
  let repository = "agent-man-config";
  let template = environment.AGENT_MAN_TEMPLATE ?? DEFAULT_TEMPLATE;
  let remote: string | undefined;
  let local = false;
  let github = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--github") {
      github = true;
      const candidate = arguments_[index + 1];
      if (candidate !== undefined && !candidate.startsWith("--")) {
        repository = candidate;
        index += 1;
      }
    } else if (argument === "--template") {
      template = optionValue(arguments_, index, argument);
      index += 1;
    } else if (argument === "--remote") {
      remote = optionValue(arguments_, index, argument);
      index += 1;
    } else if (argument === "--local") {
      local = true;
    } else {
      throw new AppError(`Unknown init option '${argument}'.`);
    }
  }

  const selectedModes = Number(github) + Number(remote !== undefined) + Number(local);
  if (selectedModes > 1) {
    throw new AppError("Choose only one of --github, --remote, or --local.");
  }
  if (remote !== undefined) {
    return { kind: "init", mode: { kind: "remote", url: remote } };
  }
  if (local) {
    return { kind: "init", mode: { kind: "local" } };
  }
  return { kind: "init", mode: { kind: "github", repository, template } };
}

export function parseArguments(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): CliAction {
  const command = arguments_[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help" };
  }
  if (command === "--version" || command === "-v" || command === "version") {
    return { kind: "version" };
  }
  if (command === "init") {
    return parseInit(arguments_.slice(1), environment);
  }
  if (command === "add") {
    const harness = arguments_[1];
    if (harness === undefined || arguments_.length !== 2) {
      throw new AppError("Usage: agent-man add <harness>");
    }
    return { kind: "add", harness };
  }
  if (command === "status" && arguments_.length === 1) {
    return { kind: "status" };
  }
  if (command === "sync" && arguments_.length === 1) {
    return { kind: "sync" };
  }
  throw new AppError(`Unknown command '${command}'. Run 'agent-man help'.`);
}
