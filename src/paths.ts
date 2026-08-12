import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppPaths {
  readonly backupDirectory: string;
  readonly homeDirectory: string;
  readonly lockPath: string;
  readonly pendingApplyPath: string;
  readonly repositoryDirectory: string;
  readonly skillSourceDirectory: string;
  readonly stateDirectory: string;
  readonly templateDirectory: string;
}

export function resolveAppPaths(environment: NodeJS.ProcessEnv = process.env): AppPaths {
  const configuredHome = environment.HOME;
  const homeDirectory = resolve(
    configuredHome === undefined || configuredHome.trim() === "" ? homedir() : configuredHome,
  );
  const configuredState = environment.AGENT_MAN_HOME;
  const stateDirectory = resolve(
    configuredState === undefined || configuredState.trim() === ""
      ? join(homeDirectory, ".agent-man")
      : configuredState,
  );
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(moduleDirectory, "..", "..");

  return {
    backupDirectory: join(stateDirectory, "backups"),
    homeDirectory,
    lockPath: join(stateDirectory, "sync.lock"),
    pendingApplyPath: join(stateDirectory, "pending-apply.json"),
    repositoryDirectory: join(stateDirectory, "repo"),
    skillSourceDirectory: join(packageRoot, ".agents", "skills", "agent-man"),
    stateDirectory,
    templateDirectory: join(packageRoot, "templates", "config-repository"),
  };
}
