/**
 * Attachment-to-LLMMessage conversion.
 *
 * Hand-port of openclaude `createAttachmentMessage()`
 * (`src/utils/attachments.ts:3221`) plus the message-block formatting
 * that lives at the `query.ts:1688-1698` injection site.
 *
 * Each attachment kind renders as one (or zero) `LLMMessage`. Attachments
 * are emitted on the user channel because openclaude's contract is that
 * the model treats them as user-context. System-reminder-style
 * attachments wrap their content in `<system-reminder>` tags inside the
 * user-channel message — matches openclaude's convention.
 *
 * AgenC branding substitutions ONLY: `AGENC.md` for `CLAUDE.md`, `AgenC`
 * for `OpenClaude`/`Claude Code` where the prose names a product. Every
 * other byte of the attachment-rendering prose is verbatim openclaude.
 *
 * @module
 */

import type { LLMMessage } from "../../llm/types.js";
import type { Attachment } from "./types.js";

/**
 * Convert a list of attachments into the corresponding `LLMMessage[]`,
 * preserving order. Attachments that render as nothing (e.g. a producer
 * that emits an attachment whose payload is empty) are skipped.
 */
export function attachmentsToMessages(
  attachments: readonly Attachment[],
): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const attachment of attachments) {
    const message = renderAttachment(attachment);
    if (message !== null) out.push(message);
  }
  return out;
}

/**
 * Renders a single attachment as a user-channel message, or null when the
 * attachment payload would render to no useful content.
 */
function renderAttachment(attachment: Attachment): LLMMessage | null {
  switch (attachment.kind) {
    case "nested_memory": {
      const header = `## Memory: ${attachment.displayPath} (${attachment.memoryType})\n`;
      return userContextMessage(`${header}${attachment.content}`);
    }
    case "relevant_memories": {
      if (attachment.memories.length === 0) return null;
      const blocks = attachment.memories.map((mem) => {
        const head = mem.header ?? `## ${mem.path}`;
        const truncationNote =
          mem.limit !== undefined
            ? `\n\n> This memory file was truncated at ${mem.limit} lines.`
            : "";
        return `${head}\n${mem.content}${truncationNote}`;
      });
      return userContextMessage(
        `<system-reminder>\n## Relevant memories\n\n${blocks.join("\n\n")}\n</system-reminder>`,
      );
    }
    case "plan_mode": {
      // Plan-mode prose for the per-turn pulse. The producer
      // (./plan-mode.ts) consults `runtime/src/planning/plan-instructions.ts`
      // for the actual full / sparse text — this renderer just wraps.
      // Source: openclaude attachments.ts:566-577 (plan_mode rendering at
      // the createAttachmentMessage call site).
      return userContextMessage(
        `<system-reminder>\n${planModeBody(attachment.variant, attachment.planFilePath, attachment.planExists)}\n</system-reminder>`,
      );
    }
    case "plan_mode_reentry": {
      return userContextMessage(
        `<system-reminder>\n${planModeReentryBody(attachment.planFilePath, attachment.planExists)}\n</system-reminder>`,
      );
    }
    case "plan_mode_exit": {
      return userContextMessage(
        `<system-reminder>\n${planModeExitBody(attachment.planFilePath, attachment.planExists)}\n</system-reminder>`,
      );
    }
    case "auto_mode": {
      return userContextMessage(
        `<system-reminder>\n${autoModeBody(attachment.variant)}\n</system-reminder>`,
      );
    }
    case "auto_mode_exit": {
      return userContextMessage(
        `<system-reminder>\nYou have exited auto mode. Tool approvals are now requested per call.\n</system-reminder>`,
      );
    }
    case "date_change": {
      return userContextMessage(
        `<system-reminder>\nThe local calendar date is now ${attachment.newDate}.\n</system-reminder>`,
      );
    }
    case "critical_system_reminder": {
      return userContextMessage(
        `<system-reminder>\n${attachment.content}\n</system-reminder>`,
      );
    }
    case "output_style": {
      return userContextMessage(
        `<system-reminder>\nActive output style: ${attachment.style}.\n</system-reminder>`,
      );
    }
    case "deferred_tools_delta": {
      const lines: string[] = ["<system-reminder>", "## Tool catalog updated"];
      if (attachment.addedNames.length > 0) {
        lines.push("Added:", ...attachment.addedLines.map((l) => `- ${l}`));
      }
      if (attachment.removedNames.length > 0) {
        lines.push(
          "Removed:",
          ...attachment.removedNames.map((n) => `- ${n}`),
        );
      }
      lines.push("</system-reminder>");
      return userContextMessage(lines.join("\n"));
    }
    case "agent_listing_delta": {
      const heading = attachment.isInitial
        ? "## Available agents"
        : "## Agent listing updated";
      const lines: string[] = ["<system-reminder>", heading];
      if (attachment.addedLines.length > 0) {
        const addedHeading = attachment.isInitial ? "" : "Added:";
        if (addedHeading.length > 0) lines.push(addedHeading);
        for (const line of attachment.addedLines) lines.push(`- ${line}`);
      }
      if (attachment.removedTypes.length > 0) {
        lines.push("Removed:");
        for (const type of attachment.removedTypes) lines.push(`- ${type}`);
      }
      lines.push("</system-reminder>");
      return userContextMessage(lines.join("\n"));
    }
    case "mcp_instructions_delta": {
      const lines: string[] = [
        "<system-reminder>",
        "## MCP server instructions updated",
      ];
      if (attachment.addedNames.length > 0) {
        for (let i = 0; i < attachment.addedNames.length; i += 1) {
          lines.push(`### ${attachment.addedNames[i]}`);
          lines.push(attachment.addedBlocks[i] ?? "");
        }
      }
      if (attachment.removedNames.length > 0) {
        lines.push("Removed:");
        for (const name of attachment.removedNames) lines.push(`- ${name}`);
      }
      lines.push("</system-reminder>");
      return userContextMessage(lines.join("\n"));
    }
    case "edited_text_file": {
      return userContextMessage(
        `<system-reminder>\nThe file \`${attachment.filename}\` was modified. Diff:\n\n${attachment.snippet}\n</system-reminder>`,
      );
    }
    case "edited_image_file": {
      // Image diffs are surfaced via the structured content path so
      // multimodal providers can render them. Text body carries a small
      // header so providers without multimodal support still see context.
      return {
        role: "user",
        content: [
          {
            type: "text",
            text: `<system-reminder>\nThe image \`${attachment.filename}\` was modified. Updated content:\n</system-reminder>`,
          } as never,
          {
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mediaType,
              data: attachment.content,
            },
          } as never,
        ],
        runtimeOnly: { mergeBoundary: "user_context" },
      };
    }
    case "agent_mention": {
      return userContextMessage(
        `<system-reminder>\nThe user mentioned the \`${attachment.agentType}\` agent.\n</system-reminder>`,
      );
    }
  }
}

