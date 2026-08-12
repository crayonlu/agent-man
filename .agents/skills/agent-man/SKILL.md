---
name: agent-man
description: Install, inspect, plan, synchronize, back up, and restore native AI agent configuration surfaces with agent-man and Git. Use when asked to keep Grok Build configuration or shared Agent Skills consistent across devices, to install agent-man for another agent, or to diagnose an agent-man repository. Do not use for cross-harness conversion, arbitrary dotfiles, project-local configuration, credentials, sessions, history, logs, caches, trust state, or provider switching.
---

# Agent Man

Use the `agent-man` executable as the only configuration interface. It preserves each profile's
native files and never invents a shared schema or translates between harnesses.

## Safety contract

- Run `agent-man profiles --json`, `agent-man doctor --json`, and `agent-man plan --json` before a
  first or risky synchronization. Summarize its capture, internal commit, and remote apply paths
  without opening file contents.
- A built-in profile allowlist is the maximum management boundary. `.gitignore` may narrow that
  boundary; never edit it merely to make an unsupported path synchronize.
- Treat `active` entries such as skills, commands, and hooks as executable code. Tell the user when
  a plan changes them.
- Internal relative symbolic links are portable. Absolute, external, broken, and out-of-profile
  links are device-local bindings: do not follow, replace, upload, or work around them. Stop if a
  stored link would resolve through a local binding on this device.
- Keep the Git repository private. GitHub is transport and history, not a secret manager. Use
  environment-variable references, `env_key`, or `bearer_token_env_var`; never request or print a
  token.
- Do not force-push, auto-resolve a conflict, stage arbitrary files in the internal repository, or
  claim success until `agent-man sync --json` succeeds and `agent-man status --json` is clean.

## Install the CLI

First check `node --version`, `git --version`, `agent-man --version`, and, for the default GitHub
flow, `gh auth status`. Node.js 22 or newer is required.

If the CLI is absent, ask before installing global software, then install directly from the official
GitHub repository:

```bash
npm install --global git+https://github.com/crayonlu/agent-man.git
agent-man --version
```

Never ask for a GitHub token. Ask the user to complete `gh auth login` themselves when needed.

To make this skill available outside the source repository, use the common Agent Skills location:

```bash
agent-man skill install --target agents
```

Claude Code uses its own user directory:

```bash
agent-man skill install --target claude
```

Use `--target all` only when the user deliberately wants both copies. Use `--force` only after
showing that an existing entry differs; replacement removes the entry itself and never follows a
target symlink.

## Initialize storage

Before creating a repository, confirm the intended GitHub owner/name because this is an external
write. The normal flow creates a private repository from the official template or verifies that an
existing repository is private:

```bash
agent-man init --github agent-man-config
```

For a non-GitHub remote whose privacy the CLI cannot verify:

```bash
agent-man init --remote <git-url>
```

On an additional device, `init` validates and transactionally applies already tracked profiles. Do
not run `add` for a profile already present in the cloned repository.

## Enable a native profile

List the supported roots and exact allowlists:

```bash
agent-man profiles --json
```

Then enable only the requested profile. `grok` uses `$GROK_HOME` or `~/.grok`; `agent-skills` uses
`~/.agents`:

```bash
agent-man add grok
# or
agent-man add agent-skills
```

After `add`, perform the standard gate:

```bash
agent-man doctor --json
agent-man plan --json
agent-man sync --json
agent-man status --json
```

Stop if `doctor` returns an error, if any of the plan's three path groups contains an unexpected
path, or if an `active` change was not requested. Local bindings reported as warnings are protected,
not failures.

## Routine synchronization

```bash
agent-man doctor --json
agent-man plan --json
agent-man sync --json
agent-man status --json
```

Sync captures native files, commits only known profile/control paths, validates fetched Git objects
before merge, validates the complete merged index, creates one journaled transaction backup, applies
the merged tree, and pushes. A merge conflict leaves all live profile files untouched. An
interrupted prior apply is rolled back before a new mutating command continues. Report conflict
paths and let the user decide how to resolve them inside the private path printed by the CLI.

## Restore

List rollback points without reading their contents:

```bash
agent-man backups --json
agent-man restore <backup-id> --json
agent-man plan --json
```

Restore creates a new pre-restore safety backup. It changes the native surface, not Git history; the
following plan shows what a later sync would capture.
