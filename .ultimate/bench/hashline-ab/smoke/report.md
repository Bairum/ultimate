# Edit tooling A/B

Exploratory measurements, not a statistical confidence interval. N/A means not enough paired data.

| Model                      | Arm      | Runs |    Pass | Edit errors | Wrong target | Output/pass | Cost/pass USD | Mean seconds |
| -------------------------- | -------- | ---: | ------: | ----------: | -----------: | ----------: | ------------: | -----------: |
| anthropic/claude-haiku-5-5 | baseline |    2 | 100.00% |       0.00% |            0 |      474.50 |      0.001952 |        13.22 |

## Pass bars

- N/A — only one arm measured; no A/B verdict.

## Per-task matrix

| Model                      | Task                             | baseline |
| -------------------------- | -------------------------------- | -------- |
| anthropic/claude-haiku-5-5 | access-remove-optional-chain-001 | 1:PASS   |
| anthropic/claude-haiku-5-5 | call-swap-call-args-001          | 1:PASS   |
