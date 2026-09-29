# Independent Light: fair timing confirmation

Frozen Core `3c954ea5591c683aa9b14a0219345e11051b06dd` **does not meet every requested aggregate gate on both DeepSeek models**. The new `candidate-eq` matrix contains all 48 declared cells, twelve frozen tasks repeated twice per model. Its raw wall times govern timing acceptance. The earlier confirmation remains retained and is reported separately; Pi was not rerun.

## Equal guard and retained evidence

The new harness uses **one live balance check per task before process launch**, matching the retained Pi method. It keeps the same lifetime $15 spend ledger, $10 account floor, 45-call task cap, high reasoning effort, 8,192-token output ceiling, task deadlines, prompts and graders. Before every provider call, local reservations check the lifetime cap and account headroom from the latest live balance minus subsequent local spend and all in-flight maximum charges. An unavailable or sub-floor balance blocks launches. Other jobs can spend between live checks, as in the Pi baseline method. No balance time was subtracted from a completed result. The longest socket path is 93 bytes.

The earlier confirmation used per-call live balance checks inside task time. Those checks averaged 6.21 seconds/task on Flash and 8.45 on Pro. Its original 46/48 launch, two zero-call socket failures, and 48/48 completed model-bearing repair matrix remain intact. The earlier full report remains in the retained benchmark archive. No failed or completed model-bearing cell was selectively retried in the fair matrix.

## Full comparison

| Model | Agent / confirmation | Completed | Median / p90 s | Tokens/task | Calls/task |
| --- | --- | ---: | ---: | ---: | ---: |
| deepseek-flash | Retained Pi | 24/24 | 43.14 / 91.00 | 185,724 | 17.00 |
| deepseek-flash | Independent Light, earlier guard | 24/24 | 44.17 / 93.21 | 158,977 | 14.42 |
| deepseek-flash | Independent Light, equal guard | 24/24 | 43.97 / 79.30 | 166,521 | 15.25 |
| deepseek-flash | Main Light 9e7 | 23/24 | 69.02 / 129.68 | 321,514 | 20.92 |
| deepseek-flash | Main Light 11e, latest full | 23/24 | 50.98 / 70.70 | 159,836 | 16.50 |
| deepseek-v4-pro | Retained Pi | 23/24 | 97.65 / 198.32 | 254,787 | 19.96 |
| deepseek-v4-pro | Independent Light, earlier guard | 24/24 | 86.53 / 195.13 | 251,101 | 20.08 |
| deepseek-v4-pro | Independent Light, equal guard | 24/24 | 81.70 / 200.70 | 250,113 | 19.33 |
| deepseek-v4-pro | Main Light 9e7 | 21/24 | 153.81 / 300.31 | 384,221 | 24.75 |
| deepseek-v4-pro | Main Light 11e, latest full | 20/24 | 129.85 / 300.31 | 356,101 | 22.54 |

Main 9e7 has the stronger Pro completion result; main 11e improves Flash time and tokens. Neither dominates the other across both models, so both retained full candidates are shown. Their own failed cells, including startup failures and timeouts, stay included. Main-job newer subset experiments are not substituted for full confirmation.

| Model | Completion / no lost Pi task | Faster median | Faster p90 | Fewer tokens |
| --- | --- | --- | --- | --- |
| deepseek-flash | pass | fail | pass | pass |
| deepseek-v4-pro | pass | pass | fail | pass |

These are observed comparisons with two repeats per task, not a general performance guarantee. Stochastic call counts and reasoning can differ between the two confirmations even though source is unchanged.

## Analytic decomposition

All retained and new per-task tables are in [per-task decomposition](light-independent-status.md); numeric records are in [numeric per-run evidence](light-independent-data.json). They report N, raw system-plus-schema P, N×P, prefix changes after discovery, history residual, the largest tool results and message positions, visible/tool-argument output, reasoning output, TTFT, generation, tool durations, guard and residual overhead. N×P + prefix change + history + output equals provider-recorded total tokens. Historical Pi did not record exact TTFT/generation or separate tool durations, so those splits and their deltas remain NA. Sum of tool spans can overlap; residual overhead is an estimate. Mean components do not decompose a median. Recorded request spans include local reservation and serialization before upstream forwarding. Full proxy admission overlaps that request span; the smaller pre-reservation guard interval does not. Neither interval includes the fair pre-launch live balance request.

| Model | ΔN×P | Δprefix change | Δhistory | Δvisible output | Δreasoning | Δprovider requests s | Δtools + overhead s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-flash | 985.4 | 268.3 | -20,184.5 | 143.0 | -415.0 | -5.1 | 5.1 |
| deepseek-v4-pro | 3,156.9 | 365.3 | -8,392.9 | 417.9 | -220.4 | -26.6 | 7.9 |

