import { vi } from "vitest";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import type { CompletedToolResultRecord, TurnState } from "../../src/session/turn-state.js";

/**
 * Shared construction for the synthetic completion-gate cases. Each file that
 * drives the gate directly needs the same session, context and turn state, and
 * spelling it out per file duplicated it verbatim. No tool, provider, model or
 * benchmark runs here.
 */
export function syntheticResult(
  callId: string,
  override: Partial<CompletedToolResultRecord> = {},
): CompletedToolResultRecord {
  return {
    callId,
    toolName: "FileRead",
    arguments: JSON.stringify({ file_path: "README.md" }),
    content: "project overview",
    isError: false,
    ...override,
  };
}

export function syntheticGate(taskText: string, answerText: string) {
  const emit = vi.fn();
  const session = {
    emit,
    nextInternalSubId: () => "synthetic-gate-event",
    services: { runtimeOptions: { nonInteractive: true } },
    sessionConfiguration: { sessionSource: "cli_main" },
  } as unknown as Session;
  const context = {
    subId: "synthetic-gate-turn",
    depth: 0,
    config: { maxTurns: 30 },
    permissionMode: "default",
  } as unknown as TurnContext;
  const state = {
    messages: [{ role: "user", content: taskText }],
    assistantMessages: [
      { uuid: "answer", role: "assistant", text: answerText, toolCalls: [] },
    ],
    toolUseBlocks: [],
    needsFollowUp: false,
    transition: undefined,
    turnCount: 3,
    completedToolResults: [
      syntheticResult("before-gate"),
      syntheticResult("after-gate"),
    ],
    completionGate: { maxRounds: 10, taskText },
    completionGateRound: 1,
    completionGateToolLedgerMark: 1,
    completionGateSettled: false,
    completionGateUnavailablePrompted: false,
  } as unknown as TurnState;
  const last = () =>
    emit.mock.calls
      .filter(([event]) => event.msg.type === "completion_gate")
      .at(-1)?.[0].msg.payload;
  return { session, context, state, last };
}
