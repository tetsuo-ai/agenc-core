# Evaluation suites protocol v1

Status: implemented suite protocol, deterministic plan compilers, strict
attempt/reset/report evidence envelopes, and committed definitions. This is not
a fault executor, published baseline, or populated pilot.

The evaluation contract in [`evaluation-contract-v1.md`](evaluation-contract-v1.md)
pins tasks, systems, preregistration, evidence, and score derivation. It is
immutable at `1.0.0`, but it did not distinguish coding quality from
implementation-specific trust conformance or preregister a recovery condition.
The additive suite protocol closes that boundary without changing evaluation
contract v1.

## Authoritative artifacts

| Artifact | Purpose |
| --- | --- |
| `runtime/src/eval-suites/suite-protocol-v1.schema.json` | Strict input schema; unknown fields and cross-kind shapes fail |
| `runtime/src/eval-suites/suite-evidence-v1.schema.json` | Separate strict reset, competitive-report, and trust-report envelopes |
| `runtime/src/eval-suites/validation.ts` | Semantic, release-digest, catalog, schedule, and preregistration-binding validation |
| `runtime/src/eval-suites/evidence.ts` | Exact task/plan/reset/report joins and pass/failure semantics |
| `runtime/eval/suites/catalog.json` | Digest-pinned active-definition catalog |
| `runtime/eval/suites/competitive-coding/1.0.0/definition.json` | Product-neutral competitive coding definition |
| `runtime/eval/suites/trust-conformance/1.0.0/definition.json` | Deterministic AgenC trust-conformance definition |

Validate the committed catalog without running a task or loading a provider:

```bash
npm --workspace=@tetsuo-ai/runtime run check:eval-suites -- --json
```

That command and the committed catalog are source-repository tooling, not a new
installed `agenc` CLI verb. The validator/plan/report APIs are included in the
built runtime root export; an executor is deliberately deferred.

The public runtime export exposes the same validators, catalog loader,
preregistration binder, deterministic plan compilers, and report binders. The legacy
`runtime/eval/tasks` runner remains a small public diagnostic; it is not silently
promoted into either suite.

## Competitive coding suite

`agenc-competitive-coding@1.0.0` accepts only real-repository change tasks using
the existing operator/agent task projection. The exact canonical agent-task
bytes, repository state, tools, budgets, model configuration, hidden verifier,
and declared artifacts are identical across systems. Product-reported success
is diagnostic; the external workspace patch and hidden verifier decide coding
quality. Unsupported in-scope behavior remains a failure.

Each task/seed has three separately preregistered experiment conditions:

1. `clean`
2. `coordinator_process_kill`
3. `client_disconnect`

They are separate evaluation-contract v1 bundles because v1's matrix cell is
`system × task × seed`; forcing multiple conditions into one bundle would create
colliding cells. `validateCompetitiveConditionRegistrations` requires all three
conditions, the same byte-identical suite manifest, identical inputs/systems/
budgets/scoring/trial design, distinct experiment IDs, and the exact condition
harness digest.

### Product-neutral recovery schedule

The evaluator owns the fault schedule. An adapter may expose only the standard
black-box operations `start`, task delivery plus harness receipt, transport
disconnect/reconnect, coordinator-process-group kill, and result collection. Triggers may
not inspect AgenC events, daemon methods, run state, tool names, budgets, or a
competitor's private protocol.

Acceptance is the harness-owned receipt produced only after the exact canonical
agent-task bytes have been delivered successfully over the harness transport;
it is not a product-internal "run started" event. The receipt also identifies
the harness-launched process group and client transport by evidence digest.
After that receipt records its monotonic timestamp, the compiler chooses a delay
inside the definition's bounded recovery window. It uses SHA-256 rejection
sampling over the exact definition digest, suite-manifest digest, task digest,
task version, preregistered wall-time budget, condition, and seed slot. Callers
cannot supply a different wall-time range. System identity is deliberately
absent. The same inputs therefore produce the same unbiased delay and plan
digest for every product. A task whose budget cannot fit the minimum delay plus
the maximum observation jitter plus the recovery window is rejected during
preregistration; the latest permitted observation therefore leaves the entire
recovery window intact. A fault that never fires is
an explicit `fault_not_injected` failure; it cannot silently become a clean run.
Reports store the scheduled delay separately from the observed monotonic
injection time and accept only the definition's bounded one-second harness
jitter; they never relabel the target time as the observation.

The kill condition sends `SIGKILL` to only the harness-launched coordinator
process group, then uses the adapter's restart-and-attach operation. The
disconnect condition abruptly closes only the harness-owned client transport,
then reconnects it. Cancellation and product-process restart are different
semantic operations and are forbidden in the common competitive schedule.
Competitive recovery is Linux-only until another platform can implement the
same process/transport semantics; an unsupported platform is explicit, not an
approximate substitute.

### Competitive report

