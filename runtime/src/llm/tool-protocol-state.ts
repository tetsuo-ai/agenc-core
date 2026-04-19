import type { LLMResponse, LLMToolCall } from "./types.js";

export type ToolProtocolRepairReason =
  | "circuit_breaker"
  | "finalization_guard"
  | "max_tool_rounds"
  | "missing_tool_handler"
  | "reactive_compact_retry"
  | "request_cancelled"
  | "request_timeout"
  | "round_aborted"
  | "stall_escalated"
  | "validation_recovery";

export interface PendingToolProtocolCall {
  readonly id: string;
  readonly name: string;
}

export interface ToolProtocolState {
  pendingToolCalls: Map<string, PendingToolProtocolCall>;
  repairCount: number;
  lastRepairReason?: ToolProtocolRepairReason;
  violationCount: number;
  lastViolation?: string;
}

export function createToolProtocolState(): ToolProtocolState {
  return {
    pendingToolCalls: new Map<string, PendingToolProtocolCall>(),
    repairCount: 0,
    lastRepairReason: undefined,
    violationCount: 0,
    lastViolation: undefined,
  };
}

export function responseHasToolCalls(
  response: Pick<LLMResponse, "toolCalls"> | undefined,
): boolean {
  return Boolean(response && response.toolCalls.length > 0);
}

export function responseHasMalformedToolFinish(
  response: Pick<LLMResponse, "finishReason" | "toolCalls"> | undefined,
): boolean {
  return Boolean(
    response &&
    response.finishReason === "tool_calls" &&
    response.toolCalls.length === 0,
  );
}

export function hasPendingToolProtocol(
  state: ToolProtocolState,
): boolean {
  return state.pendingToolCalls.size > 0;
}

export function getPendingToolProtocolCalls(
  state: ToolProtocolState,
): readonly PendingToolProtocolCall[] {
  return [...state.pendingToolCalls.values()];
}

export function openToolProtocolTurn(
  state: ToolProtocolState,
  toolCalls: readonly LLMToolCall[],
): void {
  state.pendingToolCalls = new Map(
    toolCalls.map((toolCall) => [
      toolCall.id,
      { id: toolCall.id, name: toolCall.name },
    ]),
  );
}

export function recordToolProtocolResult(
  state: ToolProtocolState,
  toolCallId: string | undefined,
): void {
  if (!toolCallId) return;
  state.pendingToolCalls.delete(toolCallId);
}

export function noteToolProtocolRepair(
  state: ToolProtocolState,
  reason: ToolProtocolRepairReason,
): void {
  state.repairCount++;
  state.lastRepairReason = reason;
}

export function noteToolProtocolViolation(
  state: ToolProtocolState,
  violation: string,
): void {
  state.violationCount++;
  state.lastViolation = violation;
}
