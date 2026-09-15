import { afterEach, describe, expect, test, vi } from "vitest";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { EMERGENCY_COMPACTION_FOCUS } from "../../../src/services/compact/ladder.js";
import {
  createRuntimeEmergencySummarizer,
  truncateUtf8,
} from "../../../src/services/compact/emergency-summarizer.js";
import { conservativeOutputTokenEstimate } from "../../../src/services/compact/transaction-limits.js";
import { reduceAll } from "../../../src/session/event-log-reducer.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

afterEach(() => vi.restoreAllMocks());

const source = [
  { role: "user" as const, content: `Please migrate the parity scorer. ${"context ".repeat(300)}` },
  { role: "assistant" as const, content: "I'll read the scorer first.", toolCalls: [{ id: "call-1", name: "FileRead", arguments: JSON.stringify({ file_path: "/app/scorer.py" }) }] },
  { role: "tool" as const, toolCallId: "call-1", toolName: "FileRead", content: `def score(): ...${"# body\n".repeat(400)}` },
  { role: "assistant" as const, content: "Now writing the dense grid.", toolCalls: [{ id: "call-2", name: "Write", arguments: JSON.stringify({ file_path: "/app/grid.py", content: "x".repeat(500) }) }] },
  { role: "tool" as const, toolCallId: "call-2", toolName: "Write", content: "File created successfully at: /app/grid.py" },
  { role: "assistant" as const, content: "Grid written; verifying parity next." },
];

function transcriptPayload() {
  return {
    role: "user" as const,
    content: JSON.stringify({
      version: 1,
      kind: "untrusted_compaction_transcript",
      coverage_priority: "",
      allowed_source_ref_ids: ["ref-1"],
      units: [{ unit_id: "u1", messages: source.map((message) => ({
        role: message.role, content: message.content,
        ...("toolCalls" in message ? { tool_calls: message.toolCalls } : {}),
        ...("toolCallId" in message ? { tool_call_id: message.toolCallId, tool_name: message.toolName } : {}),
      })) }],
    }),
  };
}

