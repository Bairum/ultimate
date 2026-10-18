## Discovery and settings

Discovery is clone built-ins, then `~/.ultimate/`, then `<project>/.ultimate/`; later names replace earlier ones.
Skills load from clone `skills/`, then the project's `.pi/skills/`, then `~/.ultimate/skills/`, then
`<project>/.ultimate/skills/`, with later names winning. Personal instructions load from `~/.ultimate/AGENTS.md`
(or `CLAUDE.md`) ahead of the project's. Pi's own `~/.pi/agent/skills/` and `~/.pi/agent/AGENTS.md` are not read: they
belong to Pi, so link a skill into `~/.ultimate/skills/` to use it here.
Every built-in is on by default, including `board` (durable agent messages and @ultimate's messages to you), `questions` (answer cards for @ultimate's questions to the user), `faux` (inert unless `ULTIMATE_FAUX=1`), `lineage` (conversation trees: roots, branches, notes), `parallel` (web tools; reads `secrets`), `classify` (Jev typed judgments; reads `secrets`), `cloud` (replica sync; inert until configured in user settings and Secrets), `cloudflare` (deferred Workers Observability tool; inert without a call and its secret), `phase` (working phases; requires `classify`), and `tailscale` (remote access; inert on faux servers except previews, and only user settings can turn it off for good). Settings layer defaults, `~/.ultimate/settings.json`, then `<project>/.ultimate/settings.json`:
`extensions.enable` and `extensions.disable` are name arrays, later layers win, and changes apply live without a
restart. User/project extension folders are on by default too; `disable` turns off any extension. Unknown names
produce a notice. `summaryModel` (`"provider/id[:thinking]"`, default `openai/gpt-6-luna:medium`; project over user)
picks the model for automatic titles, summaries, reply assessments, question extraction and tree abstracts;
in faux mode the unset default is `faux/faux-1:off`. Set it in either file or with
the "Summary model…" command, and it applies to the next request. `fastModels` (`["openai/<id>", …]`; project over
user) runs those models on the priority tier through the `fast` extension, at a higher usage rate.
User config is independent of `ULTIMATE_HOME`. This repository's `.ultimate/settings.json` holds only its isolate setup
and lander checks.

A project's `.ultimate/` applies only once it is chosen: its `extensions/`, the project `extensions` settings layer,
`agents/`, and `skills/` load only when the project decision is local. Decisions are kept per project path with Pi's
`ProjectTrustStore` in `~/.ultimate/trust.json`, and a linked git worktree shares its main checkout's; undecided behaves like global and is reported in system info
(`project.decision`). Every `.ultimate/settings.json` key (`defaultSurface`, `isolates`, …) goes through the gated
`host.projectSettings()`; onboarding reads the file only to show what choosing the project would bring. The `onboarding` extension asks once and its Extensions panel changes the choice live. Resources you add to a
project's `.ultimate/` stay unloaded until that project is local; tests seed the decision in their temporary home.
