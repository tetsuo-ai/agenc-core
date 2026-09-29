# Measured DeepSeek selector replay

Suite: xprov-deepseek-known-answer-v1. Held-out tasks: 6. Matrix complete: true.

Both models received each fixed task once. Quality is an exact JSON verifier result. Costs below are token-usage estimates at registry peak rates.

| Strategy | Passed / recorded | Estimated cost | Passes / estimated dollar | Sum of call latency |
| --- | ---: | ---: | ---: | ---: |
| selector | 4/6 | $0.066891 | 59.7986 | 335.63s |
| selector_calibrated | 4/6 | $0.066891 | 59.7986 | 335.63s |
| selector_classified | 4/6 | $0.021082 | 189.7389 | 89.72s |
| always_strongest | 4/6 | $0.070959 | 56.3704 | 347.37s |
| always_cheapest | 4/6 | $0.021082 | 189.7389 | 89.72s |
| fixed_parent | 4/6 | $0.021082 | 189.7389 | 89.72s |

| Split | Model | Passed / recorded | Estimated cost |
| --- | --- | ---: | ---: |
| calibration | deepseek-flash | 6/6 | $0.005400 |
| calibration | deepseek-v4-pro | 6/6 | $0.046138 |
| holdout | deepseek-flash | 4/6 | $0.021082 |
| holdout | deepseek-v4-pro | 4/6 | $0.070959 |

- Six held-out tasks and one completion per model and task cannot establish general routing superiority.
- Only native DeepSeek was measured. These direct API calls do not measure AgenC sub-agent orchestration or tool use.
- Strongest means the predeclared Pro baseline, not a measured universal ranking.
- selector and selector_calibrated use predeclared human task kind and complexity. selector_classified uses the current runtime text classifier.
- Calibration uses only calibration labels. No measured holdout outcome is passed to the selector.
- Price calculations use reported tokens and registry peak rates; off-peak rates and rounded account balance differ.
- No commercial router or provider outside DeepSeek was called.

See selector-replay.json for every selection, source hashes, uncertainty intervals and sanitized error codes.
