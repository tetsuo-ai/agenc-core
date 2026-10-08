import { formatUnknownToolMessage, type ToolSuggestion } from "./tool-name-suggestion.js";
import { buildRecoverableToolFailureMetadata } from "./result-metadata.js";
import { createToolEffectDispositionEvidence } from "./effect-boundary.js";
import type { ToolResult } from "./types.js";

export function plainTextErrorToolResult(message: string): ToolResult {
  return { content: message, isError: true };
}

/**
 * Error result for a refusal produced BEFORE the tool performed any effect
 * (argument/mode/state validation). Carries an authoritative
 * `confirmed_no_effect` disposition so the admitted-tool-call boundary does
 * not treat the refusal as an unknown-outcome effect: a bare `isError`
 * result from a non-idempotent tool poisons the session's mutation gate
 * (#1751 — a misfired ExitPlanMode blocked every later side-effecting call).
 * Only use this for paths that provably touched nothing.
 */
/**
 * A refusal a mutating tool makes before it touches anything, named after the
 * tool. Without the disposition the executor files the error as an unknown
 * outcome and gates the whole session behind /resolve (#2190).
 */
export function preEffectRefusal(toolName: string, message: string): ToolResult {
  return validationErrorToolResult(`tool:${toolName}:validation`, message);
}

export function validationErrorToolResult(
  evidenceRef: string,
  message: string,
): ToolResult {
  return {
    content: message,
    isError: true,
    effectDisposition: createToolEffectDispositionEvidence({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
      evidenceRef,
      evidenceMaterial: message,
    }),
  };
}

/** A rejected name has no execution interval or tool effect. */
export function unknownToolResult(toolName: string, callId: string, suggestion?: ToolSuggestion): ToolResult {
  const message = formatUnknownToolMessage(toolName, suggestion?.name, suggestion?.loadWith);
  const content = JSON.stringify({ tool_use_id: callId, is_error: true, content: `<tool_use_error>Error: ${message}</tool_use_error>` });
  return {
    ...validationErrorToolResult(`tool:${toolName}:unknown_tool`, content),
    metadata: { ...buildRecoverableToolFailureMetadata("input_validation"), preflightCode: "unknown_tool" },
  };
}
