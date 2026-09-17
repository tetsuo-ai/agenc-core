import { expect, test, vi } from "vitest";
import { completionGate } from "../../src/phases/completion-gate.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import type { CompletedToolResultRecord, TurnState } from "../../src/session/turn-state.js";

function result(callId: string, override: Partial<CompletedToolResultRecord> = {}): CompletedToolResultRecord {
  return { callId, toolName: "FileRead", arguments: JSON.stringify({ file_path: "README.md" }), content: "project overview", isError: false, ...override };
}

function setup() {
  const emit = vi.fn();
  const session = {
    emit, nextInternalSubId: () => "synthetic-gate-event",
    services: { runtimeOptions: { nonInteractive: true } },
    sessionConfiguration: { sessionSource: "cli_main" },
  } as unknown as Session;
  const context = {
    subId: "synthetic-gate-turn", depth: 0,
    config: { maxTurns: 30 }, permissionMode: "default",
  } as unknown as TurnContext;
  const state = {
    messages: [{ role: "user", content: "Run pytest and report its result." }],
    assistantMessages: [{ uuid: "answer", role: "assistant", text: "- [-] pytest is unavailable in this environment", toolCalls: [] }],
    toolUseBlocks: [], needsFollowUp: false, transition: undefined, turnCount: 3,
    completedToolResults: [result("before-gate"), result("after-gate")],
    completionGate: { maxRounds: 10, taskText: "Run pytest and report its result." },
    completionGateRound: 1, completionGateToolLedgerMark: 1,
    completionGateSettled: false, completionGateUnavailablePrompted: false,
  } as unknown as TurnState;
  const last = () => emit.mock.calls.filter(([event]) => event.msg.type === "completion_gate").at(-1)?.[0].msg.payload;
  return { session, context, state, last };
}

test.each(["file read", "command"] as const)(
  "an unrelated successful %s does not prove pytest is unavailable",
  async kind => {
    const f = setup();
    await completionGate(f.state, f.context, f.session);
    expect(f.last()).toMatchObject({ outcome: "injected", reason: "unavailable_unproven" });
    expect(f.state.completionGateUnavailablePrompted).toBe(true);
    f.state.transition = undefined;
    f.state.completedToolResults.push(result("unrelated", kind === "command"
      ? { toolName: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }), content: "/workspace", metadata: { exitCode: 0 } }
      : {}));
    await completionGate(f.state, f.context, f.session);
    expect(f.last()).toMatchObject({ outcome: "injected", reason: "unavailable_unproven" });
    expect(f.state.completionGateSettled).toBe(false);
  },
);
