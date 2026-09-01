# Critical-path target decisions

Status: mixed. CP-0001 through CP-0007 are in the 0.17.0 runtime. CP-0008
still has a flattening cutover (fork context concatenates `taskPrompt`).
Per-file headers that still say "implementation pending" are stale when this
table says shipped.

Reviewed against commit `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` on
2026-07-31. Re-checked against the 0.17.0 tree.

| ID | Decision | Runtime |
| --- | --- | --- |
| CP-0001 | [Separate caller, admission, and physical-effect outcomes](0001-effect-outcome-separation.md) | Shipped (schema v17) |
| CP-0002 | [Use strict canonical recovery with quarantine](0002-strict-recovery-quarantine.md) | Shipped. `turn_checkpoint` journal shape is additive; resume uses the fail-closed reader — [recovery journal vs checkpoint reader](../durable-runs-effects-events.md#recovery-journal-vs-checkpoint-reader) |
| CP-0003 | [Version durable checkpoints and bind complete tool results](0003-versioned-durable-checkpoints.md) | Shipped. Current writes are checkpoint v4 / rollout schema 5; see [checkpoint slice versions](../durable-runs-effects-events.md#checkpoint-slice-versions) |
| CP-0004 | [Separate CSV source, item, and path identities](0004-csv-identity-and-replay.md) | Shipped |
| CP-0005 | [Publish only complete derived-index generations](0005-derived-index-freshness.md) | Shipped |
| CP-0006 | [Make compaction a rollback-capable transaction](0006-compaction-transaction.md) | Shipped. Mid-turn skip/throw is a per-turn `compact_failed` warning, and checkpoint v4 authenticates post-compact history. See [compact skip and session survival](0006-compaction-transaction.md#compact-skip-and-session-survival). |
| CP-0007 | [Govern workflow handoff artifacts](0007-workflow-handoff-artifact.md) | Shipped |
| CP-0008 | [Preserve trusted instructions and untrusted data end to end](0008-agent-invocation-envelope.md) | Mixed. Envelope types exist; fork still concatenates `Task: ${input.taskPrompt}` |

## Interpretation rules

- `MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative.
- The owner codes in parentheses are stable implementation-work identifiers;
  the preceding text is the self-contained scope. The local contributor backlog
  is orchestration detail, not required to interpret these records.
- A target decision becomes implemented only when its owning work is merged
  with its migrations, tests, benchmarks, documentation, and rollback evidence.
- Persisted readers and migrations land before new writers.
- A runtime that cannot interpret a safety-relevant new format refuses the
  affected run, session, job, or artifact. It never guesses or silently drops
  the state.
- Changes to an accepted decision require a superseding record. Once a fixture
  or contract is consumed by another PR, it is not rewritten in place.
- These decisions do not authorize a release or a package-version change.

## Evidence

Synthetic legacy and adversarial fixtures live under
`runtime/tests/fnd/fixtures/`. Their manifest binds every file to the audited
commit, exact bytes, and SHA-256. The fixture corpus contains no user data,
credentials, private paths, or generated bulk inputs.
