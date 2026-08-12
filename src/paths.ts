import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppPaths {
  readonly backupDirectory: string;
  readonly homeDirectory: string;
  readonly lockPath: string;
  readonly repositoryDirectory: string;
  readonly stateDirectory: string;
  readonly templateDirectory: string;
}

export function resolveAppPaths(environment: NodeJS.ProcessEnv = process.env): AppPaths {
  const homeDirectory = environment.HOME ?? homedir();
  const stateDirectory = environment.AGENT_MAN_HOME ?? join(homeDirectory, ".agent-man");
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(moduleDirectory, "..", "..");

  return {
    backupDirectory: join(stateDirectory, "backups"),
    homeDirectory,
    lockPath: join(stateDirectory, "sync.lock"),
    repositoryDirectory: join(stateDirectory, "repo"),
    stateDirectory,
    templateDirectory: join(packageRoot, "templates", "config-repository"),
  };
}
