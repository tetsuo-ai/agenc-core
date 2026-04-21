# Runtime Owner Manifest

This document is the Phase 0 forbidden-owner manifest for the codex
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

- `runtime/src/bin/agenc.ts`
  Interactive CLI bootstrap. It still owns session bootstrap and the
  top-level `buildTurnContext(...)` call today, but the approved cutover
  target is bootstrap plus UI surface only.
- `runtime/src/bin/slash.ts`
  Slash-command wrapper. It is a live entrypoint but not a long-term
  runtime owner; the manifest keeps it explicit so the check can reject
  new legacy imports there.
- `runtime/src/tasks/LocalMainSessionTask.ts`
  Background main-session path. The approved plan names
  `startBackgroundSession`; the live tree currently exposes
  `registerMainSessionTask` and `completeMainSessionTask`, so Phase 0
  keys on the file path.
- `runtime/src/agents/delegate.ts`
  Local delegate/subagent entry path. It must converge on the same
  session bootstrap and turn kernel as the main CLI path.
- `runtime/src/session/turn-context.ts`
  Owns the `TurnContext` shape and builder API.
- `runtime/src/session/run-turn.ts`
  Owns the codex-aligned turn orchestration kernel.
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

- `runtime/src/entrypoints/agentSdkTypes.ts::unstable_v2_createSession`
- `runtime/src/entrypoints/agentSdkTypes.ts::unstable_v2_resumeSession`
- `runtime/src/bridge/createSession.ts::createBridgeSession`
- `runtime/src/bridge/createSession.ts::getBridgeSession`

These surfaces must stay visible in the manifest so the replacement work
does not accidentally claim that local runtime ownership already covers
SDK or remote bridge creation/resume paths. They are compatibility
surfaces, not proof of local runtime ownership.

## Fabricated-Context Seams

These are either real context-fabrication sites today or near-boundary
files that must stay listed until the cutover removes the seam:

- `runtime/src/bin/agenc.ts`
- `runtime/src/commands/compact.ts`
- `runtime/src/utils/forkedAgent.ts`
- `runtime/src/utils/hooks/execAgentHook.ts`
- `runtime/src/commands/context/context-noninteractive.ts`
- `runtime/src/utils/processUserInput/processSlashCommand.tsx`
- `runtime/src/services/MagicDocs/magicDocs.ts`
- `runtime/src/tools/AgentTool/runAgent.ts`
- `runtime/src/tools/AgentTool/**`

Some listed seams have already dropped their legacy-owner imports. They
remain in the manifest until the surrounding compatibility surface is
fully retired or recategorized, so the checker can keep tracking the
remaining boundary risk deliberately.

## Legacy Runtime-Owner Files

These are the legacy owners or owner families the plan forbids from
growing back into the live runtime boundary:

- `runtime/src/query.ts`
- `runtime/src/services/compact/compact.ts`
- `runtime/src/services/compact/autoCompact.ts`
- `runtime/src/services/compact/reactiveCompact.ts`
- `runtime/src/services/compact/microCompact.ts`
- `runtime/src/services/compact/cachedMicrocompact.ts`
- `runtime/src/services/compact/apiMicrocompact.ts`
- `runtime/src/services/compact/postCompactCleanup.ts`
- `runtime/src/services/compact/sessionMemoryCompact.ts`
- `runtime/src/services/compact/snipCompact.ts`
- `runtime/src/services/compact/snipProjection.ts`
- `runtime/src/services/compact/grouping.ts`
- `runtime/src/services/compact/prompt.ts`
- `runtime/src/services/compact/compactWarningHook.ts`
- `runtime/src/services/compact/compactWarningState.ts`
- `runtime/src/services/compact/cachedMCConfig.ts`
- `runtime/src/services/compact/timeBasedMCConfig.ts`
- `runtime/src/services/tools/StreamingToolExecutor.ts`
- `runtime/src/services/tools/toolExecution.ts`
- `runtime/src/services/tools/toolHooks.ts`
- `runtime/src/services/tools/toolOrchestration.ts`
- `runtime/src/tools/AgentTool/**`

The helper files `grouping.ts`, `compactWarningHook.ts`, and
`compactWarningState.ts` are still listed here because the plan treats
them as legacy-family files whose imports must stay tightly constrained
even if they survive as helpers.

## Allowed Non-Runtime Consumers

Only the following non-runtime consumers are approved for the helper
surfaces that remain under `runtime/src/services/compact/*`:

- `runtime/src/components/TokenWarning.tsx`
  Approved consumer of `runtime/src/services/compact/compactWarningHook.ts`
- `runtime/src/commands/compact/compact.ts`
  Approved consumer of
  `runtime/src/services/compact/compactWarningState.ts`

No current non-runtime consumer is approved for
`runtime/src/services/compact/grouping.ts`.

## Ownership Rules

- Live entrypoints must not add new direct imports from
  `runtime/src/query.ts`, `runtime/src/services/compact/**`, or
  `runtime/src/services/tools/**`.
- `runtime/src/tools/AgentTool/**` is treated as a legacy owner family.
  Existing direct imports that are still transitional must be declared as
  explicit exceptions in the machine-readable contract; new ones fail.
