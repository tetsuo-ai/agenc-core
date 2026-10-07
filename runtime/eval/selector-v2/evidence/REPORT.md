# AgenC selector v2 report

PR: [tetsuo-ai/agenc-core#2808](https://github.com/tetsuo-ai/agenc-core/pull/2808), base `xprov/automatic-selection`.

Built on `xprov/automatic-selection` at `02d8c3d7b197187b9d0d4aa250fc2777f1c5b6b7`, in the independent `xprov/selector-v2` checkout. Runtime implementation and compatibility commits: `94f6b0b9abed`, `4e962317b520`, `6225ea0e919e`. No release, deployment or merge.

## Verdict

The frozen verified-policy replay meets the requested numerical target against both OpenRouter Auto arms: **12/14 held-out passes for $0.011888654**, versus **11/14 for $0.022757472 restricted** and **11/14 for $0.016185956 unrestricted**. That is one additional pass, with 47.8% and 26.5% lower recorded total cost respectively.

This is a small-sample point result, not proof of general superiority. The 95% Wilson intervals overlap widely (v2 60.1% to 96.0%, either Auto arm 52.4% to 92.4%). Each paired comparison has one win and zero losses, exact two-sided p = 1.0. The cheapest fixed model also passes 12/14 for $0.004265886, 64.1% less than v2. It dominates v2 on the observed held-out quality/cost frontier. V2 is slower than both Auto arms at p50 and p95.

The stronger conclusion, that deployed AgenC beats OpenRouter Auto end to end, **is not established**. The default runtime has parent-first routing; verified routing requires a trusted host verifier. Four real Linux daemon runs retained the parent and produced correct child results, but all four parent final answers failed the frozen output grader. The direct replay excludes parent orchestration and daemon overhead. No new held-out tuning was done to hide these outcomes.

## Method and contamination boundaries

The existing router-bench suite and deterministic graders are unchanged: 42 tasks, 28 calibration and 14 held out. The first recorded matched task/model response is reused from the completed real response matrix. The matrix contains 378 native responses, 84 OpenRouter responses and 42 OpenAI diagnostic responses. All seven required comparison arms have full 42-task coverage. OpenAI's unknown subscription dollars do not enter the price comparison; Qwen remains disconnected after its recorded 401. No new direct inference calls were made.

The parent is `deepseek/deepseek-flash`. The frozen strongest arm is `kimi/kimi-k3`, a predeclared premium candidate, not a claim that it empirically wins this suite. Cheapest is `meta/muse-spark-1.3-contributor`. The current-selector arm runs the unchanged v1 selection math from the latest pushed base and chooses `meta/muse-spark-1.2-contributor` here. The restricted OpenRouter arm uses the frozen candidate allowlist; unrestricted uses the recorded unconstrained Auto route.

Calibration input contains only the 28 calibration prompts, grades, usage, latency and infrastructure outcomes, with reference answers removed. Leave-one-task-out fits exclude the scored task from ability, latency, availability and conditional-recovery estimates. Configuration selection uses calibration data only. Held-out predictions use the final calibration fit without updates. The task's own frozen grader is available to the verified arm as a trusted local check after each attempted answer; routing never sees reference answers. Direct tool tasks are inline fixtures and do not prove real tool execution. The separate daemon runs do exercise real workspace tools.

The requested source reports already exposed aggregate results. In addition, six held-out tasks reuse the original benchmark task family and eight are fresh extension tasks. This is not a newly created blind benchmark. The policy was frozen at **2026-09-29 10:04:11 UTC**, before this job scored task-level held-out rows. The original manifest is preserved. The portable manifest explicitly discloses one later source edit: inserting "and" in an unavailable-model message to restore an existing test contract. Reversing that exact edit reproduces the frozen source hash. A subsequent notification fix exposes all independent verdicts to parents and does not change direct routing. A replay after these edits matches all 378 model choices, request IDs, verdicts and costs.

Native provider costs are usage multiplied by the benchmark's frozen rates, not reconciled invoices. OpenRouter costs use its recorded reconciled billing. Local deterministic verification has zero API dollars; measured Python verifier process time is added to held-out v2 latency. Calibration latency reuses recorded attempt latency, so it excludes that local verifier process time. No paid verifier cost is concealed. Latencies come from the original recordings at different times; they are not controlled simultaneous latency trials. There is one response per task/model, no repeated-sample error estimate, and no correction that would make the small benchmark population representative of all workloads.

## Math and implementation

For a task x and eligible model m:

`U(m,x) = P(success | m,x) - lambda * estimated dollars - mu * estimated seconds`.

Eligibility runs before optimization: connected and allowed provider/model pairs, provider health, tools/vision/reasoning support, model context and output limits, canonical pricing when dollars are capped, and the task's spend cap. A connected active parent can remain eligible without an invented model profile. The existing atomic admission and budget kernel remains authoritative at each actual dispatch.

The user can select quality, balanced or economy cost preference and balanced or fast speed, inherit the parent, or name a provider/model. `lambda = willingness / max(0.001, task budget or 0.05)`, where willingness is 0, 0.025 or 0.25. `mu` is 0.0002 normally and 0.01 for fast. These are documented conversion factors, not learned universal preferences.

Parent-first selection requires the expected utility gain to exceed extra context and latency plus uncertainty: 512 estimated context tokens, 750 ms handoff latency, 0.01 margin and 0.1 times the sum of predictive interval widths. These handoff constants are conservative policy assumptions, not measurements of every model pair. Cold uncertainty therefore preserves an eligible parent. Unknown subscription prices cannot manufacture a dollar saving.

Per-skill IRT covers coding, reasoning, tool use, long context and extraction:

`p = sigmoid(a * (theta[m,skill] - difficulty[x]))`.

Local prompt features use text length, conditional structure, code/math words and actual tool-work words. No task ID, expected answer or author difficulty label is used. No small local embedding model was installed; none was downloaded and no task text was sent for remote embeddings.

The ability posterior is an online Gaussian/Laplace approximation. For an independent Bernoulli verdict y:

`v_new = 1 / (1/v + a^2 * p * (1-p))`

`theta_new = theta + v_new * a * (y-p)`.

Prediction uses a logistic-normal mean approximation and transformed 95% interval. Variance has a numerical floor and observations are bounded. Public abilities are weak half-logit priors with variance 1.5, not vendor benchmark scores treated as calibrated task success. Unknown model versions and skills use neutral priors. Infrastructure failures update availability separately: `(4 + attempts - infrastructure failures) / (4 + attempts)`. Model self-report and clean execution are not correctness labels. Delayed independent receipts update ability once without counting execution or dollars twice.

A trusted host can provide independent tests through `SessionServices.childRoutingVerifier`. A two-step cascade chooses an adequate inexpensive first model and uses the parent as escalation anchor. It minimizes expected dollars:

`C = c1 + (1-p1)*c2`, with `Q = p1 + (1-p1)*P(parent succeeds | first failed)`.

Conditional recovery is estimated only from paired local/calibration outcomes with Beta(0.5, 0.5) smoothing. Missing pairs supply no invented recovery gain. First-model predicted success must be at least 0.65; the frozen selected predicted quality threshold is 0.75. The threshold is a routing estimate, not a promised 75% or 95% real-world success rate. Both potential attempts, context overhead and verifier charges must fit the hard cap. Failure triggers fresh authorization and admission. Verifier unavailability/errors and unknown usage stop the chain; tool replay requires a trusted safety attestation. A host that uses a paid verifier must admit and charge it through the budget system.

Safe contextual Thompson sampling is implemented but off by default and disabled in the benchmark. It requires at least three verified observations and bounds quality, price and latency loss conservatively within an opt-in envelope (default 0.01, maximum 0.05). It cannot add a disallowed, disconnected, incompatible or over-cap candidate. No measured exploration benefit is claimed. Each route emits a short explanation, and explicit overrides still enforce capabilities and caps.

The verifier is a host service, never a model-supplied shell command or tool argument. Ordinary CLI sessions do not automatically gain access to the benchmark oracle or its fitted abilities. There is no automatic import of benchmark training data into the user's history. Consumers must wait for the final routing notice before accepting a cascaded answer. Individual attempt receipts remain durable; one aggregate durable cascade receipt and restart/resume of a partially completed cascade are not implemented.

## What the calibration supported

| Step | Calibration passes | Total USD | Decision |
|---|---:|---:|---|
| Parent-first cold | 26/28 | $0.036869268 | Retain as safe default; removes unnecessary cold delegation |
| Local IRT without verifier | 26/28 | $0.036869268 | No route or score improvement on this suite; retain independent learning machinery without a performance claim |
| Initial general cascade, best eligible threshold 0.95/economy | 26/28 | $0.044696732 | Reject this policy; more expensive than parent |
| Parent-anchored cascade plus availability, threshold 0.85/economy | 26/28 | $0.033738116 | Small cost gain supported |
| Expanded calibration grid, threshold 0.75/balanced | 26/28 | $0.018590350 | Freeze this verified policy before held-out scoring |
| Safe exploration | Not enabled | $0 additional | Unit-tested only; no evidence supporting production exploration here |

The final grid was 0.65, 0.70, 0.75, 0.80, 0.85, 0.90 and 0.95 crossed with quality/balanced/economy, plus the two no-verifier diagnostics. Selection requires the restricted Auto calibration score (26/28), minimizes recorded cost and resolves ties deterministically. Configuration selection is not nested cross-validation; the reported calibration quality is development evidence. It optimizes within this policy family, not over every baseline. The old selector is cheaper at the same calibration quality. Full trial summaries and compressed calibration outputs are preserved, including the unsuccessful first step.

The final held-out policy keeps the parent for four tasks and plans a verified cascade for ten. Nine first attempts pass. The only actual escalation, `hold-code-topological-order`, fails on both models. Thus **zero held-out failures are rescued by the cascade**. The observed quality/cost result comes from the first-choice mixture, not proven error-recovery value.

## Calibration and held-out tables

Dollar totals include all attempts, including failed cascade attempts. All arms use the same frozen task sets. Intervals are 95% Wilson score intervals.

### Calibration

| Arm | Pass / tasks | Wilson 95% | Total USD | USD / task | p50 / p95 seconds | Covered |
|---|---:|---|---:|---:|---:|---:|
| Selector v2 (verified) | 26/28 | 77.4% to 98.0% | $0.018590 | $0.000664 | 5.192 / 19.790 | 28/28 |
| Current selector | 26/28 | 77.4% to 98.0% | $0.006957 | $0.000248 | 6.424 / 22.151 | 28/28 |
| Fixed parent | 26/28 | 77.4% to 98.0% | $0.036869 | $0.001317 | 3.028 / 7.562 | 28/28 |
| Always strongest | 25/28 | 72.8% to 96.3% | $0.379328 | $0.013547 | 13.568 / 45.776 | 28/28 |
| Always cheapest | 25/28 | 72.8% to 96.3% | $0.007001 | $0.000250 | 6.009 / 22.974 | 28/28 |
| OpenRouter Auto restricted | 26/28 | 77.4% to 98.0% | $0.038639 | $0.001380 | 3.137 / 11.723 | 28/28 |
| OpenRouter Auto unrestricted | 25/28 | 72.8% to 96.3% | $0.019927 | $0.000712 | 5.067 / 15.501 | 28/28 |
| V2 parent-first cold | 26/28 | 77.4% to 98.0% | $0.036869 | $0.001317 | 3.028 / 7.562 | 28/28 |
| V2 IRT without verifier | 26/28 | 77.4% to 98.0% | $0.036869 | $0.001317 | 3.028 / 7.562 | 28/28 |

### Held out

| Arm | Pass / tasks | Wilson 95% | Total USD | USD / task | p50 / p95 seconds | Covered |
|---|---:|---|---:|---:|---:|---:|
| Selector v2 (verified) | 12/14 | 60.1% to 96.0% | $0.011889 | $0.000849 | 7.051 / 42.503 | 14/14 |
| Current selector | 11/14 | 52.4% to 92.4% | $0.003552 | $0.000254 | 8.879 / 34.034 | 14/14 |
| Fixed parent | 11/14 | 52.4% to 92.4% | $0.022005 | $0.001572 | 3.342 / 22.103 | 14/14 |
| Always strongest | 11/14 | 52.4% to 92.4% | $0.293116 | $0.020937 | 19.580 / 138.731 | 14/14 |
| Always cheapest | 12/14 | 60.1% to 96.0% | $0.004266 | $0.000305 | 7.589 / 54.361 | 14/14 |
| OpenRouter Auto restricted | 11/14 | 52.4% to 92.4% | $0.022757 | $0.001626 | 4.473 / 13.008 | 14/14 |
| OpenRouter Auto unrestricted | 11/14 | 52.4% to 92.4% | $0.016186 | $0.001156 | 6.487 / 25.632 | 14/14 |
| V2 parent-first cold | 11/14 | 52.4% to 92.4% | $0.022005 | $0.001572 | 3.342 / 22.103 | 14/14 |
| V2 IRT without verifier | 11/14 | 52.4% to 92.4% | $0.022005 | $0.001572 | 3.342 / 22.103 | 14/14 |

## Quality/cost frontier

The archived chart `pareto.png` (SHA-256 `a7d7a91ebe749b36486dc38f6ddbe74161c1787ba20bd4dfd3d6b7db2c762fef`) uses a logarithmic cost axis and Wilson bars. At calibration, the current selector is the cheapest arm at the highest observed quality. On held-out tasks, current selector and always-cheapest form the observed frontier; v2 is dominated by always-cheapest. Uncertainty bars do not turn these point frontiers into population guarantees.

## Fresh versus reused held-out tasks

| Subset | V2 | Auto restricted | Auto unrestricted | Always cheapest |
|---|---|---|---|---|
| 8 fresh extension tasks | 7/8, $0.005688650 | 7/8, $0.011524272 | 7/8, $0.008657336 | 7/8, $0.002419482 |
| 6 reused source tasks | 5/6, $0.006200004 | 4/6, $0.011233200 | 4/6, $0.007528620 | 5/6, $0.001846404 |

The one extra pass versus Auto occurs on reused `hold-hard-coding`. Fresh held-out quality is equal, with lower v2 recorded cost, but the cheapest baseline is again less expensive. The paired sign/McNemar exact test is descriptive only with these counts.

## Real Linux Core daemon evidence

Each serial run uses an isolated home and the actual Core daemon. A DeepSeek Flash parent calls `spawn_agent` with automatic routing; durable receipts and file-tool events are collected. The native provider guard caps concurrency at two calls per provider. There were no new direct API benchmark calls. All four v2 routes retained `deepseek-flash`. These exercise the cold default, not a host-installed benchmark verifier or trained policy.

| Task | V2 child | V2 parent final | V2 parent + child USD | V2 seconds | Recorded current-selector child / parent | Current USD | Current seconds |
|---|---|---|---:|---:|---|---:|---:|
| cal-simple-extraction | pass | fail | $0.007478748 | 45.118 | pass / fail | $0.004052120 | 21.231 |
| cal-tool-config-trace | pass | fail | $0.004471920 | 27.551 | pass / fail | $0.006063670 | 31.947 |
| hold-simple-coding | pass | fail | $0.004225116 | 24.060 | pass / fail | $0.004174420 | 21.799 |
| hold-tool-artifact-manifest | pass | fail | $0.003642024 | 29.003 | fail / fail | $0.005871026 | 33.201 |

V2 child quality is 4/4 versus 3/4 in these matched recorded baseline runs, but end-to-end success is 0/4 in both. All v2 parent outputs fail `invalid-json` after the existing completion gate. The final simple-coding run additionally triggers the harness's parent FileRead prohibition after the child completed; the guard blocks that read and the paid response is still counted. Required child file use and daemon receipts are present. Latency and total cost vary in both directions; these four runs do not establish a statistically reliable daemon advantage. Parent orchestration dominates the cheap child-call cost, so the direct cost saving must not be advertised as a total application saving.

## Tests

- Mac source Core typecheck and test-support typecheck pass with the installed Node 26.8.1 toolchain and `--preserveSymlinks` for the shared dependency link.
- Mac focused selector, admission, outcomes, fallback and spawn integration: 8 files, 145 tests pass. Independent-verdict notification checks: 16 pass. Final rejection compatibility, selector math and spawn isolation checks: 113 pass.
- The provided Linux Core runner completed the full branch suite at `94f6b0b9abed`: 2,688 files passed, 16 failed, 1 skipped; 31,503 tests passed, 29 failed, 11 skipped. Its reused main baseline at `1370385d69e3`: 2,673 files passed, 14 failed, 1 skipped; 31,236 tests passed, 27 failed, 11 skipped. All 27 baseline failures match by test and cause, including hermetic ownership/permission assumptions, discovery and existing fixture failures. Both also report the same two blocked/unconsumed network attempts from the concurrent-chat fixture.
- Of the two extra full-suite failures, one exact rejection-message mismatch was fixed in `6225ea0e919e`. The MCP entrypoint's 15-second timeout also reproduces on the supplied finished main timeout baseline. No timeout budget was weakened.
- Final Linux regression scope `tests/agents tests/bin/mcp-cli.test.ts` at `6225ea0e919e`: **79 files passed, 1,426 tests passed, 1 skipped, exit 0**. This includes the compatibility fix and the MCP test. Separate Linux notification checks at `4e962317b520`: 16 passed. There are **no unresolved new failures versus main**; the entire Core suite is not claimed green, and the full suite was not repeated after the small compatibility/notification edits.
- Linux runtime bundle and declaration generation passed after using `--preserveSymlinks` for declaration generation in the isolated shared-dependency checkout. Four daemon runs used that built Core, not a mock transport.
- Portable frozen replay: 378 rows, zero missing cells, no new provider calls; exact model/request/verdict/cost equivalence after compatibility edits. Frozen task verification and `git diff --check` pass.

Tests cover sigmoid stability and monotonicity, source priors, independent posterior updates and uncertainty, invalid-state sanitation, parent gates, caps and capabilities, conditional recovery, full-chain reserve checks, verifier failure and unknown-usage stops, safe tool retry, opt-in bandit loss bounds, explanations/overrides, delayed receipt deduplication and real spawn/fallback integration. Full and focused logs are retained locally; the committed `tests.json` summarizes outcomes and baseline classifications.

## New spend and credential scan

Only new calls from this job are counted here. Reused router-bench inference was not charged again. Native dollars below are frozen-rate usage estimates; conservative guard accounting is separately shown.

| Provider | New calls | New estimated USD | Conservative guard charge | Authorization |
|---|---:|---:|---:|---|
| DeepSeek | 31 (24 parent, 7 child) | $0.019817808 | $0.147338400 | Below $3; the account stayed above its $10 floor |
| Kimi | 0 | $0 | $0 | Below $3 |
| MiniMax | 0 | $0 | $0 | Below $3 |
| Meta | 0 | $0 | $0 | Below $3 |
| OpenRouter | 0 | $0 | $0 | Below $3 |
| OpenAI OAuth proxy | 0 | $0 new | $0 | 0/40 calls |
| Grok signed-in PC home | 0 | $0 new | $0 | 0/40 calls; credentials untouched |
| Qwen | 0 | $0 | $0 | Skipped recorded 401 |

No unresolved new provider costs remain. Keys were parsed in process memory from the authorized sources, passed to the PC through SSH stdin into the guard process environment, and never placed in command arguments or files. Four inference runs were serial, with at most two calls per provider in a run. The other router-bench job reported completion at 10:07:17 UTC; this job's first new inference began at 10:10:08 UTC. No inference account load was added during its recorded active phase.

Final known-key scans cover all regular files in this job's Mac task root, isolated PC task directory, three runner worktrees and all five named runner result pairs. Symlinks into other jobs are not traversed. The scans compare authorized provider credentials in memory, including identifiable long-key prefixes, and inspect gzip and loose Git object payloads. They never print matches. Per-machine file and compressed-payload counts are recorded in the scan JSON summaries. **Zero hits, zero redactions, zero unreadable files, zero missing roots** on both machines. Scan summaries are committed. Grok credentials were never read or copied; the scanner does not obtain them. No protected owner application homes, SSH directory, wallets or Codex configuration were accessed.

## Sources and replay

- [DeepSeek official release notes](https://api-docs.deepseek.com/updates/), dated 2026-09-10 and 2026-08-13, retrieved 2026-09-29. The exact score anchors and dates are embedded in `provider-selector-irt.ts`.
- [Meta Muse Spark benchmarks](https://dev.meta.ai/models/muse-spark), undated page retrieved 2026-09-29. The contributor billing variant has no separate published ability measurement. These heterogeneous vendor results are deliberately weak priors.
- [FrugalGPT](https://arxiv.org/abs/2305.05176), 2023. Motivates verified cost-aware cascades; this is not a replication of its learned answer scorer.
- [RouteLLM](https://arxiv.org/abs/2406.18665), 2024. Context for task-dependent routing and held-out evaluation; no claimed reproduction.
- [OpenRouter Auto documentation](https://openrouter.ai/docs/guides/routing/routers/auto-router), retrieved 2026-09-29, for router restrictions and the comparison arm semantics.

The repository's `runtime/eval/selector-v2/README.md` gives replay instructions. The repository keeps the grader and task specification, original and portable source hashes, Wilson tables, paired counts and the plot script. The frozen tasks, stripped real request records, compressed calibration inputs/results, all 378 evaluation rows and the PNG are in the evaluation archive, named with their SHA-256 in the README. Headers, balances, credentials and provider reasoning traces are excluded from the public records. Replay calls no inference endpoints. It checks the pinned source and fitted-policy hashes before grading. The original task directories also held detailed runner logs and daemon evidence; isolated PC task homes held raw receipt artifacts.
