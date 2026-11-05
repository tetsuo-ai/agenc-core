import { expect, test, vi } from "vitest";
import { createCsvAgentInvocationEnvelope, materializeAgentInvocationMessages } from "../../src/contracts/agent-invocation-envelope.js";
import { LLMCapabilityError } from "../../src/llm/errors.js";
import { BedrockProvider } from "../../src/llm/providers/bedrock/index.js";
import { GrokAcpProvider } from "../../src/llm/providers/grok/acp-adapter.js";
import type { LLMMessage } from "../../src/llm/types.js";

test.each(["{malformed", "[]", '"not-an-object"'])("preflights Bedrock replayed tool arguments %s", async (argumentsText) => {
  const fetchImpl = vi.fn<typeof fetch>();
  const provider = new BedrockProvider({ model: "amazon.nova-pro-v1:0", fetchImpl });
  const messages: LLMMessage[] = [
    { role: "user", content: "Read the file." },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "read", arguments: argumentsText }] },
    { role: "tool", content: "read result", toolCallId: "read-1", toolName: "read" },
  ];
  await expect(Promise.resolve().then(() => provider.validateRequest(messages, {})))
    .rejects.toBeInstanceOf(LLMCapabilityError);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("preflights Bedrock unsupported message content before counting or signing", () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const provider = new BedrockProvider({ model: "amazon.nova-pro-v1:0", fetchImpl });
  const messages: LLMMessage[] = [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }] }];
  expect(() => provider.validateRequest(messages, {})).toThrow(LLMCapabilityError);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("preflights authenticated ACP invocation without starting the composer", async () => {
  const provider = new GrokAcpProvider({ model: "grok-composer-2.5-fast", env: {} });
  const messages = materializeAgentInvocationMessages(createCsvAgentInvocationEnvelope({
    jobId: "preflight-job", itemId: "preflight-item", rowIndex: 0, rowSha256: `sha256:${"b".repeat(64)}`,
    instruction: "classify the row", row: { value: "untrusted" },
  }));
  try {
    expect(() => provider.validateRequest(messages, {})).toThrow(LLMCapabilityError);
    expect(() => provider.validateRequest([{ role: "user", content: "plain text" }], {})).not.toThrow();
  } finally {
    await provider.dispose();
  }
});