function userContextMessage(text: string): LLMMessage {
  return {
    role: "user",
    content: text,
    runtimeOnly: { mergeBoundary: "user_context" },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Plan-mode / auto-mode body builders.
//
// These are the verbatim openclaude bodies for the per-turn pulse,
// adapted for AgenC tool names. Prose source:
// `openclaude/src/utils/attachments.ts:1187-1243` (plan-mode bodies)
// and `:1336-1378` (auto-mode bodies).
//
// Kept inline rather than re-imported from `planning/plan-instructions.ts`
// so producers and the renderer share one source of truth and can
// evolve together. The producer file gates which variant fires; this
// file owns the prose.
// ──────────────────────────────────────────────────────────────────────

function planModeBody(
  variant: "full" | "sparse",
  planFilePath: string,
  planExists: boolean,
): string {
  if (variant === "sparse") {
    return `Plan mode is active. Read-only tools only; the only writable target is the active AgenC plan file at ${planFilePath}. End your turn with AskUserQuestion or ExitPlanMode.`;
  }
  const planLine = planExists
    ? `A plan file already exists at ${planFilePath}. You can read it and make incremental edits using the Edit tool.`
    : `No plan file exists yet. Create your plan at ${planFilePath} using the Write tool.`;
  return `Plan mode is active. The user indicated that they do not want you to execute yet — you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.\n\n## Plan File Info\n${planLine}\n\nYou should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit — other than this you are only allowed to take READ-ONLY actions.`;
}

function planModeReentryBody(
  planFilePath: string,
  planExists: boolean,
): string {
  const planLine = planExists
    ? `A plan file exists at ${planFilePath} from a previous planning session.`
    : `No plan file exists yet. Create your plan at ${planFilePath}.`;
  return `## Re-entering plan mode\n\nYou are returning to plan mode after having previously exited it. ${planLine}\n\nBefore proceeding with any new planning, evaluate the user's current request against any prior plan and decide whether to start fresh or continue. Always edit the plan file before calling ExitPlanMode.`;
}

function planModeExitBody(
  planFilePath: string,
  planExists: boolean,
): string {
  const planRef = planExists
    ? ` The plan file is located at ${planFilePath} if you need to reference it.`
    : "";
  return `## Exited plan mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions.${planRef}`;
}

function autoModeBody(variant: "full" | "sparse"): string {
  if (variant === "sparse") {
    return `Auto mode is active — tool calls do not require per-call approval. Continue working autonomously toward the user's goal; ask for input only when genuinely blocked.`;
  }
  return `Auto mode is active. The user has authorized autonomous tool execution for this session — tool calls run without per-call approval prompts. Persist until the task is complete; only stop to ask the user when you cannot proceed safely or correctly without their input. Use the same diagnostic and verification habits you would in a normal session.`;
}