describe("runtime emergency summarizer", () => {
  test("map stage keeps the original request, latest state and dropped counts, and never exceeds the reserve", () => {
    const summarize = createRuntimeEmergencySummarizer();
    const body = JSON.parse(summarize({ stage: "map", messages: [transcriptPayload()], allowedSourceRefIds: ["ref-1"], maxOutputTokens: 4_096 })) as
      { narrative: string; facts: unknown[]; open_actions: unknown[] };
    expect(body.facts).toEqual([]);
    expect(body.open_actions).toEqual([]);
    expect(body.narrative).toContain("Runtime emergency compaction: the model summarizer could not reduce this context; 6 messages and 2 tool calls (FileRead×1, Write×1) were dropped.");
    expect(body.narrative).toContain("Original request:\nPlease migrate the parity scorer.");
    expect(body.narrative).toContain("Latest assistant text:\nGrid written; verifying parity next.");
    expect(body.narrative).toContain("Latest tool calls:\nWrite(");
    expect(body.narrative).not.toContain("def score()");

    const tiny = summarize({ stage: "map", messages: [transcriptPayload()], allowedSourceRefIds: ["ref-1"], maxOutputTokens: 64 });
    expect(conservativeOutputTokenEstimate(tiny)).toBeLessThanOrEqual(64);
    expect((JSON.parse(tiny) as { narrative: string }).narrative).toContain("Runtime emergency compaction");
  });

  test("reduce stage merges children: earliest request, latest state, summed counts", () => {
    const summarize = createRuntimeEmergencySummarizer();
    const child = (request: string, latest: string, messages: number) => ({
      ref_id: `s-${messages}`, sha256: "a".repeat(64),
      body: { narrative: `Runtime emergency compaction: the model summarizer could not reduce this context; ${messages} messages and 1 tool calls (Read×1) were dropped. Re-read files before relying on earlier contents.\n\nOriginal request:\n${request}\n\nLatest assistant text:\n${latest}`, facts: [], open_actions: [] },
    });
    const reduced = JSON.parse(summarize({ stage: "reduce", allowedSourceRefIds: ["s-4", "s-2"], maxOutputTokens: 4_096, messages: [{
      role: "user", content: JSON.stringify({ kind: "untrusted_compaction_summaries", stage: "reduce", summaries: [child("first ask", "state one", 4), child("second ask", "state two", 2)] }),
    }] })) as { narrative: string };
    expect(reduced.narrative).toContain("6 messages and 2 tool calls (Read×2) were dropped");
    expect(reduced.narrative).toContain("Original request:\nfirst ask");
    expect(reduced.narrative).toContain("Latest assistant text:\nstate two");
  });

  test("truncateUtf8 cuts on code-point boundaries and marks the cut", () => {
    expect(truncateUtf8("abc", 10)).toBe("abc");
    const cut = truncateUtf8("αβγδε".repeat(10), 12);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(12);
    expect(cut.endsWith(" […]")).toBe(true);
  });

  // The rollout store requires integrity metadata on tool results; the
  // durable-path cases use text-only history and leave tool handling to the
  // pure summarizer cases above.
  const durableSource = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: index === 0
      ? `Please migrate the parity scorer. ${"context ".repeat(300)}`
      : index === 7
        ? "Grid written; verifying parity next."
        : `Working message ${index}: ${"progress ".repeat(200)}`,
  }));

  test("the emergency tier commits through the real transaction without a provider call", async () => {
    const harness = createCompactionTransactionHarness(durableSource, { compactionMode: "automatic" });
    try {
      const before = reduceAll(harness.store.readAll()).state.history;
      const result = await compactConversation(durableSource, harness.context, EMERGENCY_COMPACTION_FOCUS, {
        keepCount: 0,
        summarizer: createRuntimeEmergencySummarizer(),
      });
      expect(harness.provider.chat).not.toHaveBeenCalled();
      expect(result.transaction).toBeDefined();
      const lifecycle = harness.store.readAll().filter((item) =>
        item.type === "compaction_intent" || item.type === "compaction_failed" || item.type === "compaction_committed");
      expect(lifecycle.map((item) => item.type)).toEqual(["compaction_intent", "compaction_committed"]);
      const committed = lifecycle.at(-1) as { payload: { summary: { body: { narrative: string; tool_pairs: unknown[] } }; replacement_history: unknown[] } };
      expect(committed.payload.summary.body.narrative).toContain("Original request:\nPlease migrate the parity scorer.");
      expect(committed.payload.summary.body.narrative).toContain("Latest assistant text:\nGrid written; verifying parity next.");
      expect(committed.payload.summary.body.tool_pairs).toEqual([]);
      const history = reduceAll(harness.store.readAll()).state.history;
      expect(history.length).toBeLessThan(before.length);
      // The reduced projection carries the boundary as the developer message;
      // its authenticated marker lives in runtime-only metadata the projection
      // does not expose.
      expect(history[0]).toMatchObject({ role: "developer", content: expect.stringContaining("agenc_compaction_boundary_v1") });
      expect(history[1]).toMatchObject({ role: "user", content: expect.stringContaining("Runtime emergency compaction") });
      expect(JSON.stringify(history)).not.toContain("Working message 3");
    } finally {
      harness.close();
    }
  });

  test("a bounded output reserve still commits a header-only summary", async () => {
    const harness = createCompactionTransactionHarness(durableSource, { compactionMode: "automatic", maxOutputTokens: 512 });
    try {
      const result = await compactConversation(durableSource, harness.context, EMERGENCY_COMPACTION_FOCUS, {
        keepCount: 0,
        summarizer: createRuntimeEmergencySummarizer(),
      });
      expect(result.transaction).toBeDefined();
      expect(harness.provider.chat).not.toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });
});
