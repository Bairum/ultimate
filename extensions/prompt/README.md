Ultimate's system prompt: coding guidelines, project context, skills, and the source reload layers.

The system prompt stays the same across builds, so a hot reload keeps the prompt cache. Instead, the input that starts a
conversation's run gets a hidden `prompt.build` note when the build differs from the one its last run started on: "Build
changed: <old> → <new> · generation N · changed: …". The note is decided in the commit that places the input (the
patched `beforeInput` hook), and the `prompt.build` document records the last build each conversation saw. A new
conversation records its first build silently, and a fork starts from its parent's.
