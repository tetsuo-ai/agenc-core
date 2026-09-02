import { afterEach, describe, expect, it } from "vitest";

import { compactConversation } from "../../../src/services/compact/compact.js";
import { getCompactionSystemPrompt } from "../../../src/services/compact/prompt.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import type { LLMMessage, LLMResponse } from "../../../src/llm/types.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../../helpers/compaction-transaction-harness.js";

const SESSION_ID = "runtime-tool-pairs-contract";
const TOOL_CALLS = 200;

/**
 * A live desktop session with 218 tool calls could never compact: the
 * policy made the model echo a {tool_call_id, result_sha256} pair for every
 * call (about 28 KB of digests), and the output was then judged at one
 * token per UTF-8 byte against an 8,192-token reserve. Three attempts,
 * three "output_limit_exceeded". The runtime already knew every pair (it
 * compared the echo against them), so it now pins them itself, the model
 * writes narrative, facts and open actions only, and provider usage is the
 * output count.
 */
describe("compaction with runtime-owned tool pairs", () => {
  let harness: CompactionTransactionHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  it("commits a body without tool_pairs and pins every pair of the span itself", async () => {
    const source = createSource(TOOL_CALLS);
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
      maxOutputTokens: 8_192,
      chat: bodyWithoutPairs("x".repeat(12_000), 3_100),
    });

    const result = await compactConversation(source, harness.context);
    const committed = result.transaction?.committed;
    expect(committed?.replacement_history.length).toBeGreaterThan(0);
    // The persisted replacement history is the live projection: no message
    // carries a response id, or the durable checkpoint hash can never match.
    expect(committed?.replacement_history.every((message) => message.id === undefined)).toBe(true);
    const serialized = JSON.stringify(committed);
    for (const index of [0, 1, TOOL_CALLS / 2, TOOL_CALLS - 1]) {
      expect(serialized).toContain(`"call-${index}"`);
    }
    expect(serialized.match(/"tool_call_id"/g)?.length ?? 0).toBeGreaterThanOrEqual(
      TOOL_CALLS,
    );
    // The model was never asked to echo the pairs.
    for (const call of harness.provider.chat.mock.calls as unknown as LLMMessage[][][]) {
      const payload = JSON.parse(String(call[0]?.[0]?.content)) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("required_tool_pairs");
    }
  });

  it("accepts a summary larger than 8 KB when the provider reports its token count", async () => {
    // Tool results of a few hundred bytes each, so the summary still
    // shrinks the span by far more than the required fifth.
    const source = createSource(TOOL_CALLS, 400);
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
      // A realistic window: the wire output limit now leaves room for
      // hidden reasoning, and the harness default of 64k is too tight for
      // 200 tool results plus that room.
      contextWindowTokens: 256_000,
      maxOutputTokens: 8_192,
      chat: bodyWithoutPairs("y".repeat(9_216), 2_300),
    });
    // No tokenizer for this provider: the old code then counted one token
    // per byte and refused anything over 8,192 bytes.
    (harness.provider as unknown as { tokenCountCapability: unknown }).tokenCountCapability =
      undefined;

    const result = await compactConversation(source, harness.context);
    expect(result.transaction?.committed.replacement_history.length).toBeGreaterThan(0);
  });

  it("still rejects a model that echoes pairs which do not match the span", async () => {
    const source = createSource(8);
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
      chat: async () => ({
        content: JSON.stringify({
          narrative: "Forged.",
          facts: [],
          open_actions: [],
          tool_pairs: [{ tool_call_id: "call-0", result_sha256: "0".repeat(64) }],
        }),
        toolCalls: [],
        usage: {
          promptTokens: 128,
          completionTokens: 64,
          totalTokens: 192,
          availability: "reported",
          provenance: "provider",
        },
        model: "grok-4.5",
        finishReason: "stop",
      }),
    });

    await expect(compactConversation(source, harness.context)).rejects.toThrow(
      /omitted, forged, duplicated, or reordered/,
    );
  });

  it("gives the final call a larger output reserve and hides old tool bodies from the compactor", async () => {
    // Eight results of 7,000 characters: the newest five keep their bodies,
    // the three oldest are cleared in what the model reads. The authoritative
    // history and its pair digests are untouched.
    const source = createSource(8, 7_000);
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
      contextWindowTokens: 256_000,
      maxOutputTokens: 32_768,
      chat: bodyWithoutPairs("z".repeat(2_000), 600),
    });

    const result = await compactConversation(source, harness.context);
    expect(result.transaction?.committed.replacement_history.length).toBeGreaterThan(0);
    const calls = harness.provider.chat.mock.calls as unknown as [
      LLMMessage[],
      { maxOutputTokens?: number; reasoningEffort?: string },
    ][];
    expect(calls.length).toBeGreaterThan(0);
    const [messages, options] = calls[calls.length - 1]!;
    // 16k of visible summary, doubled on the wire for hidden reasoning.
    expect(options.maxOutputTokens).toBe(16_384 * 2);
    expect(options.reasoningEffort).toBe("low");
    const payload = String(messages[0]?.content);
    // The kept suffix (three messages) holds call 7, so the summarized span
    // carries seven results: the newest five keep their bodies, two are
    // cleared.
    expect(payload.match(/\[Old tool result content cleared\]/g)?.length ?? 0).toBe(2);
    expect(payload).toContain("wrote game6/index.html####");
    expect(payload).toContain("wrote game2/index.html####");
    expect(payload).not.toContain("wrote game0/index.html####");
    expect(payload).not.toContain("wrote game1/index.html####");
    const committed = JSON.stringify(result.transaction?.committed);
    expect(committed.match(/"tool_call_id"/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });

  it("accepts records without source_ref_ids when only one ref is allowed", async () => {
    const source = createSource(40, 300);
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
      chat: async () => ({
        content: JSON.stringify({
          narrative: "Four games written.",
          facts: [{ id: "f1", text: "game0..game3 exist" }],
          open_actions: [{ id: "a1", text: "wire the hub" }],
        }),
        toolCalls: [],
        usage: {
          promptTokens: 128,
          completionTokens: 64,
          totalTokens: 192,
          availability: "reported",
          provenance: "provider",
        },
        model: "grok-4.5",
        finishReason: "stop",
      }),
    });

    const result = await compactConversation(source, harness.context);
    const committed = JSON.stringify(result.transaction?.committed);
    expect(committed).toContain("wire the hub");
    expect(committed).toContain(":span:001");
  });

  it("does not ask the model for tool pairs anymore", () => {
    for (const stage of ["leaf", "reduce", "final"] as const) {
      const prompt = getCompactionSystemPrompt(stage);
      expect(prompt).not.toContain("tool_pairs");
      expect(prompt).not.toContain("required_tool_pairs");
      expect(prompt).toContain("do not list tool pairs");
    }
  });
});

