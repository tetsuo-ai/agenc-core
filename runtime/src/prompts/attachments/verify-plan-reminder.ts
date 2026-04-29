/**
 * Verified-plan reminder attachment producer.
 *
 * Mirrors upstream's post-plan reminder cadence: after plan mode exits,
 * count human turns backwards to the `plan_mode_exit` marker and emit a
 * reminder every `TURNS_BETWEEN_REMINDERS` turns. Tool results and
 * runtime-injected user-context messages are not human turns.
 *
 * AgenC does not ship upstream's plan-verification tool, so this producer
 * only emits the reminder attachment. The renderer owns the AgenC-specific
 * prose for direct plan verification.
 *
 * @module
 */

import type { LLMMessage } from "../../llm/types.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type { Attachment } from "./types.js";

export const VERIFY_PLAN_REMINDER_CONFIG = {
  TURNS_BETWEEN_REMINDERS: 10,
} as const;

const PLAN_MODE_EXIT_MARKER = "Exited plan mode";
const DISABLED_ENV_VALUES = new Set(["0", "false", "no", "off"]);

function isVerifyPlanReminderEnabled(): boolean {
  const raw = process.env.AGENC_VERIFY_PLAN?.trim().toLowerCase();
  return raw === undefined || !DISABLED_ENV_VALUES.has(raw);
}

function isHumanTurn(message: LLMMessage): boolean {
  return (
    message.role === "user" &&
    message.toolCallId === undefined &&
    message.runtimeOnly?.mergeBoundary !== "user_context"
  );
}

function messageContent(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  let text = "";
  for (const part of message.content) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

function messageContains(message: LLMMessage, marker: string): boolean {
  return messageContent(message).includes(marker);
}

/**
 * Count human turns since plan mode exit. Returns 0 if no plan exit
 * marker is visible in the current message history.
 */
export function getVerifyPlanReminderTurnCount(
  messages: readonly LLMMessage[],
): number {
  let turnCount = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined) continue;
    if (isHumanTurn(message)) {
      turnCount += 1;
    }
    if (messageContains(message, PLAN_MODE_EXIT_MARKER)) {
      return turnCount;
    }
  }
  return 0;
}

export const verifyPlanReminderProducer: AttachmentProducer = async (
  opts,
): Promise<readonly Attachment[]> => {
  if (!isVerifyPlanReminderEnabled()) return [];
  if (opts.subagentDepth !== 0) return [];
  if (opts.permissionContext.mode === "plan") return [];

  const turnCount = getVerifyPlanReminderTurnCount(opts.messages);
  if (
    turnCount === 0 ||
    turnCount % VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS !== 0
  ) {
    return [];
  }

  return [{ kind: "verify_plan_reminder" }];
};
