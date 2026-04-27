# Runtime Owner Manifest

This document is the Phase 0 forbidden-owner manifest for the AgenC runtime
runtime replacement in `agenc-core/runtime`.

It does two jobs:

- name the current local runtime owners and the surfaces that are
  explicitly not local runtime owners
- define a machine-readable contract for the first-pass structural check
  in `runtime/scripts/check-runtime-ownership.mjs`

This manifest is intentionally exact about file paths and intentionally
modest about what the static check proves. It is a defense-in-depth
guardrail for the replacement tranche, not a proof that runtime
ownership is fully consolidated.

## True Local Runtime Owners

- `runtime/src/bin/route.ts`
  Interactive route gate for one-shot CLI vs TUI vs resume. It is a
  live entry surface, but it must stay a pure router and must not grow
  bootstrap/session semantics.
- `runtime/src/bin/agenc.ts`
  Interactive CLI adapter. It owns the one-shot loop plus
  `bootTUIEntry(...)` / `resumeTUIEntry(...)` handoff, but it no longer
  owns `buildTurnContext(...)` directly.
- `runtime/src/bin/bootstrap.ts`
  Canonical local bootstrap owner. It owns session creation/resume,
  sidecar and MCP startup wiring, and the current `buildTurnContext(...)`
  handoff into the AgenC runtime session kernel.
- `runtime/src/tui/main.tsx`
  Ink/TUI bootstrap surface. It owns terminal lifecycle and stdin-loss
  handling for the live cockpit, but it must not grow session bootstrap
  or legacy runtime-owner imports.
- `runtime/src/bin/slash.ts`
  Slash-command wrapper and registry bridge gate. It is a live entry
  surface, but not a separate runtime owner.
- `runtime/src/agents/delegate.ts`
  Local delegate/subagent entry path. It must converge on the same
  session bootstrap and turn kernel as the main CLI path.
- `runtime/src/session/turn-context.ts`
  Owns the `TurnContext` shape and builder API.
- `runtime/src/session/run-turn.ts`
  Owns the AgenC runtime-aligned turn orchestration kernel.
- `runtime/src/tools/execution.ts`
  Intended tool execution owner after legacy service ownership is
  removed.
- `runtime/src/tools/orchestrator.ts`
  Intended tool orchestration owner after legacy service ownership is
  removed.
- `runtime/src/tools/streaming-executor.ts`
  Intended streaming tool executor owner after the legacy owner is
  retired.
- `runtime/src/llm/compact/**`
  Intended compaction owner root after the legacy compact service family
  stops owning runtime behavior.

## Compatibility-Only Surfaces

No compatibility-only creation/resume surfaces are present in the current
runtime tree. If SDK or remote bridge creation/resume surfaces are
reintroduced, they must be listed here rather than treated as local runtime
owners.

## Fabricated-Context Seams

Owner-owned context fabrication is declared directly on the owner records in
the machine-readable contract below. The old non-owner seams named during the
Phase 0 cutover have been removed from the live tree.

## Legacy Runtime-Owner Files

The exact legacy owner files named during Phase 0 have been removed from the
live tree. The forbidden-import patterns below remain the guardrail that keeps
those owner families from growing back into the live runtime boundary.

## Ownership Rules

- Live entrypoints must not add new direct imports from
  `runtime/src/query.ts`, `runtime/src/services/compact/**`, or
  `runtime/src/services/tools/**`.
- `runtime/src/tools/AgentTool/**` is treated as a legacy owner family.
  Existing direct imports that are still transitional must be declared as
  explicit exceptions in the machine-readable contract; new ones fail.
- `buildTurnContext(...)` is only allowed as a manifest-declared
  owner/seam call. Today the canonical bootstrap owner is
  `runtime/src/bin/bootstrap.ts`; any new call site must be added to the
  manifest intentionally.
- `ToolUseContext` fabrication is a seam, not an invisible convenience.
  New object-literal fabrication sites fail unless the manifest is
  updated first.
- Helper imports from the legacy compact family are allowed only for the
  exact importer paths listed in the machine-readable contract.
- Static checks protect structure. Smoke tests remain the primary proof
  that the runtime behaves correctly after ownership moves.

## Static Vs Smoke Check Limits

- The structural check is heuristic only. It uses TypeScript AST import
  resolution and a narrow set of context-fabrication heuristics.
- It checks direct imports and known seam patterns. It does not prove
  semantic ownership, runtime dispatch, or full transitive behavior.
- Manifest-declared transitional exceptions are warnings, not silent
  passes.
- A green structural check does not prove that the cutover is done.
  Phase smoke tests and parity checks still carry the proof burden.

## Machine-Readable Contract

The checker reads the JSON block below. Update the prose above and the
JSON together.

