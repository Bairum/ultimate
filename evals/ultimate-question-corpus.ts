// Verbatim message tool texts from @ultimate conversation #97078.
// `reply` is transport metadata, not part of the extractor input.
export const ultimateQuestionCorpus = [
  {
    // #97078/126140; message {to: 'user'} uses the default reply: true.
    name: 'preview decision (reply defaults to true)',
    text: `The polish for my view is ready to check: http://127.0.0.1:37293 (faux preview, with an open question already set up).

- My answers to you are now plain chat bubbles in my colour, the same style as my messages to you. The green "Final answer" card is gone here, and question cards still sit underneath.
- Answers I send to branches stay as a compact "replied to #id" line.
- The "Assessed: …" lines are also gone from my view.
- Other conversations are unchanged.

Checks and the web tests pass. I couldn't see the screenshots myself: the files it named don't exist, so please look in the preview.

Land it?
1. Yes
2. Change something first`,
  },
  {
    // #97078/127783; message {to: 'user', reply: false}.
    name: 'one-way screenshot fix report',
    text: "The screenshot fix is on main, pushed and live (`6630d2a`). The tool was treating `path` as part of the page address and always saved to its own folder. Now `path` is the file location (relative or absolute, folders created) and the result shows the real file. There's one stale prompt line that still describes the old use; #127401 is fixing it.",
  },
  {
    // #97078/126740; message {to: 'user', reply: false}.
    name: 'one-way relay with no question',
    text: 'Messages I send to busy coordinators now reach them mid-run instead of waiting as a follow-up (`a7e77f8`, on main, pushed and live). This also applies to @lander and @cloudflare.',
  },
] as const