The result namespace is `agenc.eval.competitive-coding-report@1.0.0`. Its strict
envelope binds the exact task/agent projection, suite manifest,
repository/reset recipe, reset receipt,
harness delivery receipt, process-group/transport evidence, deterministic fault
plan, run record, external verifier evidence, and final outcome. It reports
clean Verified Fix Rate, verified fixes and recovery by fault condition, attempts,
and unsupported outcomes. It does not report deterministic trust-conformance
metrics, and the definition validator forbids a reporting profile that mixes
the two suite namespaces into one quality aggregate. Aggregate metric derivation
and publication remain part of the later reporting checkbox.

## Trust-conformance suite

`agenc-trust-conformance@1.0.0` is AgenC-only and deterministic. It pins the
offline harness, fake-provider, fake-tool, scenario fixture, initial-state, and
expected-state digests. Their canonical preimages are retained in the strict
versioned `fixtures.json` bundle; catalog loading verifies its path, byte size,
document digest, schema, and every definition-to-fixture/state join. Its compiler
uses a domain-separated SHA-256 seed per
definition/scenario/seed slot, ASCII-lexicographic scenario order, and a virtual
monotonic clock. Network and live provider calls are forbidden. A retry is a new
recorded attempt; failed evidence is retained.

Exactly seven fault families are required:

| Fault family | Injection boundary | Required result |
| --- | --- | --- |
| Restart | after reservation, before model-result commit | reservation recovered once; no duplicate transition; terminal result queryable |
| Reconnect | after event publish, before cursor acknowledgement | replay complete; duplicates harmless; terminal result queryable |
| Budget | concurrent child reservations before commit | parent cap conserved; unknown usage held; reconciliation exactly once |
| Cancellation | parent cancellation after child admission | no new descendant admission; queued/running descendants cancelled; partial evidence retained |
| Permission | repository requests capability escalation | no capability grant or mutation; denial audited |
| Event loss | replay retention evicted before reconnect | explicit retention gap; zero hidden loss; terminal result queryable |
| Uncertain effect | effect dispatched before acknowledgement commit | `unknown_outcome`; dependent mutations stopped; zero automatic replay |

Each scenario pins its boundary, action, timeout, expected invariants, and
required evidence event taxonomy. Missing a family or swapping an action/boundary
fails validation. Known product defects remain observable conformance failures;
the definition never weakens an oracle to make the baseline green.

The result namespace is `agenc.eval.trust-conformance-report@1.0.0`. Its strict
envelope binds the plan, reset, harness and run receipts, fault observation,
exact invariant results, required evidence taxonomy, and observed final-state
digest. A passing report requires the fault to fire, every invariant to pass,
the exact expected state, every required evidence type, and completion within
the pinned timeout. Failed attempts retain the evidence they actually observed;
they never fabricate later events merely to make a valid report. It reports
Trust Recovery Rate, results per fault family, unknown outcomes, and the
zero-tolerance counts for policy escapes, duplicated uncertain mutations, and
hidden event loss. Coding-quality metrics are forbidden in this report.

## Reset, containment, and evidence

Both suites require a content-addressed reset receipt proving a fresh clone and
empty product state, session, cache, and process tree. `HOME`, tool home, temp,
sockets, ports, and the environment are isolated or sanitized. Logs/samples are
not reused across independent trials. Recovery within an intentionally faulted
run stays in that run; retrying evaluator infrastructure creates a new attempt.
Each receipt is also bound to the exact system configuration and seed plus
either the competitive manifest/task/reset recipe/condition or the trust
scenario, so it cannot be replayed across evaluation cells.

The agent projection never receives verifier commands, bundles, reference
solutions, provenance, or holdout identity. Hidden artifacts remain under the
existing separate-principal/remote-custodian policy, keyed commitment, access
log, complete-matrix seal, and authorized unblinding flow. Publicly derived tasks
are contamination-resistant, never described as contamination-free.

No new signing or evidence service is introduced. Suite documents reuse RFC 8785
canonical JSON and domain-separated SHA-256 digests. The digest covers canonical
document meaning rather than whitespace; the loader rejects invalid UTF-8,
duplicate keys, symlinks, path escape, file replacement, and oversized input so
ambiguous byte streams cannot alias one meaning. Future suite executors must
bind each report's run-record digest to the existing append-only evidence ledger
and external seal.

## Versioning, migration, and rollback

Every join is exact `kind + suiteId + suiteVersion + documentDigest`. Mutable
`latest` image tags and implicit catalog selection are forbidden.

- Patch: non-scoring metadata only, with a new immutable document and digest.
- Minor: a compatible catalog update or competitive task-manifest addition that
  does not change existing case semantics.
- Major: scoring, required behavior, schedule/case meaning, or removals.
- Any task, scenario, schedule, or scoring change creates a new suite version.
- Adding a trust fault family also requires a new suite-protocol/schema version;
  protocol v1 intentionally contains exactly these seven families.
- Published bytes are never edited in place and scores from different versions
  are not pooled without a separately reviewed bridge study.

The released v1 catalog and definition digests are literal runtime constants;
the default CLI rejects in-place bytes changed under the same version. Rollback
selects a prior catalog/definition by its immutable digest. It does not
rewrite current results or relabel them as belonging to the prior version.
Evaluation-contract `1.0.0` and legacy diagnostic reports remain readable and
unchanged.

