# agent-man

`agent-man` keeps one native AI agent configuration surface consistent across devices with ordinary
Git. It does not convert configuration between harnesses and is deliberately not a general dotfiles
manager.

The project stays small by giving existing tools one job each:

- GitHub Template gives a new private configuration repository safe defaults.
- Git provides history, text merges, transport, and ignore matching.
- agent-man defines portable profile boundaries, validates them, and applies changes transactionally.

There is no database, daemon, web service, GitHub SDK, background process, normalized configuration
schema, or force-push protocol. The architectural invariants and research behind this shape are in
[DESIGN.md](docs/DESIGN.md).

## Supported native profiles

| Profile        | Native root               | Portable allowlist                                 | Why it exists                                                      |
| -------------- | ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `grok`         | `$GROK_HOME` or `~/.grok` | `config.toml`, `sandbox.toml`, `skills/`, `hooks/` | Grok Build's documented user configuration and authored extensions |
| `agent-skills` | `~/.agents`               | `skills/`, `commands/`                             | Open agent assets consumed natively by compatible harnesses        |

Unknown paths are unmanaged even if a `.gitignore` negation tries to include them. Credentials,
sessions, history, memory, logs, caches, crash data, trust decisions, installed marketplaces, and
project-local configuration never enter the portable surface.

## Requirements and installation

- Node.js 22 or newer
- Git
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login` for the default flow

Install the CLI directly from the official GitHub repository:

```bash
npm install --global git+https://github.com/crayonlu/agent-man.git
agent-man --version
```

The npm package name is `@crayonlu/agent-man`; the executable remains `agent-man`. The package is
currently installed from GitHub, so no npm-registry publication is required.

## Give agent-man to an agent

The package bundles an [Agent Skill](https://agentskills.io/). Install it into the common Agent
Skills directory discovered by [Codex](https://developers.openai.com/codex/skills/),
[Gemini CLI](https://geminicli.com/docs/cli/using-agent-skills/), and
[Grok Build](https://docs.x.ai/build/features/skills-plugins-marketplaces):

```bash
agent-man skill install --target agents
```

Claude Code uses its native user directory:

```bash
agent-man skill install --target claude
```

`--target all` deliberately installs both copies. No postinstall script edits HOME, and `--force`
never follows an existing target symlink.

For Codex, the skill can also be installed before the CLI:

> Use `$skill-installer` to install the `agent-man` skill from
> `https://github.com/crayonlu/agent-man/tree/main/.agents/skills/agent-man`.

Then give Codex this request:

> Use `$agent-man` to inspect, plan, and synchronize my Grok Build configuration with a private
> GitHub repository named `agent-man-config`. Do not convert formats or read file contents. Show me
> `doctor --json` and `plan --json` results before the first sync, and call out changes to skills or
> hooks as executable code.

For another compatible harness, replace `$agent-man` with “the installed agent-man skill” (or use
`/agent-man` when that harness exposes user skills as slash commands).

The CLI emits stable JSON envelopes with `schemaVersion: 1`, machine-readable error codes, paths,
risk labels, and counts—never configuration contents.

## First device

```bash
# Creates a private repository from crayonlu/agent-man-config-template when absent.
agent-man init --github agent-man-config

agent-man profiles
agent-man add grok
agent-man doctor
agent-man plan
agent-man sync
agent-man status
```

`init --github` verifies that an existing GitHub repository is private before cloning it. To use a
different Git remote whose privacy agent-man cannot verify:

```bash
agent-man init --remote git@example.com:me/agent-man-config.git
```

`agent-man init --local` exists for offline use and testing.

## Additional devices

Install agent-man and run the same initialization command:

```bash
agent-man init --github agent-man-config
agent-man doctor
agent-man status
```

The cloned Git index is fully validated before tracked profiles are applied. Existing native files
are backed up in one transaction; unknown and device-local paths are left alone. Clone uses
`--no-checkout`: agent-man validates the fetched Git tree directly from the object database before
Git may materialize attributes, links, or files into its private worktree.

## Daily use

```bash
agent-man doctor --json
agent-man plan --json
agent-man sync --json
agent-man status --json
```

`plan` fetches refs without merging or changing native files. Its JSON separates local native
capture operations, already changed internal-repository paths that will be committed, and remote
paths that would be applied. Every path carries an `active`, `configuration`, or `unmanaged` risk
label; an unsafe remote tree fails the plan before checkout or merge.

`sync` performs one coherent operation:

1. Capture only allowlisted native entries into the private internal worktree.
2. Stage only repository controls and known profile directories.
3. Validate Git modes, path portability, limits, ignore boundaries, inline credential fields, and
   symbolic links before committing.
4. Fetch with Git object checking, validate the remote tree from blobs/modes, then merge normally; a
   conflict leaves every live profile untouched.
5. Validate the merged Git index and worktree again.
6. Snapshot every affected live path, persist an apply journal, replace leaves atomically, and roll
   back on failure. The next mutating command automatically recovers an interrupted process.
7. Push normally with repository hooks disabled. A push race fails safely; the coherent local state
   is retried on the next sync.

No command force-pushes or uses last-writer-wins replacement.

## Narrow a profile with `.gitignore`

