import { describe, expect, it } from "vitest";

import { normalizeHistoryMessages } from "../../src/session/session.js";
import { llmMessageToCheckpointResponseItem } from "../../src/session/message-history-conversion.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";

// A resumed session restores `history` from the rollout reconstruction, which
// yields persisted ResponseItems (seal at the top level). The live turn stores
// LLMMessages (seal under `runtimeOnly`). Both shapes must normalize to the
// same in-memory message, or the first checkpoint of the resumed turn throws
// "checkpoint v2 requires every tool result to be sealed" (seen live on the
// desktop after a daemon restart: 6 parallel tool calls executed, no tool
// result was ever persisted, the turn died).
describe("normalizeHistoryMessages", () => {
  const integrity = createToolResultIntegrity({
    runId: "conv-resumed",
    toolCallId: "call-1",
    content: "file body",
  });

  it("keeps the tool-result seal of a persisted (rollout) history item", () => {
    const [restored] = normalizeHistoryMessages([
      {
        role: "tool",
        content: "file body",
        toolCallId: "call-1",
        toolName: "FileRead",
        toolResultIntegrity: integrity,
      },
    ]);
    expect(restored?.runtimeOnly?.toolResultIntegrity).toEqual(integrity);
    // The exact projection the durable checkpoint validates.
    const projected = llmMessageToCheckpointResponseItem(restored!);
    expect(projected.toolResultIntegrity).toBeDefined();
  });

  it("keeps the seal of a live (runtimeOnly) history item unchanged", () => {
    const [live] = normalizeHistoryMessages([
      {
        role: "tool",
        content: "file body",
        toolCallId: "call-1",
        toolName: "FileRead",
        runtimeOnly: { toolResultIntegrity: integrity },
      },
    ]);
    expect(live?.runtimeOnly?.toolResultIntegrity).toEqual(integrity);
  });

  it("prefers the runtimeOnly seal when both shapes are present", () => {
    const other = createToolResultIntegrity({
      runId: "conv-resumed",
      toolCallId: "call-1",
      content: "other body",
    });
    const [message] = normalizeHistoryMessages([
      {
        role: "tool",
        content: "file body",
        toolCallId: "call-1",
        toolResultIntegrity: other,
        runtimeOnly: { toolResultIntegrity: integrity },
      },
    ]);
    expect(message?.runtimeOnly?.toolResultIntegrity).toEqual(integrity);
  });

  it("leaves unsealed non-tool items without runtimeOnly", () => {
    const [user] = normalizeHistoryMessages([{ role: "user", content: "hi" }]);
    expect(user?.runtimeOnly).toBeUndefined();
  });

  it("restores reasoning provenance while keeping legacy replay state unbound", () => {
    const [current, legacy] = normalizeHistoryMessages([
      {
        role: "assistant",
        content: "",
        providerReasoning: {
          version: 2,
          content: "qwen-state",
          provider: "qwen",
          model: "qwen3.8-max",
        },
      },
      {
        role: "assistant",
        content: "",
        providerReasoning: { version: 1, content: "legacy-state" },
      },
    ]);

    expect(current).toMatchObject({
      providerReasoningContent: "qwen-state",
      providerReasoningProvenance: {
        provider: "qwen",
        model: "qwen3.8-max",
      },
    });
    expect(legacy?.providerReasoningContent).toBe("legacy-state");
    expect(legacy?.providerReasoningProvenance).toBeUndefined();
  });

  it("drops conflicting dual reasoning representations atomically", () => {
    const conflicts = normalizeHistoryMessages([
      {
        role: "assistant",
        content: "",
        providerReasoningContent: "deepseek-state",
        providerReasoningProvenance: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
        },
        providerReasoning: {
          version: 2,
          content: "qwen-state",
          provider: "qwen",
          model: "qwen3.8-max",
        },
      },
      {
        role: "assistant",
        content: "",
        providerReasoningContent: "same-state",
        providerReasoningProvenance: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
        },
        providerReasoning: {
          version: 2,
          content: "same-state",
          provider: "qwen",
          model: "qwen3.8-max",
        },
      },
    ]);

    for (const message of conflicts) {
      expect(message.providerReasoningContent).toBeUndefined();
      expect(message.providerReasoningProvenance).toBeUndefined();
    }
  });

  it("never upgrades legacy or malformed replay state with adjacent provenance", () => {
    const messages = normalizeHistoryMessages([
      {
        role: "assistant",
        content: "",
        providerReasoningContent: "legacy-state",
        providerReasoningProvenance: {
          provider: "qwen",
          model: "qwen3.8-max",
        },
        providerReasoning: { version: 1, content: "legacy-state" },
      },
      {
        role: "assistant",
        content: "",
        providerReasoningContent: "flat-state",
        providerReasoningProvenance: {
          provider: "qwen",
          model: "qwen3.8-max",
        },
        providerReasoning: "malformed",
      },
      {
        role: "assistant",
        content: "",
        providerReasoning: {
          version: 2,
          content: "durable-state",
          provider: "qwen",
          model: "qwen3.8-max",
        },
        providerReasoningProvenance: { provider: "qwen" },
      },
    ]);

    for (const message of messages) {
      expect(message.providerReasoningContent).toBeUndefined();
      expect(message.providerReasoningProvenance).toBeUndefined();
    }
  });
});
