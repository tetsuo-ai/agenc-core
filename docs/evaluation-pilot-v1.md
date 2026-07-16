# Evaluation pilot v1

Status: frozen public-development candidates and qualification protocol;
not yet a scored or superiority-qualified pilot.

The pilot pipeline deliberately separates three facts that are easy to blur:

1. a task was selected without looking at AgenC or comparator outcomes;
2. its public source bytes, verifier material, image, and repository state are
   reproducibly pinned; and
3. independent QA has proved that the task is suitable for measurement.

Only a catalog that passes all three boundaries may enter a real-agent pilot.
The committed source lock currently establishes the first two for 30
candidates. Its per-task source evidence explicitly records
`candidate_requires_local_qa`; it does not fabricate independent solves,
negative-patch reviews, or successful pilot results.

## Frozen development candidates

The v1 source lock is
`runtime/eval/suites/competitive-coding/1.0.0/task-sets/pilot/1.0.0/source-lock.json`,
with document digest
`sha256:797a8debf2459bd0df228c5b8b4b77c15d37b2fcb6adf1a00824b26b8f2f161f`.
It selects exactly 30 public tasks from 30 repositories and eight language
strata:

| Language stratum | Tasks |
| --- | ---: |
| C, C++, Go, Java, JavaScript, Rust | 4 each |
| C#, TypeScript | 3 each |

The source is the public `SWE-bench-Live/MultiLang` dataset at immutable
revision `608f7ae9ab8ea1f9f0d030fe04562cf6bd1a0c8b`, with source tooling pinned
to commit `70ec57e852e3f2d195790fe71f553e272c691833`. Selection happened before any
AgenC or comparator result existed. The lock records exact row digests,
repository commits, issue text, OCI manifest digests, category/stressor labels,
and content-addressed setup, reference, verifier, and source-evidence bytes.
Mutable image tags are retained only as provenance; execution uses the attached
`@sha256:` manifest digest.

The selection covers every preregistered work category at least three times:
multi-file fixes, failing-test diagnosis, regression repair,
compatibility-constrained refactoring, missing tests, long-context navigation,
and ambiguous issues. It also reserves tasks for product-neutral tool timeout,
partial-output, untrusted-repository-content, and collaboration stress. A label
is not proof of coverage: the final curation protocol requires a CAS-bound
mechanism/evidence record before qualification.

Repository prompt-injection candidates receive the same public setup patch for
every system. The patch marks the adversarial text as untrusted repository
content; it never changes the hidden verifier and never uses AgenC-only
protocol semantics.

## Reproducing the source freeze

The refresh command is intentionally explicit and networked. It reads the
pinned public dataset and resolves current registry manifests; it is not part
of `npm test` and does not make model calls:

```bash
cd runtime
node scripts/refresh-eval-pilot-source.mjs \
  --output /tmp/agenc-pilot-refresh/source-lock.json
```

The command creates a fresh `source-lock.json` plus `cas/sha256/` beside it and
refuses to overwrite an existing lock. Compare the regenerated document and
CAS inventory with the committed version. A changed upstream dataset head,
missing row, missing image, or moved image tag fails or produces a different
digest instead of silently changing the pilot.

The default local test is hermetic and verifies the committed document digest,
task/repository/language/category/stressor invariants, every CAS byte count and
SHA-256 digest, compressed verifier joins, and the explicit incomplete-QA
status:

```bash
npm --workspace=@tetsuo-ai/runtime exec -- \
  vitest run tests/eval/evaluation-pilot-source-lock.test.ts
```

## Qualification boundary

`runtime/src/eval-pilot/` defines the closed curation schema, semantic
validator, safe loader, and agent projection. A score-ready curation catalog
must bind exactly 30 development tasks to the evaluation-contract suite and
prove all of the following locally:

- at least 15 repository families and no more than two tasks per family;
- public real-issue provenance, immutable repository/image/tool/policy/reset
  pins, and exact source-row selection joins;
- three cold preflights where the base fails target checks, existing regression
  checks pass, and the reference solution passes everything;
- an independent successful solve from the issue and pinned base while the
  verifier remains inaccessible;
- at least two independently reviewed incomplete, overfit, regressing, or
  test-tampering patches that the verifier rejects;