- `buildTurnContext(...)` is only allowed as a known owner/seam call.
  Any new call site must be added to the manifest intentionally.
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
      "id": "cli_bootstrap",
      "path": "runtime/src/bin/agenc.ts",
      "kind": "live_entrypoint",
      "ownedSurface": "interactive CLI bootstrap and current turn bootstrap",
      "disposition": "cut over first; keep only bootstrap plus UI surface"
    },
    {
      "id": "slash_adapter",
      "path": "runtime/src/bin/slash.ts",
      "kind": "live_entrypoint",
      "ownedSurface": "slash-command wrapper and bridge gate",
      "disposition": "thin adapter only; no standalone runtime ownership"
    },
    {
      "id": "background_main_session",
      "path": "runtime/src/tasks/LocalMainSessionTask.ts",
      "kind": "live_entrypoint",
      "ownedSurface": "background main-session path",
      "disposition": "must converge on the same session bootstrap contract as the CLI path"
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
  "compatibilityOnlySurfaces": [
    {
      "surface": "runtime/src/entrypoints/agentSdkTypes.ts::unstable_v2_createSession",
      "path": "runtime/src/entrypoints/agentSdkTypes.ts",
      "symbol": "unstable_v2_createSession",
      "disposition": "compatibility stub only; not a local runtime owner"
    },
    {
      "surface": "runtime/src/entrypoints/agentSdkTypes.ts::unstable_v2_resumeSession",
      "path": "runtime/src/entrypoints/agentSdkTypes.ts",
      "symbol": "unstable_v2_resumeSession",
      "disposition": "compatibility stub only; not a local runtime owner"
    },
    {
      "surface": "runtime/src/bridge/createSession.ts::createBridgeSession",
      "path": "runtime/src/bridge/createSession.ts",
      "symbol": "createBridgeSession",
      "disposition": "remote bridge compatibility surface only"
    },
    {
      "surface": "runtime/src/bridge/createSession.ts::getBridgeSession",
      "path": "runtime/src/bridge/createSession.ts",
      "symbol": "getBridgeSession",
      "disposition": "remote bridge compatibility surface only"
    }
  ],
  "fabricatedContextSeams": [
    {
      "path": "runtime/src/bin/agenc.ts",
      "status": "known_current_owner",
      "expectedHeuristics": [
        "build_turn_context_call"
      ]
    },
    {
      "path": "runtime/src/commands/compact.ts",
      "status": "known_transitional_seam",
      "expectedHeuristics": []
    },
    {
      "path": "runtime/src/utils/forkedAgent.ts",
      "status": "known_transitional_seam",
      "expectedHeuristics": [
        "imports_tool_use_context",
        "declares_create_subagent_context",
        "create_subagent_context_call"
      ]
    },
    {
      "path": "runtime/src/utils/hooks/execAgentHook.ts",
      "status": "known_transitional_seam",
      "expectedHeuristics": [
        "imports_tool_use_context"
      ]
    },
    {
      "path": "runtime/src/commands/context/context-noninteractive.ts",
      "status": "near_boundary_review_only",
      "expectedHeuristics": [
        "imports_tool_use_context"
      ]
    },
    {
      "path": "runtime/src/utils/processUserInput/processSlashCommand.tsx",
      "status": "near_boundary_review_only",
      "expectedHeuristics": [
        "imports_tool_use_context",
        "imports_legacy_compact_service"
      ]
    },
    {
      "path": "runtime/src/services/MagicDocs/magicDocs.ts",
      "status": "known_transitional_seam",
      "expectedHeuristics": [
        "imports_tool_use_context",
        "tool_use_context_object_literal"
      ]
    },
    {
      "path": "runtime/src/tools/AgentTool/runAgent.ts",
      "status": "legacy_owner_path",
      "expectedHeuristics": [
        "imports_tool_use_context",
        "create_subagent_context_call"
      ]
    }
  ],
  "legacyRuntimeOwnerFiles": [
    {
      "path": "runtime/src/query.ts",
      "category": "legacy_query_owner",
      "finalDisposition": "remove as a live runtime owner"
    },
    {
      "path": "runtime/src/services/compact/compact.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "move retained behavior under runtime/src/llm/compact and delete as owner"
    },
    {
      "path": "runtime/src/services/compact/autoCompact.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "behavior parity reference only; delete as owner"
    },
    {
      "path": "runtime/src/services/compact/reactiveCompact.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "behavior parity reference only; delete as owner"
    },
    {
      "path": "runtime/src/services/compact/microCompact.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "behavior parity reference only; delete as owner"
    },
    {
      "path": "runtime/src/services/compact/cachedMicrocompact.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "behavior parity reference only; delete as owner"
    },
    {
      "path": "runtime/src/services/compact/apiMicrocompact.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "delete"
    },
    {
      "path": "runtime/src/services/compact/postCompactCleanup.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "move retained behavior under runtime/src/llm/compact and delete as owner"
    },
    {
      "path": "runtime/src/services/compact/sessionMemoryCompact.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "delete"
    },
    {
      "path": "runtime/src/services/compact/snipCompact.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "move retained behavior under runtime/src/llm/compact and delete as owner"
    },
    {
      "path": "runtime/src/services/compact/snipProjection.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "delete"
    },
    {
      "path": "runtime/src/services/compact/grouping.ts",
      "category": "legacy_compact_helper",
      "finalDisposition": "keep only as a tightly-scoped helper"
    },
    {
      "path": "runtime/src/services/compact/prompt.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "delete"
    },
    {
      "path": "runtime/src/services/compact/compactWarningHook.ts",
      "category": "legacy_compact_helper",
      "finalDisposition": "keep only as a tightly-scoped helper"
    },
    {
      "path": "runtime/src/services/compact/compactWarningState.ts",
      "category": "legacy_compact_helper",
      "finalDisposition": "keep only as a tightly-scoped helper"
    },
    {
      "path": "runtime/src/services/compact/cachedMCConfig.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "delete"
    },
    {
      "path": "runtime/src/services/compact/timeBasedMCConfig.ts",
      "category": "legacy_compact_owner",
      "finalDisposition": "delete"
    },
    {
      "path": "runtime/src/services/tools/StreamingToolExecutor.ts",
      "category": "legacy_tool_owner",
      "finalDisposition": "runtime uses runtime/src/tools/streaming-executor.ts instead"
    },
    {
      "path": "runtime/src/services/tools/toolExecution.ts",
      "category": "legacy_tool_owner",
      "finalDisposition": "runtime uses runtime/src/tools/execution.ts instead"
    },
    {
      "path": "runtime/src/services/tools/toolHooks.ts",
      "category": "legacy_tool_owner",
      "finalDisposition": "replace with runtime hook ownership and delete old owner"
    },
    {
      "path": "runtime/src/services/tools/toolOrchestration.ts",
      "category": "legacy_tool_owner",
      "finalDisposition": "runtime uses runtime/src/tools/orchestrator.ts instead"
    },
    {
      "path": "runtime/src/tools/AgentTool/**",
      "category": "legacy_agent_owner_family",
      "finalDisposition": "replace with runtime/src/agents/* ownership and delete old owner path"
    }
  ],
  "allowedNonRuntimeConsumers": [
    {
      "target": "runtime/src/services/compact/compactWarningHook.ts",
      "allowedImporters": [
        "runtime/src/components/TokenWarning.tsx"
      ],
      "reason": "warning UI hook surface"
    },
    {
      "target": "runtime/src/services/compact/compactWarningState.ts",
      "allowedImporters": [
        "runtime/src/commands/compact/compact.ts"
      ],
      "reason": "manual compact command support state"
    },
    {
      "target": "runtime/src/services/compact/grouping.ts",
      "allowedImporters": [],
      "reason": "no non-runtime consumer is approved in-tree today"
    }
  ],
  "ownershipRules": [
    "All live turns must converge on the same session bootstrap and turn kernel.",
    "Static checks reject new direct live-entrypoint imports from legacy owners, but they do not prove that the runtime is fully cut over.",
    "Helper files under runtime/src/services/compact are allowed only for the exact importer paths declared here.",
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
      "runtime/src/bin/agenc.ts",
      "runtime/src/bin/slash.ts",
      "runtime/src/tasks/LocalMainSessionTask.ts",
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
    "directImportExceptions": [
      {
        "importer": "runtime/src/tasks/LocalMainSessionTask.ts",
        "target": "runtime/src/query.ts",
        "severity": "warning",
        "reason": "known transitional background-session import until session ownership moves out of query.ts"
      },
      {
        "importer": "runtime/src/tasks/LocalMainSessionTask.ts",
        "target": "runtime/src/tools/AgentTool/loadAgentsDir.ts",
        "severity": "warning",
        "reason": "known transitional agent-definition import until delegate and background-session ownership converge"
      }
    ],
    "helperImportPolicies": [
      {
        "target": "runtime/src/services/compact/grouping.ts",
        "allowedImporters": [
          "runtime/src/llm/compact/compact.ts",
          "runtime/src/services/compact/compact.ts"
        ]
      },
      {
        "target": "runtime/src/services/compact/compactWarningHook.ts",
        "allowedImporters": [
          "runtime/src/components/TokenWarning.tsx"
        ]
      },
      {
        "target": "runtime/src/services/compact/compactWarningState.ts",
        "allowedImporters": [
          "runtime/src/commands/compact/compact.ts",
          "runtime/src/services/compact/compactWarningHook.ts",
          "runtime/src/services/compact/microCompact.ts"
        ]
      }
    ],
    "allowlistedFabricationSeams": [
      "runtime/src/bin/agenc.ts",
      "runtime/src/commands/compact.ts",
      "runtime/src/utils/forkedAgent.ts",
      "runtime/src/utils/hooks/execAgentHook.ts",
      "runtime/src/services/MagicDocs/magicDocs.ts",
      "runtime/src/tools/AgentTool/runAgent.ts"
    ]
  }
}
```
<!-- runtime-owner-manifest:json:end -->
