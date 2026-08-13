import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { AppError } from "./errors.js";
import {
  MAX_MANAGED_FILE_BYTES,
  TreeEntry,
  managedPathExists,
  pathInside,
  readManagedFile,
  removeManagedPath,
  resolveManagedRoot,
  writeBufferAtomic,
} from "./files.js";
import { AppPaths } from "./paths.js";
import { NativeProfile, liveDirectoryFor } from "./profiles.js";
import { CommandRunner, executableAvailable, runCommand } from "./process.js";

export const AGE_RECIPIENT_PATH = ".age-recipient";

export type SecretChangeKind = "added" | "modified";
export type SecretProtectionReason =
  "age-unavailable" | "decrypt-failed" | "identity-missing" | "identity-mismatch";

export interface SecretPairState {
  readonly active: boolean;
  readonly change?: SecretChangeKind;
  readonly protectedReason?: SecretProtectionReason;
}

export interface SecretApplyAction {
  readonly contents?: Buffer;
  readonly currentEntry?: TreeEntry;
  readonly liveRoot: string;
  readonly operation: "delete" | "write";
  readonly profile: NativeProfile;
  readonly relativePath: string;
}

export interface SecretApplyPlan {
  readonly action?: SecretApplyAction;
  readonly protectedReason?: SecretProtectionReason;
}

export type AgeIdentity =
  { readonly kind: "missing" } | { readonly kind: "ready"; readonly path: string };

interface ReadySecretContext {
  readonly identityPath: string;
  readonly recipient: string;
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: readonly number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const high = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < generators.length; index += 1) {
      const generator = generators[index];
      if (((high >>> index) & 1) !== 0 && generator !== undefined) {
        checksum ^= generator;
      }
    }
  }
  return checksum;
}

function validX25519Recipient(recipient: string): boolean {
  if (
    !recipient.startsWith("age1") ||
    recipient.length !== 62 ||
    recipient !== recipient.toLowerCase()
  ) {
    return false;
  }
  const separator = recipient.lastIndexOf("1");
  if (separator !== 3) {
    return false;
  }
  const values: number[] = [];
  for (const character of "age") {
    values.push(character.charCodeAt(0) >>> 5);
  }
  values.push(0);
  for (const character of "age") {
    values.push(character.charCodeAt(0) & 31);
  }
  for (const character of recipient.slice(separator + 1)) {
    const value = BECH32_CHARSET.indexOf(character);
    if (value < 0) {
      return false;
    }
    values.push(value);
  }
  return bech32Polymod(values) === 1;
}

export function parseAgeRecipient(contents: string): string {
  if (contents.includes("\0") || contents.includes("�")) {
    throw new AppError(
      `Repository control '${AGE_RECIPIENT_PATH}' is not valid UTF-8 text.`,
      "SECRETS_RECIPIENT_INVALID",
    );
  }
  const trimmed = contents.trim();
  const lines = trimmed === "" ? [] : trimmed.split(/\r?\n/u);
  const recipient = lines[0];
  if (lines.length !== 1 || recipient === undefined || !validX25519Recipient(recipient)) {
    throw new AppError(
      `Repository control '${AGE_RECIPIENT_PATH}' must contain exactly one valid age X25519 recipient.`,
      "SECRETS_RECIPIENT_INVALID",
    );
  }
  return recipient;
}

export function readAgeRecipient(repository: string): string | undefined {
  const repositoryRoot = resolveManagedRoot(repository);
  const absolutePath = pathInside(repositoryRoot, AGE_RECIPIENT_PATH);
  if (!managedPathExists(absolutePath)) {
    return undefined;
  }
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AppError(
      `Repository control '${AGE_RECIPIENT_PATH}' must be a real regular file.`,
      "SECRETS_RECIPIENT_INVALID",
    );
  }
  return parseAgeRecipient(readManagedFile(repositoryRoot, AGE_RECIPIENT_PATH).toString("utf8"));
}

