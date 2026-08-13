# agent-man design

## Project definition

agent-man is a profile-driven manager for portable, native AI agent configuration surfaces. A
surface is smaller than a harness home directory: it contains only files with documented cross-device
meaning and excludes identity, runtime state, machine trust, downloaded artifacts, and project-owned
configuration. Each profile may additionally opt into one opaque `secrets.env` leaf whose plaintext
is never stored; Git sees only its age ciphertext.

This definition is the primary boundary. agent-man is not:

- a configuration converter;
- a general dotfiles manager;
- a Git wrapper for arbitrary paths;
- a symlink farm from HOME into a checkout; or
- a service that replaces GitHub/Git transport.

## Minimal state model

There are three states, following the useful distinction made by tools such as chezmoi without
adopting their template system:

- **native** — the actual files consumed by the harness;
- **stored** — the validated profile files in the private Git worktree;
- **upstream** — ordinary Git history on the configured remote.

Native state is the source of local edits. Stored state is the merge boundary. A clean merged stored
state is applied to native state only after validation and backup. No fourth configuration database
exists. The lock, backup manifests, and short-lived apply journal are operational recovery metadata,
never an alternate source of configuration truth.

## Why GitHub Template is initialization, not synchronization

GitHub creates a repository from a template with an independent history. Later template changes do
not propagate into repositories already created from it. Therefore the template owns only safe birth
defaults: root deny rules, line-ending attributes, and explanatory README content. Git commits and
merges—not the template relationship—are the synchronization protocol.

agent-man seeds missing control files for empty/custom remotes but never treats the public template
as an update channel for private configuration repositories.

## Profile contract

A built-in profile must declare:

1. A documented native root and any official environment override.
2. An exact allowlist of portable files/directories plus narrowly scoped file patterns where the
   harness documents a named-file convention (for example Codex `*.config.toml`).
3. A risk label for every allowlisted path: `configuration` or `active`.
4. Targeted validators where a native format can embed credentials.
5. An official non-mutating verification command when one exists.
6. Tests for exclusions, remote apply, deletion, path limits, links, and failure rollback.
7. An optional `native`/`stored` encrypted-secrets pair with a risk label.

A new profile is rejected when its proposed root mixes portable configuration with credentials or
runtime state and no stable allowlist can separate them. Supporting “everything under `~/.tool`” is
not generality; it is an unauditable security boundary.

The current profiles are intentionally bounded, not entire home directories:

- Grok Build uses the documented `GROK_HOME` root. agent-man captures authored config/rules,
  sandbox/LSP settings, agents, personas, skills, and hooks; authentication, sessions, memory,
  logs, plugins, and marketplace downloads remain local.
- Claude Code uses `CLAUDE_CONFIG_DIR` or `~/.claude` and captures the authored global files listed
  by Anthropic (`CLAUDE.md`, `settings.json`, keybindings, rules, skills, commands, output styles,
  agents, workflows, and themes). Transcripts, history, auto-memory, plugins, and `.claude.json`
  stay out of scope.
- Codex uses `CODEX_HOME` or `~/.codex` and captures `config.toml`, global `AGENTS.md` instructions,
  and named `*.config.toml` profiles. Auth, sessions, logs, caches, and admin `requirements.toml`
  are not portable.
- OpenCode uses `XDG_CONFIG_HOME/opencode` or `~/.config/opencode` and captures global JSON/JSONC
  and TUI config, `AGENTS.md`, agents, commands, skills, and themes. Plugin installations and the
  dependency cache are deliberately excluded.
- Pi uses its documented `$PI_CODING_AGENT_DIR` or `~/.pi/agent` root and captures settings plus authored extensions, skills,
  prompts, and themes. Pi packages, the package/npm store, trust decisions, and sessions are local.
- Gemini CLI uses `GEMINI_CLI_HOME/.gemini` or `~/.gemini` and captures user settings, global
  `GEMINI.md`, keybindings, policies, agents, skills, and custom commands. Authentication, trusted
  folders, project history, temporary checkpoints, and installed extensions remain local.
- Multiple harnesses document the open `~/.agents/skills` convention; the `agent-skills` profile keeps
  that native directory (and its existing commands directory) without converting its contents.

These profiles can coexist in one private repository, but they remain separate native trees. There
is no implicit cross-profile copy or format conversion.

## Shared-identity encrypted secrets

The secrets model deliberately adds no configuration schema or key service. Every profile declares
the same special pair: native `secrets.env` and stored `secrets.env.age`. The ordinary portable-tree
planner does not see the plaintext leaf. A separate module encrypts/decrypts the pair, while the
existing apply transaction backs up, journals, atomically replaces, and rolls it back like any other
native leaf.

