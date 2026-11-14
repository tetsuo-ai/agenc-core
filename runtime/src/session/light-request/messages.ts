import type { LLMMessage } from "../../llm/types.js";
import type { LightRequestOptions } from "../../config/schema.js";

const WORKFLOW_REMINDERS = new Set(["auto_mode", "auto_mode_exit", "verify_plan_reminder"]);

/** Runtime metadata, never matching user-authored tags, identifies attachments. */
export function leanLightMessages(
  messages: readonly LLMMessage[],
  instructions: string,
  options: Required<LightRequestOptions>,
): { readonly messages: readonly LLMMessage[]; readonly instructions: string } {
  const minimal = options.short_system_prompt && options.system_text === "minimal";
  // Environment facts are already in the startup prompt. Attachments belong
  // to history: compaction can drop their anchors, and producers can refresh
  // them even when they precede the first retained user message.
  const kept = messages.filter(message => {
    const kind = message.runtimeOnly?.attachmentKind;
    const runtimeControl = message.runtimeOnly?.excludeFromDurableHistory === true;
    if (message.role !== "user" || (kind === undefined && !runtimeControl)) {
      return true;
    }
    if (!options.reminders && kind !== undefined && WORKFLOW_REMINDERS.has(kind)) return false;
    // The minimal text carries no built-in product help; the keyword-triggered help reminders go with it.
    if (minimal && kind === "product_help") return false;
    return true;
  });
  return { messages: kept, instructions };
}