export function validateAgeCiphertext(contents: Buffer, label: string): void {
  const marker = Buffer.from("\n--- ", "ascii");
  const markerOffset = contents.indexOf(marker);
  if (markerOffset < 0) {
    throw new AppError(
      `Encrypted secrets file '${label}' is not a valid age file.`,
      "SECRETS_CIPHERTEXT_INVALID",
    );
  }
  const headerEnd = contents.indexOf(0x0a, markerOffset + marker.byteLength);
  if (headerEnd < 0 || contents.byteLength - (headerEnd + 1) < 32) {
    throw new AppError(
      `Encrypted secrets file '${label}' is not a valid age file.`,
      "SECRETS_CIPHERTEXT_INVALID",
    );
  }
  const header = contents.subarray(0, headerEnd).toString("ascii");
  const lines = header.split("\n");
  if (
    lines.length !== 4 ||
    lines[0] !== "age-encryption.org/v1" ||
    !/^-> X25519 [A-Za-z0-9+/]{43}$/u.test(lines[1] ?? "") ||
    !/^[A-Za-z0-9+/]{43}$/u.test(lines[2] ?? "") ||
    !/^--- [A-Za-z0-9+/]{43}$/u.test(lines[3] ?? "")
  ) {
    throw new AppError(
      `Encrypted secrets file '${label}' is not a valid age file.`,
      "SECRETS_CIPHERTEXT_INVALID",
    );
  }
}

function identityCandidates(paths: AppPaths, environment: NodeJS.ProcessEnv): readonly string[] {
  const configured = environment.AGENT_MAN_AGE_IDENTITY_FILE;
  if (configured !== undefined && configured.trim() !== "") {
    return [resolve(configured)];
  }
  return [
    join(paths.homeDirectory, ".config", "age", "keys.txt"),
    join(paths.stateDirectory, "age-keys.txt"),
  ];
}

function assertPrivateIdentity(path: string): void {
  const file = lstatSync(path);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new AppError(
      "The configured age identity must be a real regular file.",
      "SECRETS_IDENTITY_OPEN",
    );
  }
  const parentPath = dirname(path);
  const parent = lstatSync(parentPath);
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new AppError(
      "The age identity parent must be a real private directory.",
      "SECRETS_IDENTITY_OPEN",
    );
  }
  if (
    process.platform !== "win32" &&
    ((file.mode & 0o7777) !== 0o600 || (parent.mode & 0o077) !== 0)
  ) {
    throw new AppError(
      "The age identity must use mode 0600 and its containing directory must not be accessible by group or others.",
      "SECRETS_IDENTITY_OPEN",
    );
  }
}

export function resolveAgeIdentity(
  paths: AppPaths,
  environment: NodeJS.ProcessEnv = process.env,
): AgeIdentity {
  for (const candidate of identityCandidates(paths, environment)) {
    if (!managedPathExists(candidate)) {
      continue;
    }
    assertPrivateIdentity(candidate);
    return { kind: "ready", path: candidate };
  }
  return { kind: "missing" };
}

export function ageToolsAvailable(environment: NodeJS.ProcessEnv = process.env): boolean {
  return executableAvailable("age", environment) && executableAvailable("age-keygen", environment);
}

function resultBytes(result: ReturnType<CommandRunner>): Buffer {
  return result.stdoutBytes ?? Buffer.from(result.stdout, "utf8");
}

export function deriveAgeRecipient(
  identityPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): string {
  let output: string;
  try {
    output = runner("age-keygen", ["-y", identityPath], { env: environment }).stdout.trim();
  } catch {
    throw new AppError(
      "Could not derive an age recipient from the local identity.",
      "SECRETS_IDENTITY_INVALID",
    );
  }
  try {
    return parseAgeRecipient(output);
  } catch {
    throw new AppError(
      "Could not derive an age recipient from the local identity.",
      "SECRETS_IDENTITY_INVALID",
    );
  }
}

