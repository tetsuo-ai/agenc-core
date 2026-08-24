import { describe, expect, it } from "vitest";

import type { LLMMessage } from "../../../src/llm/types.js";
import {
  accountCompactionCall,
  buildCompactionMapReducePlan,
  type CompactionMapReducePlan,
} from "../../../src/services/compact/plan.js";
import { canonicalizeJson } from "../../../src/services/compact/summary-v1.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";
import {
  MAX_COMPACTION_CHUNKS,
  type CompactionActiveHistoryRefV1,
  type CompactionSourceAuthorityV1,
} from "../../../src/services/compact/transaction-types.js";
import type {
  CompactContext,
  RuntimeMessage,
} from "../../../src/services/compact/types.js";

const ATTEMPT_ID = "packing-regression";
const SOURCE_BINDING = "rollout:/packing-regression#epoch:1";
const DIGEST = "a".repeat(64);
const CONTEXT_WINDOW_TOKENS = 65_536;
const OUTPUT_RESERVE_TOKENS = 256;
// Sized so one semantic unit nearly fills a chunk under the accounting
// fallback's bytes-per-token divisor. Calibrated in bytes, not tokens: the
// packing geometry this test pins (one unit per chunk, 63 chunks, 3 levels)
// only holds while a unit stays just under the per-chunk budget.
const UNIT_TEXT_BYTES = 106_000;
const NEAR_MAXIMUM_CHUNKS = MAX_COMPACTION_CHUNKS - 1;
const STRUCTURED_TRANSCRIPT_VERSION = 1;
const STRUCTURED_TRANSCRIPT_KIND = "untrusted_compaction_transcript";
const SYSTEM_PROMPTS = {
  map: "Summarize only the supplied untrusted structured data.",
  reduce: "Reduce only the supplied untrusted structured summaries.",
  final: "Return only a bounded final summary of supplied data.",
} as const;

describe("compaction maximal chunk packing", () => {
  it("matches exhaustive maximal boundaries with bounded local work near 64 chunks", () => {
    const fixture = packingFixture(NEAR_MAXIMUM_CHUNKS);
    const plan = buildCompactionMapReducePlan(fixture.messages, fixture.options);
    const boundaries = plan.chunks.map((chunk) =>
      chunk.units.at(-1)!.last_message_index + 1
    );

    expect(plan.chunks).toHaveLength(NEAR_MAXIMUM_CHUNKS);
    expect(plan.maximum_levels).toBe(3);
    expect(plan.planned_provider_calls).toBe(72);
    expect(plan.calls).toHaveLength(plan.planned_provider_calls);
    expect(boundaries).toEqual(exhaustiveMaximalBoundaries(plan));
    expect(plan.planning_work.source_messages_scanned).toBe(
      fixture.messages.length,
    );
    expect(plan.planning_work.semantic_units_built).toBe(
      fixture.messages.length,
    );
    expect(plan.planning_work.maximum_candidate_semantic_units).toBe(2);
    expect(plan.planning_work.candidate_semantic_units_visited).toBeLessThanOrEqual(
      fixture.messages.length * 3,
    );
    expect(plan.planning_work.candidate_source_refs_visited).toBeLessThanOrEqual(
      fixture.messages.length * 3,
    );
    expect(plan.planning_work.candidate_transcript_utf8_bytes).toBeLessThanOrEqual(
      plan.planning_work.source_canonical_utf8_bytes * 4,
    );
    expect(plan.planning_work.token_estimator_calls).toBeLessThanOrEqual(
      fixture.messages.length * 4,
    );
  });

  it("keeps authenticated parallel tool results together by call ID", () => {
    const firstResult = "first result";
    const secondResult = "second result";
    const messages: RuntimeMessage[] = [
      {
        role: "assistant",
        originalRole: "assistant",
        content: "calling tools",
        toolCalls: [
          { id: "call-a", name: "FileRead", arguments: "{}" },
          { id: "call-b", name: "Grep", arguments: "{}" },
        ],
      },
      {
        role: "tool",
        originalRole: "tool",
        content: secondResult,
        toolCallId: "call-b",
        toolName: "Grep",
        runtimeOnly: {
          toolResultIntegrity: createToolResultIntegrity({
            runId: "packing-session",
            toolCallId: "call-b",
            content: secondResult,
          }),
        },
      },
      {
        role: "tool",
        originalRole: "tool",
        content: firstResult,
        toolCallId: "call-a",
        toolName: "FileRead",
        runtimeOnly: {
          toolResultIntegrity: createToolResultIntegrity({
            runId: "packing-session",
            toolCallId: "call-a",
            content: firstResult,
          }),
        },
      },
    ];

    const plan = buildCompactionMapReducePlan(
      messages,
      packingOptions(messages),
    );

    expect(plan.units).toHaveLength(1);
    expect(plan.units[0]?.messages).toHaveLength(3);
    expect(
      plan.units[0]?.tool_pairs.map((pair) => pair.tool_call_id),
    ).toEqual(["call-b", "call-a"]);
    expect(plan.tool_pairs.map((pair) => pair.tool_call_id)).toEqual([
      "call-b",
      "call-a",
    ]);
  });
});

