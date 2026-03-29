/**
 * Workstream 0 orchestration regression catalog and expected outcome schema.
 *
 * The source traces for these scenarios came from real runtime failures under
 * `~/.agenc/trace-payloads`, then were normalized into deterministic replay
 * fixtures under `runtime/benchmarks/v1/incidents`.
 *
 * @module
 */

import type { ReplayTaskStatus } from "./replay.js";
import type {
  WorkflowCompletionState,
  WorkflowDependencyStateKind,
  WorkflowResolutionSemantics,
} from "../workflow/completion-state.js";

export const ORCHESTRATION_EXPECTATION_SCHEMA_VERSION = 1 as const;

export interface OrchestrationRegressionCatalogEntry {
  scenarioId: string;
  title: string;
  category:
    | "workspace_root"
    | "allowlist"
    | "delegation_fallback"
    | "overdelegation"
    | "validation_false_positive"
    | "ungrounded_write"
    | "false_completion"
    | "workflow_contract"
    | "verification_state"
    | "provider_capability"
    | "retry_budget";
  fixtureBaseName: string;
  summary: string;
}

export interface OrchestrationExpectedReplay {
  taskPda: string;
  finalStatus: ReplayTaskStatus;
  completionState: WorkflowCompletionState;
  dependencyStateKind: WorkflowDependencyStateKind;
  resolutionSemantics: WorkflowResolutionSemantics;
  replayErrors: number;
  replayWarnings: number;
  policyViolations: number;
  verifierVerdicts: number;
}

export interface OrchestrationBaselineMetrics {
  turns: number;
  toolCalls: number;
  fallbackCount: number;
  spuriousSubagentCount: number;
  approvalCount: number;
  restartRecoverySuccess: boolean;
}

export interface OrchestrationRegressionExpectation {
  schemaVersion: typeof ORCHESTRATION_EXPECTATION_SCHEMA_VERSION;
  scenarioId: string;
  title: string;
  sourceTraceId: string;
  sourceArtifacts: string[];
  expectedReplay: OrchestrationExpectedReplay;
  baselineMetrics: OrchestrationBaselineMetrics;
}

export const ORCHESTRATION_REGRESSION_SCENARIOS: readonly OrchestrationRegressionCatalogEntry[] = [
  {
    scenarioId: "delegated_split_workspace_root",
    title: "Delegated child persists /workspace while tool layer reads host root",
    category: "workspace_root",
    fixtureBaseName: "delegated-split-workspace-root",
    summary:
      "Child execution kept /workspace as envelope truth while delegated reads were translated to the host workspace, causing required PLAN.md grounding to fail.",
  },
  {
    scenarioId: "wrong_workspace_root",
    title: "Delegated child resolves PLAN.md against umbrella root",
    category: "workspace_root",
    fixtureBaseName: "wrong-workspace-root",
    summary:
      "Child review read relative PLAN.md against /home/tetsuo/git/AgenC instead of the delegated workspace root.",
  },
  {
    scenarioId: "allowlist_access_denied",
    title: "Delegated read blocked by stale allowed-directory scope",
    category: "allowlist",
    fixtureBaseName: "allowlist-access-denied",
    summary:
      "Child had the correct absolute target path but filesystem policy still denied the read.",
  },
  {
    scenarioId: "delegation_fallback_dual_truth",
    title: "Delegation fallback reports completion while carrying failure semantics",
    category: "delegation_fallback",
    fixtureBaseName: "delegation-fallback-dual-truth",
    summary:
      "Parent step emitted delegation_fallback with outer completion semantics but inner validation failure.",
  },
  {
    scenarioId: "readonly_review_overdelegated",
    title: "Single-file PLAN.md review explodes into parallel subagents",
    category: "overdelegation",
    fixtureBaseName: "readonly-review-overdelegated",
    summary:
      "Planner spawned multiple review children for trivial shared-context work, then timed out blocked on synthesis.",
  },
  {
    scenarioId: "noop_success_rejected",
    title: "Grounded no-op write phase rejected for missing mutation evidence",
    category: "validation_false_positive",
    fixtureBaseName: "noop-success-rejected",
    summary:
      "Child correctly concluded the target was already satisfied, but validation still demanded file mutation evidence.",
  },
  {
    scenarioId: "ungrounded_writer_fabrication",
    title: "Writer fabricated current repo structure without grounded reads",
    category: "ungrounded_write",
    fixtureBaseName: "ungrounded-writer-fabrication",
    summary:
      "Write phase skipped PLAN.md grounding, used the wrong target-path form, and described files that did not exist.",
  },
  {
    scenarioId: "shell_stub_false_completion",
    title: "Shell implementation accepted despite explicit stubs and skipped verifier",
    category: "false_completion",
    fixtureBaseName: "shell-stub-false-completion",
    summary:
      "Implementation wrote explicit stub markers into required shell files, then the weak plan_only_execution gate still accepted the run as completed.",
  },
  {
    scenarioId: "reviewer_writer_contract_collapse",
    title: "Six reviewers collapse into one reviewer-writer hybrid step",
    category: "workflow_contract",
    fixtureBaseName: "reviewer-writer-contract-collapse",
    summary:
      "Required reviewer cardinality collapsed into a single mixed-role child, so the writer no longer consumed distinct reviewer artifacts.",
  },
  {
    scenarioId: "needs_verification_child_survives_parent",
    title: "Child needs_verification state survives to the parent verifier",
    category: "verification_state",
    fixtureBaseName: "needs-verification-child-survives-parent",
    summary:
      "A child completed enough work to satisfy dependencies but still required verifier closure, and the parent preserved that nonterminal state instead of coercing it to failure.",
  },
  {
    scenarioId: "followup_tool_contract_suppressed",
    title: "Follow-up routed tool contract is silently stripped on xAI",
    category: "provider_capability",
    fixtureBaseName: "followup-tool-contract-suppressed",
    summary:
      "A follow-up turn dropped required routed tools instead of failing closed when the preserved tool contract could not be honored.",
  },
  {
    scenarioId: "xai_route_mismatch_fail_open",
    title: "xAI multi-agent route accepts incompatible custom tools",
    category: "provider_capability",
    fixtureBaseName: "xai-route-mismatch-fail-open",
    summary:
      "Provider/tool/model incompatibility was allowed to execute instead of failing closed before the request was shaped.",
  },
  {
    scenarioId: "request_tree_budget_retry_reset",
    title: "Planner retries reset request-tree child budgets",
    category: "retry_budget",
    fixtureBaseName: "request-tree-budget-retry-reset",
    summary:
      "Planner/verifier retries recreated child-budget trackers and let the same request tree exceed its intended total child budget.",
  },
] as const;
