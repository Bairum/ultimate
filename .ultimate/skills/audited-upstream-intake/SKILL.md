---
name: audited-upstream-intake
description: Assess and integrate new commits from this fork's upstream repository with a security audit, a trial merge and one plan, before anything runs on the live host. Use when asked to look at, assess, merge or bring in upstream changes, or a Pi upgrade that comes with them.
---

# Audited upstream intake

Upstream code is untrusted until read. Follow `assess-outside-pr` for the shared steps (read the whole diff before
running anything, trial merge, prove once, report); this skill adds what is specific to merging upstream into this
fork. Memory `upstream-integration-boundary` records the last integrated commit and what stays out.

## 1. Fetch and scope

`git fetch` upstream again right before you start and before you report; commits newer than the range you assessed
are reported separately, never folded in silently. Value the range by commit or theme: what each brings, what it
costs us, what we skip.

## 2. Dependencies

- Version changes in `package.json` and `pnpm-workspace.yaml`; `@earendil-works/*` stay pinned to exact versions.
- A Pi upgrade means a storage migration: take backups of every project's state **before** the first restart on
  the new version.
- Our patches: `patches/` and the `patchedDependencies` with their `# Pi upstream:` comments in
  `pnpm-workspace.yaml` (each names what it fixes and when it can go); [Borrowed from Pi](../../../docs/pi-upstream.md)
  lists the other couplings. A patch must be re-made for a new version or dropped when upstream fixed it.
- When the pi-claude-code patch is regenerated, re-apply the `writeFrame` listener fix from `41eab0e` by hand, then
  regenerate the lockfile with `pnpm install --lockfile-only`.

## 3. Security audit, before anything runs

- New user actions are pairing-gated (memory `browser-pairing-security`): acting needs pairing, reading stays open.
- New HTTP routes, outbound requests (egress), process signalling (`kill`, spawned children), secret reads.
- Defaults: new features that serve, share or push start off (memory `upstream-share-push-safety`).

Prove each concern with a bounded throwaway test or script, run and deleted; put the command and output in the report.

## 4. Correctness against the fork

Check each upstream change against behaviour the fork has changed (its fixes, extensions, settings): a merge that
compiles can still undo a fork fix. Name every overlap.

## 5. Trial merge, throwaway

```bash
git worktree add /tmp/upstream-trial HEAD && cd /tmp/upstream-trial
git merge --no-commit --no-ff <upstream-ref>    # conflicts and pnpm check only
git merge --abort; cd -; git worktree remove /tmp/upstream-trial; git worktree prune
```

MCP stays out (memory `upstream-integration-boundary`).

## 6. Plan and report

One plan: the merge, with our fixes as separate commits on top, each naming its origin at the code. One much easier
alternative (a subset of commits, or waiting) and what it gives up. Say which restarts it needs: changes to
`server/`, `shared/` or the patches mean `pnpm install` and a restart of every running instance (memory
`core-change-restart-all-instances`). List verification gaps plainly.

## Upstream reporting is deferred

Never file, post or comment on GitHub (issues, PRs, security reports) without the user's fresh approval; hand any
wording to @ultimate.