| Model | Light / Pi reasoning tokens | Light TTFT / generation s | Light tool / runtime overhead s | Pre-reservation interval / full admission s |
| --- | ---: | ---: | ---: | ---: |
| deepseek-flash | 2,681.8 / 3,096.8 | 14.04 / 21.93 | 6.63 / 5.15 | 0.0029 / 0.30 |
| deepseek-v4-pro | 3,870.1 / 4,090.5 | 25.19 / 55.59 | 7.48 / 7.77 | 0.0049 / 0.42 |

The only change for this rerun addresses the largest measured Flash timing penalty: unequal live balance requests in the harness. The prior measured token term was history replay; it motivated canonical read/batch-edit guidance, capability lookup, bounded new output and focused inspection. Those independent designs remain frozen. The stable full-catalog experiment was already measured and rejected: 657,011/727,337 tokens per task on Flash/Pro and failure of the frozen task12 discovery condition. Existing exit-event waits and retrievable output references remain; neither universal event-only continuation nor removed reasoning history is claimed.

For each fair task, STATUS.md retains term-by-term deltas and the largest measured term. Reasoning output and its replay are separate measured quantities. These observational prompt comparisons cannot establish that AgenC wording causes a reasoning difference. No new runtime or prompt tuning was made to chase this confirmation.

## Path-guidance finding

**The frozen candidate has the guidance gap.** `light-presentation.ts` replaces FileRead/MultiEdit descriptions and strips property descriptions, removing the canonical workspace-relative path advice. `light-workflow.ts` does not restore it. All four earlier task07 first requests confirm the omission. This candidate uses MultiEdit initially; a subsequently discovered Write retains its canonical description, unlike the main job’s compact Write. The earlier four DeepSeek task07 cells passed; that does not disprove the risk or predict Luna behavior. No Luna calls were made here. In the fair Flash task05 repeat2, a mistyped absolute edit path is rejected at call4 and corrected at call5. This directly records a recovered path error without proving the omitted wording caused it.

The candidate also disables automatic headless completion rounds for Light unless explicitly configured `always`; this is another relevant behavior shared with the diagnosis. The reported main Luna failure involved a wrong absolute output path and abandoned recovery. No path or completion-policy change was made to this frozen candidate. Evidence: `evidence/path-guidance-audit.json`; diagnosis: `/private/tmp/light-diag/REPORT.md`.

## Tests and integrity

Linux build, source/test-support typechecks and the retained 85 focused checks pass. The fair guard has 45 passing offline harness checks. The new full-suite pair uses the official Linux runner, sequentially after all paid cells, on pinned main `3caa13df9` and the unchanged candidate `3c954ea55`.

| Full suite | Result |
| --- | --- |
| Pinned main | Tests  31 failed / 32497 passed / 11 skipped (32539) |
| Frozen candidate | Tests  27 failed / 32509 passed / 11 skipped (32547) |

New full-suite failure identities versus this paired main: **0**. Earlier full-suite failures and isolated passes remain in the old report and evidence; a later result does not erase them.

Fair cohort overlap: 13/48 cells overlap main-job provider intervals; 0/48 overlap its Core suites; 0/48 overlap owned Core suites. Exact intervals are in `evidence/overlap-fair.json`. No overlap-based timing correction is applied.

The frozen benchmark is process-based, not an adversarial filesystem boundary. Existing baseline/main fixture-name exposure and container scratch-space caveats remain. Task12 requires Light to discover and call the initially deferred planning tool; Pi is exempt from that discovery receipt. The grader was not weakened. The fair trace audit covers 1,135 distinct calls. Pro task03 repeat2 executes two root searches that expose source-cache and sibling-run filenames; later observed reads and edits stay in its repository, with no observed foreign source-content read. This is a real workspace-scope violation qualifying the 48/48 functional grader result. Flash task05 repeat2 recovers from a rejected mistyped absolute edit path. Temporary container fixtures/cleanup and false-positive syntax fragments remain documented. The authoritative audit uses the original Linux path mapping; an invalid Mac-path audit is retained separately. Final clean-room/credential scans are recorded in STATUS.md and their evidence files.

Lifetime ledger: 2,752 entries; observed list-rate estimate $2.833374, conservatively charged/reserved $2.853192, below the $15 cap. Credentials entered Linux only through SSH stdin and process memory. Scans emit counts and paths, never matching contents.

No merge, release or deployment is included.


Final credential scans cover 9,897 Mac files and 75,764 PC files. Both find
zero exact authorized-key matches, zero generic provider-key matches and
zero read errors. The three Mac and fifteen PC header-flagged files match
unchanged pinned-main fixtures byte for byte. Match contents were never
printed. Dependency trees, Git object databases and symlinks are excluded.

Clean-room verification compares every changed Core source/prompt/tool file
and authored proof file against the 701-file Pi package using normalized
8/12/20-word overlap, with inherited main text subtracted. New textual overlap
is zero; numeric-only table sequences are retained separately. This is a
lexical check, not proof of semantic independence. No Pi package prose was
used as implementation input or included in the published numeric evidence.

The raw traces, control harness and detailed scan logs remain in the benchmark archive. This document and its linked numeric tables contain no captured prompt or response text.