One X25519 age identity is shared manually across trusted devices. Its public recipient is the
single-line root control `.age-recipient`; the private identity is resolved locally from
`AGENT_MAN_AGE_IDENTITY_FILE`, `~/.config/age/keys.txt`, or `$AGENT_MAN_HOME/age-keys.txt` and is
never copied into stored state. POSIX identity files must be mode `0600` and their containing
directory private.

```text
native plaintext ──stdin──> age -e -r <recipient> ──stdout──> stored ciphertext
stored ciphertext ──stdin──> age -d -i <identity>  ──stdout──> native plaintext
```

No temporary plaintext file is created. Command I/O is byte-preserving because an age file is
binary. Capture first decrypts existing ciphertext with the local identity and rewrites only when
the native bytes differ. With no stored ciphertext, a ready identity may derive the recipient and
create `.age-recipient` in the same scoped commit. If age/identity is unavailable, the derived
recipient mismatches the control, or ciphertext cannot be decrypted, the pair becomes a protected
local binding: capture and apply both skip it, including deletion, while ordinary config proceeds.

Fetched trees validate the control's Bech32 X25519 recipient and the structural age v1 envelope
before checkout. Authenticity and recipient fit are established by age decryption before apply.
Identity distribution, rotation orchestration, SOPS, KMS, and key servers remain non-goals.

## Allowlist and ignore invariants

The compiled profile allowlist is authoritative. Git ignore files are user-editable subtraction:

```text
effective surface = built-in allowlist − ignored paths
```

There is no operation that adds an arbitrary path. Force-tracked paths outside a profile fail full
repository validation before commit, apply, or push. Newly ignored tracked paths are removed only
from agent-man's internal worktree/index; live native files remain on disk and remote deletions under
the new ignore rule remain local.

## Symbolic-link model

Git stores a symlink as mode `120000` with the link text in a blob. It does not store the target's
contents. agent-man adopts that exact model.

| Link form                                                      | Capture              | Apply                    | Reason                                       |
| -------------------------------------------------------------- | -------------------- | ------------------------ | -------------------------------------------- |
| Surface root symlink                                           | Resolve once         | Operate on resolved root | The user explicitly selected this trust root |
| Nested internal relative link with existing allowlisted target | Store link text/mode | Recreate link            | Portable native structure                    |
| Absolute link                                                  | Local binding        | Protect/skip             | Encodes one device's path                    |
| Relative link escaping the surface                             | Local binding        | Protect/skip             | Would cross the management boundary          |
| Broken or out-of-profile link                                  | Local binding        | Protect/skip             | Target cannot be reproduced safely           |
| Unsafe link committed to stored Git state                      | Reject               | Never apply              | A remote must not define local escape paths  |

Directory walking uses `lstat` semantics and never descends through a nested link. Target-chain
validation reads link text/metadata only. Windows-native relative separators are canonicalized to
Git's portable `/` representation; Git blob backslashes remain invalid. Before every copy, removal,
or comparison, each existing
ancestor below the resolved surface root is checked again for symlinks. Leaf replacement is atomic
where the operating system permits it.

The same resolver runs against fetched Git tree entries without consulting the checkout. A stored
link that is internally reproducible in Git is still refused on apply if its target chain would pass
through an external device-local binding.

Git index mode remains authoritative when Windows or `core.symlinks=false` materializes a link as a
small regular file. If the OS cannot create a real link, agent-man fails instead of silently changing
its meaning.

## Transaction and conflict invariants

The synchronization order is fixed:

```text
capture (including secrets) → scoped stage → validate → commit → fetch → object-tree preflight
        → merge → validate → snapshot + journal → apply (or rollback) → push
```

- Merge conflicts occur only in the private stored worktree; live native files are untouched.
- Every affected live leaf and every “previously absent” destination is represented in one backup
  manifest before apply begins.
- A replaced native `secrets.env` is necessarily plaintext in its local rollback copy. That copy
  remains below the mode-`0700` state directory, never enters Git, and follows normal retention.
- The backup id is durably journaled before the first mutation. A later mutating command replays that
  backup when the prior process died before clearing the journal.
- Deletions execute before copies so Git type changes such as symlink-to-directory are reproducible.
- Any apply error restores the manifest. A rollback error is surfaced separately and preserves the
  backup for manual recovery.
- A push happens after a coherent local apply. A non-fast-forward push failure does not corrupt
  native/stored agreement; the next sync fetches and retries normally.
