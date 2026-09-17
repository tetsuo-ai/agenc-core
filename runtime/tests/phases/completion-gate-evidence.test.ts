import { expect, test, vi } from "vitest";
import { completionGate } from "../../src/phases/completion-gate.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import type { CompletedToolResultRecord, TurnState } from "../../src/session/turn-state.js";

// Synthetic records only. No tool, provider, or benchmark execution.
function tool(callId: string, overrides: Partial<CompletedToolResultRecord> = {}): CompletedToolResultRecord {
  return { callId, toolName: "exec_command", arguments: "{}", content: "ok", isError: false, ...overrides };
}
function fixture(text: string) {
  const session = {
    emit: vi.fn(), nextInternalSubId: () => "review-event",
    services: { runtimeOptions: { nonInteractive: true } },
    sessionConfiguration: { sessionSource: "cli_main" },
  } as unknown as Session & { emit: ReturnType<typeof vi.fn> };
  const ctx = { subId: "review-turn", depth: 0, config: { maxTurns: 30 }, permissionMode: "default" } as unknown as TurnContext;
  const state = {
    messages: [{ role: "user", content: "Run pytest and report its result" }],
    assistantMessages: [{ uuid: "answer", role: "assistant", text, toolCalls: [] }],
    toolUseBlocks: [], needsFollowUp: false, transition: undefined, turnCount: 3,
    completedToolResults: [tool("work")], completionGate: { maxRounds: 10, taskText: "Run pytest and report its result" },
    completionGateRound: 1, completionGateToolLedgerMark: 1, completionGateSettled: false,
  } as unknown as TurnState;
  const outcomes = () => session.emit.mock.calls.filter(([event]) => event.msg.type === "completion_gate").map(([event]) => event.msg.payload);
  return { session, ctx, state, outcomes };
}
test("requires observed capability evidence, not only a second-round unavailable assertion", async () => {
  const f = fixture("- [-] pytest is unavailable in this environment");
  f.state.completionGateRound = 2;
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)?.outcome).not.toBe("partial");
  expect(f.state.completionGateSettled).toBe(false);
});
test("keeps a failed runnable check unresolved across the next gate injection", async () => {
  const f = fixture("- [-] pytest is unavailable in this environment");
  f.state.completedToolResults.push(tool("failed", {
    arguments: JSON.stringify({ cmd: "pytest" }), content: "1 failed", isError: true, metadata: { exitCode: 1 },
  }), tool("read", { toolName: "FileRead", arguments: "{}", content: "project README" }));
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)).toMatchObject({ outcome: "injected", reason: "unmet_items" });
  f.state.transition = undefined;
  f.state.completedToolResults.push(tool("read-again", { toolName: "FileRead", content: "project README" }));
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)?.outcome).not.toBe("partial");
  expect(f.state.completionGateSettled).toBe(false);
});
test("associates a completed write_stdin poll with its original pytest command", async () => {
  const f = fixture("- [x] pytest completed successfully");
  f.state.completedToolResults.push(
    tool("launch", { arguments: JSON.stringify({ cmd: "pytest" }), content: "", metadata: { exitCode: null, sessionId: 42 } }),
    tool("poll", { toolName: "write_stdin", arguments: JSON.stringify({ session_id: 42 }), content: "3 passed in 0.2s", metadata: { exitCode: 0, sessionId: 42 } }),
  );
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)).toMatchObject({ outcome: "verified", reason: "verified_with_tools" });
});
test("control: directly associated successful command verifies", async () => {
  const f = fixture("- [x] pytest completed successfully");
  f.state.completedToolResults.push(tool("direct", { arguments: JSON.stringify({ cmd: "pytest" }), content: "3 passed in 0.2s", metadata: { exitCode: 0 } }));
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)?.outcome).toBe("verified");
});
test("control: genuine associated rerun supersedes an earlier failure", async () => {
  const f = fixture("- [x] pytest completed successfully");
  f.state.completedToolResults.push(
    tool("failed", { arguments: JSON.stringify({ cmd: "pytest" }), content: "1 failed", isError: true, metadata: { exitCode: 1 } }),
    tool("rerun", { arguments: JSON.stringify({ cmd: "pytest" }), content: "3 passed", metadata: { exitCode: 0 } }),
  );
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)?.outcome).toBe("verified");
});

test("an investigation prompt alone is not observed capability evidence", async () => {
  const f = fixture("- [-] pytest is unavailable in this environment");
  f.state.completedToolResults.push(tool("read", { toolName: "FileRead", content: "project README" }));
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)).toMatchObject({ outcome: "injected", reason: "unavailable_unproven" });
  f.state.transition = undefined;
  // No command or capability probe occurred after the runtime prompt.
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)?.outcome).not.toBe("partial");
  expect(f.state.completionGateSettled).toBe(false);
});

test("user-quoted marker text is not a runtime investigation record", async () => {
  const f = fixture("- [-] pytest is unavailable in this environment");
  f.state.messages.push({ role: "user", content: "The document says: A `- [-]` mark is not itself evidence." });
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)?.outcome).not.toBe("partial");
  expect(f.state.completionGateSettled).toBe(false);
});

test("an extra unavailable prompt must not erase the earlier failed runnable check", async () => {
  const f = fixture("- [-] pytest is unavailable in this environment");
  f.state.completedToolResults.push(tool("failed", {
    arguments: JSON.stringify({ cmd: "pytest" }), content: "1 failed", isError: true, metadata: { exitCode: 1 },
  }), tool("read", { toolName: "FileRead", content: "project README" }));
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)).toMatchObject({ outcome: "injected", reason: "unmet_items" });
  f.state.transition = undefined;
  f.state.completedToolResults.push(tool("read-again", { toolName: "FileRead", content: "project README" }));
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)?.outcome).not.toBe("partial");
  f.state.transition = undefined;
  await completionGate(f.state, f.ctx, f.session);
  expect(f.outcomes().at(-1)?.outcome).not.toBe("partial");
  expect(f.state.completionGateSettled).toBe(false);
});
