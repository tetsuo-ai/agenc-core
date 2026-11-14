import { expect, test, vi } from "vitest";

import type { LLMMessage, LLMResponse, LLMToolCall } from "../../src/llm/types.js";
import { oneShotFastModeActive } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

test.each([false, true])("execution and follow-up history keep literal entities (fast=%s)", async (fast) => {
  const args = { file_path: "entities.html", content: "&lt; &gt; &amp; &quot; &#39; &amp;lt;\n" };
  const call: LLMToolCall = { id: "write-entities", name: "Write", arguments: JSON.stringify(args) };
  const execute = vi.fn(async (_input: Record<string, unknown>) => ({ content: "written" }));
  const provider = mkProvider();
  const requests: LLMMessage[][] = [];
  let fastCalls = 0;
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    requests.push(structuredClone(messages));
    if (oneShotFastModeActive()) fastCalls++;
    return {
      content: requests.length === 1 ? "" : "done",
      toolCalls: requests.length === 1 ? [call] : [],
      finishReason: requests.length === 1 ? "tool_calls" : "stop",
      model: "test-model",
      usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 },
    };
  };
  const { session, events } = mkSession({
    provider,
    registry: {
      tools: [{ name: "Write", description: "Write", inputSchema: { type: "object" }, execute }],
      toLLMTools: () => [],
      dispatch: async (toolCall: LLMToolCall) => execute(JSON.parse(toolCall.arguments)),
    } as never,
    services: {
      runtimeOptions: resolveAgentRuntimeOptions({}, {
        lightMode: true,
        nonInteractive: true,
        dangerouslyBypassApprovalsAndSandbox: true,
        relaxedOneShot: true,
      }),
    },
  });
  Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
    ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
  }) });
  const ctx = mkCtx({
    permissionMode: "bypassPermissions",
    sandboxPolicy: { value: "danger_full_access" },
    config: { ...mkCtx().config, bypassFastMode: fast },
  });
  const turn = runTurn(session, ctx, "Write the literal entities, then finish.", { exactOutput: true });
  let terminal;
  for (;;) {
    const next = await turn.next();
    if (next.done) { terminal = next.value; break; }
  }

  expect(terminal?.reason).toBe("completed");
  expect(requests).toHaveLength(2);
  expect(fastCalls).toBe(fast ? 2 : 0);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0]).toMatchObject(args);
  expect(requests[1]!.find((message) => message.toolCalls?.length)?.toolCalls).toEqual([call]);
  expect(events).toContainEqual(expect.objectContaining({ msg: {
    type: "tool_call_started",
    payload: expect.objectContaining({ callId: call.id, toolName: call.name, args: call.arguments }),
  } }));
});
