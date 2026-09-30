import { afterEach, describe, expect, it } from "vitest";

import { compactConversation } from "../../../src/services/compact/compact.js";
import { getCompactionSystemPrompt } from "../../../src/services/compact/prompt.js";
import type {
  CompactionResult,
  RuntimeMessage,
} from "../../../src/services/compact/types.js";
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
 * output count. The pinned pairs stay in the durable records: the summary
 * message the model reads afterwards carries none of them, so its size no
 * longer grows with the number of compacted tool calls.
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
    // The durable summary pins every pair of the summarized span in order
    // (the last call stays verbatim in the kept suffix); the model-visible
    // summary message carries none of them.
    expect(
      result.transaction?.committed.summary.body.tool_pairs.map(
        (pair) => pair.tool_call_id,
      ),
    ).toEqual(Array.from({ length: TOOL_CALLS - 1 }, (_, index) => `call-${index}`));
    const message = summaryMessageContent(result);
    expect(message).not.toContain("call-");
    expect(message).not.toContain("tool_pairs");
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

  it("renders the same summary message for 1 and 200 compacted tool calls", async () => {
    const rendered: string[] = [];
    // One call needs a large result for the source to clear the shrink floor.
    for (const [toolCalls, resultBytes] of [[1, 8_000], [TOOL_CALLS, 0]] as const) {
      const source = createSource(toolCalls, resultBytes);
      harness = createCompactionTransactionHarness(source, {
        compactionMode: "automatic",
        sessionId: SESSION_ID,
        chat: bodyCitingFirstSource,
      });
      const result = await compactConversation(source, harness.context, "", {
        keepCount: 0,
      });
      const transaction = result.transaction!;
      const body = transaction.committed.summary.body;
      expect(body.tool_pairs).toHaveLength(toolCalls);
      expect(body.facts[0]?.source_ref_ids.length).toBeGreaterThan(0);
      const message = summaryMessageContent(result);
      expect(message).not.toContain(transaction.attempt_id);
      expect(message).not.toContain(transaction.committed.summary.summary_sha256);
      rendered.push(message);
      harness.close();
      harness = undefined;
    }

    expect(rendered[1]).toBe(rendered[0]);
    expect(rendered[0]).not.toMatch(/[0-9a-f]{64}/u);
    expect(rendered[0]).not.toContain("tool_call_id");
    expect(rendered[0]).not.toContain("source_ref_ids");
    expect(JSON.parse(rendered[0]!)).toEqual({
      facts: ["Each game has its own folder."],
      kind: "agenc_compaction_context_v2",
      narrative: "Built the arcade.",
      open_actions: ["Run the smoke test."],
      trust: "untrusted_historical_data",
      version: 2,
    });
  });

  it("still rejects a model that echoes pairs which do not match the span", async () => {
    const source = createSource(8);
    harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: SESSION_ID,
      chat: async () => providerResponse({
        narrative: "Forged.",
        facts: [],
        open_actions: [],
        tool_pairs: [{ tool_call_id: "call-0", result_sha256: "0".repeat(64) }],
      }, 64),
    });

    await expect(compactConversation(source, harness.context)).rejects.toThrow(
      /omitted, forged, duplicated, or reordered/,
    );
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
  return async () =>
    providerResponse({ narrative, facts: [], open_actions: [] }, completionTokens);
}

/** A body whose records cite the first allowlisted source of every call. */
async function bodyCitingFirstSource(messages: LLMMessage[]): Promise<LLMResponse> {
  const payload = JSON.parse(String(messages[0]?.content)) as {
    readonly allowed_source_ref_ids: readonly string[];
  };
  const sourceRefIds = payload.allowed_source_ref_ids.slice(0, 1);
  return providerResponse({
    narrative: "Built the arcade.",
    facts: [{ id: "f1", text: "Each game has its own folder.", source_ref_ids: sourceRefIds }],
    open_actions: [{ id: "a1", text: "Run the smoke test.", source_ref_ids: sourceRefIds }],
  });
}

function providerResponse(body: unknown, completionTokens = 128): LLMResponse {
  return {
    content: JSON.stringify(body),
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
  };
}

/** The committed, model-visible summary message of a compaction. */
function summaryMessageContent(result: CompactionResult): string {
  const content = result.transaction?.committed.replacement_history.find(
    (message) => message.compactionHistory?.kind === "summary",
  )?.content;
  if (typeof content !== "string") throw new Error("no committed summary message");
  return content;
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
