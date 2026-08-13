import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CommandContext,
  Output,
  addProfile,
  doctor,
  initialize,
  restore,
  showStatus,
  sync,
} from "../src/commands.js";
import { MAX_MANAGED_FILE_BYTES } from "../src/files.js";
import { resolveAppPaths } from "../src/paths.js";
import { findNativeProfile } from "../src/profiles.js";
import { runCommand } from "../src/process.js";
import { applyProfiles, validateReferenceScope } from "../src/repository.js";
import { resolveAgeIdentity } from "../src/secrets.js";

class MemoryOutput implements Output {
  public readonly messages: string[] = [];

  public info(message: string): void {
    this.messages.push(message);
  }
}

interface Device {
  readonly context: CommandContext;
  readonly environment: NodeJS.ProcessEnv;
  readonly grok: string;
  readonly identity: string;
  readonly shared: string;
}

const ageAvailable = (() => {
  try {
    runCommand("age", ["--version"]);
    runCommand("age-keygen", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

function makeDevice(root: string, name: string): Device {
  const home = join(root, `${name}-home`);
  const state = join(root, `${name}-state`);
  const grok = join(home, ".grok");
  const identityDirectory = join(root, `${name}-identity`);
  const identity = join(identityDirectory, "keys.txt");
  const shared = join(home, ".agents");
  mkdirSync(home, { mode: 0o700, recursive: true });
  mkdirSync(identityDirectory, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") {
    chmodSync(identityDirectory, 0o700);
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_MAN_AGE_IDENTITY_FILE: identity,
    AGENT_MAN_HOME: state,
    GROK_HOME: grok,
    HOME: home,
  };
  return {
    context: {
      environment,
      output: new MemoryOutput(),
      paths: resolveAppPaths(environment),
    },
    environment,
    grok,
    identity,
    shared,
  };
}

function generateIdentity(device: Device): void {
  runCommand("age-keygen", ["-o", device.identity], { env: device.environment });
  if (process.platform !== "win32") {
    chmodSync(device.identity, 0o600);
  }
}

function copyIdentity(source: Device, target: Device): void {
  copyFileSync(source.identity, target.identity);
  if (process.platform !== "win32") {
    chmodSync(target.identity, 0o600);
  }
}

function configureGit(repository: string): void {
  runCommand("git", ["config", "user.name", "Secrets Test"], { cwd: repository });
  runCommand("git", ["config", "user.email", "secrets@example.invalid"], { cwd: repository });
  runCommand("git", ["config", "commit.gpgSign", "false"], { cwd: repository });
}

function initializeWithRemote(device: Device, remote: string): void {
  initialize({ kind: "local" }, device.context);
  configureGit(device.context.paths.repositoryDirectory);
  runCommand("git", ["remote", "add", "origin", remote], {
    cwd: device.context.paths.repositoryDirectory,
  });
}

function tracked(repository: string): readonly string[] {
  return runCommand("git", ["ls-files"], { cwd: repository })
    .stdout.trim()
    .split("\n")
    .filter((path) => path !== "");
}

test(
  "shared age identity encrypts, applies, and updates secrets across isolated devices",
  { skip: !ageAvailable },
  () => {
    const root = mkdtempSync(join(tmpdir(), "agent-man-secrets-devices-"));
    try {
      const remote = join(root, "config.git");
      runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);

      const first = makeDevice(root, "first");
      generateIdentity(first);
      initializeWithRemote(first, remote);
      mkdirSync(first.grok, { recursive: true });
      writeFileSync(join(first.grok, "config.toml"), 'theme = "dark"\n');
      writeFileSync(join(first.grok, "secrets.env"), "TOKEN=first\n");
      addProfile("grok", first.context);
      sync(first.context);

      const repository = first.context.paths.repositoryDirectory;
      assert.equal(existsSync(join(repository, ".grok", "secrets.env.age")), true);
      assert.equal(
        readFileSync(join(repository, ".grok", "secrets.env.age"), "utf8").includes("TOKEN=first"),
        false,
      );
      assert.equal(tracked(repository).includes(".grok/secrets.env.age"), true);
      assert.equal(
        tracked(repository).some((path) => path.endsWith("/secrets.env")),
        false,
      );
      assert.equal(tracked(repository).includes(".age-recipient"), true);

      const second = makeDevice(root, "second");
      initialize({ kind: "remote", url: remote }, second.context);
      configureGit(second.context.paths.repositoryDirectory);
      assert.equal(existsSync(join(second.grok, "secrets.env")), false);
      copyIdentity(first, second);
      sync(second.context);
      assert.equal(readFileSync(join(second.grok, "secrets.env"), "utf8"), "TOKEN=first\n");

      writeFileSync(join(first.grok, "secrets.env"), "TOKEN=updated\n");
      sync(first.context);
      const update = sync(second.context);
      assert.equal(readFileSync(join(second.grok, "secrets.env"), "utf8"), "TOKEN=updated\n");
      assert.notEqual(update.backup, undefined);
      if (update.backup !== undefined) {
        restore(update.backup.id, second.context);
      }
      assert.equal(readFileSync(join(second.grok, "secrets.env"), "utf8"), "TOKEN=first\n");

      const opaque = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
      writeFileSync(join(second.grok, "secrets.env"), opaque);
      sync(second.context);
      sync(first.context);
      assert.deepEqual(readFileSync(join(first.grok, "secrets.env")), opaque);
      assert.equal(showStatus(first.context).profiles[0]?.changes.length, 0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("age identity lookup follows explicit, user, then state precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-secrets-identity-order-"));
  try {
    const home = join(root, "home");
    const state = join(root, "state");
    const explicitDirectory = join(root, "explicit");
    const explicit = join(explicitDirectory, "keys.txt");
    const standardDirectory = join(home, ".config", "age");
    const standard = join(standardDirectory, "keys.txt");
    const fallback = join(state, "age-keys.txt");
    for (const directory of [home, state, explicitDirectory, standardDirectory]) {
      mkdirSync(directory, { mode: 0o700, recursive: true });
      if (process.platform !== "win32") {
        chmodSync(directory, 0o700);
      }
    }
    for (const path of [explicit, standard, fallback]) {
      writeFileSync(path, "not-read-by-resolution\n", { mode: 0o600 });
      if (process.platform !== "win32") {
        chmodSync(path, 0o600);
      }
    }
    const baseEnvironment: NodeJS.ProcessEnv = { AGENT_MAN_HOME: state, HOME: home };
    const paths = resolveAppPaths(baseEnvironment);

    assert.deepEqual(
      resolveAgeIdentity(paths, {
        ...baseEnvironment,
        AGENT_MAN_AGE_IDENTITY_FILE: explicit,
      }),
      { kind: "ready", path: explicit },
    );
    rmSync(explicit);
    assert.deepEqual(resolveAgeIdentity(paths, baseEnvironment), {
      kind: "ready",
      path: standard,
    });
    rmSync(standard);
    assert.deepEqual(resolveAgeIdentity(paths, baseEnvironment), {
      kind: "ready",
      path: fallback,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  "profile ignore rules can disable the encrypted secret pair without deleting plaintext",
  { skip: !ageAvailable },
  () => {
    const root = mkdtempSync(join(tmpdir(), "agent-man-secrets-ignore-"));
    try {
      const device = makeDevice(root, "device");
      generateIdentity(device);
      initialize({ kind: "local" }, device.context);
      configureGit(device.context.paths.repositoryDirectory);
      mkdirSync(device.grok, { recursive: true });
      writeFileSync(join(device.grok, "secrets.env"), "TOKEN=local\n");
      addProfile("grok", device.context);
      sync(device.context);

      const repository = device.context.paths.repositoryDirectory;
      appendFileSync(join(repository, ".grok", ".gitignore"), "\nsecrets.env.age\n");
      sync(device.context);

      assert.equal(existsSync(join(repository, ".grok", "secrets.env.age")), false);
      assert.equal(tracked(repository).includes(".grok/secrets.env.age"), false);
      assert.equal(readFileSync(join(device.grok, "secrets.env"), "utf8"), "TOKEN=local\n");
      assert.equal(showStatus(device.context).profiles[0]?.changes.length, 0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "a failed profile add removes a recipient created by that attempt",
  { skip: !ageAvailable },
  () => {
    const root = mkdtempSync(join(tmpdir(), "agent-man-secrets-add-rollback-"));
    try {
      const device = makeDevice(root, "device");
      generateIdentity(device);
      initialize({ kind: "local" }, device.context);
      configureGit(device.context.paths.repositoryDirectory);
      mkdirSync(device.grok, { recursive: true });
      writeFileSync(join(device.grok, "secrets.env"), "TOKEN=private\n");
      writeFileSync(
        join(device.context.paths.repositoryDirectory, ".gitattributes"),
        "* filter=unexpected\n",
      );

      assert.throws(() => addProfile("grok", device.context), /text and eol behavior/);
      assert.equal(
        existsSync(join(device.context.paths.repositoryDirectory, ".age-recipient")),
        false,
      );
      assert.equal(existsSync(join(device.context.paths.repositoryDirectory, ".grok")), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "missing or mismatched identity protects secrets while ordinary sync continues",
  { skip: !ageAvailable },
  () => {
    const root = mkdtempSync(join(tmpdir(), "agent-man-secrets-protected-"));
    try {
      const remote = join(root, "config.git");
      runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);
      const first = makeDevice(root, "first");
      generateIdentity(first);
      initializeWithRemote(first, remote);
      mkdirSync(first.grok, { recursive: true });
      writeFileSync(join(first.grok, "config.toml"), "value = 1\n");
      writeFileSync(join(first.grok, "secrets.env"), "TOKEN=shared\n");
      addProfile("grok", first.context);
      sync(first.context);

      const missing = makeDevice(root, "missing");
      mkdirSync(missing.grok, { recursive: true });
      writeFileSync(join(missing.grok, "secrets.env"), "TOKEN=local-only\n");
      initialize({ kind: "remote", url: remote }, missing.context);
      configureGit(missing.context.paths.repositoryDirectory);
      assert.equal(readFileSync(join(missing.grok, "secrets.env"), "utf8"), "TOKEN=local-only\n");
      assert.equal(sync(missing.context).profiles[0]?.protectedSecrets, 1);
      assert.equal(
        doctor(missing.context).diagnostics.some(
          (item) => item.code === "SECRETS_IDENTITY_MISSING" && item.level === "warning",
        ),
        true,
      );

      const wrong = makeDevice(root, "wrong");
      generateIdentity(wrong);
      initialize({ kind: "remote", url: remote }, wrong.context);
      configureGit(wrong.context.paths.repositoryDirectory);
      assert.equal(existsSync(join(wrong.grok, "secrets.env")), false);
      assert.equal(sync(wrong.context).profiles[0]?.protectedSecrets, 1);
      assert.equal(
        doctor(wrong.context).diagnostics.some(
          (item) => item.code === "SECRETS_RECIPIENT_MISMATCH" && item.level === "error",
        ),
        true,
      );

      runCommand("git", ["rm", ".grok/secrets.env.age"], {
        cwd: first.context.paths.repositoryDirectory,
      });
      runCommand("git", ["commit", "-m", "Delete stored secret"], {
        cwd: first.context.paths.repositoryDirectory,
      });
      runCommand("git", ["push"], { cwd: first.context.paths.repositoryDirectory });
      const protectedDeletion = sync(missing.context);
      assert.equal(protectedDeletion.profiles[0]?.protectedSecrets, 1);
      assert.equal(readFileSync(join(missing.grok, "secrets.env"), "utf8"), "TOKEN=local-only\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("recipient controls and plaintext tracking are rejected without exposing secret values", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-secrets-controls-"));
  try {
    const device = makeDevice(root, "device");
    initialize({ kind: "local" }, device.context);
    configureGit(device.context.paths.repositoryDirectory);
    mkdirSync(join(device.context.paths.repositoryDirectory, ".grok"), { recursive: true });
    writeFileSync(
      join(device.context.paths.repositoryDirectory, ".grok", ".gitignore"),
      "*\n!.gitignore\n!secrets.env.age\n",
    );
    writeFileSync(join(device.context.paths.repositoryDirectory, ".age-recipient"), "invalid\n");
    assert.equal(
      doctor(device.context).diagnostics.some((item) => item.code === "SECRETS_RECIPIENT_INVALID"),
      true,
    );

    rmSync(join(device.context.paths.repositoryDirectory, ".age-recipient"));
    writeFileSync(
      join(device.context.paths.repositoryDirectory, ".grok", "secrets.env"),
      "TOKEN=do-not-print\n",
    );
    runCommand("git", ["add", "-f", ".grok/.gitignore", ".grok/secrets.env"], {
      cwd: device.context.paths.repositoryDirectory,
    });
    const report = doctor(device.context);
    assert.equal(
      report.diagnostics.some((item) => item.code === "INLINE_SECRET"),
      true,
    );
    assert.equal(
      report.diagnostics.some((item) => item.message.includes("do-not-print")),
      false,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a fetched tree containing a fake age payload is rejected before apply", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-man-secrets-fake-ciphertext-"));
  try {
    const device = makeDevice(root, "device");
    initialize({ kind: "local" }, device.context);
    const repository = device.context.paths.repositoryDirectory;
    configureGit(repository);
    mkdirSync(join(repository, ".grok"), { recursive: true });
    writeFileSync(join(repository, ".grok", ".gitignore"), "*\n!.gitignore\n!secrets.env.age\n");
    writeFileSync(
      join(repository, ".grok", "secrets.env.age"),
      "age-encryption.org/v1\nthis-is-not-an-age-stanza\n",
    );
    runCommand("git", ["add", "."], { cwd: repository });
    runCommand("git", ["commit", "-m", "Add fake ciphertext"], { cwd: repository });

    assert.throws(() => validateReferenceScope(repository, "HEAD"), /not a valid age file/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  "an open identity is diagnosed without printing private material",
  { skip: !ageAvailable || process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "agent-man-secrets-mode-"));
    try {
      const device = makeDevice(root, "device");
      generateIdentity(device);
      initialize({ kind: "local" }, device.context);
      configureGit(device.context.paths.repositoryDirectory);
      mkdirSync(device.grok, { recursive: true });
      writeFileSync(join(device.grok, "secrets.env"), "TOKEN=private\n");
      chmodSync(device.identity, 0o644);
      const report = doctor(device.context);
      assert.equal(
        report.diagnostics.some(
          (item) => item.code === "SECRETS_IDENTITY_OPEN" && item.level === "error",
        ),
        true,
      );
      assert.equal(
        report.diagnostics.some(
          (item) => item.code === "SECRETS_RECIPIENT_MISSING" && item.level === "warning",
        ),
        true,
      );
      assert.equal(
        report.diagnostics.some((item) => item.message.includes("TOKEN=private")),
        false,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "a later secrets apply failure rolls an earlier plaintext write back",
  { skip: !ageAvailable },
  () => {
    const root = mkdtempSync(join(tmpdir(), "agent-man-secrets-rollback-"));
    try {
      const device = makeDevice(root, "device");
      generateIdentity(device);
      initialize({ kind: "local" }, device.context);
      configureGit(device.context.paths.repositoryDirectory);
      mkdirSync(device.grok, { recursive: true });
      mkdirSync(device.shared, { recursive: true });
      writeFileSync(join(device.grok, "secrets.env"), "TOKEN=grok-new\n");
      writeFileSync(join(device.shared, "secrets.env"), "TOKEN=shared-new\n");
      addProfile("grok", device.context);
      addProfile("agent-skills", device.context);
      sync(device.context);
      writeFileSync(join(device.grok, "secrets.env"), "TOKEN=grok-old\n");
      writeFileSync(join(device.shared, "secrets.env"), "TOKEN=shared-old\n");

      let decryptions = 0;
      const failingRunner: typeof runCommand = (command, arguments_, options) => {
        if (command === "age" && arguments_[0] === "-d") {
          decryptions += 1;
          if (decryptions === 2) {
            return {
              status: 0,
              stderr: "",
              stdout: "",
              stdoutBytes: Buffer.alloc(MAX_MANAGED_FILE_BYTES + 1),
            };
          }
        }
        return runCommand(command, arguments_, options);
      };
      assert.throws(
        () =>
          applyProfiles(
            device.context.paths,
            [findNativeProfile("grok"), findNativeProfile("agent-skills")],
            [],
            device.environment,
            failingRunner,
          ),
        /rolled back/,
      );
      assert.equal(readFileSync(join(device.grok, "secrets.env"), "utf8"), "TOKEN=grok-old\n");
      assert.equal(readFileSync(join(device.shared, "secrets.env"), "utf8"), "TOKEN=shared-old\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);
