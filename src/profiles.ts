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

export interface PortableFilePattern {
  /** A simple `*`/`?` glob matched against a profile-relative path. */
  readonly glob: string;
  readonly risk: EntryRisk;
  readonly scanForSecrets?: boolean;
}

export interface NativeProfile {
  readonly description: string;
  readonly displayName: string;
  /** Relative to the user's home directory when no override is set. */
  readonly defaultHomeDirectory?: string;
  readonly homeEnvironmentVariable?: string;
  /** Appended to a configured home environment variable, for XDG-style roots. */
  readonly homeEnvironmentSubdirectory?: string;
  readonly name: string;
  readonly portableDirectories: readonly PortableDirectory[];
  readonly portableFiles: readonly PortableFile[];
  readonly portableFilePatterns?: readonly PortableFilePattern[];
  readonly repositoryDirectory: string;
  readonly verificationCommand?: {
    readonly arguments: readonly string[];
    readonly command: string;
  };
}

const GROK_PROFILE: NativeProfile = {
  description:
    "Portable Grok Build user configuration, rules, skills, agents, personas, and hooks.",
  displayName: "Grok Build",
  homeEnvironmentVariable: "GROK_HOME",
  name: "grok",
  portableDirectories: [
    { relativePath: "agents", risk: "active" },
    { relativePath: "skills", risk: "active" },
    { relativePath: "hooks", risk: "active" },
    { relativePath: "personas", risk: "active" },
  ],
  portableFiles: [
    { relativePath: "config.toml", risk: "configuration", scanForSecrets: true },
    { relativePath: "sandbox.toml", risk: "active" },
    { relativePath: "lsp.json", risk: "configuration", scanForSecrets: true },
    { relativePath: "AGENTS.md", risk: "active" },
  ],
  repositoryDirectory: ".grok",
  verificationCommand: { arguments: ["inspect"], command: "grok" },
};

const CLAUDE_CODE_PROFILE: NativeProfile = {
  defaultHomeDirectory: ".claude",
  description:
    "Portable Claude Code authored instructions, settings, skills, commands, agents, workflows, and themes.",
  displayName: "Claude Code",
  homeEnvironmentVariable: "CLAUDE_CONFIG_DIR",
  name: "claude-code",
  portableDirectories: [
    { relativePath: "agents", risk: "active" },
    { relativePath: "commands", risk: "active" },
    { relativePath: "output-styles", risk: "active" },
    { relativePath: "rules", risk: "active" },
    { relativePath: "skills", risk: "active" },
    { relativePath: "themes", risk: "configuration" },
    { relativePath: "workflows", risk: "active" },
  ],
  portableFiles: [
    { relativePath: "CLAUDE.md", risk: "active" },
    { relativePath: "keybindings.json", risk: "configuration" },
    { relativePath: "settings.json", risk: "active", scanForSecrets: true },
  ],
  repositoryDirectory: ".claude-code",
  verificationCommand: { arguments: ["--version"], command: "claude" },
};

const CODEX_PROFILE: NativeProfile = {
  defaultHomeDirectory: ".codex",
  description:
    "Portable Codex user configuration, global AGENTS instructions, and named config profiles.",
  displayName: "Codex",
  homeEnvironmentVariable: "CODEX_HOME",
  name: "codex",
  portableDirectories: [],
  portableFiles: [
    { relativePath: "AGENTS.md", risk: "active" },
    { relativePath: "AGENTS.override.md", risk: "active" },
    { relativePath: "config.toml", risk: "active", scanForSecrets: true },
  ],
  portableFilePatterns: [{ glob: "*.config.toml", risk: "active", scanForSecrets: true }],
  repositoryDirectory: ".codex",
  verificationCommand: { arguments: ["--version"], command: "codex" },
};

const OPENCODE_PROFILE: NativeProfile = {
  defaultHomeDirectory: ".config/opencode",
  description:
    "Portable OpenCode global config, instructions, agents, commands, skills, and themes.",
  displayName: "OpenCode",
  homeEnvironmentSubdirectory: "opencode",
  homeEnvironmentVariable: "XDG_CONFIG_HOME",
  name: "opencode",
  portableDirectories: [
    { relativePath: "agents", risk: "active" },
    { relativePath: "commands", risk: "active" },
    { relativePath: "skills", risk: "active" },
    { relativePath: "themes", risk: "configuration" },
  ],
  portableFiles: [
    { relativePath: "AGENTS.md", risk: "active" },
    { relativePath: "opencode.json", risk: "active", scanForSecrets: true },
    { relativePath: "opencode.jsonc", risk: "active", scanForSecrets: true },
    { relativePath: "tui.json", risk: "configuration" },
  ],
  repositoryDirectory: ".opencode",
  verificationCommand: { arguments: ["--version"], command: "opencode" },
};