`agent-man add grok` creates `.grok/.gitignore` in the private configuration repository. It starts
with a deny-by-default representation of the built-in allowlist. Add ordinary Git ignore patterns
to make the surface smaller, for example:

```gitignore
# Keep this authored skill only on the current device.
skills/work-only/**
```

On the next `sync`, agent-man stops tracking newly ignored internal copies while preserving the live
files on every device. A negation such as `!auth.json` cannot widen the compiled profile and is
rejected if that path is force-tracked.

Git's normal rule still applies: an ignore pattern alone does not remove an already tracked path.
agent-man performs that scoped index/worktree cleanup so users and agents never need to manipulate
the private internal repository for routine exclusions.

## Symbolic-link semantics

Links are configuration structure, not aliases to content that agent-man should follow:

- The selected surface root itself may be a symlink; it is explicitly resolved once as the trust
  root. Set `GROK_HOME` when a different Grok root is intentional.
- A nested relative link is portable only when its lexical target and complete link chain stay
  inside the same allowlisted surface and the target exists. Its original link text is stored.
- An absolute, external, broken, or out-of-profile link is a local binding. It and its subtree are
  reported, protected from remote replacement/deletion, and never uploaded or traversed.
- A configuration repository may contain only portable internal links. Git mode `120000`, not the
  worktree file type alone, is authoritative.
- On a checkout with `core.symlinks=false`, agent-man reads the link text and mode from the Git index.
  Applying a link still requires operating-system symlink support; on Windows, enable Developer Mode
  or the appropriate privilege. Failure is explicit and transactionally rolled back.
- A portable stored link is rejected on a device if its complete target chain would pass through an
  external local binding. This prevents a safe repository link from becoming an alias into a
  device-only tree.

Node does not expose a portable `openat` API, so agent-man cannot defend against a hostile concurrent
process running as the same OS user that races filesystem operations. It does component-by-component
ancestor checks, never follows nested links for content, and uses atomic leaf replacement. A machine
already compromised at the user account level is outside the threat model.

## Backups and restore

```bash
agent-man backups --json
agent-man restore <backup-id> --json
agent-man plan --json
```

Backups contain a versioned manifest plus only paths affected by an apply transaction, including
“previously absent” markers needed to remove newly created files during rollback. Ten recent rollback
points are retained. A private `pending-apply.json` journal makes a process kill between files
recoverable; `sync`, `restore`, `add`, and `init` restore the pre-apply backup before proceeding.
Restore creates a fresh pre-restore safety backup and changes the native surface, not Git history;
the following plan shows what a later sync would capture.

Local state is private on POSIX systems:

```text
~/.agent-man/
├── repo/       # private Git worktree
├── backups/    # transaction manifests and affected native entries
├── pending-apply.json # exists only while a native apply is in progress
└── sync.lock          # PID/host/timestamp; stale same-host locks are recovered
```

Set `AGENT_MAN_HOME` to an explicit real directory to relocate it. It may not be HOME or an ancestor
of HOME. On POSIX, an existing custom directory must already be mode `0700`; agent-man refuses it
instead of silently changing permissions on a broad path.

## Security model

- Keep the configuration repository private. GitHub is not a credential manager.
- Grok `config.toml` receives targeted checks for inline API keys, authorization headers, and
  secret-like environment assignments. Prefer `env_key`, `bearer_token_env_var`, and `${VAR}`.
- File count, depth, individual size, and total size are bounded. Windows-reserved names,
  case-insensitive collisions, Unicode-normalization collisions, special files, submodules, and
  unmanaged Git modes are rejected.
- Fetched commits are inspected with `git ls-tree`/`cat-file` before checkout or merge. Repository
  attributes may set only text/EOL behavior; nested attributes, filters, external diff/merge
  drivers, recursive submodules, repository hooks, and filesystem-monitor hooks are not part of the
  synchronization protocol.
- Skills, commands, hooks, and sandbox policy are labeled `active` because they can change agent or
  machine behavior. Review them like code.
- The scanner is defense in depth, not a guarantee that arbitrary prose contains no secret. Never
  intentionally put secrets in a managed file.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Non-goals

- Converting Claude, Codex, Gemini, Grok, or any other harness configuration into another format
- Mirroring an entire harness home directory or accepting arbitrary directory flags
- Synchronizing authentication, sessions, history, memory, trust state, logs, cache, or usage data
- Managing project-local configuration already owned by a project's Git repository
- Installing plugins, switching providers, proxying APIs, or tracking usage
- Background synchronization, a web UI, or conflict auto-resolution

## Development and verification

```bash
npm install
npm run format
npm run test
npm run install:check
npm run test:grok
```

The normal suite uses temporary HOME, `GROK_HOME`, `AGENT_MAN_HOME`, Git worktrees, and local bare
remotes. It covers two-device synchronization, conflicts, restore, path and secret rejection, Git
object preflight, symlink modes and chains, materialized symlinks, local bindings, crash-journal
recovery, stale locks, JSON, and Skill installation.
`test:grok` runs `grok inspect` with isolated HOME/XDG/Grok directories and skips cleanly when Grok
Build is unavailable. No test reads or writes the developer's real harness directories.

CI runs Node.js 22 and 24 on Linux, macOS, and Windows. The project has zero runtime dependencies and
is licensed under the [MIT License](LICENSE).
