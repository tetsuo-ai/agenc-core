# Runtime Completion Semantics

This guide defines the final completion rules for `runtime/` implementation-class work after the false-completion cleanup.

Phase 0 cleanup guardrails for the planner/delegation/verifier path are tracked
separately in [workflow-cleanup-mode.md](workflow-cleanup-mode.md). That guide
is the temporary freeze for status families, verifier issue codes, compatibility
overrides, and must-pass incident fixtures while the architectural cleanup is
in progress.

## Authoritative rule

The workflow verification layer is the only authority for implementation completion.

Implementation-class tasks cannot terminate `completed` unless they pass the contract-backed verifier. That applies to:

- deterministic implementation/fix/refactor runs
- delegated implementation runs
- resumed partial implementation runs

## Completion states

- `completed`: all required obligations were satisfied and verification passed
- `partial`: grounded progress exists, but required obligations are still open or a verifier failed
- `blocked`: no sufficient grounded progress exists, or execution is waiting on an external blocker
- `needs_verification`: grounded implementation progress exists, but the required runnable harness or verifier pass is still missing

## Remaining legacy compatibility classes

Only these classes may still use the legacy non-implementation completion path:

- `docs`
  - documentation-only artifact updates such as `README.md`, `CHANGELOG.md`, or other doc-only files
- `research`
  - grounded research-only turns with citations or research-tool evidence and no implementation mutation
- `plan_only`
  - non-execution turns, exact-response turns, and dialogue-memory turns that do not request environment changes

If a turn mutates implementation artifacts or otherwise behaves like implementation work and it does not carry the workflow verification contract, the runtime must reject legacy completion.

## Operator meaning

When an implementation turn is rejected from the legacy path, the operator-visible meaning is:

- the agent made grounded progress, but the run is not allowed to count as complete yet
- the fix is to route the work through the contract-backed verifier, not to relax the completion gate

When a docs, research, or plan-only turn is accepted through the compatibility path, that is an explicit exception, not a fallback for implementation work.

## Debugging checklist

If a run looks incorrectly complete, check these in order:

1. Did the turn carry `verificationContract` or `completionContract`?
2. Did the planner verifier actually run and pass?
3. Did the final state come from `completed` with verifier coverage, or from a legacy compatibility class?
4. Did the turn mutate any non-doc implementation artifacts?

If the answer to `3` is “legacy compatibility” and the answer to `4` is yes, that is a bug.
