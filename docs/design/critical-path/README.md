# Critical-path target decisions

Status: accepted target architecture; implementation is pending.

These decision records freeze the contracts required by the algorithmic
critical-path remediation program. They were reviewed against commit
`d2b228e87ea63bd6a5d93e6f599f36bce88d672b` on 2026-07-31.

They describe target behavior. They do not claim that the current runtime
already implements it. Current implemented behavior remains documented by the
other pages under `docs/design/` until the corresponding implementation PR is
merged and those pages are updated.

| ID | Decision | Implementation owner |
| --- | --- | --- |
| CP-0001 | [Separate caller, admission, and physical-effect outcomes](0001-effect-outcome-separation.md) | Effect-outcome state machine and retry audit (A1) |
| CP-0002 | [Use strict canonical recovery with quarantine](0002-strict-recovery-quarantine.md) | Strict recovery contracts, bounded projection, and authoritative cutover (A2a, E1a, A2b) |
| CP-0003 | [Version durable checkpoints and bind complete tool results](0003-versioned-durable-checkpoints.md) | Checkpoint digest, ordered tool pairing, and legacy migration (A3) |
| CP-0004 | [Separate CSV source, item, and path identities](0004-csv-identity-and-replay.md) | CSV identity, import visibility, and replay safety (B1) |
| CP-0005 | [Publish only complete derived-index generations](0005-derived-index-freshness.md) | Persistent fuzzy-file indexing and full-corpus memory indexing (D2, C3b) |
| CP-0006 | [Make compaction a rollback-capable transaction](0006-compaction-transaction.md) | Transactional, injection-safe context compaction (C2) |
| CP-0007 | [Govern workflow handoff artifacts](0007-workflow-handoff-artifact.md) | Workflow artifact contract followed by bounded scheduler consumption (B3a, B3b) |
| CP-0008 | [Preserve trusted instructions and untrusted data end to end](0008-agent-invocation-envelope.md) | CSV, workflow, memory, session, wire, and provider invocation adapters (B1, B3, C3) |

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
