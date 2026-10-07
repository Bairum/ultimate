Manage user-global secrets through metadata-only server actions, shared by every Ultimate project. Opt in by enabling `secrets` in settings.

Values live in `~/.ultimate/secrets.json`, plaintext at 0600 in a 0700 directory, like Pi's `auth.json`. This is not a vault: the agent's shell runs as the same user and can access the file. Prompt guidance prevents accidental reading, not malicious access. Never include values in conversations, notices, documents, or logs.

The Secrets panel uses `list`, `set { name, value }`, and `delete { name }`. Rotation means setting the same name again; deletion removes it. Results contain metadata only. Writes use atomic rename under a pid-owned lock shared across processes. Unsafe file permissions are refused; fix them with `chmod 600 ~/.ultimate/secrets.json`.

Other server facets import `readSecret(userHome, name)` from `store.ts`. Declare required names through the server facet's `secrets` export. The store is independent of project state and `ULTIMATE_HOME`.
