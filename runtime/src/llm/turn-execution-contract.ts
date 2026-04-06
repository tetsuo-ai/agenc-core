import { basename } from "node:path";
import { createHash } from "node:crypto";

import type { ChatExecuteParams } from "./chat-executor-types.js";
import type {
  ActiveTaskContext,
  TurnExecutionContract,
} from "./turn-execution-contract-types.js";
import {
  buildArtifactTaskRuntimeRequirements,
  mergeArtifactTaskRequiredToolEvidence,
  resolveDirectArtifactTaskContract,
  resolveMessageScopedWorkspaceRoot,
  type ArtifactTaskContract,
} from "./chat-executor-artifact-task.js";
import {
  classifyPlannerPlanArtifactIntent,
  collectPlannerRequestSignals,
  extractPlannerArtifactTargets,
  extractPlannerSourceArtifactTargets,
  plannerRequestImplementsFromArtifact,
  requestExplicitlyRequestsDelegation,
  requestRequiresToolGroundedExecution,
  extractExplicitSubagentOrchestrationRequirements,
  isDialogueOnlyDirectTurnMessage,
  type PlannerPlanArtifactIntent,
} from "./chat-executor-planner.js";
import {
  specRequiresFileMutationEvidence,
  specRequiresMeaningfulWorkspaceEvidence,
  type DelegationContractSpec,
} from "../utils/delegation-validation.js";
import { isConcordiaSimulationTurnMessage } from "./chat-executor-turn-contracts.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import { createExecutionEnvelope } from "../workflow/execution-envelope.js";
import {
  normalizeArtifactPaths,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";
import { areDocumentationOnlyArtifacts } from "../workflow/artifact-paths.js";

const IMPLICIT_IMPLEMENTATION_TASK_RE =
  /\b(?:implement|implementation|scaffold|migrate|refactor|wire\s+up|hook\s+up|set\s+up|setup|build|create)\b[\s\S]{0,48}\b(?:project|service|api|endpoint|cli|daemon|shell|app|module|library|program|parser|compiler|database|workspace|repo(?:sitory)?|tests?|feature|workflow|tooling?)\b|\b(?:fix|repair|debug)\b[\s\S]{0,48}\b(?:bug|issue|error|failure|regression|crash|test|tests|build|compile|lint|typecheck|service|api|endpoint|module|file|workspace|repo(?:sitory)?)\b/i;
const EXPLANATION_ONLY_RE =
  /\b(?:explain|describe|outline|summarize|brainstorm|compare|review|walk\s+me\s+through|how\s+would|what\s+would)\b/i;
const PHASE_CONTINUATION_RE =
  /\b(?:phase|step|milestone|task)\s+[a-z0-9_.-]+\b/i;
const TASK_CONTINUATION_RE = /\b(?:continue|resume|finish|complete|implement|do|execute)\b/i;
const BUILD_VERIFICATION_RE =
  /\b(?:run|rerun|execute|verify|validated?|check|confirm|ensure|with|including)\b[\s\S]{0,32}\b(?:build|compile|typecheck|lint|tests?|testing|vitest|jest|pytest|ctest|cargo\s+test|go\s+test)\b|\b(?:build|compile|typecheck|lint)\s+(?:verification|checks?)\b|\b(?:tests?|testing|vitest|jest|pytest|ctest|cargo\s+test|go\s+test)\s+(?:verification|checks?|pass|passing|coverage)\b/i;
const BEHAVIOR_VERIFICATION_RE =
  /\b(?:run|rerun|execute|verify|validated?|check|confirm|ensure|with|including)\b[\s\S]{0,32}\b(?:behavior|behaviour|scenario|smoke(?:\s+tests?)?|integration|e2e|end-to-end|playtest)\b|\b(?:smoke|integration|e2e|end-to-end|play)\s*tests?\b|\bbehavior(?:al)?\s+(?:verification|checks?)\b/i;
const VERIFICATION_PATHISH_TOKEN_RE =
  /(?:^|(?<=\s))(?:@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+|@?[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+|\.{1,2}\/[A-Za-z0-9._\/-]+|\/[A-Za-z0-9._\/-]+)(?=$|\s)/g;
const DELEGATED_RESEARCH_RE =
  /\b(?:research|compare|citation|cite|browser|official\s+docs?|references?|survey|investigate|analy[sz]e|review|inspect|assess|evaluate)\b/i;
const DELEGATED_MUTATION_RE =
  /\b(?:write|author|edit|update|fix|patch|implement|create|scaffold|modify|rewrite)\b/i;

function stableHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

function normalizeArtifacts(
  artifacts: readonly string[] | undefined,
  workspaceRoot?: string,
): readonly string[] {
  return normalizeArtifactPaths(artifacts ?? [], workspaceRoot);
}

function buildContractFingerprint(payload: Record<string, unknown>): string {
  return stableHash(payload);
}

function resolvePredeclaredContract(params: {
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
  readonly runtimeWorkspaceRoot?: string;
  readonly activeTaskContext?: ActiveTaskContext;
}): TurnExecutionContract | undefined {
  const required = params.requiredToolEvidence;
  if (!required) {
    return undefined;
  }
  if (required.artifactTaskContract) {
    return buildArtifactUpdateTurnContract({
      artifactTaskContract: required.artifactTaskContract,
      taskLineageId: params.activeTaskContext?.taskLineageId,
    });
  }
  if (!required.verificationContract && !required.completionContract) {
    return undefined;
  }
  const workspaceRoot = normalizeWorkspaceRoot(
    required.verificationContract?.workspaceRoot ?? params.runtimeWorkspaceRoot,
  );
  const sourceArtifacts = normalizeArtifacts(
    required.verificationContract?.requiredSourceArtifacts ??
      required.verificationContract?.inputArtifacts,
    workspaceRoot,
  );
  const targetArtifacts = normalizeArtifacts(
    required.verificationContract?.targetArtifacts,
    workspaceRoot,
  );
  const completionContract =
    required.completionContract ?? required.verificationContract?.completionContract;
  const documentationOnly =
    completionContract?.placeholderTaxonomy === "documentation" &&
    (targetArtifacts.length === 0 || areDocumentationOnlyArtifacts(targetArtifacts));
  const turnClass = documentationOnly ? "artifact_update" : "workflow_implementation";
  const ownerMode = documentationOnly ? "artifact_owner" : "workflow_owner";
  const contractFingerprint = buildContractFingerprint({
    turnClass,
    ownerMode,
    workspaceRoot,
    sourceArtifacts,
    targetArtifacts,
    verificationMode: required.verificationContract?.verificationMode,
    completionContract,
  });
  return {
    version: 1,
    turnClass,
    ownerMode,
    workspaceRoot,
    sourceArtifacts,
    targetArtifacts,
    allowedToolNames: required.executionEnvelope?.allowedTools,
    delegationPolicy: documentationOnly ? "direct_owner" : "planner_allowed",
    verificationContract: required.verificationContract,
    completionContract,
    ...(documentationOnly
      ? { artifactTaskContract: required.artifactTaskContract }
      : {}),
    executionEnvelope: required.executionEnvelope,
    contractFingerprint,
    taskLineageId:
      params.activeTaskContext?.contractFingerprint === contractFingerprint
        ? params.activeTaskContext.taskLineageId
        : `task_${stableHash({ contractFingerprint, ownerMode, workspaceRoot })}`,
  };
}

function buildArtifactUpdateTurnContract(params: {
  readonly artifactTaskContract: ArtifactTaskContract;
  readonly taskLineageId?: string;
}): TurnExecutionContract {
  const runtimeRequirements = buildArtifactTaskRuntimeRequirements(
    params.artifactTaskContract,
  );
  const contractFingerprint = buildContractFingerprint({
    turnClass: "artifact_update",
    ownerMode: "artifact_owner",
    workspaceRoot: params.artifactTaskContract.workspaceRoot,
    sourceArtifacts: params.artifactTaskContract.sourceArtifacts,
    targetArtifacts: params.artifactTaskContract.targetArtifacts,
    operationMode: params.artifactTaskContract.operationMode,
    groundingMode: params.artifactTaskContract.groundingMode,
    completionContract: runtimeRequirements.completionContract,
  });
  return {
    version: 1,
    turnClass: "artifact_update",
    ownerMode: "artifact_owner",
    workspaceRoot: params.artifactTaskContract.workspaceRoot,
    sourceArtifacts: params.artifactTaskContract.sourceArtifacts,
    targetArtifacts: params.artifactTaskContract.targetArtifacts,
    allowedToolNames: params.artifactTaskContract.allowedToolNames,
    delegationPolicy: params.artifactTaskContract.delegationPolicy,
    verificationContract: runtimeRequirements.verificationContract,
    completionContract: runtimeRequirements.completionContract,
    artifactTaskContract: params.artifactTaskContract,
    executionEnvelope: runtimeRequirements.executionEnvelope,
    contractFingerprint,
    taskLineageId:
      params.taskLineageId ??
      `task_${stableHash({
        targetArtifacts: params.artifactTaskContract.targetArtifacts,
        contractFingerprint,
      })}`,
  };
}

function collectDelegationSpecText(spec: DelegationContractSpec): string {
  return [
    spec.task,
    spec.objective,
    spec.parentRequest,
    spec.inputContract,
    ...(spec.acceptanceCriteria ?? []),
    ...(spec.requiredToolCapabilities ?? []),
    ...(spec.tools ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

function resolveDelegationSpecTurnContract(params: {
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
  readonly runtimeWorkspaceRoot?: string;
  readonly activeTaskContext?: ActiveTaskContext;
}): TurnExecutionContract | undefined {
  const spec = params.requiredToolEvidence?.delegationSpec;
  if (!spec) {
    return undefined;
  }

  const executionContext = spec.executionContext;
  const workspaceRoot = normalizeWorkspaceRoot(
    executionContext?.workspaceRoot ?? params.runtimeWorkspaceRoot,
  );
  const sourceArtifacts = normalizeArtifacts(
    executionContext?.requiredSourceArtifacts ?? executionContext?.inputArtifacts,
    workspaceRoot,
  );
  const targetArtifacts = normalizeArtifacts(
    executionContext?.targetArtifacts ?? spec.ownedArtifacts,
    workspaceRoot,
  );
  const allowedToolNames = executionContext?.allowedTools;
  const specText = collectDelegationSpecText(spec);
  const requiresMutation =
    specRequiresFileMutationEvidence(spec) ||
    DELEGATED_MUTATION_RE.test(specText) ||
    targetArtifacts.length > 0 ||
    executionContext?.effectClass === "filesystem_write" ||
    executionContext?.effectClass === "filesystem_scaffold" ||
    executionContext?.stepKind === "delegated_write" ||
    executionContext?.stepKind === "delegated_scaffold";
  const researchLike =
    !requiresMutation &&
    (DELEGATED_RESEARCH_RE.test(specText) ||
      (spec.requiredToolCapabilities ?? []).some((capability) =>
        /browser|research|citation|docs?|search/i.test(capability),
      ) ||
      executionContext?.stepKind === "delegated_research" ||
      executionContext?.stepKind === "delegated_review");

  const turnClass = researchLike ? "research" : "workflow_implementation";
  const ownerMode = researchLike ? "research_owner" : "workflow_owner";
  const completionContract =
    executionContext?.completionContract ??
    (researchLike
      ? {
          taskClass: "review_required" as const,
          placeholdersAllowed: false,
          partialCompletionAllowed: false,
          placeholderTaxonomy: targetArtifacts.length > 0 && areDocumentationOnlyArtifacts(targetArtifacts)
            ? "documentation" as const
            : "implementation" as const,
        }
      : resolveImplementationCompletionContract(specText));
  const verificationMode =
    executionContext?.verificationMode ??
    (researchLike
      ? "grounded_read"
      : specRequiresMeaningfulWorkspaceEvidence(spec)
        ? "conditional_mutation"
        : "mutation_required");
  const stepKind =
    executionContext?.stepKind ??
    (researchLike
      ? "delegated_research"
      : targetArtifacts.length === 0
        ? "delegated_write"
        : "delegated_write");
  const verificationContract =
    workspaceRoot ||
    sourceArtifacts.length > 0 ||
    targetArtifacts.length > 0 ||
    (spec.acceptanceCriteria?.length ?? 0) > 0 ||
    executionContext?.verificationMode ||
    executionContext?.stepKind ||
    executionContext?.completionContract
      ? {
          workspaceRoot,
          ...(sourceArtifacts.length > 0 ? { inputArtifacts: sourceArtifacts } : {}),
          ...(sourceArtifacts.length > 0
            ? { requiredSourceArtifacts: sourceArtifacts }
            : {}),
          ...(targetArtifacts.length > 0 ? { targetArtifacts } : {}),
          ...(spec.acceptanceCriteria?.length
            ? { acceptanceCriteria: spec.acceptanceCriteria }
            : {}),
          verificationMode,
          stepKind,
          completionContract,
        }
      : undefined;
  const executionEnvelope = createExecutionEnvelope({
    workspaceRoot,
    allowedReadRoots: workspaceRoot ? [workspaceRoot] : [],
    allowedWriteRoots: workspaceRoot ? [workspaceRoot] : [],
    allowedTools: allowedToolNames,
    ...(sourceArtifacts.length > 0 ? { inputArtifacts: sourceArtifacts } : {}),
    ...(sourceArtifacts.length > 0
      ? { requiredSourceArtifacts: sourceArtifacts }
      : {}),
    ...(targetArtifacts.length > 0 ? { targetArtifacts } : {}),
    effectClass:
      executionContext?.effectClass ??
      (researchLike ? "read_only" : targetArtifacts.length > 0 ? "filesystem_write" : "mixed"),
    verificationMode,
    stepKind,
    role: executionContext?.role,
    artifactRelations: executionContext?.artifactRelations,
    completionContract,
    fallbackPolicy: executionContext?.fallbackPolicy ?? "fail_request",
    resumePolicy: executionContext?.resumePolicy,
    approvalProfile:
      executionContext?.approvalProfile ??
      (researchLike ? "read_only" : targetArtifacts.length > 0 ? "filesystem_write" : "inherit"),
  });
  const contractFingerprint = buildContractFingerprint({
    turnClass,
    ownerMode,
    workspaceRoot,
    sourceArtifacts,
    targetArtifacts,
    verificationMode,
    stepKind,
    completionContract,
    allowedToolNames,
  });
  return {
    version: 1,
    turnClass,
    ownerMode,
    workspaceRoot,
    sourceArtifacts,
    targetArtifacts,
    allowedToolNames,
    delegationPolicy: researchLike ? "forbid" : "planner_allowed",
    verificationContract,
    completionContract,
    executionEnvelope,
    contractFingerprint,
    taskLineageId:
      params.activeTaskContext?.contractFingerprint === contractFingerprint
        ? params.activeTaskContext.taskLineageId
        : `task_${stableHash({ contractFingerprint, ownerMode, workspaceRoot })}`,
  };
}

function messageMentionsArtifact(
  messageText: string,
  activeTaskContext: ActiveTaskContext,
): boolean {
  const lowered = messageText.toLowerCase();
  if (
    activeTaskContext.displayArtifact &&
    lowered.includes(activeTaskContext.displayArtifact.toLowerCase())
  ) {
    return true;
  }
  return [...activeTaskContext.sourceArtifacts, ...activeTaskContext.targetArtifacts].some(
    (artifact) =>
      lowered.includes(artifact.toLowerCase()) ||
      lowered.includes(basename(artifact).toLowerCase()),
  );
}

function shouldContinueActiveTask(params: {
  readonly messageText: string;
  readonly activeTaskContext?: ActiveTaskContext;
}): boolean {
  const activeTaskContext = params.activeTaskContext;
  if (!activeTaskContext) {
    return false;
  }
  if (messageMentionsArtifact(params.messageText, activeTaskContext)) {
    return true;
  }
  if (PHASE_CONTINUATION_RE.test(params.messageText)) {
    return true;
  }
  return TASK_CONTINUATION_RE.test(params.messageText);
}

function resolveWorkflowImplementationRequested(params: {
  readonly messageText: string;
  readonly artifactIntent: PlannerPlanArtifactIntent;
  readonly activeTaskContext?: ActiveTaskContext;
}): boolean {
  if (
    params.artifactIntent === "edit_artifact" ||
    params.artifactIntent === "grounded_plan_generation"
  ) {
    return false;
  }
  if (isDialogueOnlyDirectTurnMessage(params.messageText)) {
    return false;
  }
  if (plannerRequestImplementsFromArtifact(params.messageText)) {
    return true;
  }
  if (
    EXPLANATION_ONLY_RE.test(params.messageText) &&
    !PHASE_CONTINUATION_RE.test(params.messageText)
  ) {
    return false;
  }
  if (shouldContinueActiveTask(params)) {
    return true;
  }
  const signals = collectPlannerRequestSignals(params.messageText, []);
  return signals.hasImplementationScopeCue || IMPLICIT_IMPLEMENTATION_TASK_RE.test(params.messageText);
}

function normalizeVerificationIntentText(messageText: string): string {
  return messageText.replace(VERIFICATION_PATHISH_TOKEN_RE, " ");
}

function resolveImplementationCompletionContract(
  messageText: string,
): ImplementationCompletionContract {
  const verificationIntentText = normalizeVerificationIntentText(messageText);
  if (BEHAVIOR_VERIFICATION_RE.test(verificationIntentText)) {
    return {
      taskClass: "behavior_required",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "implementation",
    };
  }
  if (BUILD_VERIFICATION_RE.test(verificationIntentText)) {
    return {
      taskClass: "build_required",
      placeholdersAllowed: false,
      partialCompletionAllowed: false,
      placeholderTaxonomy: "implementation",
    };
  }
  return {
    taskClass: "artifact_only",
    placeholdersAllowed: false,
    partialCompletionAllowed: false,
    placeholderTaxonomy: "implementation",
  };
}

function resolveWorkflowSourceArtifacts(params: {
  readonly messageText: string;
  readonly workspaceRoot?: string;
  readonly activeTaskContext?: ActiveTaskContext;
  readonly explicitArtifactTargets: readonly string[];
  readonly explicitSourceArtifactTargets: readonly string[];
}): readonly string[] {
  const explicitSourceArtifacts = normalizeArtifacts(
    params.explicitSourceArtifactTargets,
    params.workspaceRoot,
  );
  if (explicitSourceArtifacts.length > 0) {
    return explicitSourceArtifacts;
  }
  if (shouldContinueActiveTask(params)) {
    return normalizeArtifacts(
      params.activeTaskContext?.sourceArtifacts,
      params.workspaceRoot,
    );
  }
  return [];
}

function resolveWorkflowTargetArtifacts(params: {
  readonly messageText: string;
  readonly workspaceRoot?: string;
  readonly activeTaskContext?: ActiveTaskContext;
  readonly explicitArtifactTargets: readonly string[];
  readonly explicitSourceArtifactTargets: readonly string[];
}): readonly string[] {
  const explicitTargets = normalizeArtifacts(
    params.explicitArtifactTargets.filter(
      (target) => !params.explicitSourceArtifactTargets.includes(target),
    ),
    params.workspaceRoot,
  );
  if (explicitTargets.length > 0) {
    return explicitTargets;
  }
  if (!shouldContinueActiveTask(params)) {
    return [];
  }
  return normalizeArtifacts(
    params.activeTaskContext?.targetArtifacts,
    params.workspaceRoot,
  );
}

function buildWorkflowImplementationContract(params: {
  readonly messageText: string;
  readonly workspaceRoot?: string;
  readonly activeTaskContext?: ActiveTaskContext;
}): TurnExecutionContract {
  const explicitArtifactTargets = extractPlannerArtifactTargets(params.messageText);
  const explicitSourceArtifactTargets = extractPlannerSourceArtifactTargets(
    params.messageText,
  );
  const workspaceRoot = resolveMessageScopedWorkspaceRoot({
    messageText: params.messageText,
    workspaceRoot: params.workspaceRoot,
    explicitArtifactTargets: [
      ...explicitArtifactTargets,
      ...explicitSourceArtifactTargets,
    ],
  });
  const sourceArtifacts = resolveWorkflowSourceArtifacts({
    messageText: params.messageText,
    workspaceRoot,
    activeTaskContext: params.activeTaskContext,
    explicitArtifactTargets,
    explicitSourceArtifactTargets,
  });
  const explicitTargetArtifacts = resolveWorkflowTargetArtifacts({
    messageText: params.messageText,
    workspaceRoot,
    activeTaskContext: params.activeTaskContext,
    explicitArtifactTargets,
    explicitSourceArtifactTargets,
  });
  const implementFromArtifactRequest =
    explicitSourceArtifactTargets.length > 0 &&
    plannerRequestImplementsFromArtifact(params.messageText);
  const targetArtifacts =
    implementFromArtifactRequest &&
    explicitTargetArtifacts.length === 0 &&
    workspaceRoot
      ? [workspaceRoot]
      : explicitTargetArtifacts;
  const completionContract = resolveImplementationCompletionContract(
    params.messageText,
  );
  const verificationContract: WorkflowVerificationContract | undefined = workspaceRoot
    ? {
        workspaceRoot,
        ...(sourceArtifacts.length > 0 ? { inputArtifacts: sourceArtifacts } : {}),
        ...(sourceArtifacts.length > 0
          ? { requiredSourceArtifacts: sourceArtifacts }
          : {}),
        ...(targetArtifacts.length > 0 ? { targetArtifacts } : {}),
        verificationMode: "mutation_required",
        completionContract,
      }
    : undefined;
  const executionEnvelope = createExecutionEnvelope({
    workspaceRoot,
    allowedReadRoots: workspaceRoot ? [workspaceRoot] : [],
    allowedWriteRoots: workspaceRoot ? [workspaceRoot] : [],
    ...(sourceArtifacts.length > 0 ? { inputArtifacts: sourceArtifacts } : {}),
    ...(sourceArtifacts.length > 0
      ? { requiredSourceArtifacts: sourceArtifacts }
      : {}),
    ...(targetArtifacts.length > 0 ? { targetArtifacts } : {}),
    effectClass: "filesystem_write",
    verificationMode: "mutation_required",
    completionContract,
    fallbackPolicy: "fail_request",
    approvalProfile: "filesystem_write",
  });
  const contractFingerprint = buildContractFingerprint({
    turnClass: "workflow_implementation",
    ownerMode: "workflow_owner",
    workspaceRoot,
    sourceArtifacts,
    targetArtifacts,
    completionContract,
  });
  return {
    version: 1,
    turnClass: "workflow_implementation",
    ownerMode: "workflow_owner",
    workspaceRoot,
    sourceArtifacts,
    targetArtifacts,
    delegationPolicy: "planner_allowed",
    verificationContract,
    completionContract,
    executionEnvelope,
    contractFingerprint,
    taskLineageId:
      params.activeTaskContext?.contractFingerprint === contractFingerprint
        ? params.activeTaskContext.taskLineageId
        : `task_${stableHash({
            workspaceRoot,
            sourceArtifacts,
            targetArtifacts,
            contractFingerprint,
          })}`,
    ...(workspaceRoot
      ? {}
      : {
          invalidReason:
            "Implementation-class execution requires a resolved workspace root before model or tool execution.",
        }),
  };
}

export function resolveTurnExecutionContract(params: {
  readonly message: ChatExecuteParams["message"];
  readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
}): TurnExecutionContract {
  const messageText =
    typeof params.message.content === "string"
      ? params.message.content
      : params.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(" ");
  const runtimeWorkspaceRoot = normalizeWorkspaceRoot(
    params.runtimeContext?.workspaceRoot,
  );
  const activeTaskContext = params.runtimeContext?.activeTaskContext;
  if (isConcordiaSimulationTurnMessage(params.message)) {
    const contractFingerprint = buildContractFingerprint({
      turnClass: "concordia_simulation",
      ownerMode: "concordia_owner",
      workspaceRoot: runtimeWorkspaceRoot,
    });
    return {
      version: 1,
      turnClass: "concordia_simulation",
      ownerMode: "concordia_owner",
      workspaceRoot: runtimeWorkspaceRoot,
      sourceArtifacts: [],
      targetArtifacts: [],
      delegationPolicy: "planner_allowed",
      contractFingerprint,
      taskLineageId: `task_${stableHash({
        contractFingerprint,
        workspaceRoot: runtimeWorkspaceRoot,
      })}`,
    };
  }

  const explicitArtifactTargets = extractPlannerArtifactTargets(messageText);
  const explicitSourceArtifactTargets = extractPlannerSourceArtifactTargets(
    messageText,
  );
  const artifactIntent = classifyPlannerPlanArtifactIntent(messageText);
  const explicitDelegationRequested = requestExplicitlyRequestsDelegation(messageText);
  const explicitSubagentOrchestrationRequested =
    extractExplicitSubagentOrchestrationRequirements(messageText) !== undefined;
  const artifactTaskContract = resolveDirectArtifactTaskContract({
    messageText,
    workspaceRoot: runtimeWorkspaceRoot,
    explicitArtifactTargets,
    explicitSourceArtifactTargets,
    artifactIntent,
    explicitDelegationRequested,
    explicitSubagentOrchestrationRequested,
    hasBlockingRuntimeContract: false,
  });
  if (artifactTaskContract) {
    return buildArtifactUpdateTurnContract({
      artifactTaskContract,
      taskLineageId:
        shouldContinueActiveTask({ messageText, activeTaskContext })
          ? activeTaskContext?.taskLineageId
          : undefined,
    });
  }

  const predeclaredDelegationContract = resolveDelegationSpecTurnContract({
    requiredToolEvidence: params.requiredToolEvidence,
    runtimeWorkspaceRoot,
    activeTaskContext,
  });
  if (predeclaredDelegationContract) {
    return predeclaredDelegationContract;
  }

  if (isDialogueOnlyDirectTurnMessage(messageText)) {
    const contractFingerprint = buildContractFingerprint({
      turnClass: "dialogue",
      ownerMode: "none",
      workspaceRoot: runtimeWorkspaceRoot,
    });
    return {
      version: 1,
      turnClass: "dialogue",
      ownerMode: "none",
      workspaceRoot: runtimeWorkspaceRoot,
      sourceArtifacts: [],
      targetArtifacts: [],
      delegationPolicy: "forbid",
      contractFingerprint,
      taskLineageId: `task_${stableHash({
        contractFingerprint,
        workspaceRoot: runtimeWorkspaceRoot,
      })}`,
    };
  }

  const predeclared = resolvePredeclaredContract({
    requiredToolEvidence: params.requiredToolEvidence,
    runtimeWorkspaceRoot,
    activeTaskContext,
  });
  if (predeclared) {
    return predeclared;
  }

  if (
    resolveWorkflowImplementationRequested({
      messageText,
      artifactIntent,
      activeTaskContext,
    })
  ) {
    return buildWorkflowImplementationContract({
      messageText,
      workspaceRoot: runtimeWorkspaceRoot,
      activeTaskContext,
    });
  }

  const contractFingerprint = buildContractFingerprint({
    turnClass: "dialogue",
    ownerMode: "none",
    workspaceRoot: runtimeWorkspaceRoot,
  });
  return {
    version: 1,
    turnClass: "dialogue",
    ownerMode: "none",
    workspaceRoot: runtimeWorkspaceRoot,
    sourceArtifacts: [],
    targetArtifacts: [],
    delegationPolicy: "forbid",
    contractFingerprint,
    taskLineageId: `task_${stableHash({
      contractFingerprint,
      workspaceRoot: runtimeWorkspaceRoot,
    })}`,
  };
}

export function mergeTurnExecutionRequiredToolEvidence(params: {
  readonly base: ChatExecuteParams["requiredToolEvidence"];
  readonly turnExecutionContract: TurnExecutionContract;
}): NonNullable<ChatExecuteParams["requiredToolEvidence"]> | undefined {
  if (params.turnExecutionContract.turnClass === "artifact_update") {
    return params.turnExecutionContract.artifactTaskContract
      ? mergeArtifactTaskRequiredToolEvidence({
          base: params.base,
          artifactTaskContract: params.turnExecutionContract.artifactTaskContract,
        })
      : params.base;
  }
  if (params.turnExecutionContract.turnClass === "workflow_implementation") {
    return {
      maxCorrectionAttempts: Math.max(
        0,
        Math.floor(params.base?.maxCorrectionAttempts ?? 1),
      ),
      delegationSpec: params.base?.delegationSpec,
      unsafeBenchmarkMode: params.base?.unsafeBenchmarkMode,
      verificationContract:
        params.turnExecutionContract.verificationContract ??
        params.base?.verificationContract,
      completionContract:
        params.turnExecutionContract.completionContract ??
        params.base?.completionContract,
      executionEnvelope:
        params.turnExecutionContract.executionEnvelope ??
        params.base?.executionEnvelope,
    };
  }
  return params.base;
}

export function deriveActiveTaskContext(
  contract: TurnExecutionContract,
): ActiveTaskContext | undefined {
  if (
    contract.turnClass !== "artifact_update" &&
    contract.turnClass !== "workflow_implementation"
  ) {
    return undefined;
  }
  return {
    version: 1,
    taskLineageId: contract.taskLineageId,
    contractFingerprint: contract.contractFingerprint,
    turnClass: contract.turnClass,
    ownerMode: contract.ownerMode,
    workspaceRoot: contract.workspaceRoot,
    sourceArtifacts: contract.sourceArtifacts,
    targetArtifacts: contract.targetArtifacts,
    displayArtifact:
      contract.artifactTaskContract?.displayTargetArtifact ??
      contract.sourceArtifacts[0] ??
      contract.targetArtifacts[0] ??
      undefined,
  };
}
