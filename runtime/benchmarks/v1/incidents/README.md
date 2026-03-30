# Orchestration Incident Fixtures

This directory is the must-pass replay corpus for the planner, delegation, and
verifier cleanup tracked in
[`TODO.MD`](../../../../TODO.MD).

The machine-readable catalog lives in
`runtime/src/eval/orchestration-scenarios.ts`.
The deterministic replay harness lives in
`runtime/tests/pipeline-incident-replay.integration.test.ts`.

## Must-Pass Fixtures

These fixtures already exist and are part of the mandatory cleanup bar:

- `allowlist-access-denied`
- `delegated-split-workspace-root`
- `delegation-fallback-dual-truth`
- `followup-tool-contract-suppressed`
- `needs-verification-child-survives-parent`
- `noop-success-rejected`
- `readonly-review-overdelegated`
- `request-tree-budget-retry-reset`
- `reviewer-writer-contract-collapse`
- `shell-stub-false-completion`
- `ungrounded-writer-fabrication`
- `wrong-workspace-root`
- `xai-route-mismatch-fail-open`

Each cleanup phase must keep these fixtures green.

## Covered Failure Classes

The cleanup fixture set now covers the previously missing failure classes:

- reviewer/writer contract collapse
- `needs_verification` child state surviving parent verification
- tool-routing fail-open
- follow-up tool-schema suppression
- request-tree budget reset across retries

## Phase 0 Rule

Do not widen planner, delegation, verifier, or compatibility semantics without
updating the cleanup inventory in:

- `docs/architecture/guides/workflow-cleanup-mode.md`
- `runtime/src/workflow/cleanup-mode.ts`
- this incident README