<!-- runtime-owner-manifest:json:start -->
```json
{
  "schemaVersion": 1,
  "manifestPath": "docs/plan/runtime-owner-manifest.md",
  "runtimeSourceRoot": "runtime/src",
  "trueLocalRuntimeOwners": [
    {
      "id": "cli_route",
      "path": "runtime/src/bin/route.ts",
      "kind": "live_entrypoint",
      "ownedSurface": "interactive route gate for one-shot CLI vs TUI vs resume",
      "disposition": "pure routing surface only; must not grow session or bootstrap semantics"
    },
    {
      "id": "cli_entry",
      "path": "runtime/src/bin/agenc.ts",
      "kind": "live_entrypoint",
      "ownedSurface": "one-shot CLI loop plus bootTUIEntry/resumeTUIEntry adapters",
      "disposition": "live adapter surface only; turn bootstrap lives in runtime/src/bin/bootstrap.ts"
    },
    {
      "id": "session_bootstrap",
      "path": "runtime/src/bin/bootstrap.ts",
      "kind": "bootstrap_owner",
      "ownedSurface": "session create/resume bootstrap, MCP/sidecar wiring, and TurnContext handoff",
      "disposition": "canonical local bootstrap owner after the AgenC runtime cutover",
      "expectedHeuristics": [
        "build_turn_context_call"
      ]
    },
    {
      "id": "tui_boot",
      "path": "runtime/src/tui/main.tsx",
      "kind": "ui_entrypoint",
      "ownedSurface": "Ink mount path, terminal lifecycle, and stdin-loss handling",
      "disposition": "UI surface only; session bootstrap must stay outside the TUI tree"
    },
    {
      "id": "slash_adapter",
      "path": "runtime/src/bin/slash.ts",
      "kind": "live_entrypoint",
      "ownedSurface": "slash-command wrapper and registry bridge gate",
      "disposition": "thin adapter only; no standalone runtime ownership"
    },
    {
      "id": "delegate_entry",
      "path": "runtime/src/agents/delegate.ts",
      "kind": "live_entrypoint",
      "ownedSurface": "delegate and subagent local entry path",
      "disposition": "must converge on the same runtime turn contract as the main session path"
    },
    {
      "id": "turn_context_kernel",
      "path": "runtime/src/session/turn-context.ts",
      "kind": "kernel_owner",
      "ownedSurface": "TurnContext definition and builder",
      "disposition": "canonical local owner"
    },
    {
      "id": "run_turn_kernel",
      "path": "runtime/src/session/run-turn.ts",
      "kind": "kernel_owner",
      "ownedSurface": "turn orchestration kernel",
      "disposition": "canonical local owner"
    },
    {
      "id": "tool_execution_owner",
      "path": "runtime/src/tools/execution.ts",
      "kind": "owner_module",
      "ownedSurface": "tool execution",
      "disposition": "destination owner after legacy service removal"
    },
    {
      "id": "tool_orchestrator_owner",
      "path": "runtime/src/tools/orchestrator.ts",
      "kind": "owner_module",
      "ownedSurface": "tool orchestration",
      "disposition": "destination owner after legacy service removal"
    },
    {
      "id": "streaming_executor_owner",
      "path": "runtime/src/tools/streaming-executor.ts",
      "kind": "owner_module",
      "ownedSurface": "streaming tool execution",
      "disposition": "destination owner after legacy service removal"
    },
    {
      "id": "compact_owner_root",
      "path": "runtime/src/llm/compact/**",
      "kind": "owner_root",
      "ownedSurface": "compaction ownership root",
      "disposition": "destination owner root after legacy compact removal"
    }
  ],
  "compatibilityOnlySurfaces": [],
  "fabricatedContextSeams": [],
  "legacyRuntimeOwnerFiles": [],
  "allowedNonRuntimeConsumers": [],
  "ownershipRules": [
    "All live turns must converge on the same session bootstrap and turn kernel.",
    "Static checks reject new direct live-entrypoint imports from legacy owners, but they do not prove that the runtime is fully cut over.",
    "Context fabrication must stay manifest-listed until the owning tranche removes it."
  ],
  "staticVsSmokeCheckLimits": [
    "The structural check is heuristic only and uses AST-visible patterns.",
    "It checks direct imports and known seam markers, not full semantic ownership.",
    "Manifest-declared transitional exceptions are warnings rather than proof that the architecture is acceptable.",
    "Smoke tests and parity checks remain the primary proof of the cutover."
  ],
  "checkConfig": {
    "liveEntrypoints": [
      "runtime/src/bin/route.ts",
      "runtime/src/bin/agenc.ts",
      "runtime/src/bin/bootstrap.ts",
      "runtime/src/tui/main.tsx",
      "runtime/src/bin/slash.ts",
      "runtime/src/agents/delegate.ts"
    ],
    "forbiddenDirectImports": [
      {
        "pattern": "runtime/src/query.ts",
        "reason": "legacy query-loop owner"
      },
      {
        "pattern": "runtime/src/services/compact/**",
        "reason": "legacy compact service owner family"
      },
      {
        "pattern": "runtime/src/services/tools/**",
        "reason": "legacy tool service owner family"
      },
      {
        "pattern": "runtime/src/tools/AgentTool/**",
        "reason": "legacy subagent owner family"
      }
    ],
    "directImportExceptions": [],
    "helperImportPolicies": [],
    "allowlistedFabricationSeams": []
  }
}
```
<!-- runtime-owner-manifest:json:end -->
