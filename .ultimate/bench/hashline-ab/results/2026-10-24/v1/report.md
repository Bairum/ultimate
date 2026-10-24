# Edit tooling A/B

Exploratory measurements, not a statistical confidence interval. N/A means not enough paired data.

Wrong target counts runs that changed non-blank lines outside the mutated region; blank-line seams (only blank lines changed there) are counted separately.

| Model                       | Arm      | Runs |    Pass | Edit errors | Wrong target | Blank seams | Output/pass | Cost/pass USD | Mean seconds |
| --------------------------- | -------- | ---: | ------: | ----------: | -----------: | ----------: | ----------: | ------------: | -----------: |
| anthropic/claude-sonnet-5-5 | baseline |  318 |  99.06% |       5.02% |            3 |           0 |      596.89 |      0.028451 |        14.27 |
| anthropic/claude-sonnet-5-5 | hashline |  318 | 100.00% |       8.65% |            0 |           5 |      503.11 |      0.026878 |        12.96 |
| openai-codex/gpt-6.1-sol    | baseline |  318 | 100.00% |       0.93% |            0 |           3 |      352.40 |      0.024189 |        16.06 |
| openai-codex/gpt-6.1-sol    | hashline |  318 | 100.00% |       0.00% |            0 |           3 |      215.20 |      0.023693 |        14.53 |

## Pass bars

### anthropic/claude-sonnet-5-5: hashline vs baseline

- Pass rate B ≥ A − 2 pp: PASS
- Edit-tool error rate ≤ 3%: FAIL
- Zero wrong-target writes: PASS
- Output tokens/passed task ≥ 15% lower: PASS
- Cost/passed task not higher: PASS

### openai-codex/gpt-6.1-sol: hashline vs baseline

- Pass rate B ≥ A − 2 pp: PASS
- Edit-tool error rate ≤ 3%: PASS
- Zero wrong-target writes: PASS
- Output tokens/passed task ≥ 15% lower: PASS
- Cost/passed task not higher: PASS

## Per-task matrix

