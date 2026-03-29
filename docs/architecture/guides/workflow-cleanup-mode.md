# Workflow Cleanup Mode

This guide defines the temporary cleanup freeze for the planner, delegation,
and verifier path while the architectural refactor in
[`TODO.MD`](../../../TODO.MD) is in progress.

Cleanup mode is active for the runtime workflow surfaces that currently own the
contradictory execution semantics:

- planner graph shaping
- delegation admission and child scoping
- child output validation
- parent-side verifier issue reporting
- legacy compatibility completion paths

The goal of Phase 0 is not to change those semantics yet. The goal is to stop
them from drifting further while the real cleanup lands in later phases.

## Active Freeze

Cleanup mode is declared in code by
`runtime/src/workflow/cleanup-mode.ts` as
`phase0_freeze_semantics`.

While this mode is active:

- workflow completion states are frozen
- execution-kernel step and node status families are frozen
- delegated output validation codes are frozen
- runtime verification channels are frozen
- planner verifier issue codes are frozen behind explicit registries and
  mappings
- legacy compatibility classes and compatibility-source values are frozen
- known delegation compatibility override flags are frozen

Any new status code, verifier issue code, or compatibility override must update
the cleanup-mode registries and their regression tests in the same change.

## Frozen Surfaces

### Completion and execution status families

- `runtime/src/workflow/completion-state.ts`
- `runtime/src/workflow/execution-kernel-types.ts`

These files now define the canonical arrays for the currently allowed runtime
states. Phase 0 does not change their meaning; it only stops silent expansion.

### Validation and verifier issue families

- `runtime/src/utils/delegation-validation.ts`
- `runtime/src/workflow/verification-results.ts`
- `runtime/src/llm/chat-executor-verifier.ts`
- `runtime/src/workflow/cleanup-mode.ts`

Delegated validation codes remain the contract-layer source of truth.
Planner/verifier issue codes must now map through the cleanup-mode registry
instead of growing through ad hoc strings.

### Compatibility surfaces

- `runtime/src/llm/chat-executor-contract-flow.ts`
- `runtime/src/workflow/execution-envelope.ts`
- `runtime/src/workflow/migrations.ts`
- `runtime/src/gateway/delegation-admission.ts`

Phase 0 does not remove compatibility behavior. It only freezes the currently
allowed classes and override shapes so new exceptions cannot quietly expand.

## Must-Pass Incident Fixtures

The current must-pass replay corpus is documented beside the fixtures in
[`runtime/benchmarks/v1/incidents/README.md`](../../../runtime/benchmarks/v1/incidents/README.md).

The existing must-pass fixture set is:

- `allowlist-access-denied`
- `delegated-split-workspace-root`
- `delegation-fallback-dual-truth`
- `noop-success-rejected`
- `readonly-review-overdelegated`
- `shell-stub-false-completion`
- `ungrounded-writer-fabrication`
- `wrong-workspace-root`

These incidents are the minimum regression bar for the cleanup phases. New
cleanup work must not regress any of them.

## Open Failure Classes Still Tracked

The remaining open failure classes that still need fixture coverage are:

- reviewer/writer contract collapse
- `needs_verification` child deadlock
- tool-routing fail-open
- follow-up tool-schema suppression
- request-tree budget reset across retries

These are cleanup targets, not optional backlog items.

## Operator Guidance

During cleanup mode:

- do not add local one-off planner/verifier fixes unless they are guardrails
- do not add new compatibility branches to “make a case pass”
- if a new incident appears, add it to the incident corpus and this cleanup
  inventory before widening behavior

The next semantic changes belong in Phase 1 and later, where the runtime moves
to one typed workflow contract instead of layered heuristics.
