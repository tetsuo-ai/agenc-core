# Rejected-write / whitespace recovery

A recoverable write error followed by `"\n\n"` used to end a headless run with exit 0 and unfinished code. The runtime now recognizes whitespace-only output as empty and asks the model to continue unfinished work within the existing permissions. It uses the existing attended/unattended retry limits; it never automatically replays a mutation.

## Spark 1 results, 2026-10-22

Native Linux ARM64 CLI, Node 26.12.1, local `DeepSeek-v4.1-Flash-EXL3` through the existing TensorFold server. Baseline `2a25d23c334fc289084d234aeb2070ffcdcdf790`; candidate runtime archive SHA-256 `8d94b5f90831d1ec969099848edd69329928ed8426e53186bb8470d92c63f758`. Both builds report 0.19.13. The live installed CLI was left untouched.

| Confirmation check | Before | After |
| --- | --- | --- |
| Rejected Write + whitespace: independent task checks | 0/5 | 5/5 |
| Persistent whitespace | false success, exit 0 | exit 4 after 3 retries |
| Ordinary CSV/SQLite: independent task checks | 4/6 | 6/6 |
| Ordinary tasks: CLI exit 0 | 6/6, including 2 incorrect tasks | 4/6; 2 explicit permission exits |

The controlled trigger scripts only the first two responses: an actual `Write` to an unread existing file, then a whitespace-only stop. The proxy requires the real runtime's rejection and unchanged file before sending the blank stop. All subsequent responses come from DeepSeek. Each candidate recovered, read the file, made a fresh edit and passed 3 visible + 5 heldout checks. The candidate needed 3–5 real model requests after the two scripted responses (median CLI time 12.942 seconds). The persistent-blank case keeps returning blanks; the candidate stops after the existing 2/8/30-second ladder rather than reporting success.

The ordinary regression screen uses fresh workspaces and the frozen CSV and SQLite fixtures, three paired repeats each. A separate read-only bubblewrap process checks the visible and heldout suites after every run, rejects missing test receipts/counts/skips, uses a private bytecode cache, and checks that supplied tests were unchanged. No candidate ordinary run exercised empty-response retry: the observed 4/6 versus 6/6 difference is **not causal evidence** for the fix. Both incorrect control runs returned `"\n\n"` with exit 0; one followed an unread-file Write rejection. Candidate runs `000020` and `000023` produced correct files but retained exit 2 after tool approval denials. No permissions were relaxed to improve the score.

All 28 attempts appear in [results.json](results.json), including two pilot pairs excluded from confirmation. The first candidate only detected whitespace: recovery fired, but the old “Return the final answer now” instruction led DeepSeek to describe its unfinished work and stop. That pilot remained incorrect. The final candidate also changed the recovery instruction.

This establishes recovery for the tested sequence with this local model. It does not estimate natural failure frequency or establish a general success rate, token reduction, or latency improvement. Scripted responses report artificial zero tokens; do not compare them as inference cost. The existing inference deployment may span both Sparks, so this is not a single-device throughput measurement.

## Reproduce

Use two built Linux runtimes with identical native dependencies/helpers and the same local model endpoint. Keep the model, sampler, context and output limits fixed. The recorded requests all used the same model, `max_tokens=8192`, `parallel_tool_calls=false`, no request temperature override, and no Light task-limit prompt. Existing server settings were unchanged. Every recorded request returned HTTP 200.

Set `NODE_BIN`, `BEFORE_AGENC` and `AFTER_AGENC` to their absolute paths. Use a **fresh** results directory and a private home directory outside the workspaces. The example uses an already-installed narrow AppArmor profile; omit that option only when the host does not need it. Doctor must report a ready sandbox; the runner fails if it cannot provide isolated verification.

```bash
bench=runtime/benchmarks/rejected-write-recovery
bench_args=(--root /tmp/agenc-recovery-bench --home-root "$HOME/.agenc-recovery-bench"
  --node "$NODE_BIN" --before "$BEFORE_AGENC" --after "$AFTER_AGENC"
  --apparmor-profile agenc-native-userns --variants paired)
python3 "$bench/evaluate.py" "${bench_args[@]}" --fixtures "$bench/trigger-fixtures.json" \
  --scenario rejected-write-blank --label trigger-confirmation --repeats 5
python3 "$bench/evaluate.py" "${bench_args[@]}" --fixtures "$bench/trigger-fixtures.json" \
  --scenario persistent-blank --label persistent-confirmation --repeats 1
python3 "$bench/evaluate.py" "${bench_args[@]}" --fixtures "$bench/natural-fixtures.json" \
  --scenario natural --label natural-confirmation --repeats 3
python3 "$bench/analyze.py" /tmp/agenc-recovery-bench/runs.jsonl /tmp/agenc-recovery-analysis.json
python3 -m unittest discover -s "$bench" -p 'test_evidence.py'
```

The runner records every request, tool error, CLI exit, independent check and timeout. Trials run serially with alternating variant order. A client timeout aborts the comparison and stops the isolated daemons rather than letting a background turn contaminate later trials. The frozen [protocol](protocol.json) specifies publication gates before confirmation; the analyzer reports missing trials and nonzero exits. The published evaluator additionally registers daemon cleanup before restart, covering partial-start failures found after measurement; its regression fails on the measured runner and passes after the cleanup fix. Both evaluator hashes are recorded.

## Validation

The exact final whitespace regression suite fails 4 new cases on pristine upstream, with its 7 existing cases passing. The fix passes 59 owning recovery/permission/budget/admission tests and 4 terminal-classification tests. Typecheck and the runtime build pass. Five benchmark negative controls pass.

`npm run test:fast` is **not green** on this macOS host: the cron-warning assertion at `runtime/tests/bin/bootstrap.test.ts:4672` fails (1 failed, 1509 passed, 117 skipped in the bail run). All five cases of that assertion also fail on a pristine upstream snapshot. The authoritative `npm test` boundary requires Linux Docker; these host functional checks and native Spark end-to-end trials do not replace that gate. Final cleanup found no processes using the benchmark homes and no active/waiting model connections.
