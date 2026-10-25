import { expect, it } from 'vitest'
import { needsDecision } from '../extensions/messages/triage.ts'

// Endings of real coordinator messages to @ultimate.
it.each([
  "Waiting on worker #293632. When it reports, I'll:\n1. Read its diff and rerun `pnpm check`, `pnpm test` and the messaging e2e tests.\n2. Compare the after screenshots against the before ones.\n3. Run a review, then `workspace submit`.",
  "Once it has landed, I'll:\n1. Update this branch to that main.\n2. Brief one worker with the rename and the cleanup.\n3. Verify with `pnpm check`, `pnpm test`, the messaging e2e tests (including `board-remote`) and before-and-after faux screenshots of #97078.\n4. Run a review, then `workspace submit`.",
  'Still waiting on #250944. Once it reports, a quick re-review of that one fix, then:\n1. Submit this branch.\n2. Deploy the Worker when the client change lands.\n3. Run `pnpm fleet:e2e` against the real Worker with a throwaway project, then clean up.\n4. Ask @ultimate for the restart.',
  "I'm waiting on reviewer #254538's final check of both repos. If it approves:\n1. I submit this branch.\n2. I deploy the Worker when the change lands.\n3. I run `pnpm fleet:e2e` on real infrastructure with a throwaway project, then clean up after it.\n4. I ask @ultimate for the restart.",
  "Reviewer #253701 is re-checking the fixes in both repos. I'm waiting for its verdict. If it approves:\n1. `workspace submit`;\n2. deploy the new Worker, at the same moment the client change lands;\n3. run `pnpm fleet:e2e` on real infrastructure and clean up after it;\n4. ask @ultimate for the restart.",
])('reads plan steps after a colon as no decision: %#', (text) => {
  expect(needsDecision(text)).toBe(false)
})

it.each([
  'Shall I submit?\n1. Approve: I run `workspace submit` and stop the preview.\n2. Change something first (wording, how quiet the item is, the phone icon).',
  "**Checks:** pnpm check passes. I'll submit only after its verdict and the user's approval.\n\n1. Approve round 2 as shown.\n2. Change something first (say what).",
  "I'm waiting for two things:\n- **Your decision**, relayed through @ultimate:\n  1. Approve round 2 as shown. I submit once the review is clean.\n  2. Change something first; say what.",
  '## Decisions\n1. Fix:\n   1. Anchoring off only while following (recommended).\n   2. `overflow-anchor: none` always.\n2. Go:\n   1. Build it in this branch.\n   2. First catch a real failure on #97078 during a live run.',
  '**Decisions:**\n1. **Build:** (a) the `pnpm reset` script (recommended); (b) only the documented recipe.',
  'Next steps:\n1. **Scope:** (a) fallback only; (b) fallback and setup check.\n2. **Go:** (a) build it; (b) wait.',
  'Merged the worker. Land it now?',
  // #384676's assessment, routed as a silent note for 40 minutes.
  "## Decisions\n1. **Scope:** (a) A and B; (b) only A, since B is cosmetic; (c) nothing, the codebase is fine as is.\n2. **How to run it:** (a) I do both myself on this branch, have one reviewer check it, then submit. They're too small to be worth handing to workers. (b) Two workers in parallel, then a review.\n\nMy picks: 1a 2a.",
])('reads a question or options as a decision: %#', (text) => {
  expect(needsDecision(text)).toBe(true)
})