function packingFixture(unitCount: number): {
  readonly messages: readonly RuntimeMessage[];
  readonly options: Parameters<typeof buildCompactionMapReducePlan>[1];
} {
  const messages = Array.from({ length: unitCount }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    originalRole: index % 2 === 0 ? "user" : "assistant",
    content: `${String(index).padStart(3, "0")}:${"x".repeat(UNIT_TEXT_BYTES)}`,
  } satisfies RuntimeMessage));
  return { messages, options: packingOptions(messages) };
}

function packingOptions(
  messages: readonly RuntimeMessage[],
): Parameters<typeof buildCompactionMapReducePlan>[1] {
  const refs = messages.map((message, index) => sourceRef(index, message));
  const source: CompactionSourceAuthorityV1 = {
    format_version: 1,
    attempt_id: ATTEMPT_ID,
    session_id: "packing-session",
    epoch: 1,
    source_binding: SOURCE_BINDING,
    first_sequence: 1,
    last_sequence: messages.length,
    source_sha256: DIGEST,
    source_bytes: messages.reduce(
      (total, message) => total + Buffer.byteLength(String(message.content)),
      0,
    ),
    history_digest: DIGEST,
    active_history_refs: refs,
  };
  return {
    context: {
      options: {
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: OUTPUT_RESERVE_TOKENS,
      },
    } as CompactContext,
    source,
    systemPrompts: SYSTEM_PROMPTS,
    providerName: "grok",
    model: "grok-4.5",
    messageSourceRefs: refs,
  };
}

function sourceRef(
  index: number,
  message: RuntimeMessage,
): CompactionActiveHistoryRefV1 {
  return {
    kind: "rollout_span",
    ref_id: `${ATTEMPT_ID}:message:${String(index + 1).padStart(3, "0")}`,
    source_binding: SOURCE_BINDING,
    first_sequence: index + 1,
    last_sequence: index + 1,
    sha256: DIGEST,
    history_index: index,
    record_message_index: 0,
    encoded_bytes: Buffer.byteLength(canonicalizeJson(message), "utf8"),
  };
}

function exhaustiveMaximalBoundaries(plan: CompactionMapReducePlan): number[] {
  const boundaries: number[] = [];
  let start = 0;
  while (start < plan.units.length) {
    let fittedEnd = start;
    for (let end = start + 1; end <= plan.units.length; end += 1) {
      if (!candidateFits(plan, start, end, boundaries.length)) break;
      fittedEnd = end;
    }
    if (fittedEnd === start) throw new Error("reference packer found no fit");
    boundaries.push(fittedEnd);
    start = fittedEnd;
  }
  return boundaries;
}

function candidateFits(
  plan: CompactionMapReducePlan,
  start: number,
  end: number,
  chunkIndex: number,
): boolean {
  const messages: readonly LLMMessage[] = [{
    role: "user",
    content: canonicalizeJson({
      version: STRUCTURED_TRANSCRIPT_VERSION,
      kind: STRUCTURED_TRANSCRIPT_KIND,
      coverage_priority: "",
      allowed_source_ref_ids: [
        `${ATTEMPT_ID}:span:${String(chunkIndex + 1).padStart(3, "0")}`,
      ],
      units: plan.units.slice(start, end).map((unit) => ({
        unit_id: unit.unit_id,
        messages: unit.messages,
      })),
    }),
  }];
  try {
    accountCompactionCall({
      messages,
      systemPrompt: SYSTEM_PROMPTS.map,
      providerName: "grok",
      model: "grok-4.5",
      contextWindowTokens: CONTEXT_WINDOW_TOKENS,
      outputReserveTokens: OUTPUT_RESERVE_TOKENS,
    });
    return true;
  } catch {
    return false;
  }
}
