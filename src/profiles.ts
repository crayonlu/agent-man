import { join } from "node:path";

import { AppError } from "./errors.js";
import { AppPaths } from "./paths.js";

export interface HarnessProfile {
  readonly hardExcludedDirectories: readonly string[];
  readonly hardExcludedFiles: readonly string[];
  readonly homeEnvironmentVariable?: string;
  readonly name: string;
  readonly repositoryDirectory: string;
}

const GROK_PROFILE: HarnessProfile = {
  hardExcludedDirectories: ["bin", "cache", "crash", "logs", "sessions", "tmp"],
  hardExcludedFiles: ["auth.json", "mcp_credentials.json"],
  homeEnvironmentVariable: "GROK_HOME",
  name: "grok",
  repositoryDirectory: ".grok",
};

export const HARNESS_PROFILES: readonly HarnessProfile[] = [GROK_PROFILE];

export function findHarnessProfile(name: string): HarnessProfile {
  const profile = HARNESS_PROFILES.find((candidate) => candidate.name === name);
  if (profile === undefined) {
    const supported = HARNESS_PROFILES.map((candidate) => candidate.name).join(", ");
    throw new AppError(`Unknown harness '${name}'. Supported harnesses: ${supported}`);
  }
  return profile;
}

export function liveDirectoryFor(
  profile: HarnessProfile,
  paths: AppPaths,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const variable = profile.homeEnvironmentVariable;
  if (variable !== undefined) {
    const configured = environment[variable];
    if (configured !== undefined && configured.trim() !== "") {
      return configured;
    }
  }
  return join(paths.homeDirectory, profile.repositoryDirectory);
}

export function isHardExcluded(profile: HarnessProfile, relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (profile.hardExcludedFiles.includes(normalized)) {
    return true;
  }

  return profile.hardExcludedDirectories.some(
    (directory) => normalized === directory || normalized.startsWith(`${directory}/`),
  );
}
