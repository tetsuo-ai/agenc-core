# Evaluation Contract v1

Status: implemented contract foundation, version `1.0.0`

Research and design review date: 2026-07-15

This contract is the machine boundary for real-agent evaluation. It pins what
will run before results are visible, keeps private oracle material away from the
agent, records exact run provenance, stores raw evidence separately from derived
summaries, and refuses to call an unassessed run a trusted fix.

It completes the contract-definition slice only. Public pilot candidates and
their qualification/power protocol now exist in
[`evaluation-pilot-v1.md`](evaluation-pilot-v1.md), but no qualified/scored
pilot, paid baseline, comparator run, or superiority result is claimed; those
remain separate M1 deliverables in [`todo.txt`](../todo.txt).

## Files and command

| Path | Purpose |
| --- | --- |
| `runtime/src/eval-contract/contract-v1.schema.json` | Closed JSON Schema for every v1 document |
| `runtime/src/eval-contract/types.ts` | TypeScript contract mirror |
| `runtime/src/eval-contract/validation.ts` | Schema and semantic validation, safe task projection, holdout preflight |
| `runtime/src/eval-contract/evidence-ledger.ts` | Locked payload store, append-only journal, freeze/seal/verify lifecycle |
| `runtime/src/eval-contract/experiment-bundle.ts` | Cross-document pin checks and deterministic summary derivation |

Validate one or more v1 documents locally:

```bash
npm --workspace=@tetsuo-ai/runtime run check:eval-contract -- \
  path/to/document.json
```

Machine-readable output uses `--json`. The old `schemaVersion: 1` agent-eval
report can be classified, but never upgraded into confirmatory evidence:

```bash
npm --workspace=@tetsuo-ai/runtime run check:eval-contract -- \
  --legacy --json runtime/eval/baseline-report.json
```

That command reports `legacy_non_confirmatory` and the missing pins. The legacy
runner remains useful as a deterministic offline smoke; its score is not TFR and
cannot support a competitive claim.

## Document lifecycle

```text
operator task + private verifier + repository-family map
             |
             +--> agent-safe task projection (no oracle fields)
             |
suite manifest / public holdout descriptor
             |
preregistration --externally anchored--> preregistration receipt
             |
complete planned system x task x seed run matrix
             |
each run: restricted payloads -> append-only events -> freeze -> external seal
             |
blinded complete-matrix seal -> externally verified holdout-access receipt
             |
authorized unblinding record
             |
derived summary (raw evidence references only; no embedded private evidence)
```

`validateEvaluationBundle` rejects missing or extra matrix cells, mismatched
task/system/evaluator/reset pins, unverified evidence objects, unpaired
infrastructure exclusions, and post-hoc lifecycle ordering.
`validateDerivedSummaryAgainstBundle` then re-derives the complete summary and
requires exact canonical equality with the supplied summary. A standalone
`validateEvalContractDocument` or CLI result proves only document structure and
local invariants; for a derived summary, CLI JSON explicitly reports
`claimVerified: false` and names the required bundle-bound validator.
Validation canonical-clones and deep-freezes all contract documents before the
first external-verifier `await`; cross-document checks and summary derivation use
only that call-time snapshot, so caller mutation cannot change the scored object
mid-validation.

## Task and holdout boundary

Every operator task pins:

- full repository commit and reviewed repository/fork-family identity;
- exact setup patch and issue bytes;
- tools and capabilities, deny-by-default permissions, network policy, hard
  USD/token/tool/turn/time limits, expected artifacts, image, platform, hardware,
  toolchain, and reset recipe;
- hidden verifier bundle/image/argv/timeout/output policy plus a keyed public
  commitment; and
- reference-solution and contamination-audit evidence.

`projectTaskForAgent` constructs a new, independently hashed document. It omits
the split, verifier command/bundle, reference solution, and provenance. A public
base repository is valid for a private holdout: privacy attaches to the new
issue/setup oracle, verifier, and gold patch, not to whether the upstream source
repository was public.

A private holdout descriptor reveals counts and commitments, not task identity,
prompts, repositories, or verifiers. Its custody contract requires a distinct OS
principal or remote custody service, a pinned access-control verifier, access
evidence, an append-only access-log commitment, and projection only for an
assigned run. A `0700` directory owned by the same user as an implementation
agent is explicitly not treated as implementer isolation.

