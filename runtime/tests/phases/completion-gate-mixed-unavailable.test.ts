import { expect, test, vi } from "vitest";
import { completionGate } from "../../src/phases/completion-gate.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import type { CompletedToolResultRecord, TurnState } from "../../src/session/turn-state.js";

function result(callId: string, override: Partial<CompletedToolResultRecord> = {}): CompletedToolResultRecord {
  return { callId, toolName: "FileRead", arguments: JSON.stringify({ file_path: "README.md" }), content: "project overview", isError: false, ...override };
}

function setup(answerText = "- [x] README.md was read successfully\n- [-] pytest is unavailable in this environment") {
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
    messages: [{ role: "user", content: "Read README.md and run pytest; report both results." }],
    assistantMessages: [{ uuid: "answer", role: "assistant", text: answerText, toolCalls: [] }],
    toolUseBlocks: [], needsFollowUp: false, transition: undefined, turnCount: 3,
    completedToolResults: [result("before-gate"), result("after-gate")],
    completionGate: { maxRounds: 10, taskText: "Read README.md and run pytest; report both results." },
    completionGateRound: 1, completionGateToolLedgerMark: 1,
    completionGateSettled: false, completionGateUnavailablePrompted: false,
  } as unknown as TurnState;
  const last = () => emit.mock.calls.filter(([event]) => event.msg.type === "completion_gate").at(-1)?.[0].msg.payload;
  return { session, context, state, last };
}

test.each(["file read", "command"] as const)(
  "a verified README item plus unrelated %s does not prove pytest is unavailable",
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
    // With freshness enforced, an unrelated pwd leaves the README claim without
    // an associated success since the latest request, so that item is itself
    // unmet and the gate says so. A fresh README read keeps it verified and the
    // pytest leftover is what remains unproven. Either way nothing settles.
    expect(f.last()).toMatchObject({
      outcome: "injected",
      reason: kind === "command" ? "unmet_items" : "unavailable_unproven",
    });
    expect(f.state.completionGateSettled).toBe(false);
  },
);

test("an old passing pytest result cannot verify changed code after only an unrelated new read", async () => {
  const f = setup("- [x] pytest completed successfully");
  f.state.completedToolResults = [
    result("old-check", {
      toolName: "exec_command", arguments: JSON.stringify({ cmd: "pytest" }),
      content: "3 passed", metadata: { exitCode: 0 },
    }),
    result("subsequent-edit", {
      toolName: "FileWrite", arguments: JSON.stringify({ file_path: "app/main.py" }),
      content: "source updated",
    }),
  ];
  f.state.completionGateToolLedgerMark = 2;
  f.state.completedToolResults.push(result("new-unrelated-read"));
  await completionGate(f.state, f.context, f.session);
  expect(f.last()).toMatchObject({ outcome: "injected", reason: "unmet_items" });
  expect(f.state.completionGateSettled).toBe(false);
});