## Comparator compatibility snapshot

Research refreshed 2026-07-15 against the official
[Hermes Agent `v2026.7.7.2`](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.7.2) <!-- branding-scan: allow comparator research citation -->
and [OpenClaw `v2026.7.1`](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1). <!-- branding-scan: allow comparator research citation -->
The former's asynchronous Runs API is the appropriate neutral disconnect surface;
killing its one-shot CLI would kill the in-process task. The latter's CLI signal
handler aborts a run, so `SIGTERM`/`SIGINT` is cancellation, not client
disconnection; its gateway fallback must also be disabled/pinned to prevent an
embedded fresh run. These differences are adapter limitations to preregister,
not reasons to change task inputs or schedule semantics. External workspace
diffs and hidden verification remain the source of truth for both.

The behavior snapshot is tied to the tagged
[Hermes one-shot source](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/hermes_cli/oneshot.py) <!-- branding-scan: allow comparator research citation -->
and [Runs API documentation](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/website/docs/user-guide/features/api-server.md), <!-- branding-scan: allow comparator research citation -->
plus the tagged [OpenClaw gateway/signal source](https://github.com/openclaw/openclaw/blob/v2026.7.1/src/commands/agent-via-gateway.ts). <!-- branding-scan: allow comparator research citation -->

Comparator adapters and paid runs are intentionally deferred to their own M1
checkbox. When added, they must pin release, commit, package/OCI digest, install
command, state roots, public/redacted configuration, provider/model, transport,
fallback policy, and unsupported capabilities.

## Primary-source design record

Research refreshed 2026-07-15:

- [SWE-bench paper (ICLR 2024)](https://proceedings.iclr.cc/paper_files/paper/2024/hash/edac78c3e300629acfe6cbe9ca88fb84-Abstract-Conference.html)
  and the [official harness](https://github.com/SWE-bench/SWE-bench) establish
  real repository issues, containerized reset, and execution-based verification.
- [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/)
  separates fail-to-pass from regression tests; OpenAI's
  [2026 audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)
  shows why even hidden human-reviewed tests require prompt/oracle and
  alternative-patch QA.
- [SWE-rebench (NeurIPS 2025)](https://proceedings.neurips.cc/paper_files/paper/2025/hash/21bec6ace947b1b58967b945c8ac0f10-Abstract-Datasets_and_Benchmarks_Track.html)
  supports refreshed real tasks while documenting the QA/contamination tradeoff.
- [AgentDojo (NeurIPS 2024)](https://proceedings.neurips.cc/paper_files/paper/2024/hash/97091a5177d8dc64b1da8bf3e1f6fb54-Abstract-Datasets_and_Benchmarks_Track.html)
  reports clean utility separately from adversarial/security behavior. That
  separation is the closest precedent for the two result namespaces here.
- [Inspect tasks](https://inspect.aisi.org.uk/tasks.html),
  [eval sets](https://inspect.aisi.org.uk/eval-sets.html), and
  [logs](https://inspect.aisi.org.uk/eval-logs.html) informed task versions,
  epochs, bounded retries, cancellation evidence, and log-reuse rejection.
- The [FoundationDB paper](https://www.foundationdb.org/files/fdb-paper.pdf),
  [Jepsen nemesis API](https://jepsen-io.github.io/jepsen/jepsen.nemesis.combined.html),
  and [Toxiproxy](https://github.com/Shopify/toxiproxy) support deterministic
  seeded faults controlled outside the system under test.
- [CrashMonkey](https://github.com/utsaslab/crashmonkey) is a filesystem
  crash-testing precedent for bounded black-box crash exploration and replay;
  it is not a general agent fault harness.
- [MLCommons inference rules](https://github.com/mlcommons/inference_policies/blob/master/inference_rules.adoc)
  require consistent systems, fixed seeded randomness, replicability, and
  auditable reference implementations.
- [Semantic Versioning 2.0.0](https://semver.org/),
  [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), and the
  [OCI descriptor specification](https://github.com/opencontainers/image-spec/blob/main/descriptor.md)
  informed immutable version/digest joins and digest-only container pins.

Alternatives rejected:

- Adding a mode flag to evaluation-contract v1: it changes immutable semantics
  and still permits mixed reports.
- Triggering on AgenC protocol events: precise but unfair to comparators.
- A fixed unseeded wall-clock kill: simple but phase-biased and easy to game.
- Treating a product signal handler as disconnect: it may actually cancel work.
- Reusing the legacy shell-command runner: it lacks durable acceptance,
  reconnect, full reset receipts, descendant cleanup, and confirmatory evidence.
- Importing a general chaos platform or new signing service: unnecessary scope;
  the suite needs two bounded faults and already has evidence infrastructure.

## Deliberate remaining work

This slice does not fabricate real tasks or results and does not claim that a
fault executor exists. The following remain their own TODO checkboxes: populate
the 30-task pilot and powered holdout, build the real-agent and deterministic
trust executors, implement comparator adapters, derive/publish aggregate reports,
and turn measured failures into improvements. M3/M4 implementation will make the
current trust scenarios pass; until then, failures are data rather than contract
defects.
