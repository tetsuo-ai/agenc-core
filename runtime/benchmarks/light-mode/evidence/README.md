# Light study evidence

The simultaneous completion, time and token target is **not met**. Light stays default-off and experimental. Nothing was merged, released or deployed.

The complete DeepSeek comparison uses 12 frozen tasks and two repeats per agent/model. Pi and normal mode reuse the original baseline; final Light production source is `11e51dcc132dac8f413b59cc745135592f90dfed`. Test-only tip `6c4c68431` has the same production behavior. All earlier candidates, failures and interrupted calls remain recorded.

| Model | Pi effective | Light effective | Pi / Light tokens per task | Pi / Light median seconds | Pi / Light p90 seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| deepseek-flash | 24/24 | 23/24 | 185724 / 159836 | 43.14 / 50.98 | 91.00 / 70.70 |
| deepseek-v4-pro | 23/24 | 20/24 | 254787 / 356101 | 97.65 / 129.85 | 198.32 / 300.31 |

Two Light task 06 cells failed before a model call because the benchmark directory produced an invalid UNIX socket path. Three other Pro cells timed out despite passing artifacts. All remain strict failures. Excluding task 06 from both cohorts still fails the target.

Luna used low reasoning, the same tasks and graders, and one concurrent run. It stopped at 269/600 whole-study attempts after repeated upstream 503 responses on both agents, despite three cooldown resumes. There are 29/48 main observations, including two reused Pi cells, and 19 unstarted cells. Missing usage remains unknown. The replay-on control was not started; no causal benefit from disabling replay is claimed. The owner proxy was never restarted or reconfigured.

## Published artifacts

- `expanded-comparison.json`: main aggregate and per-task results, exact run identities, acceptance gates and complete-study spend.
- `all-recorded-results.json`, `all-attempts.json`, `all-call-accounting.json`: allowlisted observations and charges. A misplaced model output directory is recorded separately rather than counted as a benchmark attempt.
- `raw-artifact-sha256.json`: hashes linking metrics to retained private captures. Request bodies, provider responses, logs, homes and credentials are not published.
- `decomposition.json`: per-run fixed prefix, history residual, output/reasoning and timing attribution. Raw prefix estimates are labeled; missing instrumentation remains null.
- `expanded-first-heads.json`: system/schema sizes, hashes and tool names, without Pi prompt or schema prose.
- `iterations.json`: every measured candidate cohort. Later brief, relative-path and required-actions screens remain unselected.
- `luna-mechanisms.json`, `luna-stop.json`: provider-attributed prefix diagnostics and the availability stop.
- `similarity-authored-source.json`: clean-room overlap counts and source hashes. Frozen third-party task inputs are separately verified clean.

Core main: 31,236 passed, 27 failed, 11 skipped. Corrected frame candidate: 31,316/27/11 with the same failure identities and zero new failures. Desktop main: 5,237/1/32; candidate: 5,238/1/32 with the same existing failure. Source/test-support and Desktop typechecks pass. The earlier `test-results.json` is retained as a historical snapshot; `frames-corrected-comparison.json` records the later full validation.

## Interpretation and reproduction

Effective completion requires the agent to finish and the grader to pass. Timeouts remain failures even if artifacts pass. Unknown usage is not zero. The strict gate requires no task completion loss, fewer tokens, and lower median and p90 time on every required model.

`legacy-harness/*.py.txt` preserves historical executed runner source for audit, not as a recommended launcher. Existing result identities are never rerun or overwritten. The maintained runner records source/task/configuration hashes and checks provider limits before admission. The complete ledger includes pilots, rejected calls and missing-usage reserves.

DeepSeek tool requests require prior reasoning content, so it is retained. Optional OpenAI reasoning replay was already off and is explicitly disabled in the main Luna runs. The exact Luna tokenizer is unavailable; raw diagnostics use a labeled reference estimate. Encrypted reasoning is counted as bytes, not plaintext tokens. The owner's proxy strips the requested output cap for both agents.

This process-based harness is not an adversarial filesystem sandbox. Shared scratch space and recorded fixture-path exposure limit the strength of its quality evidence. Shared host/provider load, serial candidate cohorts and small repeat counts also limit causal attribution. A lexical overlap screen does not prove semantic independence.
