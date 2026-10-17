# Questions

A built-in, optional answer card for final replies that need a decision. The conversations extension's accepted
`needs_input` assessment starts extraction for top-level conversations only; `done`, `neutral`, and owned subagents
never trigger it. Like conversation summaries, extraction sends reply text to the configured summary model.
It asks only for questions and options actually present in the reply, excluding rhetorical closers and offers.
Model failures and empty results quietly produce no card.

Extraction is a conversation-owned durable background task. It memoizes the chosen model and response, deduplicates
requests per answer, and discards results if input or a reset supersedes the answer. `questions.asked` carries
`{ answerId, questions }` with no model contribution: neither the questions nor an unanswered note enters context.
Appending the entry does not invalidate the sidebar assessment.

The latest unanswered card sits above the idle composer's existing rendering. Collapse/expand is shared UI state
per entry; there is no dismiss or skip choice. Confirmations offer Yes, No, and Something else; choices offer the
extracted options, including any recommendation, plus Something else with an inline text field. Phone layouts show
one question at a time with Back/Next; desktop number keys choose for the current question and Enter advances or
sends, without intercepting text editing. Send is available after at least one answer; omitted questions stay out.

The `answer` action accepts `{ askedId, answers: [{ question, answer }], note? }` and the action conversation ID.
It refuses stale cards and submits a typed `questions.answers` input. Its model content repeats each question with
`Q:` / `A:` and appends the note; the transcript renders a dedicated answer card. Any composer text is included as
the note, then cleared using the SDK's revision-aware draft access so newer edits survive. Attachments stay put.
Sending an ordinary prompt instead closes the card and derives a quiet, expandable “left unanswered” transcript
note from `questions.asked`. No extra entry or model input is written for that note.

On a faux instance, send `questions demo` to try both a confirmation and a recommended choice. Summary and
extraction calls default to the faux model there (explicit summary-model settings still win), so the entire flow
runs locally without tokens.
