import { basename as pathBasename } from "node:path";

import type { ChatExecuteParams } from "./chat-executor-types.js";
import type { PlannerPlanArtifactIntent } from "./chat-executor-planner.js";
import { areDocumentationOnlyArtifacts } from "../workflow/artifact-paths.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import type { ExecutionEnvelope } from "../workflow/execution-envelope.js";
import { createExecutionEnvelope } from "../workflow/execution-envelope.js";
import {
  normalizeArtifactPaths,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";
import { textRequiresWorkspaceGroundedArtifactUpdate } from "../workflow/workspace-inspection-evidence.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";

export type ArtifactTaskOperationMode =
  | "review_only"
  | "review_and_update_if_needed"
  | "update_in_place"
  | "create_new_artifact"
  | "spec_to_implementation";

export type ArtifactTaskGroundingMode =
  | "artifact_only"
  | "artifact_plus_workspace";

export type ArtifactTaskDelegationPolicy = "direct_owner" | "planner_allowed";

export interface ArtifactTaskContract {
  readonly targetArtifacts: readonly string[];
  readonly sourceArtifacts: readonly string[];
  readonly workspaceRoot?: string;
  readonly operationMode: ArtifactTaskOperationMode;
  readonly groundingMode: ArtifactTaskGroundingMode;
  readonly delegationPolicy: ArtifactTaskDelegationPolicy;
  readonly allowedToolNames: readonly string[];
  readonly displayTargetArtifact: string;
  readonly artifactKind: "documentation";
  readonly acceptanceCriteria: readonly string[];
}

export interface ArtifactTaskRuntimeRequirements {
  readonly verificationContract: WorkflowVerificationContract;
  readonly completionContract: ImplementationCompletionContract;
  readonly executionEnvelope: ExecutionEnvelope;
}

const DIRECT_ARTIFACT_OWNER_TOOL_NAMES = [
  "system.readFile",
  "system.listDir",
  "system.stat",
  "desktop.text_editor",
  "system.writeFile",
  "system.appendFile",
] as const;

const EXPLICIT_ARTIFACT_EXECUTION_STRUCTURE_RE =
  /\b(?:parallel|phase(?:s)?\b|pass(?:es)?\b|stage(?:s)?\b|step(?:s)?\b|phase\s+by\s+phase|one\s+phase\s+at\s+a\s+time|split\s+(?:the\s+)?(?:work|update|rewrite)|break\s+(?:the\s+)?(?:work|update|rewrite)|separate\s+(?:the\s+)?(?:work|update|rewrite)|then\s+(?:merge|synthesize|combine))\b/i;
const CONDITIONAL_ARTIFACT_UPDATE_RE =
  /\b(?:if needed|if necessary|if there (?:are|is) any|if missing|if outdated|if incorrect|if wrong|whatever is missing|what is missing)\b/i;
const EXPLICIT_ARTIFACT_CREATE_RE =
  /\b(?:create|generate|draft|write|produce|turn|convert|transform|expand)\b/i;
const EXPLICIT_ARTIFACT_REVIEW_ONLY_RE =
  /\b(?:review|read through|inspect|analy(?:s|z)e|assess|evaluate|check|look at|look through|audit)\b/i;

function requestExplicitlyPrescribesArtifactExecutionStructure(
  messageText: string,
): boolean {
  return EXPLICIT_ARTIFACT_EXECUTION_STRUCTURE_RE.test(messageText);
}

const MESSAGE_WORKSPACE_ROOT_CUE_RE =
  /\b(?:in|under|within|inside)\s+((?:\.{1,2}\/|\/)[A-Za-z0-9._\/-]+)\b(?:\s+only)?/i;

function extractMessageWorkspaceRootCue(messageText: string): string | undefined {
  const match = messageText.match(MESSAGE_WORKSPACE_ROOT_CUE_RE);
  return normalizeWorkspaceRoot(match?.[1]);
}

export function resolveMessageScopedWorkspaceRoot(params: {
  readonly messageText: string;
  readonly workspaceRoot?: string | null;
  readonly explicitArtifactTargets?: readonly string[];
}): string | undefined {
  const explicitArtifactTargets = params.explicitArtifactTargets ?? [];
  const relativeTargetsOnly =
    explicitArtifactTargets.length > 0 &&
    explicitArtifactTargets.every((target) => !target.includes("/"));
  const messageWorkspaceRoot = extractMessageWorkspaceRootCue(params.messageText);
  if (relativeTargetsOnly && messageWorkspaceRoot) {
    return messageWorkspaceRoot;
  }
  return normalizeWorkspaceRoot(params.workspaceRoot) ?? messageWorkspaceRoot;
}

function deriveArtifactTaskWorkspaceRoot(params: {
  readonly messageText: string;
  readonly workspaceRoot?: string | null;
  readonly explicitArtifactTargets: readonly string[];
}): string | undefined {
  return resolveMessageScopedWorkspaceRoot({
    messageText: params.messageText,
    workspaceRoot: params.workspaceRoot,
    explicitArtifactTargets: params.explicitArtifactTargets,
  });
}

function normalizeArtifactIdentity(value: string): string {
  return value.trim().replace(/^@+/, "").replace(/\\/g, "/").toLowerCase();
}

function resolveArtifactTaskArtifacts(params: {
  readonly workspaceRoot?: string;
  readonly explicitArtifactTargets: readonly string[];
  readonly explicitSourceArtifactTargets: readonly string[];
}): {
  readonly sourceArtifacts: readonly string[];
  readonly targetArtifacts: readonly string[];
  readonly displayTargetArtifact: string;
} | undefined {
  const normalizedTargets = normalizeArtifactPaths(
    params.explicitArtifactTargets,
    params.workspaceRoot,
  );
  if (normalizedTargets.length === 0) {
    return undefined;
  }
  const explicitSourceKeys = new Set(
    params.explicitSourceArtifactTargets.map(normalizeArtifactIdentity),
  );
  const explicitTargetPairs = params.explicitArtifactTargets
    .map((display, index) => ({
      display,
      normalized: normalizedTargets[index],
      source: explicitSourceKeys.has(normalizeArtifactIdentity(display)),
    }))
    .filter(
      (entry): entry is { display: string; normalized: string; source: boolean } =>
        typeof entry.normalized === "string",
    );
  const normalizedSourceArtifacts = normalizeArtifactPaths(
    params.explicitSourceArtifactTargets,
    params.workspaceRoot,
  );
  let targetArtifacts = explicitTargetPairs
    .filter((entry) => !entry.source)
    .map((entry) => entry.normalized);
  if (targetArtifacts.length === 0) {
    if (normalizedTargets.length === 1) {
      targetArtifacts = [normalizedTargets[0]!];
    } else {
      return undefined;
    }
  }
  targetArtifacts = [...new Set(targetArtifacts)];
  if (targetArtifacts.length !== 1) {
    return undefined;
  }
  let sourceArtifacts = normalizedSourceArtifacts.filter(
    (artifact) => artifact !== targetArtifacts[0],
  );
  if (sourceArtifacts.length === 0) {
    sourceArtifacts = [targetArtifacts[0]!];
  }
  const displayTargetArtifact =
    explicitTargetPairs.find(
      (entry) => entry.normalized === targetArtifacts[0] && !entry.source,
    )?.display ?? params.explicitArtifactTargets[0] ?? targetArtifacts[0]!;
  return {
    sourceArtifacts: [...new Set(sourceArtifacts)],
    targetArtifacts,
    displayTargetArtifact,
  };
}

function resolveArtifactTaskOperationMode(params: {
  readonly messageText: string;
  readonly artifactIntent: PlannerPlanArtifactIntent;
  readonly sourceArtifacts: readonly string[];
  readonly targetArtifacts: readonly string[];
}): ArtifactTaskOperationMode {
  const hasDistinctTarget = params.targetArtifacts.some(
    (artifact) => !params.sourceArtifacts.includes(artifact),
  );
  if (hasDistinctTarget || params.artifactIntent === "grounded_plan_generation") {
    return "create_new_artifact";
  }
  if (
    CONDITIONAL_ARTIFACT_UPDATE_RE.test(params.messageText) ||
    textRequiresWorkspaceGroundedArtifactUpdate(params.messageText)
  ) {
    return "review_and_update_if_needed";
  }
  if (
    EXPLICIT_ARTIFACT_REVIEW_ONLY_RE.test(params.messageText) &&
    !EXPLICIT_ARTIFACT_CREATE_RE.test(params.messageText)
  ) {
    return "review_only";
  }
  return "update_in_place";
}

function buildArtifactTaskAcceptanceCriteria(params: {
  readonly displayTargetArtifact: string;
  readonly operationMode: ArtifactTaskOperationMode;
}): readonly string[] {
  const targetLabel =
    pathBasename(params.displayTargetArtifact) || params.displayTargetArtifact;
  switch (params.operationMode) {
    case "create_new_artifact":
      return [
        `${targetLabel} is materialized from the declared documentation sources and reflects grounded workspace evidence when the request asks to close gaps or missing details.`,
      ];
    case "review_only":
      return [
        `${targetLabel} review findings are grounded in the declared artifact and any required workspace inspection evidence.`,
      ];
    case "review_and_update_if_needed":
      return [
        `${targetLabel} is updated in place only when needed, or the result explicitly reports that no edits were required.`,
      ];
    case "update_in_place":
      return [
        `${targetLabel} is updated in place and the resulting mutation stays within the declared documentation target.`,
      ];
    default:
      return [
        `${targetLabel} is updated according to the declared documentation contract.`,
      ];
  }
}

export function resolveDirectArtifactTaskContract(params: {
  readonly messageText: string;
  readonly workspaceRoot?: string | null;
  readonly explicitArtifactTargets: readonly string[];
  readonly explicitSourceArtifactTargets: readonly string[];
  readonly artifactIntent: PlannerPlanArtifactIntent;
  readonly explicitDelegationRequested: boolean;
  readonly explicitSubagentOrchestrationRequested: boolean;
  readonly hasBlockingRuntimeContract: boolean;
}): ArtifactTaskContract | undefined {
  if (params.hasBlockingRuntimeContract) {
    return undefined;
  }
  if (
    params.artifactIntent !== "edit_artifact" &&
    params.artifactIntent !== "grounded_plan_generation"
  ) {
    return undefined;
  }
  if (params.explicitArtifactTargets.length === 0) {
    return undefined;
  }
  if (!areDocumentationOnlyArtifacts(params.explicitArtifactTargets)) {
    return undefined;
  }

  const workspaceRoot = deriveArtifactTaskWorkspaceRoot({
    messageText: params.messageText,
    workspaceRoot: params.workspaceRoot,
    explicitArtifactTargets: params.explicitArtifactTargets,
  });
  const resolvedArtifacts = resolveArtifactTaskArtifacts({
    workspaceRoot,
    explicitArtifactTargets: params.explicitArtifactTargets,
    explicitSourceArtifactTargets: params.explicitSourceArtifactTargets,
  });
  if (!resolvedArtifacts) {
    return undefined;
  }

  const operationMode = resolveArtifactTaskOperationMode({
    messageText: params.messageText,
    artifactIntent: params.artifactIntent,
    sourceArtifacts: resolvedArtifacts.sourceArtifacts,
    targetArtifacts: resolvedArtifacts.targetArtifacts,
  });
  const groundingMode: ArtifactTaskGroundingMode =
    textRequiresWorkspaceGroundedArtifactUpdate(params.messageText)
      ? "artifact_plus_workspace"
      : "artifact_only";
  const delegationPolicy: ArtifactTaskDelegationPolicy =
    params.explicitDelegationRequested ||
    params.explicitSubagentOrchestrationRequested ||
    requestExplicitlyPrescribesArtifactExecutionStructure(params.messageText) ||
    resolvedArtifacts.sourceArtifacts.some(
      (artifact) => !resolvedArtifacts.targetArtifacts.includes(artifact),
    )
      ? "planner_allowed"
      : "direct_owner";

  return {
    targetArtifacts: resolvedArtifacts.targetArtifacts,
    sourceArtifacts: resolvedArtifacts.sourceArtifacts,
    workspaceRoot,
    operationMode,
    groundingMode,
    delegationPolicy,
    allowedToolNames: [...DIRECT_ARTIFACT_OWNER_TOOL_NAMES],
    displayTargetArtifact: resolvedArtifacts.displayTargetArtifact,
    artifactKind: "documentation",
    acceptanceCriteria: buildArtifactTaskAcceptanceCriteria({
      displayTargetArtifact: resolvedArtifacts.displayTargetArtifact,
      operationMode,
    }),
  };
}

export function buildArtifactTaskRuntimeRequirements(
  contract: ArtifactTaskContract,
): ArtifactTaskRuntimeRequirements {
  const completionContract: ImplementationCompletionContract = {
    taskClass: "artifact_only",
    placeholdersAllowed: false,
    partialCompletionAllowed: false,
    placeholderTaxonomy: "documentation",
  };
  const verificationMode =
    contract.operationMode === "review_only"
      ? "grounded_read"
      : contract.operationMode === "review_and_update_if_needed"
        ? "conditional_mutation"
        : "mutation_required";
  const verificationContract: WorkflowVerificationContract = {
    workspaceRoot: contract.workspaceRoot,
    inputArtifacts: contract.sourceArtifacts,
    requiredSourceArtifacts: contract.sourceArtifacts,
    targetArtifacts: contract.targetArtifacts,
    acceptanceCriteria: contract.acceptanceCriteria,
    verificationMode,
    completionContract,
  };
  const executionEnvelope = createExecutionEnvelope({
    workspaceRoot: contract.workspaceRoot,
    allowedReadRoots: contract.workspaceRoot ? [contract.workspaceRoot] : [],
    allowedWriteRoots:
      contract.operationMode === "review_only"
        ? []
        : contract.workspaceRoot
          ? [contract.workspaceRoot]
          : [],
    allowedTools: contract.allowedToolNames,
    inputArtifacts: contract.sourceArtifacts,
    requiredSourceArtifacts: contract.sourceArtifacts,
    targetArtifacts: contract.targetArtifacts,
    effectClass:
      contract.operationMode === "review_only"
        ? "read_only"
        : "filesystem_write",
    verificationMode,
    completionContract,
    fallbackPolicy: "fail_request",
    approvalProfile:
      contract.operationMode === "review_only"
        ? "read_only"
        : "filesystem_write",
  });
  return {
    verificationContract,
    completionContract,
    executionEnvelope: executionEnvelope ?? {
      workspaceRoot: contract.workspaceRoot,
      allowedTools: contract.allowedToolNames,
      inputArtifacts: contract.sourceArtifacts,
      requiredSourceArtifacts: contract.sourceArtifacts,
      targetArtifacts: contract.targetArtifacts,
    },
  };
}

export function mergeArtifactTaskRequiredToolEvidence(params: {
  readonly base: ChatExecuteParams["requiredToolEvidence"];
  readonly artifactTaskContract: ArtifactTaskContract;
}): NonNullable<ChatExecuteParams["requiredToolEvidence"]> {
  const runtimeRequirements = buildArtifactTaskRuntimeRequirements(
    params.artifactTaskContract,
  );
  return {
    maxCorrectionAttempts: params.base?.maxCorrectionAttempts ?? 1,
    unsafeBenchmarkMode: params.base?.unsafeBenchmarkMode,
    verificationContract: runtimeRequirements.verificationContract,
    completionContract: runtimeRequirements.completionContract,
    artifactTaskContract: params.artifactTaskContract,
    executionEnvelope: runtimeRequirements.executionEnvelope,
  };
}