function encryptSecret(
  plaintext: Buffer,
  recipient: string,
  environment: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Buffer {
  try {
    const result = runner("age", ["-e", "-r", recipient], { env: environment, input: plaintext });
    const ciphertext = resultBytes(result);
    validateAgeCiphertext(ciphertext, "stored secret");
    return ciphertext;
  } catch (error) {
    if (error instanceof AppError && error.code === "SECRETS_CIPHERTEXT_INVALID") {
      throw error;
    }
    throw new AppError("Could not encrypt the native secrets file.", "SECRETS_ENCRYPT_FAILED");
  }
}

function decryptSecret(
  ciphertext: Buffer,
  identityPath: string,
  environment: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Buffer {
  try {
    return resultBytes(
      runner("age", ["-d", "-i", identityPath], { env: environment, input: ciphertext }),
    );
  } catch {
    throw new AppError("Could not decrypt the stored secrets file.", "SECRETS_DECRYPT_FAILED");
  }
}

export function nativeSecretEntry(root: string, profile: NativeProfile): TreeEntry | undefined {
  const definition = profile.secretsFile;
  if (definition === undefined) {
    return undefined;
  }
  const physicalRoot = resolveManagedRoot(root);
  const absolutePath = pathInside(physicalRoot, definition.native);
  if (!managedPathExists(absolutePath)) {
    return undefined;
  }
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MANAGED_FILE_BYTES) {
    throw new AppError(
      "The native secrets path must be a size-limited regular file.",
      "SECRETS_NATIVE_UNSAFE",
    );
  }
  return {
    kind: "file",
    mode: stat.mode & 0o777,
    relativePath: definition.native,
    risk: definition.risk,
    size: stat.size,
  };
}

function nativeSecretContents(root: string, profile: NativeProfile): Buffer | undefined {
  const entry = nativeSecretEntry(root, profile);
  return entry === undefined
    ? undefined
    : readManagedFile(resolveManagedRoot(root), entry.relativePath);
}

function storedSecretContents(repository: string, profile: NativeProfile): Buffer | undefined {
  const definition = profile.secretsFile;
  if (definition === undefined) {
    return undefined;
  }
  const root = resolveManagedRoot(join(repository, profile.repositoryDirectory));
  const absolutePath = pathInside(root, definition.stored);
  if (!managedPathExists(absolutePath)) {
    return undefined;
  }
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MANAGED_FILE_BYTES) {
    throw new AppError(
      "The stored secrets path must be a size-limited regular file.",
      "SECRETS_CIPHERTEXT_INVALID",
    );
  }
  const contents = readManagedFile(root, definition.stored);
  validateAgeCiphertext(contents, `${profile.name}/${definition.stored}`);
  return contents;
}

function secretPairIgnored(
  repository: string,
  profile: NativeProfile,
  runner: CommandRunner,
): boolean {
  const definition = profile.secretsFile;
  if (definition === undefined) {
    return false;
  }
  const repositoryPath = `${profile.repositoryDirectory}/${definition.stored}`;
  const result = runner("git", ["check-ignore", "--no-index", "--quiet", "--", repositoryPath], {
    acceptedExitCodes: [0, 1],
    cwd: repository,
  });
  return result.status === 0;
}

export function secretPairActive(
  paths: AppPaths,
  profile: NativeProfile,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): boolean {
  if (
    profile.secretsFile === undefined ||
    secretPairIgnored(paths.repositoryDirectory, profile, runner)
  ) {
    return false;
  }
  const liveRoot = liveDirectoryFor(profile, paths, environment);
  return (
    nativeSecretEntry(liveRoot, profile) !== undefined ||
    storedSecretContents(paths.repositoryDirectory, profile) !== undefined
  );
}

function readyContext(
  paths: AppPaths,
  environment: NodeJS.ProcessEnv,
  runner: CommandRunner,
): ReadySecretContext | SecretProtectionReason {
  if (!ageToolsAvailable(environment)) {
    return "age-unavailable";
  }
  const identity = resolveAgeIdentity(paths, environment);
  if (identity.kind === "missing") {
    return "identity-missing";
  }
  let derived: string;
  try {
    derived = deriveAgeRecipient(identity.path, environment, runner);
  } catch {
    return "identity-mismatch";
  }
  const configured = readAgeRecipient(paths.repositoryDirectory);
  if (configured !== undefined && configured !== derived) {
    return "identity-mismatch";
  }
  return { identityPath: identity.path, recipient: configured ?? derived };
}

function isReadyContext(
  value: ReadySecretContext | SecretProtectionReason,
): value is ReadySecretContext {
  return typeof value !== "string";
}

export function inspectSecretPair(
  paths: AppPaths,
  profile: NativeProfile,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): SecretPairState {
  const definition = profile.secretsFile;
  if (definition === undefined) {
    return { active: false };
  }
  if (secretPairIgnored(paths.repositoryDirectory, profile, runner)) {
    return { active: false };
  }
  const liveRoot = liveDirectoryFor(profile, paths, environment);
  const native = nativeSecretContents(liveRoot, profile);
  const stored = storedSecretContents(paths.repositoryDirectory, profile);
  if (native === undefined && stored === undefined) {
    return { active: false };
  }
  const context = readyContext(paths, environment, runner);
  if (!isReadyContext(context)) {
    return { active: true, protectedReason: context };
  }
  if (stored === undefined) {
    return native === undefined ? { active: true } : { active: true, change: "added" };
  }
  let decrypted: Buffer;
  try {
    decrypted = decryptSecret(stored, context.identityPath, environment, runner);
  } catch {
    return { active: true, protectedReason: "decrypt-failed" };
  }
  return native !== undefined && !native.equals(decrypted)
    ? { active: true, change: "modified" }
    : { active: true };
}

