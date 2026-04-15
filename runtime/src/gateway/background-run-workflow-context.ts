import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

import type { ChatExecuteParams } from "../llm/chat-executor-types.js";
import type { LLMMessage } from "../llm/types.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import { normalizeWorkspaceRoot } from "../workflow/path-normalization.js";
import type { WorkflowRequestMilestone } from "../workflow/request-completion.js";
import type { WorkflowVerificationContract } from "../workflow/verification-obligations.js";
import { resolveAtMentionAttachments } from "./at-mention-attachments.js";

const FULL_IMPLEMENTATION_RE =
  /\b(?:implement|complete|finish|build)\b[\s\S]{0,160}\b(?:in full|fully|entirely|the full plan|all phases|every phase)\b/i;
const DO_NOT_STOP_RE =
  /\b(?:do not stop|don't stop|without stopping|until complete|until it's complete|until it is complete|keep going until)\b/i;
const PLAN_REFERENCE_RE = /(?:^|\s)@?PLAN\.md\b/i;
const PHASED_REQUEST_RE =
  /\b(?:all phases|every phase|phase-by-phase|milestones?|m\d+\b)\b/i;

const MILESTONE_HEADING_RE =
  /^\s*(?:[-*]\s+)?(?:#{1,6}\s*)?(M\d+)\b(?:\s*[:\-]\s*|\s+)(.+?)\s*$/i;
const PHASE_HEADING_RE =
  /^\s*(?:[-*]\s+)?(?:#{1,6}\s*)?Phase\s+([A-Za-z0-9._-]+)\b(?:\s*[:\-]\s*|\s+)(.+?)\s*$/i;

const STRICT_IMPLEMENTATION_COMPLETION_CONTRACT: ImplementationCompletionContract = {
  taskClass: "artifact_only",
  placeholdersAllowed: false,
  partialCompletionAllowed: false,
  placeholderTaxonomy: "implementation",
};

export interface BackgroundRunWorkflowContext {
  readonly historyPrelude: readonly LLMMessage[];
  readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
}

export function shouldPromoteImplementationBackgroundRun(
  content: string,
): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return (
    FULL_IMPLEMENTATION_RE.test(trimmed) ||
    (PLAN_REFERENCE_RE.test(trimmed) &&
      (DO_NOT_STOP_RE.test(trimmed) || PHASED_REQUEST_RE.test(trimmed))) ||
    (DO_NOT_STOP_RE.test(trimmed) &&
      /\b(?:implement|build|complete|finish)\b/i.test(trimmed) &&
      PHASED_REQUEST_RE.test(trimmed))
  );
}

export async function buildBackgroundRunWorkflowContext(params: {
  readonly objective: string;
  readonly workspaceRoot?: string;
}): Promise<BackgroundRunWorkflowContext> {
  const workspaceRoot = normalizeWorkspaceRoot(params.workspaceRoot);
  const atMentionAttachments = workspaceRoot
    ? await resolveAtMentionAttachments({
        content: params.objective,
        workspaceRoot,
      })
    : {
        historyPrelude: [] as const,
        executionEnvelope: undefined,
      };
  const requestMilestones = workspaceRoot
    ? await deriveRequestMilestones({
        objective: params.objective,
        workspaceRoot,
      })
    : [];
  const strictWorkflowRequest =
    shouldPromoteImplementationBackgroundRun(params.objective) ||
    requestMilestones.length > 0;
  const completionContract = strictWorkflowRequest
    ? STRICT_IMPLEMENTATION_COMPLETION_CONTRACT
    : undefined;
  const verificationContract = buildVerificationContract({
    workspaceRoot,
    requestMilestones,
    completionContract,
  });

  return {
    historyPrelude: atMentionAttachments.historyPrelude,
    runtimeContext: workspaceRoot ? { workspaceRoot } : undefined,
    requiredToolEvidence:
      verificationContract || completionContract || atMentionAttachments.executionEnvelope
        ? {
            ...(verificationContract
              ? { verificationContract }
              : {}),
            ...(completionContract
              ? { completionContract }
              : {}),
            ...(atMentionAttachments.executionEnvelope
              ? {
                  executionEnvelope: {
                    ...atMentionAttachments.executionEnvelope,
                    ...(completionContract
                      ? { completionContract }
                      : {}),
                  },
                }
              : {}),
          }
        : undefined,
  };
}

function buildVerificationContract(params: {
  readonly workspaceRoot?: string;
  readonly requestMilestones: readonly WorkflowRequestMilestone[];
  readonly completionContract?: ImplementationCompletionContract;
}): WorkflowVerificationContract | undefined {
  if (
    !params.workspaceRoot &&
    params.requestMilestones.length === 0 &&
    !params.completionContract
  ) {
    return undefined;
  }
  return {
    ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
    ...(params.requestMilestones.length > 0
      ? {
          requestCompletion: {
            requiredMilestones: params.requestMilestones,
          },
        }
      : {}),
    ...(params.completionContract
      ? { completionContract: params.completionContract }
      : {}),
  };
}

async function deriveRequestMilestones(params: {
  readonly objective: string;
  readonly workspaceRoot: string;
}): Promise<readonly WorkflowRequestMilestone[]> {
  if (
    !PLAN_REFERENCE_RE.test(params.objective) &&
    !PHASED_REQUEST_RE.test(params.objective)
  ) {
    return [];
  }

  const candidatePaths = [
    join(params.workspaceRoot, "PLAN.md"),
    join(params.workspaceRoot, "plan.md"),
  ];
  for (const path of candidatePaths) {
    try {
      await access(path, fsConstants.R_OK);
    } catch {
      continue;
    }
    const content = await readFile(path, "utf8").catch(() => undefined);
    if (typeof content !== "string" || content.trim().length === 0) {
      continue;
    }
    const milestones = parseRequestMilestones(content);
    if (milestones.length > 0) {
      return milestones;
    }
  }
  return [];
}

function parseRequestMilestones(
  content: string,
): readonly WorkflowRequestMilestone[] {
  const milestones = new Map<string, WorkflowRequestMilestone>();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const milestoneMatch = line.match(MILESTONE_HEADING_RE);
    if (milestoneMatch?.[1] && milestoneMatch[2]) {
      const id = milestoneMatch[1].toUpperCase();
      if (!milestones.has(id)) {
        milestones.set(id, {
          id,
          description: milestoneMatch[2].trim(),
        });
      }
      continue;
    }
    const phaseMatch = line.match(PHASE_HEADING_RE);
    if (phaseMatch?.[1] && phaseMatch[2]) {
      const phaseId = normalizePhaseId(phaseMatch[1]);
      if (!milestones.has(phaseId)) {
        milestones.set(phaseId, {
          id: phaseId,
          description: phaseMatch[2].trim(),
        });
      }
    }
  }
  return [...milestones.values()];
}

function normalizePhaseId(rawPhase: string): string {
  return `phase_${rawPhase.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}
