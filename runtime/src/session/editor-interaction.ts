import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import {
  EDITOR_PROPOSAL_TOOL_NAME,
  type EditorProposalPayload,
} from "../tools/system/editor-proposal.js";
import { EDITOR_INTERACTION_READ_TOOL_NAMES } from "../tools/system/editor-interaction-surface.js";
import type { Tool } from "../tools/types.js";
import type { SessionEditorInteraction } from "./autonomous-mode.js";

/**
 * Editor turns are a stricter boundary than ordinary permission-mode reads.
 * These names are the small, runtime-owned builtin surface whose
 * implementations have been audited as workspace reads. In particular, MCP
 * `readOnlyHint` and plugin metadata are advisory and must never cross this
 * boundary.
 */
const AUDITED_EDITOR_READ_TOOLS: ReadonlySet<string> = new Set(
  EDITOR_INTERACTION_READ_TOOL_NAMES,
);

export const EDITOR_INTERACTION_MAX_SAMPLING_ITERATIONS = 12;
export const EDITOR_INTERACTION_MAX_TOOL_CALLS = 32;

export function editorInteractionSystemPrompt(
  interaction: SessionEditorInteraction,
): string {
  const identity = JSON.stringify({
    interaction_id: interaction.interactionId,
    path: interaction.path ?? "",
    buffer_handle: interaction.bufferHandle,
    base_changedtick: interaction.changedtick,
    base_content_sha256: interaction.contentSha256,
    range: interaction.range,
    ...(interaction.selectionMode !== undefined
      ? { selection_mode: interaction.selectionMode }
      : {}),
    coordinate_contract: {
      line_base: 1,
      column_base: 0,
      column_unit: "utf8_byte",
      end_exclusive: true,
    },
  });
  const common = [
    "<editor_interaction_policy>",
    "This is a trusted, request-scoped interaction with the embedded editor.",
    "The editor owns the live buffer. Do not change files, buffers, git state, processes, configuration, tasks, or any other workspace state in this turn.",
    "You may inspect context using only explicitly read-only tools.",
    `The immutable editor revision identity is: ${identity}`,
  ];
  if (interaction.policy === "read_only") {
    return [
      ...common,
      "Answer the user's question directly. Do not call EditorProposal and do not propose an edit as a tool result.",
      "</editor_interaction_policy>",
    ].join("\n");
  }
  return [
    ...common,
    "Return the requested code change only by calling EditorProposal exactly once.",
    "Copy every immutable identity field above exactly into that call. Each edit must contain the exact old_text from the supplied live-buffer snapshot and its replacement new_text.",
    "Do not claim that the change has been applied. AgenC will render it as a shadow proposal; only the user can accept it.",
    "</editor_interaction_policy>",
  ].join("\n");
}

export function editorInteractionAllowsTool(
  interaction: SessionEditorInteraction,
  tool: Tool | undefined,
  trustedTool: Tool | undefined,
): boolean {
  if (
    tool !== undefined &&
    tool === trustedTool &&
    tool.metadata?.source === "builtin" &&
    tool.metadata.mutating === false &&
    tool.serverId === undefined &&
    tool.isReadOnly === true &&
    tool.recoveryCategory === "idempotent"
  ) {
    if (tool.name === EDITOR_PROPOSAL_TOOL_NAME) {
      return (
        interaction.policy === "proposal_only" &&
        tool.metadata.family === "editor" &&
        tool.metadata.hiddenByDefault === true &&
        tool.metadata.deferred === true
      );
    }
    return AUDITED_EDITOR_READ_TOOLS.has(tool.name);
  }
  return false;
}

export function editorInteractionToolCallDenial(
  interaction: SessionEditorInteraction,
  tool: Tool | undefined,
  call: Pick<LLMToolCall, "name" | "arguments">,
  trustedTool: Tool | undefined,
): string | null {
  if (
    tool?.name !== call.name ||
    !editorInteractionAllowsTool(interaction, tool, trustedTool)
  ) {
    return (
      `tool '${call.name}' is not allowed during a ` +
      `${interaction.policy} editor interaction`
    );
  }
  if (call.name !== "FileRead") return null;
  let input: unknown;
  try {
    input = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as { readonly file_path?: unknown }).file_path === "string" &&
    (input as { readonly file_path: string }).file_path
      .trim()
      .toLowerCase()
      .endsWith(".pdf")
  ) {
    return (
      "FileRead cannot open PDF files during an Editor interaction because " +
      "PDF reads require external helper processes"
    );
  }
  return null;
}

export function modelToolFromRuntimeTool(tool: Tool): LLMTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

export function validateEditorProposalResultForInteraction(
  interaction: SessionEditorInteraction,
  result: ToolDispatchResult,
): ToolDispatchResult {
  if (result.isError === true) return result;
  const proposal = result.metadata?.editorProposal;
  if (!isEditorProposalPayload(proposal)) {
    return invalidProposalResult(
      "EditorProposal returned no validated proposal metadata",
    );
  }
  const expectedPath = interaction.path ?? "";
  if (proposal.interaction_id !== interaction.interactionId) {
    return invalidProposalResult(
      "EditorProposal interaction_id does not match the active editor request",
    );
  }
  if (proposal.path !== expectedPath) {
    return invalidProposalResult(
      "EditorProposal path does not match the active editor buffer",
    );
  }
  if (proposal.buffer_handle !== interaction.bufferHandle) {
    return invalidProposalResult(
      "EditorProposal buffer_handle does not match the active editor buffer",
    );
  }
  if (proposal.base_changedtick !== interaction.changedtick) {
    return invalidProposalResult("EditorProposal base_changedtick is stale");
  }
  if (
    proposal.base_content_sha256.toLowerCase() !==
    interaction.contentSha256.toLowerCase()
  ) {
    return invalidProposalResult(
      "EditorProposal base_content_sha256 does not match the active editor buffer",
    );
  }
  return result;
}

function invalidProposalResult(message: string): ToolDispatchResult {
  return {
    content: JSON.stringify({ error: message }),
    isError: true,
    metadata: {
      editorProposalRejected: true,
    },
  };
}

function isEditorProposalPayload(
  value: unknown,
): value is EditorProposalPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proposal = value as Partial<EditorProposalPayload>;
  return (
    proposal.version === 1 &&
    typeof proposal.interaction_id === "string" &&
    typeof proposal.path === "string" &&
    Number.isSafeInteger(proposal.buffer_handle) &&
    Number.isSafeInteger(proposal.base_changedtick) &&
    typeof proposal.base_content_sha256 === "string" &&
    typeof proposal.summary === "string" &&
    Array.isArray(proposal.edits)
  );
}
