# Hashline A/B, 2026-10-24

omp's 106 edit tasks × 3 runs per arm, codemode off in every arm. Run artifacts (transcripts, storage) were deleted after measuring; each folder keeps `results.jsonl`, `report.md` and the run `manifest.json`. `combined/report.md` puts every arm against the same baseline rows.

| Arm               | What it measured                                               | Checkout |
| ----------------- | -------------------------------------------------------------- | -------- |
| `baseline`        | today's read/edit/write                                        | 19b287f0 |
| `hashline-v1`     | hashline without a parser                                      | 19b287f0 |
| `hashline-v2`     | hashline with the tree-sitter parser                           | fdf24705 |
| `hashline-prompt` | v2 plus the "every edit needs a tag" prompt line (Sonnet only) | b5f92205 |

| Model       | Arm             |   Pass | Edit errors | Wrong target | Blank seams | Output/pass | Cost/pass USD |
| ----------- | --------------- | -----: | ----------: | -----------: | ----------: | ----------: | ------------: |
| Sonnet 5.5  | baseline        | 99.06% |       5.02% |            3 |           0 |         597 |        0.0285 |
| Sonnet 5.5  | hashline-v1     |   100% |       8.65% |            0 |           5 |         503 |        0.0269 |
| Sonnet 5.5  | hashline-v2     | 99.69% |       6.60% |            1 |           7 |         499 |        0.0272 |
| Sonnet 5.5  | hashline-prompt |   100% |       4.32% |            0 |           8 |         494 |        0.0270 |
| GPT-6.1 Sol | baseline        |   100% |       0.93% |            0 |           3 |         352 |        0.0242 |
| GPT-6.1 Sol | hashline-v1     |   100% |       0.00% |            0 |           3 |         215 |        0.0237 |
| GPT-6.1 Sol | hashline-v2     |   100% |       0.00% |            0 |           3 |         217 |        0.0238 |

Notes from the transcripts:

- v1 and v2 wrong-target counts were re-scored with `rescore.ts` after blank-line seams were split out.
- The one `hashline-v2` wrong target (Sonnet, `structural-wrap-redundant-if-011` run 2) was written by a `perl -i` one-liner in bash, not by the edit tool.
- `hashline-prompt` edit errors (13 of 301 calls) are guard rejections: unseen lines, stale tags, a body restating the lines below its range. All 318 runs of that arm passed.
- Mean seconds are not comparable across arms: v1 ran four runs at a time, v2 and the prompt arm two.
