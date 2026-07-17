# Real-agent seed baseline — 2026-07-17

First real-model scorecard from the eval pilot executor (M1 "run the actual
AgenC agent, not a mock executor"). One trial per task across the 10
triple-preflight-qualified SWE-bench-Live pilot tasks, real AgenC runtime in
the phase-2b egress lane.

## Headline

| metric | value |
|--------|-------|
| Verified Fix Rate (VFR) | **7/10 = 70%** |
| Infrastructure-invalid runs (final) | **0/10** |
| Oracle containment | contained on 10/10 runs (all six deny-probes green) |
| Patch key-leak scans | clean on 10/10 |

TFR is not reported yet: the trust-conformance (fault-injection) lane has not
run against this agent build, so there is no Trust Recovery Rate to conjoin.

## Setup

- Agent under test: AgenC runtime 0.6.1 (overlay tarball), headless
  `agenc -p`, daemon mode, `--yolo`, 30-minute cap per task.
- Model/provider: `grok-4.5` via `api.x.ai` (OAuth), through the phase-2b
  egress lane: docker `--internal` network, SNI-pinned allowlist CONNECT
  sidecar, blackholed DNS, pre-agent containment probes (fail-closed).
- Verifier: eval pilot executor at agenc-core `3b5bbc4b5` (includes #1530
  hidden-test-patch base-reset, #1531/#1532 libatomic shim). Hidden gold test
  patch + full target/regression check set, absent-counts-as-failing.
- Oracle isolation: agent saw only setup patch, issue text, and overlay;
  never the test patch, reference patch, or verifier. Provider key delivered
  via `docker exec -e NAME` (never argv or patch).

## Per-task results

| task | lang | outcome | patch | agent wall |
|------|------|---------|-------|-----------|
| cthackers__adm-zip-559 | js | verified_fix | 600 B | (first run, earlier session) |
| gsd-build__get-shit-done-2186 | js | verified_fix | 2.0 KB | 5.8 min |
| grommet__grommet-7718 | js | verified_fix ¹ | 4.5 KB | 6.2 min |
| withastro__starlight-3293 | ts | verified_fix ¹ | 1.6 KB | 1.6 min |
| spectreconsole__spectre.console-2082 | c# | verified_fix | 7.6 KB | 15.5 min |
| quartznet__quartznet-2932 | c# | verified_fix ¹ | 8.5 KB | 12.6 min |
| gfx-rs__wgpu-9298 | rust | verified_fix ¹ | 23.2 KB | 15.1 min |
| shader-slang__slang-10738 | c++ | verification_failure | 1.9 KB | 35.5 min |
| harfbuzz__harfbuzz-5947 | c | verification_failure ¹ | 4.1 KB | 4.5 min |
| mc1arke__sonarqube-community-branch-plugin-1221 | java | verification_failure ² | 15.4 KB | 15.6 min |

¹ The batch ran against the pre-#1530 verifier, which recorded a false
`infrastructure_error` whenever the agent had touched test-adjacent files
(the gold hidden test patch then failed to apply). These five verdicts were
re-adjudicated by re-running `verifyCandidatePatch` (post-#1530) on the
saved agent patches — no new model spend. Four flipped to `verified_fix`;
harfbuzz's hidden target check genuinely fails (`api - harfbuzz:test-ft` =
"fail" with 1094 parsed results).

² First attempt never started the agent: the task image ships no
`libatomic.so.1`, which the overlay's portable Node needs (#1531), and the
runtime's own `LD_*` env-scrubbing hardening defeated the env-var fix for
the daemon child (#1532 installs the shim into the container's system lib
dir instead). Re-run after both fixes: agent ran contained and produced a
15.4 KB patch, but the hidden tests reference an API method the reference
fix introduces (`AzureDevopsClient.retrievePullRequestIterationIdForCommit`)
that the agent's differently-shaped fix never implemented — hidden test
compilation fails, scored `verification_failure`.

## Failure taxonomy (3 failures)

- 2 × hidden-test API/behavior mismatch: the fix compiles and may work, but
  does not satisfy the gold tests' expected shape (sonarqube: missing client
  method; slang: `diagnose-specialize-unconstrained-generic-with-assoc-type
  .slang.3` fails).
- 1 × target check not achieved: harfbuzz `test-ft` still failing, probe
  binary absent.

## Adversarial patch audit

All seven verified patches were independently audited (7 parallel auditors
prompted to refute the verdicts: test-gaming, hardcoded expected values,
verifier tampering, secrets, network access). All seven judged
**genuine root-cause fixes**; the only test-file edits found were mechanical
snapshot updates or good-faith added regression tests, which cannot affect
the verifier (it resets test files to base before applying the gold tests).

## Harness fixes shipped by this baseline

Running real agents surfaced three verifier/lane defects, each fixed on main
with revert-sensitive tests before final adjudication:

- #1530 — hidden test patch now resets its target files to base before
  applying (canonical SWE-bench), ending false `infrastructure_error`s when
  agents touch snapshots/test context.
- #1531 — overlay ships a `node/compat/libatomic.so.1` shim;
  `LD_LIBRARY_PATH` at every overlay-node exec site (sidecar, probes, agent
  lanes).
- #1532 — when the overlay node cannot start bare, the agent script installs
  the shim into the container's system lib dir, since the runtime scrubs
  `LD_*` from child environments (deliberate loader-injection hardening that
  the eval lane must not weaken).

## Limitations

- n=10 development-set tasks, one trial each: a seed signal, not a powered
  claim. No repetitions, no confidence intervals, no comparator lane yet.
- Token usage/cost was not captured by the headless result path in this
  runtime build (`tokenUsage: null`); cost-per-trusted-fix is not reportable.
- adm-zip's run predates the batch (it was the lane-proving run) and its
  wall time was not recorded on the same clock.
- The agent build under test (0.6.1) trails main; the harness fixes above do
  not change agent behavior, but the next baseline should pin a current
  runtime tarball.
- Trust-conformance lane not yet run → no TRR/TFR.

## Raw evidence

Append-only raw run evidence (agent reports, patches, verification
transcripts, progress log, pre-fix sonarqube report, batch driver) is stored
outside the repo at `~/agenc-eval-evidence/seed-baseline-2026-07-17/` on the
operator machine. Report digests inside each `agent-run-report.json` bind
the evidence; prompts and provider credentials are not committed.