`assertPrivateRootIsolation` is an operational preflight, not a proof by itself.
It validates local path ancestry, disjoint roots, owner/mode, binds the
attestation to the descriptor plus canonical path and stable filesystem
identity, invokes a verifier whose digest is pinned in the descriptor, and
rechecks the root after verification to reject path swaps.

Unblinding a private holdout additionally requires a content-addressed access
receipt whose exact statement bytes pass an externally supplied verifier. The
receipt binds the descriptor, suite, preregistration, blinded complete matrix,
projected run IDs, custody and projection policies, implementer principal set,
custodian, authorization evidence, authorized role and principal, and access-log
head. Its unseal policy must equal the preregistered unblinding policy. The
unblinding record repeats that policy, role, and authorization evidence and binds
`unblindedBy` to the signed authorized principal. The receipt verifier is the
trust boundary for the custodian's access-control and access-log claims; the
bundle validator does not pretend to recreate a remote custody service locally.

## Preregistration and scoring

The preregistration pins the evaluator commit/image/toolchain/config, analysis
and trust-assessment implementations, exact systems and comparison pairs, model
and provider identities, all generation parameters, retries, approvals,
environment/network policy, task selection, repository-family map, trial seeds,
the exact `sha256_fisher_yates_v1` order algorithm and seed, the resulting
complete execution-order digest, exclusions, evidence limits/redaction/anchor
policy, and the unblinding policy. Each run records its unique execution index;
the validator derives the same schedule and rejects index or start-time order
drift, so randomized interleaving is an enforced fact rather than a label.

`sha256_fisher_yates_v1` is portable and fully specified. Sort system IDs and
task IDs by Unicode code-unit order and seed slots numerically, then construct
the Cartesian cells in system/task/seed nesting order. For Fisher-Yates index
`i`, hash RFC 8785 canonical `{orderSeed,counter}` under the domain
`agenc.eval.execution-order-random-word.v1`, interpret the first eight hex digits
as an unsigned 32-bit integer, and rejection-sample values at or above
`floor(2^32 / (i + 1)) * (i + 1)` before taking modulo `i + 1`. Increment the
counter for every attempted word. A hard-coded order and digest vector in
`evaluation-experiment-bundle.test.ts` prevents coordinated implementation
drift. Bundle validation refuses an execution matrix above 1,000,000 cells
before allocation.

The externally verified receipt must exist before the first run. After all
planned runs, a blinded-results document commits the complete run/document/seal
matrix before an authorized unblinding record can be created. A summary cannot
predate unblinding.

Contract v1 permits only a fixed sample size: the selected task count must equal
the preregistered `stoppingRule.taskCount` and remain inside the pinned bounds.
Adding tasks, systems, repetitions, or comparisons after seeing any result
requires a new experiment and new externally anchored preregistration; it cannot
extend the old claim. Sequential stopping would change the inferential contract
and therefore needs a future version, not an optional v1 flag.

The v1 statistical rule is deliberately exact rather than a method label:

1. Pair on task ID and planned seed slot.
2. Average fresh repetitions inside each task first; trials are never resampled
   as independent observations.
3. Give tasks equal weight and recheck the scored set's pinned repository-family
   identity; a family may contribute at most 10% of tasks.
4. Resample whole repository clusters with replacement, using the pinned random
   stream and Type-7 2.5%/97.5% quantiles.
5. For every preregistered comparator, require both a point estimate of at least
   `+0.10` TFR and a lower bound above zero. The multi-comparator decision is an
   intersection-union rule: every comparison must pass.

The bootstrap stream derives its initial unsigned 32-bit state from the first
SHA-256 word over the pinned seed and comparison ID, substitutes the documented
nonzero constant only for a zero word, and then uses xorshift32 v1. The contract
literal is
`sha256_seed_and_comparison_id_first_u32_then_xorshift32_v1`. A portable vector
whose Type-7 endpoints require interpolation pins both the stream and quantile
rule.

