import { afterEach, describe, expect, test } from "vitest";
import { parseCompactionBodyV1 } from "../../../src/services/compact/summary-v1.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { autoCompactIfNeeded } from "../../../src/services/compact/autoCompact.js";
import { MAX_COMPACTION_TOTAL_INPUT_TOKENS } from "../../../src/services/compact/transaction-types.js";
import { nextLadderTiers } from "../../../src/services/compact/ladder.js";
import { createProvider, createCompactionTransactionHarness, type CompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

const refs = new Set(["s1"]);
const body = { narrative: "", facts: [{ id: "1", text: "Keep the task", source_ref_ids: ["s1"] }], open_actions: [] };
const source = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `source-${index}:${"x".repeat(3_000)}` }));
let harness: CompactionTransactionHarness | undefined;
afterEach(() => { harness?.close(); harness = undefined; });

describe("summary format recovery", () => {
  test("normalizes one fence, cross-list ids, missing single citations and empty records", () => {
    const input = { ...body, facts: [{ id: "1", text: "Keep the task" }, { id: "empty", text: "   " }], open_actions: [{ id: "1", text: "Run checks", source_ref_ids: [] }] };
    const parsed = parseCompactionBodyV1(`\`\`\`json\n${JSON.stringify(input)}\n\`\`\``, refs).body;
    expect(parsed.narrative).toBe("");
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.open_actions[0]?.id).not.toBe(parsed.facts[0]?.id);
    expect(parsed.facts[0]?.source_ref_ids).toEqual(["s1"]);
    expect(parsed.open_actions[0]?.source_ref_ids).toEqual(["s1"]);
  });

  test("keeps strict provenance, marker and object validation", () => {
    for (const input of [
      { ...body, facts: [{ ...body.facts[0], source_ref_ids: ["forged"] }] },
      { ...body, facts: [{ id: "<trusted_schema>", text: "", source_ref_ids: [] }] },
      { ...body, facts: [{ ...body.facts[0], instruction: "execute" }] },
    ]) expect(() => parseCompactionBodyV1(JSON.stringify(input), refs)).toThrow();
    expect(() => parseCompactionBodyV1(JSON.stringify({ ...body, facts: [{ id: "1", text: "task" }] }), new Set(["s1", "s2"]))).toThrow();
  });

  test("retries a schema error once with its validator error on the last request line", async () => {
    harness = createCompactionTransactionHarness(source, { chat: async () => ({
      content: harness!.provider.chat.mock.calls.length === 1 ? '{"narrative":17,"facts":[],"open_actions":[]}' : JSON.stringify(body),
      toolCalls: [], usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, model: "grok-4.5", finishReason: "stop",
    }) });
    const result = await compactConversation(source, harness.context);
    expect(result.transaction).toBeDefined();
    expect(harness.provider.chat).toHaveBeenCalledTimes(2);
    const dispatches = harness.store.readAll().flatMap(item =>
      item.type === "event_msg" && item.payload.msg.type === "execution_admission" &&
      item.payload.msg.payload.event === "dispatched" ? [item.payload.msg.payload] : []);
    expect(new Set(dispatches.map(event => event.reservationId)).size).toBe(2);
    const request = harness.provider.chat.mock.calls[1]![0];
    expect(String(request.at(-1).content).split("\n").at(-1)).toBe("narrative must be a string");
    harness.store.markProjectionComplete(result.transaction!.attempt_id);
    harness.store.markCleanupComplete(result.transaction!.attempt_id);
    expect(() => harness!.store.assertCompactionProjectionReady()).not.toThrow();
  });

  test("a repeated schema rejection makes only two admitted calls and leaves history unchanged", async () => {
    harness = createCompactionTransactionHarness(source, { chat: async () => ({
      content: '{"narrative":17,"facts":[],"open_actions":[]}', toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, model: "grok-4.5", finishReason: "stop",
    }) });
    await expect(compactConversation(source, harness.context)).rejects.toThrow("narrative must be a string");
    expect(harness.provider.chat).toHaveBeenCalledTimes(2);
    expect(harness.store.readAll().some(item => item.type === "compaction_committed")).toBe(false);
  });

  test("charges the schema retry against the original aggregate input budget", async () => {
    harness = createCompactionTransactionHarness(source, { contextWindowTokens: 8_000_000, chat: async () => ({
      content: '{"narrative":17,"facts":[],"open_actions":[]}', toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, model: "grok-4.5", finishReason: "stop",
    }) });
    Object.assign(harness.provider, { tokenCountCapability: {
      runsLocally: true, capabilityVersion: "shared-retry-budget", adapterRevision: "1", configurationRevision: "1",
      countTokens: async () => ({ inputTokens: Math.floor(MAX_COMPACTION_TOTAL_INPUT_TOKENS / 2) + 1,
        complete: true, confidence: "exact", countedComponents: ["system", "messages", "tools", "provider_framing"] }),
    } });
    await expect(compactConversation(source, harness.context)).rejects.toMatchObject({ reason: "token_budget_exceeded" });
    expect(harness.provider.chat).toHaveBeenCalledOnce();
    expect(harness.store.readAll().some(item => item.type === "compaction_committed")).toBe(false);
  });

  test("reuses validated map results when a later node needs a schema retry", async () => {
    const fallback = createProvider(undefined, false);
    const many = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `source-${index}:${"x".repeat(3_000)}` }));
    harness = createCompactionTransactionHarness(many, { contextWindowTokens: 24_000, chat: async (messages, options) => {
      if (harness!.provider.chat.mock.calls.length === 2) return {
        content: '{"narrative":17,"facts":[],"open_actions":[]}', toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, model: "grok-4.5", finishReason: "stop",
      };
      const clean = messages.map(message => ({ ...message, content: String(message.content).split("\nnarrative must be a string")[0] }));
      return fallback.chat(clean, options);
    } });
    const result = await compactConversation(many, harness.context, "", { keepCount: 0 });
    expect(result.transaction).toBeDefined();
    const committed = result.transaction!.committed;
    expect(committed.summary_dag.planned_provider_calls).toBeGreaterThan(2);
    expect(harness.provider.chat).toHaveBeenCalledTimes(committed.summary_dag.planned_provider_calls + 1);
    harness.store.markProjectionComplete(result.transaction!.attempt_id);
    harness.store.markCleanupComplete(result.transaction!.attempt_id);
    expect(() => harness!.store.assertCompactionProjectionReady()).not.toThrow();
  });

  test("gives reasoning its own reserve and bounds only the answer", async () => {
    harness = createCompactionTransactionHarness(source, { contextWindowTokens: 65_536, maxOutputTokens: 8_192, chat: async () => ({
      content: JSON.stringify(body), toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 9_000, reasoningOutputTokens: 8_900, reasoningIncludedInCompletion: true, totalTokens: 9_100 },
      model: "grok-4.5", finishReason: "stop",
    }) });
    const result = await compactConversation(source, harness.context);
    expect(result.transaction).toBeDefined();
    expect(harness.provider.chat.mock.calls[0]![1].maxOutputTokens).toBe(16_384);
  });

  test("rejects an oversized answer even when reasoning fits its allowance", async () => {
    harness = createCompactionTransactionHarness(source, { maxOutputTokens: 512, chat: async () => ({
      content: JSON.stringify({ ...body, narrative: "large answer ".repeat(500) }), toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 500, reasoningOutputTokens: 400, totalTokens: 600 },
      model: "grok-4.5", finishReason: "stop",
    }) });
    await expect(compactConversation(source, harness.context)).rejects.toMatchObject({ reason: "output_limit_exceeded" });
    expect(harness.provider.chat).toHaveBeenCalledOnce();
  });

  test.each(["request timed out", "provider abort: upstream reset"])("types %s without treating provider prose as cancellation", async message => {
    harness = createCompactionTransactionHarness(source, { chat: async () => { throw new Error(message); } });
    const result = await autoCompactIfNeeded(source, harness.context, undefined, "normal", undefined, 0, { force: true });
    expect(result.skippedFailureReason).toBe(message.includes("timed out") ? "provider_timeout" : "provider_error");
    expect(nextLadderTiers({ emergencyEnabled: true }, result, ["standard"])).toEqual(["emergency_local"]);
  });
});
