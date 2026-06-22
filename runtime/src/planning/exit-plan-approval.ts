import type { PermissionMode, PermissionUpdate } from "../permissions/types.js";
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

export function targetPermissionModeForPlanApproval(
  requested: ExitPlanApprovalMode | undefined,
  prePlanMode: PermissionMode | undefined,
): PermissionMode {
  switch (requested) {
    case "acceptEdits":
      return "acceptEdits";
    case "bypassPermissions":
      return "bypassPermissions";
    case "auto":
      return "auto";
    case "default":
    case undefined:
      return prePlanMode && prePlanMode !== "plan" ? prePlanMode : "default";
  }
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
  const callId = typeof args[CALL_ID_ARG] === "string" ? args[CALL_ID_ARG] : "";
  if (callId.length === 0) return null;
  const approval = approvals.get(callId);
  approvals.delete(callId);
  return approval ?? null;
}

export function clearExitPlanModeApprovalsForTest(): void {
  approvals.clear();
}