const PI_PROFILE: NativeProfile = {
  defaultHomeDirectory: ".pi/agent",
  description:
    "Portable Pi user settings, extensions, skills, prompt templates, and themes (not packages or sessions).",
  displayName: "Pi",
  homeEnvironmentVariable: "PI_CODING_AGENT_DIR",
  name: "pi",
  portableDirectories: [
    { relativePath: "extensions", risk: "active" },
    { relativePath: "prompts", risk: "active" },
    { relativePath: "skills", risk: "active" },
    { relativePath: "themes", risk: "configuration" },
  ],
  portableFiles: [{ relativePath: "settings.json", risk: "active", scanForSecrets: true }],
  repositoryDirectory: ".pi-agent",
  verificationCommand: { arguments: ["--version"], command: "pi" },
};

const GEMINI_CLI_PROFILE: NativeProfile = {
  defaultHomeDirectory: ".gemini",
  description:
    "Portable Gemini CLI user settings, context, policies, agents, skills, and custom commands.",
  displayName: "Gemini CLI",
  homeEnvironmentSubdirectory: ".gemini",
  homeEnvironmentVariable: "GEMINI_CLI_HOME",
  name: "gemini-cli",
  portableDirectories: [
    { relativePath: "agents", risk: "active" },
    { relativePath: "commands", risk: "active" },
    { relativePath: "policies", risk: "active" },
    { relativePath: "skills", risk: "active" },
  ],
  portableFiles: [
    { relativePath: "GEMINI.md", risk: "active" },
    { relativePath: "keybindings.json", risk: "configuration" },
    { relativePath: "settings.json", risk: "active", scanForSecrets: true },
  ],
  repositoryDirectory: ".gemini",
  verificationCommand: { arguments: ["--version"], command: "gemini" },
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

export const NATIVE_PROFILES: readonly NativeProfile[] = [
  GROK_PROFILE,
  CLAUDE_CODE_PROFILE,
  CODEX_PROFILE,
  OPENCODE_PROFILE,
  PI_PROFILE,
  GEMINI_CLI_PROFILE,
  AGENT_SKILLS_PROFILE,
];

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
      const configuredRoot = resolve(configured);
      return profile.homeEnvironmentSubdirectory === undefined
        ? configuredRoot
        : join(configuredRoot, profile.homeEnvironmentSubdirectory);
    }
  }
  return join(paths.homeDirectory, profile.defaultHomeDirectory ?? profile.repositoryDirectory);
}

function normalized(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function globToRegularExpression(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", "[^/]*").replaceAll("?", "[^/]")}$`, "u");
}

function matchesPortableFilePattern(profile: NativeProfile, relativePath: string): boolean {
  const candidate = normalized(relativePath);
  return (profile.portableFilePatterns ?? []).some((pattern) =>
    globToRegularExpression(normalized(pattern.glob)).test(candidate),
  );
}

export function isPortableFile(profile: NativeProfile, relativePath: string): boolean {
  const candidate = normalized(relativePath);
  return (
    profile.portableFiles.some((entry) => entry.relativePath === candidate) ||
    matchesPortableFilePattern(profile, candidate)
  );
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
  if (directory !== undefined) {
    return directory.risk;
  }
  return profile.portableFilePatterns?.find((pattern) =>
    globToRegularExpression(normalized(pattern.glob)).test(candidate),
  )?.risk;
}

export function isPortablePath(profile: NativeProfile, relativePath: string): boolean {
  return riskForPath(profile, relativePath) !== undefined;
}

export function shouldScanForSecrets(profile: NativeProfile, relativePath: string): boolean {
  const candidate = normalized(relativePath);
  return (
    profile.portableFiles.some(
      (entry) => entry.relativePath === candidate && entry.scanForSecrets === true,
    ) ||
    (profile.portableFilePatterns ?? []).some(
      (pattern) =>
        pattern.scanForSecrets === true &&
        globToRegularExpression(normalized(pattern.glob)).test(candidate),
    )
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
  for (const pattern of profile.portableFilePatterns ?? []) {
    lines.push(`!/${pattern.glob}`);
  }
  for (const directory of profile.portableDirectories) {
    lines.push(`!${directory.relativePath}/`, `!${directory.relativePath}/**`);
  }
  lines.push("**/.DS_Store", "**/Thumbs.db");
  return `${lines.join("\n")}\n`;
}

// Compatibility aliases are intentionally not exported. A profile is a native configuration
// surface, not a promise that an entire harness home directory is portable.
