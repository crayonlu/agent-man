# Agent configuration

This private repository stores native AI harness configuration managed by
[`agent-man`](https://github.com/crayonlu/agent-man).

- Keep this repository private.
- Keep credentials in environment variables or the operating-system keychain.
- Do not force-push: `agent-man` relies on ordinary Git history and merge semantics.
- Files matched by `.gitignore` are unmanaged: they are neither uploaded nor overwritten locally.

Managed harness directories appear at the repository root, mirroring their standard location under
your home directory. For example, Grok Build configuration is stored under `.grok/`.
