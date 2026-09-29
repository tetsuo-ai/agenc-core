# Offline validation

Validated on Linux on 2026-09-29. No paid provider request or real credential read was made to package or validate this harness. No test suite ran on the Mac.

| Check | Result |
| --- | --- |
| Runner accounting synthetic tests | 17 passed, 0 failed |
| Portable configuration, lock, credential boundary, trace audit/export and transport-cap tests | 11 passed, 0 failed |
| Summarizer self-test | Passed, including later-call model fallback rejection and incomplete/failed-run retention |
| Luna framed transport self-test | Passed with fake local responses, 0 provider calls |
| Original unsolved tasks | 12/12 correctly rejected |
| Reference solutions | 12/12 accepted |
| Original-test tampering | 12/12 correctly rejected |
| Real-path configuration validation with a `/proof` mount | Passed, 0 provider calls |

The full offline set passed both with the Linux host's Python and in the benchmark's Node container. The container reported Node `v26.5.0`, Python `3.11.2` and Pi `0.73.1`; its image digest was `node@sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271`.

The packaging tests mock all external provider/process operations; the bridge self-test uses an owned Linux child and loopback listener to exchange fake frames. Its absolute-duration and byte-cap checks use fake worker streams. The task self-validation uses fresh copies of the pinned real repositories and no model. The first added cap test asserted against framed base64 text instead of its decoded error payload; that test assertion was corrected and the complete packaging set passed afterward.

The bare Linux host has no Node executable, so real-path `--validate-only` was run successfully in the pinned Node container. No runtime source, Core unit test, Desktop source or active benchmark-runner file is modified by this package. The existing 17 runner accounting checks remain passing; the portable packaging adds 11 checks, including response-only streamed tool-call review and legacy Luna cost normalization. Full Core/Desktop baseline comparisons and paid token comparisons belong to the implementation study, not to these offline packaging checks.

Final paid study evidence is intentionally pending. See `evidence/README.md` for the publication contract.

Later accounting change,2026-09-29: eight new `test_reconcile_budget.py` checks passed on Linux. They cover peak Pro retention, off-peak Pro/Flash bounds, unchanged measured costs, and refusal of mismatched rates/models/reserves, conflicting usage and absent or excessive output caps. The changed exporter regression also passed in isolation and verifies both reserve values survive publication while usage remains missing. The earlier28 offline checks are reused; no paid call or completed suite was rerun for this change. Reconciliation keeps the original ledger and task results intact and does not raise the study cap.

The packaging credential-pattern scan covered 45 owned Mac artifacts and 1,814 Linux package/validation artifacts, with zero token/private-key-pattern hits. It read no real credential and printed no matches. This is an artifact hygiene check, not a substitute for the study owner's scan of all raw model traces before publication.

Operator-cap and owner-target update: the cap validator accepts an explicitly authorized $25 total, still rejects a $26 cap, a balance floor below $10 and more than two workers. Eleven packaging checks and the expanded summary self-test passed in the pinned Linux Node container. The summary now requires lower median and nearest-rank p90 wall time per model and no failed Light repeat on any Pi-completed task. Equal time is not a win. No new paid run was launched for these changes.
