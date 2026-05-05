/**
 * Pure projection helpers for the AgenC TUI permission bridge.
 *
 * Lives in a `.ts` file (no JSX, no React imports) so unit tests can
 * import it without dragging the full `react/jsx-dev-runtime` runtime
 * into vitest. The React-bearing TUI permission overlay consumes these
 * helpers.
 *
 * @module
 */
import type { ApprovalCtx } from "../../tools/orchestrator.js";
import type { ReviewDecision } from "../../permissions/review-decision.js";
import {
  ABORT,
  APPROVED,
  APPROVED_FOR_SESSION,
  DENIED,
} from "../../permissions/review-decision.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  recordAskUserQuestionPlanInterviewAction,
  recordAskUserQuestionUpdatedInput,
  type AskUserQuestionPlanInterviewAction,
} from "../../tools/ask-user-question/tool.js";
import { makeToolUseMessage } from "../../tui/session-transcript.js";

export interface PendingRequest {
  readonly id: string;
  readonly ctx: ApprovalCtx;
  readonly input: Record<string, unknown>;
  readonly description: string;
  resolve(decision: ReviewDecision): void;
}

function planInterviewActionFromFeedback(
  feedback: unknown,
): AskUserQuestionPlanInterviewAction | null {
  if (typeof feedback !== "string") return null;
  const normalized = feedback.toLowerCase();
  if (normalized.includes("wants to clarify these questions")) {
    return "chat_about_this";
  }
  if (normalized.includes("provided enough answers for the plan interview")) {
    return "skip_plan_interview";
  }
  return null;
}

/**
 * Build the `ToolUseConfirm` projection a single `PendingRequest`
 * produces for the upstream permission UI. Returns `null` when no
 * matching tool is registered (defensive — the bridge always has at
 * least the live tool registry, but this lets tests exercise the
 * empty-registry case without crashing).
 */
export function buildToolUseConfirm(
  request: PendingRequest,
  tools: readonly { readonly name: string }[],
): unknown | null {
  const tool =
    tools.find((candidate) => candidate.name === request.ctx.toolName) ?? tools[0];
  if (!tool) return null;
  const assistantMessage = makeToolUseMessage(
    request.ctx.callId,
    request.ctx.toolName,
    request.input,
  );
  return {
    assistantMessage,
    tool,
    description: request.description,
    input: request.input,
    toolUseContext: {},
    toolUseID: request.ctx.callId,
    permissionResult: {
      behavior: "ask",
      message: request.description,
    },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction() {},
    onAbort() {
      request.resolve(ABORT);
    },
    onAllow(
      updatedInput: unknown,
      permissionUpdates: readonly unknown[] = [],
    ) {
      if (request.ctx.toolName === ASK_USER_QUESTION_TOOL_NAME) {
        recordAskUserQuestionUpdatedInput(request.ctx.callId, updatedInput);
      }
      request.resolve(
        permissionUpdates.length > 0 ? APPROVED_FOR_SESSION : APPROVED,
      );
    },
    onReject(feedback?: string) {
      if (request.ctx.toolName === ASK_USER_QUESTION_TOOL_NAME) {
        const action = planInterviewActionFromFeedback(feedback);
        if (
          action !== null &&
          recordAskUserQuestionPlanInterviewAction(
            request.ctx.callId,
            request.input,
            action,
          )
        ) {
          request.resolve(APPROVED);
          return;
        }
      }
      request.resolve(DENIED);
    },
    async recheckPermission() {},
  };
}

/**
 * Build the queue projection for the `<Messages toolUseConfirmQueue>` prop.
 * One entry per pending request, in arrival order. Entries with no
 * matching tool are dropped silently; the TUI overlay has the same
 * fallback behavior for the head of the queue.
 */
export function buildToolUseConfirmQueue(
  requests: readonly PendingRequest[],
  tools: readonly { readonly name: string }[],
): readonly unknown[] {
  const queue: unknown[] = [];
  for (const request of requests) {
    const projected = buildToolUseConfirm(request, tools);
    if (projected !== null) queue.push(projected);
  }
  return queue;
}
