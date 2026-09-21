import { expect, it, vi } from "vitest";
import { GrokProvider } from "./providers/grok/adapter.js";
import { buildXaiResponsesRequest, extractXaiReasoningReplay } from "./wire/responses-xai.js";
import type { LLMMessage, LLMResponse } from "./types.js";

const model = "grok-4.7";
const item = { type: "reasoning", id: "reasoning-1", encrypted_content: "opaque+/==", summary: [], vendor_field: { keep: true } };
const messages: LLMMessage[] = [{ role: "user", content: "hello" }];
const output = [item, { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }];
const response = { id: "resp-test", model, status: "completed", output };
const withResponse = (data: unknown) => ({ withResponse: async () => ({ data, response: new Response("", { status: 200 }), request_id: null }) });

it.each([false, true])("preserves unsolicited encrypted reasoning through adapter and next request (stream=%s)", async (stream) => {
  const provider = new GrokProvider({ apiKey: "test-key", model });
  const create = vi.fn(() => withResponse(stream ? { async *[Symbol.asyncIterator]() {
    yield { type: "response.completed", response };
  } } : response));
  (provider as any).client = { responses: { create } };
  const result: LLMResponse = stream ? await provider.chatStream(messages, () => {}) : await provider.chat(messages);
  expect(result.providerReasoningProvenance).toEqual({ provider: "grok", model });
  const history: LLMMessage[] = [...messages, { role: "assistant", content: result.content,
    providerReasoningContent: result.providerReasoningContent, providerReasoningProvenance: result.providerReasoningProvenance },
    { role: "user", content: "continue" }];
  const built = (provider as any).buildParams(history).params;
  expect(built.input[1]).toEqual(item);
  expect(buildXaiResponsesRequest({ model, messages: history }).input).toEqual(built.input);
});

it("does not replay opaque state across models, providers or without provenance", () => {
  const replay = extractXaiReasoningReplay(output, model);
  for (const provenance of [undefined, { provider: "openai", model }, { provider: "grok", model: "grok-4.6" }]) {
    const history: LLMMessage[] = [...messages, { role: "assistant", content: "hello", ...replay, providerReasoningProvenance: provenance }];
    expect(buildXaiResponsesRequest({ model, messages: history }).input).not.toContainEqual(item);
  }
  expect(buildXaiResponsesRequest({ model, messages: [...messages, { role: "assistant", content: "hello", ...replay, providerReasoningContent: "invalid json" }] }).input).not.toContainEqual(item);
});

it("keeps function tools attached to image requests", () => {
  const provider = new GrokProvider({ apiKey: "test-key", model });
  const params = (provider as any).buildParams([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }] }], {
    toolSelection: { tools: [{ type: "function", name: "inspect", parameters: { type: "object", properties: {} } }] },
  }).params;
  expect(params.model).toBe(model);
  expect(params.tools).toHaveLength(1);
});

it("replays whole encrypted items before their tool calls after durable serialization", () => {
  const history: LLMMessage[] = JSON.parse(JSON.stringify([
    ...messages,
    { role: "assistant", content: "", ...extractXaiReasoningReplay([item], model),
      toolCalls: [{ id: "call-1", name: "inspect", arguments: "{}" }] },
    { role: "tool", toolCallId: "call-1", content: "done" },
  ]));
  const request = buildXaiResponsesRequest({ model, messages: history, options: { includeEncryptedReasoning: true } });
  expect(request.include).toEqual(["reasoning.encrypted_content"]);
  expect(request.input).toEqual([
    { role: "user", content: "hello" }, item,
    { type: "function_call", call_id: "call-1", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "done" },
  ]);
});
