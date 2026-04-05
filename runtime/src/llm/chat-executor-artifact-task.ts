import { basename as pathBasename } from "node:path";

import type { ChatExecuteParams } from "./chat-executor-types.js";
import type { PlannerPlanArtifactIntent } from "./chat-executor-planner.js";
import { areDocumentationOnlyArtifacts } from "../workflow/artifact-paths.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import type { ExecutionEnvelope } from "../workflow/execution-envelope.js";
import { createExecutionEnvelope } from "../workflow/execution-envelope.js";
import { normalizeArtifactPaths, normalizeWorkspaceRoot } from "../workflow/path-normalization.js";
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
const EXPLICIT_ARTIFACT_EXECUTABLE_VERIFICATION_RE =
  /\b(?:build|compile|typecheck|lint|tests?|testing|pytest|vitest|jest|ctest|cargo\s+test|go\s+test|npm\s+(?:test|run\s+build|run\s+typecheck|run\s+lint)|pnpm\s+(?:test|build|typecheck|lint)|yarn\s+(?:test|build|typecheck|lint)|bun\s+(?:test|run(?:\s+(?:build|typecheck|lint))?))\b/i;

function requestExplicitlyPrescribesArtifactExecutionStructure(
  messageText: string,
): boolean {
  return EXPLICIT_ARTIFACT_EXECUTION_STRUCTURE_RE.test(messageText);
}

const MESSAGE_WORKSPACE_ROOT_CUE_RE =
  /\b(?:in|under|within|inside)\s+((?:\.{1,2}\/|\/)[A-Za-z0-9._\/-]+)\b(?:\s+only)?/i;

function deriveArtifactTaskWorkspaceRoot(params: {
  readonly messageText: string;
  readonly workspaceRoot?: string | null;
  readonly explicitArtifactTargets: readonly string[];
}): string | undefined {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(params.workspaceRoot);
  if (normalizedWorkspaceRoot) {
    return normalizedWorkspaceRoot;
  }
  if (!params.explicitArtifactTargets.every((target) => !target.includes("/"))) {
    return undefined;
  }
  const match = params.messageText.match(MESSAGE_WORKSPACE_ROOT_CUE_RE);
  return normalizeWorkspaceRoot(match?.[1]);
}

export function resolveDirectArtifactTaskContract(params: {
  readonly messageText: string;
  readonly workspaceRoot?: string | null;
  readonly explicitArtifactTargets: readonly string[];
  readonly artifactIntent: PlannerPlanArtifactIntent;
  readonly explicitDelegationRequested: boolean;
  readonly hasBlockingRuntimeContract: boolean;
}): ArtifactTaskContract | undefined {
  if (
    params.explicitDelegationRequested ||
    params.hasBlockingRuntimeContract ||
    EXPLICIT_ARTIFACT_EXECUTABLE_VERIFICATION_RE.test(params.messageText) ||
    requestExplicitlyPrescribesArtifactExecutionStructure(params.messageText)
  ) {
    return undefined;
  }
  if (params.artifactIntent !== "edit_artifact") {
    return undefined;
  }
  if (params.explicitArtifactTargets.length !== 1) {
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
  const normalizedTargets = normalizeArtifactPaths(
    params.explicitArtifactTargets,
    workspaceRoot,
  );
  if (normalizedTargets.length !== 1) {
    return undefined;
  }

  const targetArtifact = normalizedTargets[0]!;
  const displayTargetArtifact = params.explicitArtifactTargets[0]!;
  const groundingMode: ArtifactTaskGroundingMode = textRequiresWorkspaceGroundedArtifactUpdate(
    params.messageText,
  )
    ? "artifact_plus_workspace"
    : "artifact_only";
  const targetLabel = pathBasename(displayTargetArtifact) || displayTargetArtifact;
  const acceptanceCriteria = groundingMode === "artifact_plus_workspace"
    ? [
      `${targetLabel} is reviewed against the current workspace layout and referenced implementation state, then updated in place only when needed. If it is already correct, the result must explicitly report that no edits were required.`,
    ]
    : [
      `${targetLabel} is reviewed directly and updated in place only when needed. If it is already correct, the result must explicitly report that no edits were required.`,
    ];

  return {
    targetArtifacts: [targetArtifact],
    sourceArtifacts: [targetArtifact],
    workspaceRoot,
    operationMode: "review_and_update_if_needed",
    groundingMode,
    delegationPolicy: "direct_owner",
    allowedToolNames: [...DIRECT_ARTIFACT_OWNER_TOOL_NAMES],
    displayTargetArtifact,
    artifactKind: "documentation",
    acceptanceCriteria,
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
  const verificationContract: WorkflowVerificationContract = {
    workspaceRoot: contract.workspaceRoot,
    inputArtifacts: contract.sourceArtifacts,
    requiredSourceArtifacts: contract.sourceArtifacts,
    targetArtifacts: contract.targetArtifacts,
    acceptanceCriteria: contract.acceptanceCriteria,
    verificationMode: "conditional_mutation",
    completionContract,
  };
  const executionEnvelope = createExecutionEnvelope({
    workspaceRoot: contract.workspaceRoot,
    allowedReadRoots: contract.workspaceRoot ? [contract.workspaceRoot] : [],
    allowedWriteRoots: contract.workspaceRoot ? [contract.workspaceRoot] : [],
    allowedTools: contract.allowedToolNames,
    inputArtifacts: contract.sourceArtifacts,
    requiredSourceArtifacts: contract.sourceArtifacts,
    targetArtifacts: contract.targetArtifacts,
    effectClass: "filesystem_write",
    verificationMode: "conditional_mutation",
    completionContract,
    fallbackPolicy: "fail_request",
    approvalProfile: "filesystem_write",
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
