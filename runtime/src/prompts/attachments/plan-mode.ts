/**
 * Plan-mode attachment producer.
 *
 * Hand-port of reference `getPlanModeAttachments` + `getPlanModeExitAttachment`
 * (`src/utils/attachments.ts:1187-1274`). Drives the per-turn pulse and the
 * one-shot exit reminder for AgenC plan mode (`PermissionMode === "plan"`).
 *
 * Algorithm:
 *
 *   1. Exit reminder fires when `trackingState.needsPlanModeExitAttachment`
 *      is true AND the current mode is NOT plan. Setting the flag is the
 *      responsibility of `permissions/mode.ts` (the FSM raises it on plan
 *      transitions out). The flag is cleared after firing (one-shot) and
 *      `hasExitedPlanModeInSession` flips true so subsequent re-entries
 *      surface the re-entry guidance. The exit reminder fires independently
 *      of the per-turn pulse — both can fire on the same turn.
 *
 *   2. Per-turn pulse fires only when current mode IS plan. The throttle
 *      counts HUMAN turns (role === "user", non-tool-result) backwards
 *      until a prior plan-mode marker is seen in `opts.messages`. On the
 *      first plan-mode emission of a (re-)entry we fire `variant: "full"`.
 *      Subsequent emissions throttle to one every
 *      `TURNS_BETWEEN_ATTACHMENTS` (5) human turns. Every
 *      `FULL_REMINDER_EVERY_N_ATTACHMENTS` (5) attachments we re-fire
 *      `variant: "full"`; otherwise `variant: "sparse"`.
 *
 *   3. Re-entry attachment (`plan_mode_reentry`) fires *instead of*
 *      `plan_mode` when the current mode is plan AND no prior plan-mode
 *      marker exists since the last exit AND
 *      `trackingState.hasExitedPlanModeInSession` is true. After the
 *      reentry attachment fires, the throttle/cycle state for the new
 *      re-entry begins counting from there (the reentry counts as the
 *      first attachment of the cycle).
 *
 * Marker phrases used to detect prior attachments in `opts.messages`:
 *   - plan_mode      → substring `"Plan mode is active"`
 *   - plan_mode_reentry → substring `"Re-entering plan mode"`
 *   - plan_mode_exit → substring `"Exited plan mode"`
 *
 * These markers come from `./messages.ts` body builders. The renderer
 * wraps them in `<system-reminder>` tags inside user-channel messages.
 *
 * Plan-file path resolution mirrors AgenC's
 * `getPlanFilePath(toolUseContext.agentId)` call. AgenC's
 * `getPlanFilePath(ctx)` keys on `{sessionId, agencHome}`. We derive
 * `sessionId` from `(opts.sessionKey as Session).conversationId` when
 * present, falling back to `"default"`. `agencHome` is read from
 * `process.env.AGENC_HOME` to match `resolveAgencHome` in
 * `planning/plan-files.ts`.
 *
 * @module
 */

import { existsSync } from "node:fs";

import { getPlanFilePath } from "../../planning/plan-files.js";
import type { LLMMessage } from "../../llm/types.js";
import type { AttachmentProducer, GetAttachmentsOptions } from "./orchestrator.js";
import type { Attachment } from "./types.js";

/**
 * Source: reference `attachments.ts:260-263`.
 */
export const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const;

const PLAN_MODE_MARKER = "Plan mode is active";
const PLAN_MODE_REENTRY_MARKER = "Re-entering plan mode";
const PLAN_MODE_EXIT_MARKER = "Exited plan mode";

/**
 * Returns true when the message looks like a runtime-emitted user-channel
 * attachment carrying the marker phrase. Tool results are excluded
 * (they have a `toolCallId`).
 */
function isHumanTurn(message: LLMMessage): boolean {
  return message.role === "user" && message.toolCallId === undefined;
}

function messageContent(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  // Multimodal content — stringify just the text parts so marker scans
  // still work for image-bearing messages.
  let text = "";
  for (const part of message.content) {
    if ((part as { type?: string }).type === "text") {
      text += (part as { text?: string }).text ?? "";
    }
  }
  return text;
}

function messageContains(message: LLMMessage, marker: string): boolean {
  const content = messageContent(message);
  return content.includes(marker);
}

/**
 * Backward-walk the message history counting HUMAN turns until a prior
 * plan-mode attachment marker is encountered.
 *
 * Source: reference `getPlanModeAttachmentTurnCount` (:1132-1164).
 */
function getPlanModeAttachmentTurnCount(messages: readonly LLMMessage[]): {
  turnCount: number;
  foundPlanModeAttachment: boolean;
} {
  let turnsSinceLastAttachment = 0;
  let foundPlanModeAttachment = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) continue;
    if (
      messageContains(message, PLAN_MODE_MARKER) ||
      messageContains(message, PLAN_MODE_REENTRY_MARKER)
    ) {
      foundPlanModeAttachment = true;
      break;
    }
    if (isHumanTurn(message)) {
      turnsSinceLastAttachment++;
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundPlanModeAttachment };
}