- Locks include PID, host, and timestamp. Only a dead same-host lock is automatically reclaimed.

## Repository and filesystem validation

Validation is performed before both capture commits and merged-tree apply:

- only root controls and known profile paths may be tracked;
- only regular files and mode-`120000` symlinks are accepted (no submodules or special files);
- tracked paths cannot be ignored at the commit/apply boundary;
- path depth, entry count, per-file bytes, and total bytes are bounded;
- Windows-reserved names and control characters are rejected;
- paths that collide after case folding or NFC normalization are rejected;
- profile-specific secret checks never include matching values in errors; and
- plaintext secrets paths are rejected from Git while stored ciphertext and `.age-recipient` are
  structurally validated from both worktree and fetched blobs;
- the Git worktree representation must agree with the index mode/blob.

Initial clone uses `--no-checkout`, and every fetched upstream tip is first validated from
`ls-tree` metadata and blob contents. This prevents a remote `.gitattributes` file from activating a
locally configured filter during checkout. Only root text/EOL attributes are allowed; nested
attributes and all filter/diff/merge/encoding macros are rejected. The private repository disables
hooks, global attributes/excludes, fsmonitor, external diffs, and recursive submodules, and enables
Git fetch/object integrity checking.

The internal state directory is mode `0700` and lock/manifests are private on POSIX. A state path must
be a real directory, cannot contain HOME, and is never silently chmodded when an existing custom path
has broad permissions. A native surface root may intentionally be a symlink.

## Threat model

agent-man protects against accidental over-capture, unsafe repository contents, plaintext-secret
tracking, path traversal via
nested symlinks, ordinary crashes, merge conflicts, push races, and unsupported cross-platform path
semantics. It avoids reading external link targets and never sends file contents to an API.

It cannot make intentionally managed executable content safe, detect every secret in arbitrary text,
or defend against malware/concurrent processes already running as the same OS user. Node provides no
portable `openat`/directory-handle API for eliminating every filesystem time-of-check/time-of-use
race. Repository compromise still matters: skills and hooks are code and must be reviewed.

## Primary references

- [Git data model: symlink mode and blob representation](https://git-scm.com/docs/gitdatamodel)
- [Git `core.symlinks`](https://git-scm.com/docs/git-config)
- [Git ignore semantics](https://git-scm.com/docs/gitignore)
- [Git attributes and line endings](https://git-scm.com/docs/gitattributes)
- [Git tree object inspection](https://git-scm.com/docs/git-ls-tree)
- [Git object integrity and hook configuration](https://git-scm.com/docs/git-config)
- [Node.js filesystem APIs and symlink-preserving copy semantics](https://nodejs.org/api/fs.html)
- [age CLI and shared-identity file encryption](https://github.com/FiloSottile/age)
- [age v1 file format](https://c2sp.org/age)
- [GitHub repositories created from templates](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template)
- [Grok Build settings and `GROK_HOME`](https://docs.x.ai/build/settings/reference)
- [Grok Build skills, plugins, hooks, and `~/.agents` compatibility](https://docs.x.ai/build/features/skills-plugins-marketplaces)
- [Grok Build hook/trust locations](https://docs.x.ai/build/features/hooks)
- [Codex Agent Skills](https://developers.openai.com/codex/skills/)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Claude Code `.claude` directory](https://code.claude.com/docs/en/claude-directory)
- [OpenCode configuration](https://opencode.ai/v2/docs/config)
- [OpenCode Agent Skills](https://opencode.ai/docs/skills/)
- [OpenCode commands](https://opencode.ai/docs/commands/)
- [Pi settings](https://pi.dev/docs/latest/settings)
- [Pi environment variables](https://pi.dev/docs/latest/environment-variables)
- [Pi skills](https://pi.dev/docs/latest/skills)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Gemini CLI configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)
- [Gemini CLI custom commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/custom-commands.md)
- [Gemini CLI Agent Skills](https://geminicli.com/docs/cli/skills/)
- [Claude Code Agent Skills](https://code.claude.com/docs/en/skills)
- [Windows symbolic-link privilege guidance](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/create-symbolic-links)
- [chezmoi source/target/actual state architecture](https://chezmoi.io/developer-guide/architecture/)

The [CC Switch symlink security fix](https://github.com/farion1231/cc-switch/commit/6b8f36431b50385f095b5e66eb20d9c11dcaa73d)
also provides practical evidence that configuration managers need explicit traversal checks,
file-size bounds, and cross-platform line-ending tests; agent-man keeps those concerns inside its
small profile/transaction core rather than adopting provider-switching or GUI scope.