export function captureSecretPair(
  paths: AppPaths,
  profile: NativeProfile,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): SecretPairState {
  const state = inspectSecretPair(paths, profile, environment, runner);
  const definition = profile.secretsFile;
  if (
    definition === undefined ||
    state.change === undefined ||
    state.protectedReason !== undefined
  ) {
    return state;
  }
  const context = readyContext(paths, environment, runner);
  if (!isReadyContext(context)) {
    return { active: true, protectedReason: context };
  }
  const liveRoot = liveDirectoryFor(profile, paths, environment);
  const plaintext = nativeSecretContents(liveRoot, profile);
  if (plaintext === undefined) {
    return { active: true };
  }
  const ciphertext = encryptSecret(plaintext, context.recipient, environment, runner);
  if (readAgeRecipient(paths.repositoryDirectory) === undefined) {
    writeBufferAtomic(
      resolveManagedRoot(paths.repositoryDirectory),
      AGE_RECIPIENT_PATH,
      `${context.recipient}\n`,
      0o644,
    );
  }
  const repositoryRoot = resolveManagedRoot(
    join(paths.repositoryDirectory, profile.repositoryDirectory),
    true,
  );
  writeBufferAtomic(repositoryRoot, definition.stored, ciphertext, 0o644);
  return state;
}

export function planSecretApply(
  paths: AppPaths,
  profile: NativeProfile,
  deletedRepositoryPaths: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): SecretApplyPlan {
  const definition = profile.secretsFile;
  if (definition === undefined) {
    return {};
  }
  if (secretPairIgnored(paths.repositoryDirectory, profile, runner)) {
    return {};
  }
  const repositoryPath = `${profile.repositoryDirectory}/${definition.stored}`;
  const deleted = deletedRepositoryPaths.includes(repositoryPath);
  const liveDirectory = liveDirectoryFor(profile, paths, environment);
  const currentEntry = nativeSecretEntry(liveDirectory, profile);
  const stored = storedSecretContents(paths.repositoryDirectory, profile);
  if (currentEntry === undefined && stored === undefined && !deleted) {
    return {};
  }
  const context = readyContext(paths, environment, runner);
  if (!isReadyContext(context)) {
    return { protectedReason: context };
  }
  const liveRoot = resolveManagedRoot(liveDirectory, stored !== undefined);
  if (stored === undefined) {
    return deleted && currentEntry !== undefined
      ? {
          action: {
            currentEntry,
            liveRoot,
            operation: "delete",
            profile,
            relativePath: definition.native,
          },
        }
      : {};
  }
  let plaintext: Buffer;
  try {
    plaintext = decryptSecret(stored, context.identityPath, environment, runner);
  } catch {
    return { protectedReason: "decrypt-failed" };
  }
  const current =
    currentEntry === undefined ? undefined : readManagedFile(liveRoot, currentEntry.relativePath);
  if (current !== undefined && current.equals(plaintext)) {
    return {};
  }
  return {
    action: {
      contents: plaintext,
      currentEntry,
      liveRoot,
      operation: "write",
      profile,
      relativePath: definition.native,
    },
  };
}

export function executeSecretActions(actions: readonly SecretApplyAction[]): void {
  for (const action of actions) {
    if (action.operation === "delete") {
      const absolutePath = pathInside(action.liveRoot, action.relativePath);
      if (managedPathExists(absolutePath)) {
        const stat = lstatSync(absolutePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new AppError(
            "The native secrets path changed type during apply.",
            "SECRETS_NATIVE_UNSAFE",
          );
        }
      }
      removeManagedPath(resolveManagedRoot(action.liveRoot), action.relativePath);
      continue;
    }
    if (action.contents === undefined) {
      throw new AppError("Secrets apply plan is missing decrypted contents.", "APPLY_PLAN_INVALID");
    }
    if (action.contents.byteLength > MAX_MANAGED_FILE_BYTES) {
      throw new AppError(
        "The decrypted secrets file exceeds the managed file size limit.",
        "FILE_TOO_LARGE",
      );
    }
    writeBufferAtomic(action.liveRoot, action.relativePath, action.contents, 0o600);
  }
}
