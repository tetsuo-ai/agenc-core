/**
 * Auto-mode attachment producer.
 *
 * Hand-port of openclaude `getAutoModeAttachments` + `getAutoModeExitAttachment`
 * (`src/utils/attachments.ts:1276-1401`). Drives the per-turn pulse and
 * the one-shot exit reminder for AgenC's autonomous-execution permission
 * modes.
 *
 * Mode mapping (openclaude `auto` → AgenC):
 *   - openclaude single mode `"auto"` becomes the canonical autonomous
 *     family in AgenC. AgenC has its own literal `"auto"` mode plus two
 *     other autonomous-leaning modes from the broader runtime: `"acceptEdits"`
 *     (file edits don't prompt) and `"bypassPermissions"` (all approvals
 *     suppressed). The producer treats all three as equivalent for
 *     reminder purposes — the model needs the same "you are running
 *     without per-call approval" guidance in each.
 *   - `"plan"`, `"default"`, `"dontAsk"`, and `"bubble"` do NOT trigger
 *     the auto-mode pulse.
 *
 * Throttle/cycle algorithm matches plan-mode exactly:
 *   - First emission in a (re-)entry → `variant: "full"`.
 *   - Subsequent: 1 every `TURNS_BETWEEN_ATTACHMENTS` (5) human turns.
 *   - Every `FULL_REMINDER_EVERY_N_ATTACHMENTS` (5) attachments → full again.
 *
 * Exit reminder: fires when `trackingState.needsAutoModeExitAttachment`
 * is true AND the current mode is no longer in the autonomous family.
 * One-shot — flag cleared after firing.
 *
 * Marker phrases (from `./messages.ts`):
 *   - auto_mode      → substring `"Auto mode is active"`
 *   - auto_mode_exit → substring `"exited auto mode"`
 *
 * @module
 */

import type { LLMMessage } from "../../llm/types.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type { Attachment } from "./types.js";

/**
 * Source: openclaude `attachments.ts:265-268`.
 */
export const AUTO_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const;

const AUTO_MODE_MARKER = "Auto mode is active";
const AUTO_MODE_EXIT_MARKER = "exited auto mode";

/**
 * AgenC permission modes treated as openclaude's `auto` mode for the
 * purposes of the auto-mode attachment family.
 */
const AUTO_FAMILY_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "auto",
  "acceptEdits",
  "bypassPermissions",
]);

function isAutoFamilyMode(mode: PermissionMode): boolean {
  return AUTO_FAMILY_MODES.has(mode);
}

function isHumanTurn(message: LLMMessage): boolean {
  return message.role === "user" && message.toolCallId === undefined;
}

function messageContent(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  let text = "";
  for (const part of message.content) {
    if ((part as { type?: string }).type === "text") {
      text += (part as { text?: string }).text ?? "";
    }
  }
  return text;
}

function messageContains(message: LLMMessage, marker: string): boolean {
  return messageContent(message).includes(marker);
}

/**
 * Source: openclaude `getAutoModeAttachmentTurnCount` (:1276-1314).
 *
 * The exit-marker case mirrors openclaude's "exit resets the throttle —
 * treat as if no prior attachment exists" branch.
 */
function getAutoModeAttachmentTurnCount(messages: readonly LLMMessage[]): {
  turnCount: number;
  foundAutoModeAttachment: boolean;
} {
  let turnsSinceLastAttachment = 0;
  let foundAutoModeAttachment = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) continue;
    if (messageContains(message, AUTO_MODE_EXIT_MARKER)) {
      // Exit resets — treat as if no prior auto_mode attachment exists.
      break;
    }
    if (messageContains(message, AUTO_MODE_MARKER)) {
      foundAutoModeAttachment = true;
      break;
    }
    if (isHumanTurn(message)) {
      turnsSinceLastAttachment++;
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundAutoModeAttachment };
}

/**
 * Source: openclaude `countAutoModeAttachmentsSinceLastExit` (:1320-1334).
 */
function countAutoModeAttachmentsSinceLastExit(
  messages: readonly LLMMessage[],
): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) continue;
    if (messageContains(message, AUTO_MODE_EXIT_MARKER)) break;
    if (messageContains(message, AUTO_MODE_MARKER)) count++;
  }
  return count;
}

export const autoModeProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  const attachments: Attachment[] = [];
  const mode = opts.permissionContext.mode;

  // Step 1 — exit reminder. Fires when the flag is set AND we are no
  // longer in any auto-family mode. If we're still in auto, clear the
  // flag silently (matches openclaude :1391-1397).
  if (trackingState.needsAutoModeExitAttachment) {
    if (isAutoFamilyMode(mode)) {
      trackingState.needsAutoModeExitAttachment = false;
    } else {
      trackingState.needsAutoModeExitAttachment = false;
      trackingState.hasExitedAutoModeInSession = true;
      attachments.push({ kind: "auto_mode_exit" });
    }
  }

  // Step 2 — per-turn pulse. Only fires in an auto-family mode.
  if (!isAutoFamilyMode(mode)) {
    return attachments;
  }

  // Throttle on human turns. First emission in a (re-)entry always fires.
  if (opts.messages.length > 0) {
    const { turnCount, foundAutoModeAttachment } =
      getAutoModeAttachmentTurnCount(opts.messages);
    if (
      foundAutoModeAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return attachments;
    }
  }

  // Full / sparse cycle — count includes the attachment we are about to emit.
  const attachmentCount =
    countAutoModeAttachmentsSinceLastExit(opts.messages) + 1;
  const variant: "full" | "sparse" =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? "full"
      : "sparse";

  attachments.push({ kind: "auto_mode", variant });
  return attachments as readonly Attachment[];
};