- a product-neutral implementation/evidence record for every declared stressor;
- byte-for-byte presence of every curation, setup, hidden-verifier, reference,
  and validation artifact in the bounded non-symlink CAS tree.

The loader rejects duplicate JSON keys, invalid UTF-8, path escape, symlinks,
oversized input, replacement races, size mismatches, digest mismatches, missing
evidence, shared protected oracle identities, or a task projection that exposes
operator-only material. Setup patches may legitimately be shared or empty;
hidden verifiers and reference evidence may not.

`validateEvaluationPlan` then binds a qualified suite to its preregistration
before the first run: exact suite and family-map digests, fixed task/repository
counts, reset policy, randomized execution order, holdout descriptor joins,
and the complete independently reviewed power-analysis document. Superiority
preflight rejects an opaque digest, an underpowered decision, or any difference
in the selected suite/experiment identity, sorted repository-size vector,
repetition count, bootstrap resample count, or bootstrap seed.

## Power and superiority boundary

The public pilot is development evidence only. Public historical issues and
reference patches are contamination-resistant diagnostics, never a private
superiority holdout.

After paired AgenC/comparator pilot attempts exist, `runtime/src/eval-power/`
aggregates repetitions within each task, preserves paired outcomes, models
repository clustering, and simulates each exact fixed repository allocation
using the same deterministic repository-clustered percentile bootstrap and
Type-7 interval implementation used by contract-v1 result scoring. CR2/
Satterthwaite remains an explicitly labeled diagnostic sensitivity; it cannot
authorize the confirmatory design. The final
design must use at least 50 independent tasks, at least 20 repository families,
at least three fresh repetitions per system/task, alpha `0.05`, and target power
`0.80`. The decision is the intersection across every preregistered comparator.
The selected sample size is fixed before the private holdout opens; there are no
unblinded sample expansions or implicit interim looks.

Power analysis is intentionally bounded before synchronous simulation: at most
32 sensitivity cells, 1.5 billion conservative nested-bootstrap task additions,
and 100 million synthetic attempt/comparator operations. Both estimates use
`BigInt` and are checked before allocating the simulation grid. Each direct
production-bootstrap invocation also fails before sample allocation when its
worst-case work exceeds 500 million task additions. Operators must narrow an
oversized grid or split exploratory diagnostics; they cannot bypass the bound
inside a confirmatory power document.

Power inputs and documents pass a descriptor-only I-JSON graph preflight before
canonicalization. It never invokes accessors and caps depth at 64, arrays at
100,000 entries, objects at 256 properties, the graph at 1.2 million nodes and
properties, individual strings at 1 MB, and aggregate string data at 200 MB.

The private one-use task manifest, prompts, repository identities, verifiers,
reference patches, and custody logs stay outside this checkout under a separate
principal. This repository may contain only the public holdout descriptor,
power-analysis document, exact system preregistrations, and externally verified
registration receipts.

## Research record

Research refreshed 2026-07-16:

- [SWE-bench-Live](https://github.com/microsoft/SWE-bench-Live) supports recent,
  multilingual, executable repository tasks and repeated gold-patch preflights.
- OpenAI's [2026 coding-evaluation audit](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)
  reports substantial broken-task rates even in reviewed public benchmarks,
  motivating independent prompt/oracle and negative-patch review.
- [SWE-rebench (NeurIPS 2025)](https://proceedings.neurips.cc/paper_files/paper/2025/hash/21bec6ace947b1b58967b945c8ac0f10-Abstract-Datasets_and_Benchmarks_Track.html)
  motivates refreshed executable tasks while documenting contamination and QA
  tradeoffs.
- [METR HCAST](https://metr.org/hcast.pdf) motivates private problems,
  independent QA, separate scaffold-development data, and repeated attempts.
- [Pustejovsky and Tipton](https://doi.org/10.1080/07350015.2016.1247004)
  supports the available small-cluster CR2/Satterthwaite diagnostic; the
  [wild cluster bootstrap](https://www.nber.org/papers/t0344) is a potential
  future sensitivity analysis. Neither replaces the preregistered production
  percentile bootstrap.
- The FDA's [adaptive-design guidance](https://www.fda.gov/media/78495/download)
  is the basis for rejecting post-hoc sample expansion without a complete
  preregistered sequential design.
