import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { createCheckpointResponseItemProjector, llmMessageToCheckpointResponseItem } from "../../src/session/message-history-conversion.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";

describe("turn-owned checkpoint redaction", () => {
  it("matches fresh projection after content, arguments and replay mutations", () => {
    const project = createCheckpointResponseItemProjector();
    const message: LLMMessage = {
      role: "assistant", content: "ordinary assistant content repeated across checkpoints",
      toolCalls: [{ id: "call-one", name: "exec_command", arguments: '{"command":"printf ordinary"}' }],
      providerReasoning: { version: 1, content: "ordinary reasoning repeated across checkpoint calls" },
    };
    expect(project(message)).toEqual(llmMessageToCheckpointResponseItem(message));
    expect(project(message)).toEqual(llmMessageToCheckpointResponseItem(message));
    message.content = "password=" + "a".repeat(40);
    message.toolCalls![0]!.arguments = '{"password":"' + "b".repeat(40) + '"}';
    message.providerReasoning = { version: 1, content: "password=" + "c".repeat(40) };
    const changed = project(message);
    expect(changed).toEqual(llmMessageToCheckpointResponseItem(message));
    expect(changed.providerReasoning).toBeUndefined();
    expect(JSON.stringify(changed)).not.toContain("a".repeat(40));
    expect(JSON.stringify(changed)).not.toContain("b".repeat(40));
  });

  it("checks the current tool seal after repeated clean content hits", () => {
    const project = createCheckpointResponseItemProjector();
    const content = "ordinary tool output repeated across checkpoint calls";
    const message: LLMMessage = { role: "tool", toolCallId: "call-one", toolName: "exec_command", content,
      runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({ runId: "test-run", toolCallId: "call-one", content }) } };
    expect(project(message)).toEqual(llmMessageToCheckpointResponseItem(message));
    expect(project(message)).toEqual(llmMessageToCheckpointResponseItem(message));
    message.content = "X" + content.slice(1);
    expect(() => llmMessageToCheckpointResponseItem(message)).toThrow();
    expect(() => project(message)).toThrow();
  });

  it("does not let a caller mutate later projections or share a turn cache", () => {
    const project = createCheckpointResponseItemProjector();
    const message: LLMMessage = { role: "user", content: [{ type: "text", text: "ordinary user message repeated for several checkpoints" }] };
    const first = project(message);
    first.content = "mutated projection";
    expect(project(message)).toEqual(llmMessageToCheckpointResponseItem(message));
    expect(createCheckpointResponseItemProjector()(message)).toEqual(llmMessageToCheckpointResponseItem(message));
  });
});
