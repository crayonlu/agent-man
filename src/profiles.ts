import { join, resolve } from "node:path";

import { AppError } from "./errors.js";
import { AppPaths } from "./paths.js";

export type EntryRisk = "active" | "configuration";

export interface PortableFile {
  readonly relativePath: string;
  readonly risk: EntryRisk;
  readonly scanForSecrets?: boolean;
}

export interface PortableDirectory {
  readonly relativePath: string;
  readonly risk: EntryRisk;
}

export interface NativeProfile {
  readonly description: string;
  readonly displayName: string;
  readonly homeEnvironmentVariable?: string;
  readonly name: string;
  readonly portableDirectories: readonly PortableDirectory[];
  readonly portableFiles: readonly PortableFile[];
  readonly repositoryDirectory: string;
  readonly verificationCommand?: {
    readonly arguments: readonly string[];
    readonly command: string;
  };
}

const GROK_PROFILE: NativeProfile = {
  description: "Portable user configuration, skills, and executable hooks for Grok Build.",
  displayName: "Grok Build",
  homeEnvironmentVariable: "GROK_HOME",
  name: "grok",
  portableDirectories: [
    { relativePath: "skills", risk: "active" },
    { relativePath: "hooks", risk: "active" },
  ],
  portableFiles: [
    { relativePath: "config.toml", risk: "configuration", scanForSecrets: true },
    { relativePath: "sandbox.toml", risk: "active" },
  ],
  repositoryDirectory: ".grok",
  verificationCommand: { arguments: ["inspect"], command: "grok" },
};

const AGENT_SKILLS_PROFILE: NativeProfile = {
  description: "Open Agent Skills and commands shared natively by compatible harnesses.",
  displayName: "Shared agent assets",
  name: "agent-skills",
  portableDirectories: [
    { relativePath: "skills", risk: "active" },
    { relativePath: "commands", risk: "active" },
  ],
  portableFiles: [],
  repositoryDirectory: ".agents",
};

export const NATIVE_PROFILES: readonly NativeProfile[] = [GROK_PROFILE, AGENT_SKILLS_PROFILE];

export function findNativeProfile(name: string): NativeProfile {
  const profile = NATIVE_PROFILES.find((candidate) => candidate.name === name);
  if (profile === undefined) {
    const supported = NATIVE_PROFILES.map((candidate) => candidate.name).join(", ");
    throw new AppError(
      `Unknown profile '${name}'. Supported profiles: ${supported}`,
      "UNKNOWN_PROFILE",
    );
  }
  return profile;
}

export function liveDirectoryFor(
  profile: NativeProfile,
  paths: AppPaths,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const variable = profile.homeEnvironmentVariable;
  if (variable !== undefined) {
    const configured = environment[variable];
    if (configured !== undefined && configured.trim() !== "") {
      return resolve(configured);
    }
  }
  return join(paths.homeDirectory, profile.repositoryDirectory);
}

function normalized(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function riskForPath(profile: NativeProfile, relativePath: string): EntryRisk | undefined {
  const candidate = normalized(relativePath);
  const file = profile.portableFiles.find((entry) => entry.relativePath === candidate);
  if (file !== undefined) {
    return file.risk;
  }
  const directory = profile.portableDirectories.find(
    (entry) => candidate === entry.relativePath || candidate.startsWith(`${entry.relativePath}/`),
  );
  return directory?.risk;
}

export function isPortablePath(profile: NativeProfile, relativePath: string): boolean {
  return riskForPath(profile, relativePath) !== undefined;
}

export function shouldScanForSecrets(profile: NativeProfile, relativePath: string): boolean {
  const candidate = normalized(relativePath);
  return profile.portableFiles.some(
    (entry) => entry.relativePath === candidate && entry.scanForSecrets === true,
  );
}

export function profileIgnoreContents(profile: NativeProfile): string {
  const lines = [
    "# agent-man allowlist. Add patterns to narrow this surface; built-in rules cannot be widened.",
    "*",
    "!.gitignore",
  ];
  for (const file of profile.portableFiles) {
    lines.push(`!${file.relativePath}`);
  }
  for (const directory of profile.portableDirectories) {
    lines.push(`!${directory.relativePath}/`, `!${directory.relativePath}/**`);
  }
  lines.push("**/.DS_Store", "**/Thumbs.db");
  return `${lines.join("\n")}\n`;
}

// Compatibility aliases are intentionally not exported. A profile is a native configuration
// surface, not a promise that an entire harness home directory is portable.
