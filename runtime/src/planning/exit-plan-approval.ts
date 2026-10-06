import type { PermissionUpdate } from "../permissions/types.js";
import { asRecord } from "../utils/record.js";

export interface ExitPlanAllowedPrompt {
  readonly tool: string;
  readonly prompt: string;
}

export type ExitPlanApprovalMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "auto";

export type ExitPlanModeApproval =
  | {
      readonly action: "approve";
      readonly plan?: string;
      readonly mode?: ExitPlanApprovalMode;
      readonly applyAllowedPrompts?: boolean;
      readonly allowedPrompts?: readonly ExitPlanAllowedPrompt[];
      readonly clearContext?: boolean;
    }
  | {
      readonly action: "revise";
      readonly plan?: string;
      readonly feedback?: string;
    };

const CALL_ID_ARG = "__callId";
const approvals = new Map<string, ExitPlanModeApproval>();

/**
 * The plan an ExitPlanMode approval request showed. The request snapshots
 * the plan file; the runtime hands that snapshot to the tool as a hidden
 * argument so the tool executes exactly the text the user approved.
 */
export const EXIT_PLAN_APPROVED_PLAN_ARG = "__agencApprovedPlan";

export interface ExitPlanApprovedPlan {
  /** The plan text the request showed, or null when it showed none. */
  readonly plan: string | null;
}

/** What an approval request built from `approvalArgs` shows as the plan. */
export function exitPlanApprovedPlan(
  approvalArgs: Record<string, unknown>,
): ExitPlanApprovedPlan {
  const plan = approvalArgs.plan;
  return Object.freeze({
    plan: typeof plan === "string" && plan.trim().length > 0 ? plan : null,
  });
}

/**
 * The snapshot the runtime injected, or undefined when there is none. The
 * runtime injects it as a non-enumerable property after argument
 * validation; a model-supplied argument of the same name is enumerable and
 * never counts.
 */
export function injectedExitPlanApprovedPlan(
  args: Record<string, unknown>,
): ExitPlanApprovedPlan | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(args, EXIT_PLAN_APPROVED_PLAN_ARG);
  if (descriptor === undefined || descriptor.enumerable === true) return undefined;
  const snapshot = asRecord(descriptor.value);
  if (snapshot === null) return undefined;
  const plan = snapshot.plan;
  if (plan !== null && typeof plan !== "string") return undefined;
  return { plan };
}

/** Whether two plan texts are the same plan; no plan and a blank plan are one thing. */
export function samePlanText(left: string | null, right: string | null): boolean {
  const blank = (value: string | null): boolean =>
    value === null || value.trim().length === 0;
  return blank(left) || blank(right) ? blank(left) && blank(right) : left === right;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function parseExitPlanAllowedPrompts(
  value: unknown,
): readonly ExitPlanAllowedPrompt[] {
  if (!Array.isArray(value)) return [];
  const prompts: ExitPlanAllowedPrompt[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const tool = nonEmptyString(record.tool);
    const prompt = nonEmptyString(record.prompt);
    if (tool === null || prompt === null) continue;
    prompts.push({ tool, prompt });
  }
  return Object.freeze(prompts);
}

export function buildPlanPromptPermissionUpdates(
  allowedPrompts: readonly ExitPlanAllowedPrompt[],
): readonly PermissionUpdate[] {
  if (allowedPrompts.length === 0) return [];
  return Object.freeze([
    {
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: Object.freeze(
        allowedPrompts.map((entry) =>
          Object.freeze({
            toolName: entry.tool,
            ruleContent: entry.prompt,
          }),
        ),
      ),
    },
  ] satisfies PermissionUpdate[]);
}

export function recordExitPlanModeApproval(
  callId: string,
  approval: ExitPlanModeApproval,
): void {
  if (callId.trim().length === 0) return;
  approvals.set(callId, approval);
}

export function consumeExitPlanModeApproval(
  args: Record<string, unknown>,
): ExitPlanModeApproval | null {
  const callId = typeof args.__agencApprovalResponseKey === "string"
    ? args.__agencApprovalResponseKey
    : typeof args[CALL_ID_ARG] === "string" ? args[CALL_ID_ARG] : "";
  if (callId.length === 0) return null;
  const approval = approvals.get(callId);
  approvals.delete(callId);
  return approval ?? null;
}

export function clearExitPlanModeApprovalsForTest(): void {
  approvals.clear();
}
