---
name: agent-man
description: Install, initialize, inspect, and run agent-man to synchronize one harness's native configuration across devices with Git. Use when asked to back up, restore, migrate, or sync Grok Build configuration, skills, hooks, or plugins without converting them to another harness. Do not use for cross-harness conversion or for syncing credentials, sessions, logs, cache, history, or project-local configuration.
---

# Agent Man

Use the `agent-man` executable as the single interface. It mirrors native files; never invent a
normalized schema or translate between harnesses.

## Safety boundary

- Before `init`, confirm the intended GitHub repository or Git remote. The default GitHub flow may
  create a private repository, which is an external write.
- Before `add grok` or the first `sync`, show the user the live directory and run `agent-man status`.
  `$GROK_HOME` takes precedence over `~/.grok`.
- Never edit `.gitignore` merely to make more files sync. Ask before changing the management
  boundary.
- Never add credential or runtime paths. Agent-man always blocks Grok's `auth.json`,
  `mcp_credentials.json`, `bin/`, `cache/`, `crash/`, `logs/`, `sessions/`, and `tmp/`.
- Warn before the first sync that agent-man cannot detect a secret embedded inside an otherwise
  managed file. Prefer environment-variable references; do not open files to inspect them unless
  the user asks.
- Do not force-push or bypass a Git conflict. Report conflicts and their repository location.
- Do not claim a sync succeeded until the command exits successfully and `agent-man status` is
  clean.

## Install

Check for Node.js 22+, Git, GitHub CLI, and `agent-man` first. If `agent-man` is absent, ask before
installing software, then use:

```bash
npm install --global git+https://github.com/crayonlu/agent-man.git
agent-man --version
```

For the default GitHub flow, verify `gh auth status`. Ask the user to complete `gh auth login` when
needed; never request or print their token.

## Initialize

For a first or additional device using GitHub:

```bash
agent-man init --github agent-man-config
```

This creates a private repository from the official template only when the repository does not
already exist. To use another Git remote:

```bash
agent-man init --remote <git-url>
```

Do not run `agent-man add grok` on an additional device whose cloned repository already contains
`.grok/`; initialization applies the clean tracked configuration automatically.

## Start managing Grok

On the first device:

```bash
agent-man status
agent-man add grok
agent-man status
agent-man sync
agent-man status
```

Summarize which files were captured without revealing file contents or secrets.

## Routine sync

```bash
agent-man status
agent-man sync
agent-man status
```

Agent-man backs up replaced or deleted files under `~/.agent-man/backups`. When a merge conflict
occurs, leave live harness files untouched, show the conflict paths, and ask the user to choose the
desired content before resolving files inside `~/.agent-man/repo`.
