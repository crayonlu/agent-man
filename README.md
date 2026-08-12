# agent-man

`agent-man` synchronizes the native configuration directory of an AI coding harness across devices.
It deliberately does not translate configuration between harnesses.

The design has three moving parts:

- GitHub Template creates a safe, private configuration repository.
- Git provides history, text merges, transport, and ignore matching.
- `agent-man` copies managed files between that repository and the harness's native directory.

No database, daemon, web service, GitHub SDK, or normalized configuration schema is involved.

> **Status:** early MVP. Grok Build is the first supported harness.

## Requirements

- Node.js 22 or newer
- Git
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login` for the default flow

## Install from source

```bash
git clone https://github.com/crayonlu/agent-man.git
cd agent-man
npm install
npm run build
npm link
```

## First device

```bash
# Creates agent-man-config under the authenticated GitHub account.
# Omit the name to use agent-man-config under the authenticated account.
agent-man init --github agent-man-config

agent-man add grok
agent-man sync
```

`init --github` asks `gh` whether the repository already exists. If it does not, `gh` creates a
**private** repository from
[`crayonlu/agent-man-config-template`](https://github.com/crayonlu/agent-man-config-template). If it
does exist, the same command simply clones it.

## Additional devices

Install `agent-man`, then run the same initialization command:

```bash
agent-man init --github agent-man-config
```

The cloned Git state is applied only after a clean checkout. Existing managed files are backed up
before replacement. Authentication, sessions, logs, and other ignored paths remain local.

Any Git remote can be used without GitHub:

```bash
agent-man init --remote git@example.com:me/agent-man-config.git
```

## Daily use

```bash
agent-man status
agent-man sync
```

`sync` performs the following sequence:

1. Capture native harness files into `~/.agent-man/repo`.
2. Commit local changes.
3. Fetch and merge the Git upstream.
4. Stop on conflicts without touching the live harness directory.
5. Back up and apply the clean merged tree.
6. Push normally; never force-push.

If Git reports a conflict, resolve it inside `~/.agent-man/repo`, run `git add` for the resolved
files, then rerun `agent-man sync`.

## What is synchronized

The configuration repository mirrors standard paths below the user's home directory:

```text
agent-man-config/
├── .gitignore
└── .grok/
    ├── config.toml
    ├── hooks/
    ├── plugins/
    └── skills/
```

For Grok Build, `$GROK_HOME` overrides the live `~/.grok` path. Repository storage remains `.grok/`
so every device shares the same Git layout.

The repository's `.gitignore` is also agent-man's user-editable management boundary. Ignored paths
are not captured, overwritten, or deleted. Known credential and runtime paths are additionally
blocked by the built-in Grok profile even if `.gitignore` is edited:

```text
auth.json
mcp_credentials.json
bin/
cache/
crash/
logs/
sessions/
tmp/
```

Keep the configuration repository private and prefer environment-variable references over inline
API keys.

## Local state

```text
~/.agent-man/
├── repo/       # private Git worktree
├── backups/    # timestamped copies of replaced/deleted files
└── sync.lock   # present only while sync runs
```

Set `AGENT_MAN_HOME` to relocate this directory.

## Non-goals

- Cross-harness conversion
- Session, history, memory, cache, log, or credential synchronization
- Provider switching, API proxying, or usage accounting
- Project-local harness configuration already owned by a project's Git repository
- Background synchronization or last-writer-wins overwrites

## Development

```bash
npm install
npm run format
npm run test
```

Tests use temporary local Git repositories; they do not contact GitHub.
