import { describe, expect, it } from "vitest";
import { conservativeBytesPerToken } from "../../../src/llm/token-accounting.js";
import {
  accountCompactionCall,
  buildCompactionMapReducePlan,
  compactionInputBytesPerToken,
} from "../../../src/services/compact/plan.js";
import { canonicalizeJson } from "../../../src/services/compact/summary-v1.js";
import type {
  CompactionActiveHistoryRefV1,
  CompactionSourceAuthorityV1,
} from "../../../src/services/compact/transaction-types.js";
import type { CompactContext, RuntimeMessage } from "../../../src/services/compact/types.js";

const PROVIDER = "grok";
const MODEL = "grok-4.6";
const CONTEXT_WINDOW_TOKENS = 500_000;
const OUTPUT_RESERVE_TOKENS = 4_000;
const SYSTEM_PROMPTS = {
  map: "Summarize only the supplied untrusted structured data.",
  reduce: "Reduce only the supplied untrusted structured summaries.",
  final: "Return only a bounded final summary of supplied data.",
} as const;

// A transcript-like body: short JSON records, the shape the summarizer reads.
function denseBody(bytes: number): string {
  const record = '{"tool":"exec_command","exit":0,"out":"[0.123, 4.56e-3, 7.8]"},';
  return record.repeat(Math.ceil(bytes / record.length)).slice(0, bytes);
}

function fixture(unitCount: number, unitBytes: number) {
  const messages = Array.from({ length: unitCount }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    originalRole: index % 2 === 0 ? "user" : "assistant",
    content: `${String(index).padStart(3, "0")}:${denseBody(unitBytes)}`,
  } satisfies RuntimeMessage));
  const refs: CompactionActiveHistoryRefV1[] = messages.map((message, index) => ({
    kind: "rollout_span",
    ref_id: `dense:message:${String(index + 1).padStart(3, "0")}`,
    source_binding: "rollout:/dense#epoch:1",
    first_sequence: index + 1,
    last_sequence: index + 1,
    sha256: "a".repeat(64),
    history_index: index,
    record_message_index: 0,
    encoded_bytes: Buffer.byteLength(canonicalizeJson(message), "utf8"),
  }));
  const source: CompactionSourceAuthorityV1 = {
    format_version: 1,
    attempt_id: "dense",
    session_id: "dense-session",
    epoch: 1,
    source_binding: "rollout:/dense#epoch:1",
    first_sequence: 1,
    last_sequence: messages.length,
    source_sha256: "a".repeat(64),
    source_bytes: messages.reduce(
      (total, message) => total + Buffer.byteLength(String(message.content)),
      0,
    ),
    history_digest: "a".repeat(64),
    active_history_refs: refs,
  };
  return {
    messages,
    options: {
      context: {
        options: {
          contextWindowTokens: CONTEXT_WINDOW_TOKENS,
          maxOutputTokens: OUTPUT_RESERVE_TOKENS,
        },
      } as CompactContext,
      source,
      systemPrompts: SYSTEM_PROMPTS,
      providerName: PROVIDER,
      model: MODEL,
      messageSourceRefs: refs,
    },
  };
}

describe("compaction input is planned at the dense bytes-per-token bound", () => {
  it("never assumes more than 2 bytes per token for the summarizer's input", () => {
    // The catalogue lists grok at 4 bytes per token; the measured compaction
    // transcript tokenized at 2.29.
    expect(conservativeBytesPerToken(PROVIDER, MODEL)).toBeGreaterThan(2);
    expect(compactionInputBytesPerToken(PROVIDER, MODEL)).toBe(2);
    expect(compactionInputBytesPerToken("unknown-provider", "unknown-model")).toBe(2);
  });

  it("accounts a dense transcript at the bound, not at the catalogue ratio", () => {
    const body = denseBody(400_000);
    const accounting = accountCompactionCall({
      messages: [{ role: "user", content: body }],
      systemPrompt: SYSTEM_PROMPTS.final,
      providerName: PROVIDER,
      model: MODEL,
      contextWindowTokens: CONTEXT_WINDOW_TOKENS,
      outputReserveTokens: OUTPUT_RESERVE_TOKENS,
    });
    // 400 KB at 2 bytes per token is 200k tokens; the catalogue would say 100k.
    expect(accounting.inputTokens).toBeGreaterThanOrEqual(200_000);
    expect(accounting.totalTokens).toBe(accounting.inputTokens + OUTPUT_RESERVE_TOKENS);
    expect(accounting.confidence).toBe("conservative");
  });

  it("splits a 1.4 MB history for a 500k window into more than one summarizer call", () => {
    // Eight units of 175 KB: 1.4 MB, the size of the history whose single
    // planned call the provider refused with 612,000 tokens.
    const { messages, options } = fixture(8, 175_000);
    const plan = buildCompactionMapReducePlan(messages, options);
    expect(plan.chunks.length).toBeGreaterThanOrEqual(2);
    for (const call of plan.calls) {
      expect(call.input_token_upper_bound + OUTPUT_RESERVE_TOKENS)
        .toBeLessThanOrEqual(CONTEXT_WINDOW_TOKENS);
    }
  });
});