Infrastructure invalidation is pair-scoped. Both members must have
`infrastructure_invalid` outcomes and carry the exact same incident plus a
canonical typed classifier event produced by the preregistered classifier
version and implementation artifact. Product-owned daemon, agent, or coordinator
failures remain product failures; only evaluator-owned coordinator failure is an
infrastructure reason. Global per-system rates always summarize all planned runs;
pair exclusions affect only that comparator's paired effect and are reported as
a separate count, so adding a comparator cannot rewrite a system's global rate.

## Verified fixes versus trusted fixes

`verifiedFix` is derived from the hidden verifier result. `trustedFix` exists
only inside a versioned trust assessment and is the conjunction of six typed,
evidence-backed predicates:

1. hidden verifier inaccessible during the run and all deterministic assertions
   passed;
2. zero permission, sandbox, concurrency, or budget escapes, with unresolved
   usage fully reserved;
3. zero duplicated uncertain mutations, unsafe automatic retries, or unresolved
   unknown outcomes;
4. all scheduled restart/disconnect faults recovered, with no event gaps or
   hidden loss;
5. schema/hash-valid patch, changed-file, test, independent-review, cost,
   approval, effect, and risk evidence with no unresolved review blocker; and
6. zero undeclared interventions or approvals.

The validator derives each predicate from its counters and derives `trustedFix`
from all six statuses. Direct adverse events are reconciled fail-closed:
`effect.unknown_outcome` and `event.gap` events cannot coexist with zero counters
or passing criteria. An assessed result must also have exactly one
`trust.assessed` payload containing the canonical assessment statement; its
producer digest must equal the preregistered trust implementation. Every
criterion must cite non-assessment payload bytes from the externally verified
ledger and include its required event taxonomy. Recorded artifacts and verifier
results likewise have to match verified payload bytes exactly. These checks
make the assessment a pinned, auditable attestation instead of an arbitrary
boolean, while the preregistered implementation remains the explicit semantic
trust boundary for the attested counters. If required evidence does not exist,
the only honest state is `unassessed`; TFR is then `null`, not zero and not an
invented success.

## Raw evidence and trust model

The raw store is not the human summary. Each event references actual restricted,
already-redacted payload bytes stored first in a local content-addressed payload
directory. The event journal contains RFC 8785 canonical JSON followed by one LF
per record. Under the same reviewed SQLite lock, append assigns sequence and
previous digest, enforces immutable run/task/system/contract identity, writes a
bounded record completely, and calls `fsync` before reporting success.

Inspection rejects BOM, CRLF, invalid UTF-8, duplicate-key/noncanonical source,
unknown fields, gaps, reorder/delete/duplicate operations, wrong links, bytes
after `run.finished`, missing final LF, and torn tails. Corruption is preserved
for investigation; the API never truncates or repairs it.

Initialization first writes immutable per-ledger metadata containing the pinned
platform-protection verifier digest. Create, append, inspect, seal, and verify all
enforce that same digest, and the frozen signed statement includes it; supplying a
more permissive verifier early and a different verifier at verification cannot
rewrite the claimed protection history.

Sealing has three non-circular layers:

- immutable ledger facts, signed as exact canonical statement bytes;
- an anchor receipt containing the statement digest, signature, verification
  material, signer, URI, and preregistered policy; and
- an exact SHA-256 content address over the stored canonical seal document.

A durable `freeze` file is created and synced before contacting the anchor, so a
crash after remote anchoring cannot reopen the prefix. Retrying resumes the same
frozen statement. Before calling the anchor again, retry validates and returns a
sole already-stored seal for that statement, including its content address,
policy, and signature. This remains idempotent even when the anchor issues
different valid receipt bytes for repeated requests or the first response was
lost. Retries re-sync already-landed exact bytes and their parent directory before
acknowledging success; initialization is resumable only while the ledger is still
empty. Event and byte limits are checked before a new payload can be persisted.
Trusted verification requires an
`expectedSealDigest` supplied from outside the evidence root and the
preregistered receipt verifier. The API never discovers a local "latest seal"
and labels journal-only inspection `integrity_only_unanchored`.

The local filesystem boundary requires canonical local paths, one SQLite lock
for create/append/inspect/seal/verify, `0700` directories, `0600` single-link
regular files, no create/truncate flags on append, descriptor/path identity
checks, file sync, and POSIX directory sync for new entries. macOS and Windows
require a pinned external ACL/reparse verifier; Windows has a documented weaker
portable directory-entry power-loss boundary because Node does not expose a
portable directory flush. Root/admin or a hostile process under the same OS
identity remains outside what pure Node can defeat while a run is live; the
external seal detects post-seal replacement.

