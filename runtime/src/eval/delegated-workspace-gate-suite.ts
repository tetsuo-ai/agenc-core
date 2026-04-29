import { readFile } from "node:fs/promises";
import path from "node:path";

import { ChatExecutor } from "../llm/chat-executor.js";
import { executeChatToLegacyResult } from "../llm/execute-chat.js";
import { createPromptEnvelope } from "../llm/prompt-envelope.js";
import { LLMTimeoutError } from "../llm/errors.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";
import { assessDelegationAdmission } from "../gateway/delegation-admission.js";
import { preflightDelegatedLocalFileScope } from "../gateway/delegated-scope-preflight.js";
import {
  buildLegacyDelegationExecutionContext,
} from "../utils/delegation-execution-context.js";
import {
  buildCanonicalDelegatedFilesystemScope,
} from "../workflow/delegated-filesystem-scope.js";
import { isPathWithinRoot } from "../workflow/path-normalization.js";
import { resolveWorkflowCompletionState } from "../workflow/completion-state.js";
import { TrajectoryReplayEngine } from "./replay.js";
import { parseTrajectoryTrace } from "./types.js";

export type PipelineDelegatedWorkspaceGateScenarioCategory =
  | "trace_replay"
  | "split_root_invariant"
  | "preflight_rejection"
  | "alias_migration_consistency"
  | "shared_artifact_writer_denial"
  | "degraded_provider_retry";

export type PipelineDelegatedWorkspaceGateExecutionMode =
  | "replay"
  | "runtime"
  | "policy";

export interface PipelineDelegatedWorkspaceGateScenarioArtifact {
  readonly scenarioId: string;
  readonly title: string;
  readonly category: PipelineDelegatedWorkspaceGateScenarioCategory;
  readonly mandatory: boolean;
  readonly executionMode: PipelineDelegatedWorkspaceGateExecutionMode;
  readonly passed: boolean;
  readonly falseCompleted: boolean;
  readonly observedOutcome: string;
  readonly expectedOutcome: string;
  readonly notes?: string;
}

export interface PipelineDelegatedWorkspaceGateArtifact {
  readonly scenarioCount: number;
  readonly mandatoryScenarioCount: number;
  readonly advisoryScenarioCount: number;
  readonly passingScenarios: number;
  readonly passRate: number;
  readonly mandatoryPassingScenarios: number;
  readonly mandatoryPassRate: number;
  readonly falseCompletedScenarios: number;
  readonly scenarios: readonly PipelineDelegatedWorkspaceGateScenarioArtifact[];
}