/**
 * Count plan-mode attachments since the last plan-mode-exit (or from the
 * start of history if no exit). Drives the full/sparse cycle so it
 * resets on re-entry.
 *
 * Source: reference `countPlanModeAttachmentsSinceLastExit` (:1170-1185).
 */
function countPlanModeAttachmentsSinceLastExit(
  messages: readonly LLMMessage[],
): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) continue;
    if (messageContains(message, PLAN_MODE_EXIT_MARKER)) {
      // Reentry/full plan_mode bodies do NOT contain the exit marker
      // ("Exited plan mode") — that string is unique to the exit body.
      break;
    }
    if (
      messageContains(message, PLAN_MODE_MARKER) ||
      messageContains(message, PLAN_MODE_REENTRY_MARKER)
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Resolve the plan-file context from the orchestrator opts. The
 * `sessionKey` is opaque-typed but in production it is the `Session`
 * instance — read its `conversationId` if present.
 */
function planFileContext(opts: GetAttachmentsOptions): {
  sessionId?: string;
  agencHome?: string;
} {
  const sessionLike = opts.sessionKey as { conversationId?: unknown };
  const sessionId =
    typeof sessionLike.conversationId === "string"
      ? sessionLike.conversationId
      : undefined;
  const agencHome = process.env.AGENC_HOME;
  return {
    sessionId,
    agencHome:
      typeof agencHome === "string" && agencHome.trim().length > 0
        ? agencHome
        : undefined,
  };
}

export const planModeProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  const attachments: Attachment[] = [];

  // Step 1 — exit reminder. Fires regardless of the per-turn pulse so a
  // mode flip from plan to default emits the exit text on the same turn
  // we suppress the plan_mode pulse.
  if (trackingState.needsPlanModeExitAttachment) {
    if (opts.permissionContext.mode === "plan") {
      // Re-entered plan before the exit reminder had a chance to fire —
      // clear the flag silently. Matches AgenC :1258-1261.
      trackingState.needsPlanModeExitAttachment = false;
    } else {
      trackingState.needsPlanModeExitAttachment = false;
      trackingState.hasExitedPlanModeInSession = true;
      const ctx = planFileContext(opts);
      const planFilePath = getPlanFilePath(ctx);
      attachments.push({
        kind: "plan_mode_exit",
        planFilePath,
        planExists: existsSync(planFilePath),
      });
    }
  }

  // Step 2 — per-turn pulse. Only fires when current mode is plan.
  if (opts.permissionContext.mode !== "plan") {
    return attachments;
  }

  // Throttle on human turns. On the first plan-mode pulse of an entry
  // (no prior marker found in the visible history) we always fire.
  if (opts.messages.length > 0) {
    const { turnCount, foundPlanModeAttachment } =
      getPlanModeAttachmentTurnCount(opts.messages);
    if (
      foundPlanModeAttachment &&
      turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return attachments;
    }
  }

  const ctx = planFileContext(opts);
  const planFilePath = getPlanFilePath(ctx);
  const planExists = existsSync(planFilePath);

  // Re-entry case: first plan-mode pulse since the last exit AND we have
  // observed a prior exit in this session. Fire `plan_mode_reentry`
  // instead of `plan_mode`. Match AgenC :1217-1220 — the reentry
  // is a *separate* attachment that precedes any plan_mode for the cycle.
  // AgenC's source emits BOTH reentry + plan_mode on the same turn
  // when both conditions hit; we mirror that exactly.
  const priorAttachmentCount = countPlanModeAttachmentsSinceLastExit(
    opts.messages,
  );
  if (
    trackingState.hasExitedPlanModeInSession &&
    priorAttachmentCount === 0
  ) {
    attachments.push({
      kind: "plan_mode_reentry",
      planFilePath,
      planExists,
    });
    // One-shot guidance — clear the flag so subsequent re-entries that
    // follow in the same session don't double-fire when we're still
    // inside the same plan-mode session. Matches AgenC :1219.
    trackingState.hasExitedPlanModeInSession = false;
  }

  // Always emit the plan_mode attachment alongside any reentry. The
  // attachment count we count INCLUDES the one we are about to emit
  // (reference `+ 1` at :1224-1225). Full reminder fires on 1, 6, 11...
  const attachmentCount = priorAttachmentCount + 1;
  const variant: "full" | "sparse" =
    attachmentCount %
      PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? "full"
      : "sparse";

  attachments.push({
    kind: "plan_mode",
    variant,
    planFilePath,
    planExists,
  });

  return attachments;
};