function bodyWithoutPairs(
  narrative: string,
  completionTokens = 128,
): (messages: LLMMessage[]) => Promise<LLMResponse> {
  return async () => ({
    content: JSON.stringify({ narrative, facts: [], open_actions: [] }),
    toolCalls: [],
    usage: {
      promptTokens: 128,
      completionTokens,
      totalTokens: 128 + completionTokens,
      availability: "reported",
      provenance: "provider",
    },
    model: "grok-4.5",
    finishReason: "stop",
  });
}

function createSource(toolCalls: number, resultBytes = 0): RuntimeMessage[] {
  const messages: RuntimeMessage[] = [{ role: "user", content: "build the arcade" }];
  for (let index = 0; index < toolCalls; index += 1) {
    const toolCallId = `call-${index}`;
    const content = `wrote game${index}/index.html${"#".repeat(resultBytes)}`;
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: toolCallId, name: "Write", arguments: "{}" }],
    });
    messages.push({
      role: "tool",
      originalRole: "tool",
      toolCallId,
      toolName: "Write",
      content,
      message: { role: "tool", content },
      runtimeOnly: {
        toolResultIntegrity: createToolResultIntegrity({
          runId: SESSION_ID,
          toolCallId,
          content,
        }),
      },
    });
  }
  messages.push({ role: "assistant", content: "All games are in." });
  return messages;
}