export interface PipelineDelegatedWorkspaceGateSuiteConfig {
  readonly incidentFixtureDir: string;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function collectScopePaths(scope: {
  readonly workspaceRoot?: string;
  readonly allowedReadRoots?: readonly string[];
  readonly allowedWriteRoots?: readonly string[];
  readonly requiredSourceArtifacts?: readonly string[];
  readonly targetArtifacts?: readonly string[];
}): readonly string[] {
  return [
    ...(scope.workspaceRoot ? [scope.workspaceRoot] : []),
    ...(scope.allowedReadRoots ?? []),
    ...(scope.allowedWriteRoots ?? []),
    ...(scope.requiredSourceArtifacts ?? []),
    ...(scope.targetArtifacts ?? []),
  ];
}

async function runDelegatedTraceReplayScenario(
  incidentFixtureDir: string,
): Promise<PipelineDelegatedWorkspaceGateScenarioArtifact> {
  const [rawTrace, rawExpected] = await Promise.all([
    readFile(
      path.join(incidentFixtureDir, "delegated-split-workspace-root.trace.json"),
      "utf8",
    ),
    readFile(
      path.join(incidentFixtureDir, "delegated-split-workspace-root.expected.json"),
      "utf8",
    ),
  ]);
  const trace = parseTrajectoryTrace(JSON.parse(rawTrace) as unknown);
  const expected = JSON.parse(rawExpected) as {
    expectedReplay: {
      taskPda: string;
      finalStatus: string;
      replayErrors: number;
      replayWarnings: number;
      policyViolations: number;
      verifierVerdicts: number;
    };
  };
  const replay = new TrajectoryReplayEngine({ strictMode: true }).replay(trace);
  const task = replay.tasks[expected.expectedReplay.taskPda];
  const observedOutcome = task?.status ?? "missing";
  return {
    scenarioId: "delegated_split_workspace_root_trace_replay",
    title: "Exact delegated split-root trace stays failed under deterministic replay",
    category: "trace_replay",
    mandatory: true,
    executionMode: "replay",
    passed:
      observedOutcome === expected.expectedReplay.finalStatus &&
      replay.errors.length === expected.expectedReplay.replayErrors &&
      replay.warnings.length === expected.expectedReplay.replayWarnings &&
      (task?.policyViolations ?? 0) === expected.expectedReplay.policyViolations &&
      (task?.verifierVerdicts ?? 0) === expected.expectedReplay.verifierVerdicts,
    falseCompleted: observedOutcome === "completed",
    observedOutcome,
    expectedOutcome: expected.expectedReplay.finalStatus,
    notes: `policyViolations=${task?.policyViolations ?? 0} verifierVerdicts=${task?.verifierVerdicts ?? 0}`,
  };
}

async function runNoSplitRootInvariantScenario(): Promise<PipelineDelegatedWorkspaceGateScenarioArtifact> {
  const hostWorkspaceRoot = "/home/tetsuo/git/AgenC/agenc-core";
  const scope = buildCanonicalDelegatedFilesystemScope({
    workspaceRoot: "/workspace",
    inheritedWorkspaceRoot: hostWorkspaceRoot,
    hostWorkspaceRoot,
    allowedReadRoots: ["/workspace"],
    allowedWriteRoots: ["/workspace/docs"],
    requiredSourceArtifacts: ["/workspace/TODO.MD"],
    targetArtifacts: ["/workspace/docs/AGENC.md"],
  });
  const scopePaths = collectScopePaths(scope);
  const aliasLeak = scopePaths.some(
    (entry) => entry === "/workspace" || entry.startsWith("/workspace/"),
  );
  const rootConsistent = scopePaths.every((entry) =>
    entry === hostWorkspaceRoot || isPathWithinRoot(entry, hostWorkspaceRoot)
  );
  return {
    scenarioId: "canonical_scope_no_split_root_invariant",
    title: "Canonical delegated scope removes alias/host split-root ambiguity",
    category: "split_root_invariant",
    mandatory: true,
    executionMode: "runtime",
    passed:
      scope.workspaceRoot === hostWorkspaceRoot &&
      aliasLeak === false &&
      rootConsistent,
    falseCompleted: false,
    observedOutcome:
      scope.workspaceRoot === hostWorkspaceRoot && rootConsistent
        ? "canonical_host_root"
        : "split_root_detected",
    expectedOutcome: "canonical_host_root",
    notes: `paths=${scopePaths.length} aliasLeak=${String(aliasLeak)}`,
  };
}

async function runPreflightImpossibleScopeScenario(): Promise<PipelineDelegatedWorkspaceGateScenarioArtifact> {
  const workspaceRoot = "/tmp/agenc-phase7-missing-workspace";
  const missingSource = `${workspaceRoot}/PLAN.md`;
  const result = preflightDelegatedLocalFileScope({
    workingDirectory: workspaceRoot,
    executionContext: {
      workspaceRoot,
      allowedReadRoots: [`${workspaceRoot}/docs`],
      allowedWriteRoots: [`${workspaceRoot}/docs`],
      requiredSourceArtifacts: [missingSource],
      targetArtifacts: [missingSource],
    },
  });
  const issueCodes = result.ok ? [] : result.issues.map((issue) => issue.code);
  return {
    scenarioId: "preflight_rejects_impossible_delegated_scope",
    title: "Spawn-time preflight rejects impossible delegated filesystem scope",
    category: "preflight_rejection",
    mandatory: true,
    executionMode: "runtime",
    passed:
      result.ok === false &&
      issueCodes.includes("required_source_outside_read_roots") &&
      issueCodes.includes("workspace_root_missing_for_required_sources") &&
      issueCodes.includes("required_source_missing"),
    falseCompleted: false,
    observedOutcome: result.ok ? "accepted" : issueCodes.join(","),
    expectedOutcome:
      "required_source_outside_read_roots,workspace_root_missing_for_required_sources,required_source_missing",
    notes: result.ok ? undefined : result.error,
  };
}

async function runAliasCompatMigrationScenario(): Promise<PipelineDelegatedWorkspaceGateScenarioArtifact> {
  const hostWorkspaceRoot = "/home/tetsuo/git/AgenC/agenc-core";
  const migrated = buildLegacyDelegationExecutionContext({
    contextRequirements: ["cwd=/workspace"],
    inheritedWorkspaceRoot: hostWorkspaceRoot,
    hostWorkspaceRoot,
    allowedReadRoots: ["/workspace"],
    allowedWriteRoots: ["/workspace"],
    requiredSourceArtifacts: ["/workspace/TODO.MD"],
    targetArtifacts: ["/workspace/prompts-for-agent.txt"],
  });
  const scopePaths = collectScopePaths({
    workspaceRoot: migrated?.workspaceRoot,
    allowedReadRoots: migrated?.allowedReadRoots,
    allowedWriteRoots: migrated?.allowedWriteRoots,
    requiredSourceArtifacts: migrated?.requiredSourceArtifacts,
    targetArtifacts: migrated?.targetArtifacts,
  });
  const aliasLeak = scopePaths.some(
    (entry) => entry === "/workspace" || entry.startsWith("/workspace/"),
  );
  const preflight = preflightDelegatedLocalFileScope({
    workingDirectory: migrated?.workspaceRoot,
    executionContext: migrated,
  });
  return {
    scenarioId: "legacy_alias_ingestion_persists_canonical_scope",
    title: "Legacy cwd=/workspace compatibility canonicalizes once and persists only host paths",
    category: "alias_migration_consistency",
    mandatory: true,
    executionMode: "runtime",
    passed:
      migrated?.compatibilitySource === "legacy_context_requirements" &&
      migrated?.workspaceRoot === hostWorkspaceRoot &&
      aliasLeak === false &&
      preflight.ok === true,
    falseCompleted: false,
    observedOutcome:
      migrated?.workspaceRoot === hostWorkspaceRoot && preflight.ok
        ? "canonicalized_once"
        : "alias_persisted",
    expectedOutcome: "canonicalized_once",
    notes: `compatibility=${migrated?.compatibilitySource ?? "missing"}`,
  };
}

async function runSharedArtifactWriterDenialScenario(): Promise<PipelineDelegatedWorkspaceGateScenarioArtifact> {
  const workspaceRoot = "/tmp/agenc-phase7-plan";
  const primaryArtifact = `${workspaceRoot}/PLAN.md`;
  const decision = assessDelegationAdmission({
    messageText:
      "Review PLAN.md in parallel and apply updates directly to the same file.",
    totalSteps: 3,
    synthesisSteps: 1,
    steps: [
      {
        name: "review_plan",
        objective: "Inspect PLAN.md for issues.",
        acceptanceCriteria: ["Read PLAN.md and report grounded issues."],
        requiredToolCapabilities: ["system.readFile"],
        contextRequirements: [],
        executionContext: {
          workspaceRoot,
          allowedReadRoots: [workspaceRoot],
          allowedWriteRoots: [workspaceRoot],
          requiredSourceArtifacts: [primaryArtifact],
          targetArtifacts: [primaryArtifact],
          effectClass: "read_only",
        },
        maxBudgetHint: "5m",
        canRunParallel: true,
      },
      {
        name: "rewrite_plan",
        objective: "Rewrite PLAN.md with the requested edits.",
        acceptanceCriteria: ["Update PLAN.md directly."],
        requiredToolCapabilities: ["system.writeFile"],
        contextRequirements: [],
        executionContext: {
          workspaceRoot,
          allowedReadRoots: [workspaceRoot],
          allowedWriteRoots: [workspaceRoot],
          requiredSourceArtifacts: [primaryArtifact],
          targetArtifacts: [primaryArtifact],
          effectClass: "filesystem_write",
        },
        maxBudgetHint: "10m",
        canRunParallel: true,
      },
      {
        name: "second_rewrite",
        objective: "Apply a second parallel rewrite to PLAN.md.",
        acceptanceCriteria: ["Also update PLAN.md directly."],
        requiredToolCapabilities: ["system.writeFile"],
        contextRequirements: [],
        executionContext: {
          workspaceRoot,
          allowedReadRoots: [workspaceRoot],
          allowedWriteRoots: [workspaceRoot],
          requiredSourceArtifacts: [primaryArtifact],
          targetArtifacts: [primaryArtifact],
          effectClass: "filesystem_write",
        },
        maxBudgetHint: "10m",
        canRunParallel: true,
      },
    ],
    edges: [],
    threshold: 0.5,
    maxFanoutPerTurn: 4,
    maxDepth: 4,
  });
  return {
    scenarioId: "shared_artifact_multi_writer_denied",
    title: "Shared-artifact multi-writer delegation is denied without real locking semantics",
    category: "shared_artifact_writer_denial",
    mandatory: true,
    executionMode: "policy",
    passed:
      decision.allowed === false &&
      decision.reason === "shared_artifact_writer_inline",
    falseCompleted: false,
    observedOutcome: decision.reason,
    expectedOutcome: "shared_artifact_writer_inline",
    notes: String(decision.diagnostics.sharedPrimaryArtifact ?? ""),
  };
}

async function runDegradedProviderRetryBrokenScopeScenario(): Promise<PipelineDelegatedWorkspaceGateScenarioArtifact> {
  const primary: LLMProvider = {
    name: "phase7-degraded-primary",
    chat: async () => {
      throw new LLMTimeoutError("phase7-degraded-primary", 5_000);
    },
    chatStream: async () => {
      throw new LLMTimeoutError("phase7-degraded-primary", 5_000);
    },
    healthCheck: async () => true,
  };
  const fallbackResponse: LLMResponse = {
    content:
      "Fallback provider responded, but the delegated workspace contract is still broken.",
    toolCalls: [],
    usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    model: "phase7-fallback-model",
    finishReason: "stop",
  };
  const fallback: LLMProvider = {
    name: "phase7-fallback",
    chat: async () => fallbackResponse,
    chatStream: async () => fallbackResponse,
    healthCheck: async () => true,
  };
  const executor = new ChatExecutor({
    providers: [primary, fallback],
  });
  const result = await executeChatToLegacyResult(executor, {
    message: {
      id: "phase7-degraded-scope-message",
      channel: "eval",
      senderId: "phase7",
      senderName: "Phase 7",
      sessionId: "phase7-degraded-scope",
      content: "Retry the delegated task after the provider times out.",
      timestamp: Date.now(),
      scope: "dm",
    },
    history: [],
    promptEnvelope: createPromptEnvelope("You are an evaluation harness."),
    sessionId: "phase7-degraded-scope",
  });
  const preflight = preflightDelegatedLocalFileScope({
    workingDirectory: "/tmp/agenc-phase7-retry",
    executionContext: {
      workspaceRoot: "/tmp/agenc-phase7-retry",
      allowedReadRoots: ["/tmp/agenc-phase7-retry/docs"],
      allowedWriteRoots: ["/tmp/agenc-phase7-retry/docs"],
      requiredSourceArtifacts: ["/tmp/agenc-phase7-retry/PLAN.md"],
      targetArtifacts: ["/tmp/agenc-phase7-retry/PLAN.md"],
    },
  });
  const completionState = resolveWorkflowCompletionState({
    stopReason: "completed",
    toolCalls: [],
    requiresVerification: true,
    verificationSatisfied: false,
  });
  return {
    scenarioId: "degraded_provider_retry_does_not_complete_broken_scope",
    title: "Provider fallback does not falsely complete a delegated task with broken canonical scope",
    category: "degraded_provider_retry",
    mandatory: true,
    executionMode: "runtime",
    passed:
      result.usedFallback === true &&
      preflight.ok === false &&
      completionState !== "completed",
    falseCompleted: completionState === "completed",
    observedOutcome: `${completionState}:${preflight.ok ? "preflight_ok" : "preflight_failed"}`,
    expectedOutcome: "needs_verification:preflight_failed",
    notes: preflight.ok ? undefined : preflight.error,
  };
}

export async function runDelegatedWorkspaceGateSuite(
  config: PipelineDelegatedWorkspaceGateSuiteConfig,
): Promise<PipelineDelegatedWorkspaceGateArtifact> {
  const scenarios = await Promise.all([
    runDelegatedTraceReplayScenario(config.incidentFixtureDir),
    runNoSplitRootInvariantScenario(),
    runPreflightImpossibleScopeScenario(),
    runAliasCompatMigrationScenario(),
    runSharedArtifactWriterDenialScenario(),
    runDegradedProviderRetryBrokenScopeScenario(),
  ]);
  const mandatoryScenarios = scenarios.filter((scenario) => scenario.mandatory);
  const passingScenarios = scenarios.filter((scenario) => scenario.passed).length;
  const mandatoryPassingScenarios = mandatoryScenarios.filter(
    (scenario) => scenario.passed,
  ).length;
  return {
    scenarioCount: scenarios.length,
    mandatoryScenarioCount: mandatoryScenarios.length,
    advisoryScenarioCount: scenarios.length - mandatoryScenarios.length,
    passingScenarios,
    passRate: ratio(passingScenarios, scenarios.length),
    mandatoryPassingScenarios,
    mandatoryPassRate: ratio(mandatoryPassingScenarios, mandatoryScenarios.length),
    falseCompletedScenarios: scenarios.filter((scenario) => scenario.falseCompleted)
      .length,
    scenarios,
  };
}
