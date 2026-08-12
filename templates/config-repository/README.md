# Native agent configuration

This private repository stores native configuration surfaces managed by
[`agent-man`](https://github.com/crayonlu/agent-man). It is not a credential store and does not
translate configuration between harnesses.

- Keep the repository private.
- Put credentials in environment variables or an operating-system keychain.
- Let `agent-man` manage files through profile allowlists; `.gitignore` may narrow, never widen,
  those boundaries.
- Do not force-push. Normal Git history and merges are the synchronization protocol.
- Inspect local, stored, and fetched remote changes with `agent-man plan`; verify safety with
  `agent-man doctor`.

Enabled profiles appear as native directories at the repository root. Their own `.gitignore` files
document the exact portable surface. External or absolute symbolic links remain device-local.
