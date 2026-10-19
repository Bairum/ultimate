/** Check the workflow requested by a branch prompt, not negated mentions of that workflow. */
export function routingInstructions(prompt: string) {
  // Keep negation over lists ("no epic, workers or review"), but not over the next instruction.
  const clauses = prompt
    .replaceAll('’', "'")
    .split(
      /[.;!\n]|\bbut\b|\band\s+(?=(?:use|plan|implement)\b)|,\s*(?=(?:(?:and|then)\s+)*(?:fix|implement|correct|edit|handle|make|use|create|write|start|plan|delegate|ask|have|run|require|assess|send)\b)/i,
    )
    .map((clause) => clause.split(/\b(?:no|not|don't|without|skip|avoid|neither)\b/i)[0])
  const affirmative = clauses.join('\n')
  return {
    direct:
      /\bsmall,? clear change\b/i.test(affirmative) ||
      clauses.some(
        (clause) =>
          /\b(?:fix|implement|correct|edit|handle|make)\b/i.test(clause) &&
          /\b(?:directly|yourself|minimal|exact|only)\b/i.test(clause),
      ),
    plan: /\b(?:plan|planning|epics?)\b/i.test(affirmative),
    workers: /\b(?:workers?|delegat(?:e|ing|ion))\b/i.test(affirmative),
    reviewer: /\b(?:reviewers?|independent review|review agent)\b/i.test(affirmative),
    review: /\breview(?:ers?)?\b/i.test(affirmative),
    assess: /\bassess(?:es|ing|ment)?\b/i.test(affirmative),
  }
}
