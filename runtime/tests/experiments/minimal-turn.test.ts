import { expect, test, vi } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";
vi.mock("../../src/phases/stream-model.js", () => ({ buildProviderOptions: () => ({ maxOutputTokens: 8192, reasoningEffort: "high" }) }));
vi.mock("../../src/session/run-turn-sampling-request.js", () => ({
  builtTools: () => [], buildPrompt: (input: unknown) => ({ input }),
}));
import { runMinimalTurn } from "../../src/session/minimal-turn.js";

function fixture(responses: unknown[]) {
  const history: { history?: LLMMessage[] } = {};
  const snapshots: LLMMessage[][] = [];
  const provider = { chatStream: vi.fn(async (messages: LLMMessage[]) => {
    snapshots.push(structuredClone(messages));
    return responses.shift();
  }) };
  const execCommand = vi.fn(async () => ({ stdout: "out", stderr: "err", exitCode: 7 }));
  const appendRollout = vi.fn();
  const session = { conversationId: "test", services: { provider, unifiedExecManager: { execCommand } },
    state: { with: async (fn: (state: typeof history) => void) => fn(history) },
    rolloutStore: { store: { appendRollout } }, emit: vi.fn(), nextInternalSubId: () => "event",
  } as unknown as Session;
  return { session, execCommand, snapshots, appendRollout, history, provider };
}

test("next request contains every actual command result and bound reasoning replay", async () => {
  const f = fixture([{ content: "", toolCalls: [
    { id: "a", name: "exec_command", arguments: '{"cmd":"first"}' },
    { id: "b", name: "exec_command", arguments: '{"cmd":"second"}' },
  ], providerReasoningContent: "opaque", providerReasoningProvenance: { provider: "deepseek", model: "test" } },
  { content: "done", toolCalls: [] }]);
  const events = [];
  for await (const event of runMinimalTurn(f.session, {} as TurnContext,
    [{ role: "user", content: "run commands" }], "instructions", new AbortController().signal)) events.push(event);
  expect(f.execCommand.mock.calls).toHaveLength(2);
  expect(f.snapshots[1]?.map(m => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
  expect(f.snapshots[1]?.[1]).toMatchObject({ providerReasoningContent: "opaque" });
  expect(JSON.parse(String(f.snapshots[1]?.[2]?.content))).toEqual({ stdout: "out", stderr: "err", exitCode: 7 });
  expect(f.snapshots[1]?.[3]?.toolCallId).toBe("b");
  expect(events.at(-1)).toMatchObject({ type: "turn_complete", content: "done" });
  expect(f.history.history).toHaveLength(5);
  expect(f.appendRollout).toHaveBeenCalledTimes(5);
});

test("aborted turns do not send a request or run a command", async () => {
  const f = fixture([]), controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const run = async () => { for await (const _ of runMinimalTurn(f.session, {} as TurnContext,
    [{ role: "user", content: "x" }], "", controller.signal)) {} };
  await expect(run()).rejects.toThrow("cancelled");
  expect(f.provider.chatStream).not.toHaveBeenCalled();
  expect(f.execCommand).not.toHaveBeenCalled();
});