| Model                       | Task                                  | baseline                                                      | hashline                                                      |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| anthropic/claude-sonnet-5-5 | access-remove-optional-chain-001      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | call-swap-call-args-001               | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | duplicate-duplicate-line-flip-001     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | duplicate-duplicate-line-flip-002     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | duplicate-duplicate-line-flip-003     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | duplicate-duplicate-line-flip-004     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | duplicate-duplicate-line-flip-005     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | duplicate-duplicate-line-flip-006     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-001  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-002  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-003  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-004  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-005  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-006  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-007  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-008  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-009  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | identifier-identifier-multi-edit-010  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | literal-flip-boolean-001              | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | literal-off-by-one-001                | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-001        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-002        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-003        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-004        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-005        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-006        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-007        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-008        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-009        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-010        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-011        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-012        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-013        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-014        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-015        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | multi-composite-multi-edit-016        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | operator-remove-negation-001          | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | operator-swap-arithmetic-001          | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | operator-swap-comparison-001          | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | operator-swap-equality-001            | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | operator-swap-increment-decrement-001 | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | operator-swap-logical-001             | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | operator-swap-nullish-001             | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | regex-swap-regex-quantifier-001       | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-duplicate-block-001        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-duplicate-block-002        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-duplicate-block-003        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-duplicate-block-004        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-duplicate-block-005        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-duplicate-block-006        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-move-distant-block-001     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-move-distant-block-002     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-move-distant-block-003     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS (blank seam)                           |
| anthropic/claude-sonnet-5-5 | structural-move-distant-block-004     | 1:PASS, 2:FAIL (wrong target), 3:PASS                         | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-move-distant-block-005     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-move-distant-block-006     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS (blank seam)                           |
| anthropic/claude-sonnet-5-5 | structural-move-distant-block-008     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-move-distant-block-009     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS (blank seam), 2:PASS (blank seam), 3:PASS (blank seam) |
| anthropic/claude-sonnet-5-5 | structural-move-distant-block-010     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-remove-case-label-001      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-remove-case-label-002      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-remove-case-label-003      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-remove-case-label-004      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-remove-case-label-005      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-remove-case-label-006      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-remove-case-label-007      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-remove-case-label-008      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-adjacent-lines-001    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-adjacent-lines-002    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-adjacent-lines-003    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-adjacent-lines-004    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-adjacent-lines-005    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-adjacent-lines-006    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-if-else-001           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-if-else-002           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-if-else-003           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-if-else-004           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-if-else-005           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-if-else-006           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-if-else-007           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-if-else-008           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-001    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-002    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-003    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-004    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-005    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-006    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-008    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-009    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-010    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-012    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-013    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-swap-sibling-blocks-014    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-001      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-002      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-004      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-005      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-006      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-008      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-009      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-010      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-011      | 1:FAIL (wrong target), 2:FAIL (wrong target), 3:PASS          | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-012      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-013      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | structural-wrap-redundant-if-014      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| anthropic/claude-sonnet-5-5 | unicode-unicode-hyphen-001            | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | access-remove-optional-chain-001      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | call-swap-call-args-001               | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | duplicate-duplicate-line-flip-001     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | duplicate-duplicate-line-flip-002     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | duplicate-duplicate-line-flip-003     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | duplicate-duplicate-line-flip-004     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | duplicate-duplicate-line-flip-005     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | duplicate-duplicate-line-flip-006     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-001  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-002  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-003  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-004  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-005  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-006  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-007  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-008  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-009  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | identifier-identifier-multi-edit-010  | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | literal-flip-boolean-001              | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | literal-off-by-one-001                | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-001        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-002        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-003        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-004        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-005        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-006        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-007        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-008        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-009        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-010        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-011        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-012        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-013        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-014        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-015        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | multi-composite-multi-edit-016        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | operator-remove-negation-001          | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | operator-swap-arithmetic-001          | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | operator-swap-comparison-001          | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | operator-swap-equality-001            | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | operator-swap-increment-decrement-001 | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | operator-swap-logical-001             | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | operator-swap-nullish-001             | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | regex-swap-regex-quantifier-001       | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-duplicate-block-001        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-duplicate-block-002        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-duplicate-block-003        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-duplicate-block-004        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-duplicate-block-005        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-duplicate-block-006        | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-move-distant-block-001     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-move-distant-block-002     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-move-distant-block-003     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-move-distant-block-004     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-move-distant-block-005     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-move-distant-block-006     | 1:PASS (blank seam), 2:PASS (blank seam), 3:PASS (blank seam) | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-move-distant-block-008     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS (blank seam), 3:PASS                           |
| openai-codex/gpt-6.1-sol    | structural-move-distant-block-009     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS (blank seam), 3:PASS (blank seam)              |
| openai-codex/gpt-6.1-sol    | structural-move-distant-block-010     | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-remove-case-label-001      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-remove-case-label-002      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-remove-case-label-003      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-remove-case-label-004      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-remove-case-label-005      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-remove-case-label-006      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-remove-case-label-007      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-remove-case-label-008      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-adjacent-lines-001    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-adjacent-lines-002    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-adjacent-lines-003    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-adjacent-lines-004    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-adjacent-lines-005    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-adjacent-lines-006    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-if-else-001           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-if-else-002           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-if-else-003           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-if-else-004           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-if-else-005           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-if-else-006           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-if-else-007           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-if-else-008           | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-001    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-002    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-003    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-004    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-005    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-006    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-008    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-009    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-010    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-012    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-013    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-swap-sibling-blocks-014    | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-001      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-002      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-004      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-005      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-006      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-008      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-009      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-010      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-011      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-012      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-013      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | structural-wrap-redundant-if-014      | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
| openai-codex/gpt-6.1-sol    | unicode-unicode-hyphen-001            | 1:PASS, 2:PASS, 3:PASS                                        | 1:PASS, 2:PASS, 3:PASS                                        |
