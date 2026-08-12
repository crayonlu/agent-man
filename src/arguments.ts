import { AppError } from "./errors.js";
import { SkillInstallTarget } from "./skill.js";

export const DEFAULT_TEMPLATE = "crayonlu/agent-man-config-template";

export type CliAction =
  | { readonly kind: "add"; readonly profile: string }
  | { readonly kind: "backups" }
  | { readonly kind: "doctor" }
  | { readonly kind: "help" }
  | { readonly kind: "init"; readonly mode: InitArgumentMode }
  | { readonly kind: "plan" }
  | { readonly kind: "profiles" }
  | { readonly id: string; readonly kind: "restore" }
  | { readonly force: boolean; readonly kind: "skill-install"; readonly target: SkillInstallTarget }
  | { readonly kind: "skill-status" }
  | { readonly kind: "status" }
  | { readonly kind: "sync" }
  | { readonly kind: "version" };

export interface CliRequest {
  readonly action: CliAction;
  readonly json: boolean;
}

export type InitArgumentMode =
  | { readonly kind: "github"; readonly repository: string; readonly template: string }
  | { readonly kind: "remote"; readonly url: string }
  | { readonly kind: "local" };

function optionValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new AppError(`${option} requires a value.`, "ARGUMENT_REQUIRED");
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
      throw new AppError(`Unknown init option '${argument}'.`, "ARGUMENT_UNKNOWN");
    }
  }

  const selectedModes = Number(github) + Number(remote !== undefined) + Number(local);
  if (selectedModes > 1) {
    throw new AppError("Choose only one of --github, --remote, or --local.", "ARGUMENT_CONFLICT");
  }
  if (remote !== undefined) {
    return { kind: "init", mode: { kind: "remote", url: remote } };
  }
  if (local) {
    return { kind: "init", mode: { kind: "local" } };
  }
  return { kind: "init", mode: { kind: "github", repository, template } };
}

function parseSkill(arguments_: readonly string[]): CliAction {
  const subcommand = arguments_[0];
  if (subcommand === "status" && arguments_.length === 1) {
    return { kind: "skill-status" };
  }
  if (subcommand !== "install") {
    throw new AppError(
      "Usage: agent-man skill <install [--target agents|claude|all] [--force] | status>",
      "ARGUMENT_INVALID",
    );
  }
  let force = false;
  let target: SkillInstallTarget = "agents";
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--force") {
      force = true;
    } else if (argument === "--target") {
      const value = optionValue(arguments_, index, argument);
      if (value !== "agents" && value !== "claude" && value !== "all") {
        throw new AppError("--target must be agents, claude, or all.", "ARGUMENT_INVALID");
      }
      target = value;
      index += 1;
    } else {
      throw new AppError(`Unknown skill option '${argument}'.`, "ARGUMENT_UNKNOWN");
    }
  }
  return { force, kind: "skill-install", target };
}

function parseAction(arguments_: readonly string[], environment: NodeJS.ProcessEnv): CliAction {
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
    const profile = arguments_[1];
    if (profile === undefined || arguments_.length !== 2) {
      throw new AppError("Usage: agent-man add <profile>", "ARGUMENT_INVALID");
    }
    return { kind: "add", profile };
  }
  if (
    (command === "backups" ||
      command === "doctor" ||
      command === "plan" ||
      command === "profiles" ||
      command === "status" ||
      command === "sync") &&
    arguments_.length === 1
  ) {
    return { kind: command };
  }
  if (command === "restore" && arguments_.length === 2) {
    const id = arguments_[1];
    if (id !== undefined) {
      return { id, kind: "restore" };
    }
  }
  if (command === "skill") {
    return parseSkill(arguments_.slice(1));
  }
  throw new AppError(`Unknown command '${command}'. Run 'agent-man help'.`, "ARGUMENT_UNKNOWN");
}

export function parseArguments(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): CliRequest {
  const jsonArguments = arguments_.filter((argument) => argument === "--json");
  if (jsonArguments.length > 1) {
    throw new AppError("--json may be specified only once.", "ARGUMENT_CONFLICT");
  }
  const withoutJson = arguments_.filter((argument) => argument !== "--json");
  return { action: parseAction(withoutJson, environment), json: jsonArguments.length === 1 };
}
