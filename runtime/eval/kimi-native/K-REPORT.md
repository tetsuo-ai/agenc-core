# Kimi native follow-up report

Updated 2026-10-23T20:02:47.681836+00:00. Worktree: `wt-kimi-followup`. Branch:
`feat/kimi-k3-1-followup`. PR #3264 and `feat/kimi-k3-1` were not modified.
The interrupted WIP was reviewed and retained, with cache TTL accounting,
published prices, tests and the funded suite on this branch.
Execution status: matrix complete.
Native $20 usage target: met.

## Current results

Current matrix: **72/72 solved**, 424 native calls,
4,883,575 input and 55,452 output tokens, $3.295087 priced usage,
1653.3 seconds summed CLI time. Two independent runs per task and
model use the built CLI in the six owner-designated trusted slots, with both
HOME and AGENC_HOME set to the isolated `home-zdr`. No trust records were written
by the suite. The refreshed key was sourced without printing and kept in process environments,
never copied to evidence. Balance and model discovery use the same native credential
in the runner. The previous scheduler was stopped before this suite ran.

Every currently listed native model is included. Older `kimi-k2-thinking`,
K2 previews, K2.5 and `moonshot-v1` variants are retired and absent from
[/v1/models](https://platform.kimi.ai/docs/api/list-models). They were not sent
billable requests under invented model IDs. All six offered models support
vision. K3 models have 1M contexts; K2 models have 256k contexts.
[Official model list](https://platform.kimi.ai/docs/models).

Each result cell is **solves/runs; calls; input/output tokens; USD; seconds**.
The before column preserves actual insufficient-funds failures. Zero usage in
that column means the API refused the call, not that a task passed for free.

| Model | Task | Before: empty account | After: funded current branch |
| --- | --- | --- | --- |
| kimi-k3.1-pro | file | 0/2; 2; 0/0; $0.000000; 3.1s | 2/2; 6; 10,716/457; $0.011256; 28.0s |
| kimi-k3.1-pro | multi-file | 0/1; 1; 0/0; $0.000000; 1.4s | 2/2; 8; 17,672/1,431; $0.023849; 41.2s |
| kimi-k3.1-pro | debug | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 10; 23,611/1,649; $0.028691; 44.5s |
| kimi-k3.1-pro | replay | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 34; 140,737/6,343; $0.116347; 155.2s |
| kimi-k3.1-pro | vision | 0/1; 1; 0/0; $0.000000; 1.2s | 2/2; 8; 17,847/1,457; $0.023979; 63.0s |
| kimi-k3.1-pro | long-context | 0/1; 1; 0/0; $0.000000; 2.6s | 2/2; 8; 800,957/1,700; $0.359548; 74.8s |
| kimi-k3.1-pro-highspeed | file | 0/2; 2; 0/0; $0.000000; 2.2s | 2/2; 6; 11,338/765; $0.029522; 16.6s |
| kimi-k3.1-pro-highspeed | multi-file | 0/1; 1; 0/0; $0.000000; 1.2s | 2/2; 8; 17,434/1,301; $0.041279; 19.4s |
| kimi-k3.1-pro-highspeed | debug | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 10; 24,607/2,015; $0.060904; 27.2s |
| kimi-k3.1-pro-highspeed | replay | 0/1; 1; 0/0; $0.000000; 1.0s | 2/2; 34; 133,176/5,581; $0.187108; 83.1s |
| kimi-k3.1-pro-highspeed | vision | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 7; 14,854/1,118; $0.036013; 18.9s |
| kimi-k3.1-pro-highspeed | long-context | 0/1; 1; 0/0; $0.000000; 1.6s | 2/2; 7; 700,131/1,539; $0.554952; 41.5s |
| kimi-k3 | file | 0/2; 2; 0/0; $0.000000; 2.5s | 2/2; 6; 10,470/320; $0.015474; 20.1s |
| kimi-k3 | multi-file | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 8; 16,752/987; $0.027736; 33.7s |
| kimi-k3 | debug | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 10; 21,864/1,025; $0.031892; 51.9s |
| kimi-k3 | replay | 0/1; 1; 0/0; $0.000000; 1.2s | 2/2; 37; 137,772/4,354; $0.142012; 172.2s |
| kimi-k3 | vision | 0/1; 1; 0/0; $0.000000; 1.2s | 2/2; 6; 11,571/544; $0.017269; 33.5s |
| kimi-k3 | long-context | 0/1; 1; 0/0; $0.000000; 2.1s | 2/2; 6; 598,282/656; $0.459611; 53.6s |
| kimi-k2.7-code | file | 0/2; 2; 0/0; $0.000000; 2.6s | 2/2; 6; 9,053/265; $0.004991; 14.1s |
| kimi-k2.7-code | multi-file | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 8; 14,328/716; $0.007720; 25.5s |
| kimi-k2.7-code | debug | 0/1; 1; 0/0; $0.000000; 1.3s | 2/2; 10; 18,403/657; $0.008632; 26.3s |
| kimi-k2.7-code | replay | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 34; 126,224/5,399; $0.054735; 143.9s |
| kimi-k2.7-code | vision | 0/1; 1; 0/0; $0.000000; 1.2s | 2/2; 6; 10,255/574; $0.005812; 22.9s |
| kimi-k2.7-code | long-context | 0/1; 1; 0/0; $0.000000; 1.6s | 2/2; 6; 597,578/669; $0.191956; 62.7s |
| kimi-k2.7-code-highspeed | file | 0/2; 2; 0/0; $0.000000; 2.5s | 2/2; 5; 7,497/252; $0.008280; 8.1s |
| kimi-k2.7-code-highspeed | multi-file | 0/1; 1; 0/0; $0.000000; 1.4s | 2/2; 8; 15,006/659; $0.015290; 13.2s |
| kimi-k2.7-code-highspeed | debug | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 11; 22,707/1,537; $0.026644; 21.3s |
| kimi-k2.7-code-highspeed | replay | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 32; 87,343/2,822; $0.070624; 54.2s |
| kimi-k2.7-code-highspeed | vision | 0/1; 1; 0/0; $0.000000; 1.2s | 2/2; 6; 10,318/534; $0.012981; 13.6s |
| kimi-k2.7-code-highspeed | long-context | 0/1; 1; 0/0; $0.000000; 1.7s | 2/2; 6; 597,532/656; $0.383331; 47.5s |
| kimi-k2.6 | file | 0/2; 2; 0/0; $0.000000; 2.4s | 2/2; 6; 9,354/435; $0.006177; 12.0s |
| kimi-k2.6 | multi-file | 0/1; 1; 0/0; $0.000000; 1.4s | 2/2; 8; 14,584/865; $0.010034; 18.0s |
| kimi-k2.6 | debug | 0/1; 1; 0/0; $0.000000; 1.3s | 2/2; 9; 17,750/998; $0.010743; 20.0s |
| kimi-k2.6 | replay | 0/1; 1; 0/0; $0.000000; 1.3s | 2/2; 33; 107,852/3,982; $0.063378; 77.3s |
| kimi-k2.6 | vision | 0/1; 1; 0/0; $0.000000; 1.1s | 2/2; 6; 10,250/588; $0.005644; 15.2s |
| kimi-k2.6 | long-context | 0/1; 1; 0/0; $0.000000; 1.5s | 2/2; 5; 497,750/602; $0.240672; 79.3s |

## Earlier funded evidence and stress runs

Earlier funded runs are preserved separately from the current matrix. They include the interrupted WIP and its initial completion-gate failure.

| Group | Solves/runs; calls; input/output; USD; seconds |
| --- | --- |
| Earlier funded runs | 51/52; 319; 2,779,916/52,046; $2.414123; 1315.1s |
| Additional confirmation / TTL | 2/2; 34; 134,656/6,695; $0.142112; 189.4s |
| Seeded long-context stress | 13/14; 42; 11,825,131/32,810; $13.574137; 1225.7s |
| Additional reasoning stress | 11/11; 186; 613,523/22,399; $0.545886; 573.5s |

| Model | Stress result | Target token range |
| --- | --- | --- |
| kimi-k3.1-pro | 3/3; 10; 3,217,857/7,245; $4.153169; 204.4s | 106,242 to 500,000 |
| kimi-k3.1-pro-highspeed | 2/2; 7; 2,692,192/5,607; $3.435097; 133.9s | 225,388 to 500,000 |
| kimi-k3 | 2/3; 8; 3,032,340/5,973; $4.188548; 302.3s | 172,966 to 500,000 |
| kimi-k2.7-code | 2/2; 6; 1,038,751/4,768; $0.481546; 236.5s | 140,432 to 200,000 |
| kimi-k2.7-code-highspeed | 2/2; 5; 874,777/4,521; $0.882649; 159.6s | 130,116 to 200,000 |
| kimi-k2.6 | 2/2; 6; 969,214/4,696; $0.433128; 189.0s | 114,526 to 200,000 |

The standard long-context task is tokenizer-calibrated near 98k tokens and
requires ordered retrieval plus file write/read-back. Seeded stress variants
shuffle records and retrieve 24 fresh values. The grader protects fixture tests
and checks actual tool behavior, not only final text. Debugging must show a
failed first test followed by a passing test. Replay must show all six stages
and matching reasoning hashes across requests. Vision requires image payloads
and an independently checked answer.

## Caching before and after

The before-cache baseline consists of the earlier funded K3.1 replay runs,
which already received automatic caching. The after runs add the stable routing
key and actual write-tier accounting. This is an observational comparison with
stochastic outputs and warm-cache effects, not a controlled speed benchmark.

| K3.1 replay group | Solves/runs | Calls | Input | Cached | Token hit rate | Cost | Time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Before cache follow-up | 4/4 | 67 | 266,641 | 240,384 | 90.15% | $0.219401 | 303.5s |
| After cache follow-up | 2/2 | 34 | 140,737 | 126,976 | 90.22% | $0.116347 | 155.2s |
| Additional TTL confirmation | 2/2 | 34 | 134,656 | 119,808 | 88.97% | $0.142112 | 189.4s |

| Current replay run | Distinct system prefix hashes | Tool hashes | Routing key hashes | Requested TTL | 5m writes | 1h writes |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| after-kimi-k3.1-pro-replay-20 | 1 | 1 | 1 | default 5m | 5376 | 0 |
| after-kimi-k3.1-pro-replay-21 | 1 | 1 | 1 | default 5m | 4096 | 0 |
| after-kimi-k3.1-pro-replay-30 | 1 | 1 | 1 | 1h | 0 | 5632 |
| after-kimi-k3.1-pro-replay-31 | 1 | 1 | 1 | 5m | 0 | 5120 |

The [complete caching guide](https://platform.kimi.ai/docs/guide/context-caching)
and its linked Chat, Responses, Messages and pricing pages were reviewed.
Caching is implicit and organization-isolated. The default is five minutes;
K3 accepts `prompt_cache_options={mode:implicit,ttl:5m|1h}`. There are no explicit
cache objects, cache IDs, special cache roles, manual refresh calls or deletion
calls. Explicit breakpoints are rejected. Writes require complete cache blocks,
but no numeric minimum block size is published. AgenC keeps the stable prefix
unchanged and appends task state and tool results.

The first write locks the TTL. Hits renew that original TTL for free, including
when a later request asks for a different TTL. The response billing headers
identify actual five-minute and one-hour writes. Both are subsets of total
input, alongside cache hits and uncached input. One-hour writes cost twice the
ordinary input rate; five-minute writes cost the ordinary input rate. Reasoning
is already included in output. See [pricing](https://platform.kimi.ai/docs/pricing/chat)
and the full [feature checklist](DOCS-REVIEW.md).

## Failures, causes, fixes and confirmation

- HTTP 429 `exceeded_current_quota_error`: the old account had no funds. The new key and funded balance resolved the account issue. The existing terminal-funds handling is retained and unit-tested; the table records reruns of every previously blocked task.
- Initial funded file task: correct file, but the prose completion gate conflicted with the requested exact `hi` reply. The WIP changed the harness to the CLI's existing JSON output contract, leaving independent task grading intact. Current file runs confirm exact bytes, read-back and final content.
- Cache billing gap: only default write pricing existed; one-hour writes were unaccounted for. Added actual response TTL parsing for JSON/SSE, published one-hour rates and sweep pricing, with tests for TTL locking, missing/malformed counts and no double counting.
- Missing cache routing hint and TTL selection: added stable session `prompt_cache_key`, request-scoped TTL and isolated client `AGENC_KIMI_CACHE_TTL`. Mocked requests cover all six models and environment precedence. Stable prefix and tool hashes are measured above.
- K3 500k-token stress timeout: the first two inference responses succeeded and the written artifact matched all 24 expected values. A later read-only preflight timed out before admission, leaving no pending inference reservation. The guard now retries transient diagnostic failures once and reuses a calibrated token bound only for byte-identical, append-only conversation history. Each appended UTF-8 byte reserves one token; changed history, model or image tails require recalibration. Regression tests cover retry limits, exhausted quota and changed prefixes. Failed run 102 remains preserved; confirmation used the identical seed 102 and 500k target under repeat 1020 and passed in 106.05 seconds across three calls. Both later calls reused the calibrated bound.
- Stop limits: added local validation for the documented five-string, 32-byte limit, including multibyte regression tests.
- Local validation found an outdated Kimi prefix expectation and a new environment entry out of sort order. Both were corrected. The first PR's latest test commit was merged into this follow-up only; its obsolete unpriced K3.1 exceptions were removed here.

## Additional API contract probes

These small native API probes are separate from the built-CLI task matrix. They use the same guarded spend ledger.

| Model | Combined schema and tools | Separate tool and schema phases |
| --- | --- | --- |
| kimi-k3.1-pro | unexpected-tool-contract | Passed |
| kimi-k3.1-pro-highspeed | unexpected-tool-contract | Passed |
| kimi-k3 | unexpected-tool-contract | Passed |
| kimi-k2.7-code | Passed | Passed |
| kimi-k2.7-code-highspeed | unexpected-tool-contract | Passed |
| kimi-k2.6 | invalid-schema-content | Passed |

The combined probes returned HTTP 200 even when the requested workflow failed. K3/K3.1 and K2.7 Highspeed skipped the tool; K2.6 called it but fenced its final JSON. The provider retains its capability gate for these combinations and now explains the general workaround: run tool steps first, then request the final schema with an empty tool catalog. Mocked tests cover this sequence for all six models and reject unsafe combinations before HTTP. K2.7 Code alone completed the combined loop. This limitation is kept visible rather than counted as a successful task.

| Preserved funded failure | Cause/evidence |
| --- | --- |
| after-kimi-k3-long-context-102 | status=failed; completion warning=False; behavior verified=False; grader=independent JSON oracle |
| before-kimi-k3.1-pro-file-1 | status=failed-completion-contract; completion warning=True; behavior verified=True; grader=exact bytes |

## Spend ledger

All amounts are USD. Prior owner spend remains included. Account deductions can lag streamed usage, so the guard uses the larger of observed spend and prior spend plus priced usage with a 10% margin. Every call reserves input and maximum output before transmission. The $24 owner cap and $1 balance floor remain active.

| Checkpoint | Available balance | Owner observed spend | Native priced usage |
| --- | ---: | ---: | ---: |
| Funded account start | 24.999100 | 0.191417 prior OpenRouter | 0 |
| Current suite start | 22.484000 | Preserved in request ledger | Earlier usage retained |
| After latest kimi-k3.1-pro matrix request | 22.484000 | 2.706517 | 2.999607 |
| After latest kimi-k3.1-pro-highspeed matrix request | 21.920340 | 3.270177 | 3.909385 |
| After latest kimi-k3 matrix request | 20.803170 | 4.387347 | 4.752758 |
| After latest kimi-k2.7-code matrix request | 20.803170 | 4.387347 | 5.026605 |
| After latest kimi-k2.7-code-highspeed matrix request | 20.085379 | 5.105137 | 5.543755 |
| After latest kimi-k2.6 matrix request | 20.085379 | 5.105137 | 5.880403 |
| Latest reconciled total | 4.945600 | 20.244917 | 20.014156 |

The first funded probe originally recorded zero cost because its rate card was missing. Its preserved usage prices to $0.08720760, already included in the running ledger. The sanitized request ledger includes both the original recorded cost and the reconstructed cost for those eight calls.

Cash balance: $4.945600; vouchers: $0.000000. Outstanding reservation: `null`.

Observed native account deductions total $20.053500, compared with $20.014156 reconstructed from response usage. The $0.039344 difference remains unreconciled against an itemized Moonshot invoice; balance timing and token-price reconstruction are separate evidence. The spend guard uses the larger account-based total and its usage margin. No further paid requests remain active.

The sanitized run results are in [evidence.json](evidence.json); per-request
usage and balance checkpoints are in [request-ledger.jsonl](request-ledger.jsonl).
Raw fixture evidence remains in the owner's `glm-fit/kimi-evidence/funded-2026-10-23`
directory. Keys, request authorization headers and account identifiers are not
included in the report or committed evidence.

## ZDR and documentation coverage

Native `kimi` shows retained/red for every model. The
[privacy policy](https://platform.kimi.ai/docs/agreement/userprivacy) retains input
while the account is active. [Enterprise ZDR](https://platform.kimi.ai/docs/guide/zero-data-retention)
requires approval by Moonshot; no request parameter enables it. With ZDR,
prompts and outputs are deleted after responding except where law requires
otherwise. Enterprise data is not used for training. Batch, direct file uploads
of images/videos, operational records and third-party services are excluded.
The WIP badge classification was correct and remains, with citations and tests.

OpenRouter Moonshot routes instead use live endpoint eligibility and
`provider.zdr=true`. The checked public list includes K3.1 Pro, K3, K2.7 Code,
K2.6, K2.5, K2 Thinking, K2 0905 and K2. Disabling ZDR shows retained; an
unrecognized proxy shows unknown. Native account policy is not inferred from
OpenRouter's list. No OpenRouter inference was purchased during this follow-up.

The [documentation checklist and complete source manifest](DOCS-REVIEW.md)
covers the platform bundle and OpenAPI schema, including every feature requested
by the owner. Optional service APIs not exposed by the AgenC chat provider are
listed explicitly: native video, remote file management, partial prefill, batch,
Formula execution, standalone Moonshot search/fetch, Responses/Messages wires,
log probabilities, prediction and safety identifiers.

## Validation and open issues

- TypeScript and test-support typechecks passed with the pinned npm 11.17.0 in the isolated home.
- 304 targeted TypeScript tests passed across 12 files after merging release 0.19.17, including six-model split tool/schema tests and model-family regressions.
- 10 wire capture and budget-ledger tests passed, including append-only calibration and bounded diagnostic retry.
- 12 Python fixture, suite budget and legacy price reconstruction tests passed.
- Final build passed after merging release 0.19.17, including launcher preflight, package entrypoints and generated SDK type parity. Built revision: 37cf50406e0b.
- Live split tool/schema confirmation passed for all six native models; raw combined-contract failures remain documented.
- The identical K3 seed 102 at 500k tokens passed under repeat 1020 after the preflight fix; both subsequent requests reused the conservative calibration.

Current matrix missing runs: 0. Current matrix failed runs: 0.

The base matrix ran before merging release 0.19.17. The merged build was
typechecked and passed 304 targeted tests; subsequent stress runs exercise that
rebuilt CLI across all six models. Passing these fixtures does not establish
perfection on arbitrary tasks. The
4,096-token evaluation output cap is lower than production defaults and the
docs' recommendation for deep reasoning. TTL renewal/expiry timing is governed
by Moonshot; local tests verify serialization and accounting, while live counts
verify cache hits and write tiers. Unsupported optional API surfaces are not
advertised as completed features.

## Prepared PR description

Title: Kimi: live results across all models, ZDR status and fixes

Follow-up to #3264, leaving its branch unchanged. Complete the interrupted native
Kimi evaluation and add the now-published pricing, cache TTL usage accounting and
stable session cache routing. Preserve Moonshot's native retained badge with
policy citations and distinguish OpenRouter's request-level ZDR eligibility.

Include independently graded CLI results for every currently offered native
model across file read-back, multi-file editing/tests, failed-test debugging,
reasoning replay, vision and near-100k-token retrieval, plus seeded long-context
stress and a cumulative spend ledger. Document official API coverage and remaining
optional surfaces. Add regression tests for cache writes/hits, TTL locking,
streaming, stop limits, isolation, pricing and retention. Avoid repeated giant
tokenizer requests with conservative append-only bounds and retry transient
read-only diagnostic failures without retrying paid inference.

Validation: 72/72 current matrix solves; 24/25 stress solves. Native priced spend $20.014156; latest account balance $4.945600. See the report for local checks, TTL verification, failed combined-schema probes and remaining API surfaces.
