import { describe, expect, it } from "vitest";

import {
  createCsvAgentInvocationEnvelope,
  materializeAgentInvocationMessages,
  validateAgentInvocationMessageSequence,
} from "../../src/contracts/agent-invocation-envelope.js";
import type { LLMMessage } from "../../src/llm/types.js";
import {
  fromAgenCRuntimeMessage,
  fromAgenCRuntimeMessages,
  toAgenCRuntimeMessages,
} from "../../src/session/runtime-message-conversion.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";

const TOOL_CALL_ID = "toolu_read_1792";
const TOOL_ARGUMENTS = JSON.stringify({ path: "src/index.ts", offset: 10 });
const TOOL_RESULT = "export const answer = 42;\n";

/**
 * An assistant tool call followed by its result, decorated with every optional
 * wire field the converters must carry: phase, provider reasoning state, the
 * tool call arguments, the result's call id and tool name, and the
 * runtime-only tool-result integrity record.
 */
function pairedToolExchange(): LLMMessage[] {
  return [
    { role: "system", content: "You are a careful assistant." },
    { role: "user", content: "Read src/index.ts" },
    {
      role: "assistant",
      content: "Reading the file.",
      phase: "commentary",
      providerReasoningContent: "opaque provider state",
      providerReasoningProvenance: { provider: "qwen", model: "qwen3.8-max" },
      toolCalls: [
        { id: TOOL_CALL_ID, name: "FileRead", arguments: TOOL_ARGUMENTS },
      ],
    },
    {
      role: "tool",
      toolCallId: TOOL_CALL_ID,
      toolName: "FileRead",
      content: TOOL_RESULT,
      runtimeOnly: {
        toolResultIntegrity: createToolResultIntegrity({
          runId: "run-1792",
          toolCallId: TOOL_CALL_ID,
          content: TOOL_RESULT,
        }),
      },
    },
    { role: "assistant", content: "The answer is 42.", phase: "final_answer" },
  ];
}

function expectEveryToolResultToFollowItsCall(messages: readonly LLMMessage[]): void {
  const toolResults = messages.filter((message) => message.role === "tool");
  expect(toolResults.length).toBeGreaterThan(0);
  for (const result of toolResults) {
    const index = messages.indexOf(result);
    const producer = messages[index - 1];
    expect(producer?.role).toBe("assistant");
    expect(producer?.toolCalls?.map((call) => call.id)).toContain(result.toolCallId);
  }
}

describe("runtime message conversion round trip", () => {
  it("restores an assistant tool call and its result with every wire field intact", () => {
    const source = pairedToolExchange();

    const restored = fromAgenCRuntimeMessages(toAgenCRuntimeMessages(source));

    expect(restored).toEqual(source);
    expect(restored[2]?.toolCalls).toEqual([
      { id: TOOL_CALL_ID, name: "FileRead", arguments: TOOL_ARGUMENTS },
    ]);
    expectEveryToolResultToFollowItsCall(restored);
    expect(() => validateAgentInvocationMessageSequence(restored)).not.toThrow();
  });

  it("writes the tool call onto the runtime assistant message and remaps the result to the user wire role", () => {
    const [, , assistant, toolResult] = toAgenCRuntimeMessages(pairedToolExchange());

    expect(assistant).toMatchObject({
      role: "assistant",
      type: "assistant",
      phase: "commentary",
      providerReasoningContent: "opaque provider state",
      toolCalls: [
        { id: TOOL_CALL_ID, name: "FileRead", arguments: TOOL_ARGUMENTS },
      ],
    });
    expect(toolResult).toMatchObject({
      role: "user",
      originalRole: "tool",
      type: "user",
      isMeta: true,
      toolCallId: TOOL_CALL_ID,
      toolName: "FileRead",
    });
    expect(toolResult?.runtimeOnly?.toolResultIntegrity?.toolCallId).toBe(TOOL_CALL_ID);
  });

  it("keeps tool calls on the legacy type plus nested message runtime shape", () => {
    const restored = fromAgenCRuntimeMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "kept" }],
      },
      toolCalls: [{ id: TOOL_CALL_ID, name: "FileRead" }],
    });

    expect(restored).toEqual({
      role: "assistant",
      content: "kept",
      toolCalls: [{ id: TOOL_CALL_ID, name: "FileRead", arguments: "" }],
    });
  });

  it("restores the developer role and runtime-only metadata of agent invocation channels", () => {
    const envelope = createCsvAgentInvocationEnvelope({
      jobId: "job-1792",
      itemId: "item-1",
      rowIndex: 0,
      rowSha256: `sha256:${"e".repeat(64)}`,
      instruction: "Classify the row.",
      row: { payload: "value" },
    });
    const channels: LLMMessage[] = [...materializeAgentInvocationMessages(envelope)];
    const source: LLMMessage[] = [
      { role: "system", content: "You are a careful assistant." },
      ...channels,
      ...pairedToolExchange().slice(2),
    ];

    const runtime = toAgenCRuntimeMessages(source);
    const restored = fromAgenCRuntimeMessages(runtime);

    expect(channels.some((channel) => channel.role === "developer")).toBe(true);
    expect(
      runtime.filter((message) => message.originalRole === "developer"),
    ).toHaveLength(channels.filter((channel) => channel.role === "developer").length);
    expect(restored).toEqual(source);
    expect(() => validateAgentInvocationMessageSequence(restored)).not.toThrow();
  });

  it("drops runtime messages that carry no recognizable role", () => {
    expect(fromAgenCRuntimeMessage({ type: "progress", content: "ignored" })).toBeNull();
    expect(
      fromAgenCRuntimeMessages([
        { type: "progress", content: "ignored" },
        { type: "user", message: { role: "user", content: "kept" } },
      ]),
    ).toEqual([{ role: "user", content: "kept" }]);
  });
});