All lifecycle comparisons use the contract's full permitted nanosecond
precision. JavaScript's millisecond-only `Date.parse` is used only to validate
calendar fields, never to order runs or access/seal events.

## Compatibility, migration, and rollback

- Contract `1.0.0` is immutable. Additive optional evolution still requires a
  reviewed version decision; breaking meaning or required fields requires a new
  schema/version and an explicit adapter.
- Legacy reports are read-only inputs to `classifyLegacyEvalReport`. They are
  never silently promoted, assigned synthetic missing pins, or mixed into v1
  summaries.
- The existing offline mock runner and its commands remain available. The new
  contract API is additive, so rollback removes the new validator/export/script
  without rewriting legacy reports or runtime state.
- Evidence journals are append-only. There is no in-place data migration. A new
  ledger format writes a new root/version and retains old sealed bytes plus their
  verifier.
- Holdout retirement rotates commitments and records an access event; it never
  republishes private manifests as a migration shortcut.

## Primary-source design record (2026-07-15)

- [NIST AI 800-3, *Expanding the AI Evaluation Toolbox with Statistical Models*](https://doi.org/10.6028/NIST.AI.800-3)
  distinguishes fixed versus population claims, models repeated trials as
  clustered observations, and warns against treating trial rows as independent.
  This drove within-task averaging followed by repository-cluster resampling.
- [Anthropic, *Demystifying evals for AI agents*](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  separates tasks, trials, graders, transcripts, and outcomes and recommends
  multiple clean trials plus cost/token capture. This drove explicit matrix and
  run provenance rather than a single aggregate score.
- [OpenAI, *Why we no longer evaluate SWE-bench Verified*](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
  and [*Separating signal from noise in coding evaluations*](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)
  document contamination and broken-verifier risks. Public coding suites may be
  diagnostic inputs, but cannot substitute for a frozen private holdout.
- [RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
  defines deterministic I-JSON bytes for hashing/signing. The implementation
  additionally rejects unsafe integers, exotic programmatic objects, lone
  surrogates, and noncanonical raw journal lines.
- [in-toto Attestation Framework, Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
  informed the split between immutable facts and a signature/verification
  receipt. AgenC does not claim a local hash chain alone is tamper-proof.
- [OSF Registrations](https://help.osf.io/article/330-welcome-to-registrations)
  informed the immutable preregistration/embargo model and the separation of
  preregistration, blinded-results commitment, and unblinding record.
- [Harbor](https://github.com/harbor-framework/harbor) informed the neutral
  task/container/agent-adapter boundary. AgenC keeps the contract portable rather
  than coupling competitive tasks to daemon-specific protocol semantics.
- [OpenClaw ShellBench](https://github.com/openclaw/shellbench) informed <!-- branding-scan: allow comparator research citation -->
  deterministic completion and reliability diagnostics, but product-specific
  trace/process scoring is not used as neutral coding-quality truth.
- Official comparator releases inspected on 2026-07-15 were
  [Hermes Agent `v2026.7.7.2`](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.7.2) <!-- branding-scan: allow comparator release research -->
  and [OpenClaw `v2026.7.1`](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1). <!-- branding-scan: allow comparator release research -->
  These links are research snapshots, not mutable runtime defaults. Every real
  comparison must preregister its exact tag, commit, package digest, install
  command, public/redacted config, model lane, and limitations.

Alternatives rejected:

- Extending the old report with more optional strings: it remains overwriteable,
  mutable-label based, and unable to prove private verification or preregistration.
- Publishing only a summary or local hash chain: either loses audit evidence or
  allows whole-prefix/seal replacement inside one trust domain.
- Treating all runs as independent bootstrap rows: this inflates apparent sample
  size and ignores task/repository clustering.
- Making a public benchmark the final holdout: current evidence shows that task
  contamination and broken tests can dominate the score.
- Requiring private repositories: private post-cutoff defects and verifiers on
  real public repositories are more representative and can remain uncontaminated.
- Building comparator adapters or paid runs in this PR: those are later M1
  checkboxes and must consume this frozen contract rather than shape it after
  results are seen.
