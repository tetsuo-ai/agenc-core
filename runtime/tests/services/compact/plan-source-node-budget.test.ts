import { describe, expect, it } from "vitest";
import { buildCompactionMapReducePlan } from "../../../src/services/compact/plan.js";
import { canonicalizeJson } from "../../../src/services/compact/summary-v1.js";
import {
  MAX_COMPACTION_OUTPUT_NODES_PER_CALL,
  type CompactionActiveHistoryRefV1,
  type CompactionSourceAuthorityV1,
} from "../../../src/services/compact/transaction-types.js";
import type { CompactContext, RuntimeMessage } from "../../../src/services/compact/types.js";

function fixture(count: number) {
  const messages: RuntimeMessage[] = Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    originalRole: index % 2 ? "assistant" : "user",
    content: `synthetic item ${index}`,
  }));
  const refs: CompactionActiveHistoryRefV1[] = messages.map((message, index) => ({
    kind: "rollout_span",
    ref_id: `node-budget:message:${index + 1}`,
    source_binding: "rollout:/node-budget#epoch:1",
    first_sequence: index + 1,
    last_sequence: index + 1,
    sha256: "a".repeat(64),
    history_index: index,
    record_message_index: 0,
    encoded_bytes: Buffer.byteLength(canonicalizeJson(message)),
  }));
  const source: CompactionSourceAuthorityV1 = {
    format_version: 1,
    attempt_id: "node-budget",
    session_id: "node-budget-session",
    epoch: 1,
    source_binding: "rollout:/node-budget#epoch:1",
    first_sequence: 1,
    last_sequence: messages.length,
    source_sha256: "a".repeat(64),
    source_bytes: messages.reduce((sum, message) => sum + Buffer.byteLength(String(message.content)), 0),
    history_digest: "a".repeat(64),
    active_history_refs: refs,
  };
  const options: Parameters<typeof buildCompactionMapReducePlan>[1] = {
    context: { options: { contextWindowTokens: 950_000, maxOutputTokens: 4_000 } } as CompactContext,
    source,
    messageSourceRefs: refs,
    providerName: "zai-coding-plan",
    model: "glm-5.3",
    systemPrompts: { map: "summarize", reduce: "reduce", final: "return a bounded summary" },
  };
  return { messages, refs, options };
}

describe("compaction source candidate node budget", () => {
  it("splits a small-byte long history instead of throwing a provider-output limit", () => {
    const { messages, refs, options } = fixture(2_000);
    expect(options.source.source_bytes).toBeLessThan(40_000);
    expect(() => canonicalizeJson({ source_sha256: "a".repeat(64), message_sources: refs }))
      .toThrow("provider output exceeds its node limit");
    const plan = buildCompactionMapReducePlan(messages, options);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.flatMap((chunk) => chunk.units).map((unit) => unit.first_message_index))
      .toEqual(messages.map((_, index) => index));
    for (const chunk of plan.chunks) {
      expect(chunk.accounting.totalTokens).toBeLessThanOrEqual(950_000);
      expect(() => canonicalizeJson({
        source_sha256: "a".repeat(64),
        message_sources: refs.slice(chunk.units[0]!.first_message_index,
          chunk.units.at(-1)!.last_message_index + 1),
      })).not.toThrow();
    }
    expect(plan.planning_work.chunk_candidate_evaluations).toBeLessThan(100);
    expect(plan.planning_work.maximum_candidate_semantic_units).toBe(2_000);
  });

  it("leaves a small fitting history in one chunk", () => {
    const { messages, options } = fixture(8);
    expect(buildCompactionMapReducePlan(messages, options).chunks).toHaveLength(1);
  });

  it("refuses an indivisible candidate that cannot fit without retrying or dropping it", () => {
    const { messages, refs, options } = fixture(1);
    Object.assign(refs[0]!, {
      contributing_ref_ids: Array.from({ length: MAX_COMPACTION_OUTPUT_NODES_PER_CALL },
        (_, index) => `source:${index}`),
    });
    expect(() => buildCompactionMapReducePlan(messages, options))
      .toThrow("cannot fit the compaction request budget");
  });

  it("does not relax canonical provider-output limits", () => {
    expect(() => canonicalizeJson(Array(MAX_COMPACTION_OUTPUT_NODES_PER_CALL).fill(0)))
      .toThrow("provider output exceeds its node limit");
  });

  it("does not turn malformed source metadata into a smaller successful candidate", () => {
    const { messages, refs, options } = fixture(8);
    Object.defineProperty(refs[0], "unsafe", { enumerable: true, get() { throw new Error("getter ran"); } });
    expect(() => buildCompactionMapReducePlan(messages, options))
      .toThrow("provider output contains a getter or hidden property");
  });
});
