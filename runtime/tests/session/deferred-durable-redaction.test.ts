import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { captureCheckpointMessage, captureDurableResponseItem, llmMessageToCheckpointResponseItem, llmMessageToDurableResponseItem } from "../../src/session/message-history-conversion.js";
import * as redaction from "../../src/session/provider-replay-redaction.js";
import { createToolResultIntegrity, verifyToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import { syntheticPng } from "../helpers/redacted-inline-image-fixture.js";

const secret = `sk-proj-${"a".repeat(64)}`;

describe("deferred durable message redaction", () => {
  it("captures nested checkpoint provenance and settled seals by value", () => {
    const message: LLMMessage = {
      role: "assistant", content: "answer", providerReasoningContent: "ordinary replay",
      providerReasoningProvenance: { provider: "deepseek", model: "model-one" },
    };
    const expected = llmMessageToCheckpointResponseItem(message);
    const captured = captureCheckpointMessage(message);
    Object.assign(message.providerReasoningProvenance!, { model: "model-two" });
    expect(llmMessageToCheckpointResponseItem(captured)).toEqual(expected);
    const content = "tool result";
    const integrity = createToolResultIntegrity({ runId: "run", toolCallId: "call", content });
    const tool: LLMMessage = { role: "tool", content, toolCallId: "call", runtimeOnly: { toolResultIntegrity: integrity } };
    const settled = captureCheckpointMessage(tool);
    const pending = captureCheckpointMessage(tool, integrity);
    expect(settled.runtimeOnly!.toolResultIntegrity).not.toBe(integrity);
    expect(pending.runtimeOnly!.toolResultIntegrity).toBe(integrity);
    expect(pending.content).toBe(content);
  });
  it("captures nested inputs and redacts only when the write is resolved", () => {
    const message: LLMMessage = {
      role: "assistant", content: [{ type: "text", text: `credential ${secret}` }],
      toolCalls: [{ id: "call", name: "exec_command", arguments: JSON.stringify({ password: secret }) }],
      providerReasoningContent: `reasoning ${secret}`,
    };
    const expected = llmMessageToDurableResponseItem(message);
    const redact = vi.spyOn(redaction, "redactDurableSecrets");
    try {
      const resolve = captureDurableResponseItem(message);
      expect(redact).not.toHaveBeenCalled();
      expect(message.providerReasoningContent).toContain(secret);
      message.content = "changed after capture";
      message.toolCalls![0]!.arguments = "changed arguments";
      message.providerReasoningContent = "changed reasoning";
      const durable = resolve();
      expect(redact).toHaveBeenCalled();
      expect(durable).toEqual(expected);
      expect(JSON.stringify(durable)).not.toContain(secret);
      expect(durable.providerReasoning).toBeUndefined();
      expect(resolve()).toBe(durable);
    } finally { redact.mockRestore(); }
  });

  it("checks tool integrity before returning and seals the redacted captured body", () => {
    const content = `credential ${secret}`;
    const message: LLMMessage = {
      role: "tool", toolCallId: "call", toolName: "exec_command", content,
      runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({ runId: "run", toolCallId: "call", content }) },
    };
    const expected = llmMessageToDurableResponseItem(message);
    const resolve = captureDurableResponseItem(message);
    message.content = "bounded later";
    expect(() => captureDurableResponseItem(message)).toThrow();
    const item = resolve();
    expect(item).toEqual(expected);
    expect(verifyToolResultIntegrity({ integrity: item.toolResultIntegrity, toolCallId: "call", content: item.content }).status).toBe("valid");
    expect(message.content).toBe("bounded later");
  });

  it("keeps the same binary-carrier omission as synchronous persistence", () => {
    const message: LLMMessage = { role: "user", content: [
      { type: "text", text: `credential ${secret}` },
      { type: "image_url", image_url: { url: syntheticPng(true) } },
    ] };
    const expected = llmMessageToDurableResponseItem(message);
    const resolve = captureDurableResponseItem(message);
    message.content = "replaced";
    expect(resolve()).toEqual(expected);
    expect(JSON.stringify(resolve())).not.toContain(secret);
  });
});
