/**
 * Attachment-to-LLMMessage conversion.
 *
 * Hand-port of AgenC `createAttachmentMessage()`
 * (`src/utils/attachments.ts:3221`) plus the model-facing attachment
 * normalization in `src/utils/messages.ts::normalizeAttachmentForAPI`.
 *
 * Each attachment kind renders as one (or zero) `LLMMessage`. Attachments
 * are emitted on the user channel because AgenC's contract is that
 * the model treats them as user-context. System-reminder-style
 * attachments wrap their content in `<system-reminder>` tags inside the
 * user-channel message — matches AgenC's convention.
 *
 * AgenC branding substitutions use AgenC instruction filenames,
 * product names, and model-facing tool names. Unsupported
 * AgenC product surfaces (buddy, bagel, teammate swarms, IDE/LSP)
 * do not render here until AgenC ships the matching producer/runtime
 * feature.
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
      // Plan-mode prose for the per-turn pulse. The producer gates
      // full/sparse emission; this renderer owns the model-facing text.
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
        `<system-reminder>\n## Exited Auto Mode\n\nYou have exited auto mode. The user may now want to interact more directly. You should ask clarifying questions when the approach is ambiguous rather than making assumptions.\n</system-reminder>`,
      );
    }
    case "date_change": {
      return userContextMessage(
        wrapSystemReminder(
          `The date has changed. Today's date is now ${attachment.newDate}. DO NOT mention this to the user explicitly because they are already aware.`,
        ),
      );
    }
    case "critical_system_reminder": {
      return userContextMessage(
        `<system-reminder>\n${attachment.content}\n</system-reminder>`,
      );
    }
    case "output_style": {
      return userContextMessage(
        wrapSystemReminder(
          `${attachment.style} output style is active. Remember to follow the specific guidelines for this style.`,
        ),
      );
    }
    case "deferred_tools_delta": {
      const parts: string[] = [];
      if (attachment.addedNames.length > 0) {
        parts.push(
          `The following deferred tools are now available via ToolSearch:\n${attachment.addedLines.join("\n")}`,
        );
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following deferred tools are no longer available (their MCP server disconnected). Do not search for them -- ToolSearch will return no match:\n${attachment.removedNames.join("\n")}`,
        );
      }
      if (parts.length === 0) return null;
      return userContextMessage(wrapSystemReminder(parts.join("\n\n")));
    }
    case "agent_listing_delta": {
      const parts: string[] = [];
      if (attachment.addedLines.length > 0) {
        const header = attachment.isInitial
          ? "Available agent types for the Agent tool:"
          : "New agent types are now available for the Agent tool:";
        parts.push(`${header}\n${attachment.addedLines.join("\n")}`);
      }
      if (attachment.removedTypes.length > 0) {
        parts.push(
          `The following agent types are no longer available:\n${attachment.removedTypes.map((t) => `- ${t}`).join("\n")}`,
        );
      }
      if (parts.length === 0) return null;
      return userContextMessage(wrapSystemReminder(parts.join("\n\n")));
    }
    case "mcp_instructions_delta": {
      const parts: string[] = [];
      if (attachment.addedBlocks.length > 0) {
        parts.push(
          `# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n${attachment.addedBlocks.join("\n\n")}`,
        );
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following MCP servers have disconnected. Their instructions above no longer apply:\n${attachment.removedNames.join("\n")}`,
        );
      }
      if (parts.length === 0) return null;
      return userContextMessage(wrapSystemReminder(parts.join("\n\n")));
    }
    case "edited_text_file": {
      return userContextMessage(
        wrapSystemReminder(
          `Note: ${attachment.filename} was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware. Here are the relevant changes (shown with line numbers):\n${attachment.snippet}`,
        ),
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
        wrapSystemReminder(
          `The user has expressed a desire to invoke the agent "${attachment.agentType}". Please invoke the agent appropriately, passing in the required context to it. `,
        ),
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

function wrapSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}

// ──────────────────────────────────────────────────────────────────────
// Plan-mode / auto-mode body builders.
//
// These are AgenC-style bodies for the per-turn pulse, adapted for
// AgenC tool names and the producer surfaces currently present here.
// Prose source: `AgenC/src/utils/messages.ts` plan/auto rendering.
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
    return `Plan mode is active. Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (${planFilePath}). Follow the planning workflow: explore codebase, ask the user clarifying questions when needed, and write to the plan incrementally. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). Never ask about plan approval via text or AskUserQuestion.`;
  }
  const planLine = planExists
    ? `A plan file already exists at ${planFilePath}. You can read it and make incremental edits using the Edit tool.`
    : `No plan file exists yet. You should create your plan at ${planFilePath} using the Write tool.`;
  return `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${planLine}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused -- avoid proposing new code when suitable implementations already exist.

2. Use read-only tools to efficiently explore the codebase. If the task is complex and AgenC exposes suitable agent types in this session, you may use agents to parallelize exploration, but keep each agent's scope specific.

### Phase 2: Design
Goal: Design an implementation approach.

Build an implementation approach based on the user's intent and your exploration results from Phase 1.

**Guidelines:**
- **Default**: Produce one clear recommended approach for most tasks.
- **Skip extra process**: For truly trivial tasks (typo fixes, single-line changes, simple renames), keep the plan correspondingly small.
- **Compare approaches only when useful**: If there are meaningful alternatives, explain the tradeoff briefly and choose one.

### Phase 3: Review
Goal: Review the plan and ensure alignment with the user's intentions.
1. Read the critical files identified during exploration to deepen your understanding.
2. Ensure that the plan aligns with the user's original request.
3. Use AskUserQuestion to clarify any remaining questions with the user.

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Begin with a **Context** section: explain why this change is being made -- the problem or need it addresses, what prompted it, and the intended outcome.
- Include only your recommended approach, not all alternatives.
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively.
- Include the paths of critical files to be modified.
- Reference existing functions and utilities you found that should be reused, with their file paths.
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests).

### Phase 5: Call ExitPlanMode
At the very end of your turn, once you have asked the user questions and are happy with your final plan file, you should call ExitPlanMode to indicate to the user that you are done planning.
This is critical - your turn should only end with either using AskUserQuestion OR calling ExitPlanMode. Do not stop unless it's for these 2 reasons.

**Important:** Use AskUserQuestion ONLY to clarify requirements or choose between approaches. Use ExitPlanMode to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ExitPlanMode.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using AskUserQuestion. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`;
}

function planModeReentryBody(
  planFilePath: string,
  planExists: boolean,
): string {
  const planLine = planExists
    ? `A plan file exists at ${planFilePath} from a previous planning session.`
    : `No plan file exists yet. Create your plan at ${planFilePath}.`;
  return `## Re-entering plan mode

You are returning to plan mode after having previously exited it. ${planLine}

**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned.
2. Evaluate the user's current request against that plan.
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task -- even if it's similar or related -- start fresh by overwriting the existing plan.
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections.
4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ExitPlanMode.

Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`;
}

function planModeExitBody(
  planFilePath: string,
  planExists: boolean,
): string {
  const planRef = planExists
    ? ` The plan file is located at ${planFilePath} if you need to reference it.`
    : "";
  return `## Exited plan mode

You have exited plan mode. You can now make edits, run tools, and take actions.${planRef}`;
}

function autoModeBody(variant: "full" | "sparse"): string {
  if (variant === "sparse") {
    return `Auto mode is active. Auto mode still active (see full instructions earlier in conversation). Execute autonomously, minimize interruptions, prefer action over planning.`;
  }
  return `## Auto Mode Active

Auto mode is active. The user chose continuous, autonomous execution. You should:

1. **Execute immediately** -- Start implementing right away. Make reasonable assumptions and proceed on low-risk work.
2. **Minimize interruptions** -- Prefer making reasonable assumptions over asking questions for routine decisions.
3. **Prefer action over planning** -- Do not enter plan mode unless the user explicitly asks. When in doubt, start coding.
4. **Expect course corrections** -- The user may provide suggestions or course corrections at any point; treat those as normal input.
5. **Do not take overly destructive actions** -- Auto mode is not a license to destroy. Anything that deletes data or modifies shared or production systems still needs explicit user confirmation. If you reach such a decision point, ask and wait, or course correct to a safer method instead.
6. **Avoid data exfiltration** -- Post even routine messages to chat platforms or work tickets only if the user has directed you to. You must not share secrets (e.g. credentials, internal documentation) unless the user has explicitly authorized both that specific secret and its destination.`;
}
