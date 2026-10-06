import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMMessage } from "../../../src/llm/types.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { EMERGENCY_COMPACTION_FOCUS } from "../../../src/services/compact/ladder.js";
import {
  createRuntimeEmergencySummarizer,
  truncateUtf8,
} from "../../../src/services/compact/emergency-summarizer.js";
import {
  buildCompactionMapReducePlan,
  structuredReductionMessages,
} from "../../../src/services/compact/plan.js";
import { conservativeOutputTokenEstimate } from "../../../src/services/compact/transaction-limits.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import { reduceAll } from "../../../src/session/event-log-reducer.js";
import { compactionPlanOptions, toolExchange } from "../../helpers/compaction-plan-fixture.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

afterEach(() => vi.restoreAllMocks());

const source: RuntimeMessage[] = [
  { role: "user", content: `Please migrate the parity scorer. ${"context ".repeat(300)}` },
  ...toolExchange([{ id: "call-1", name: "FileRead", arguments: JSON.stringify({ file_path: "/app/scorer.py" }), result: `def score(): ...${"# body\n".repeat(400)}` }], "I'll read the scorer first."),
  ...toolExchange([
    { id: "call-2", name: "Write", arguments: JSON.stringify({ file_path: "/app/grid.py", content: "x".repeat(500) }), result: "File created successfully at: /app/grid.py" },
    { id: "call-3", name: "MultiEdit", arguments: JSON.stringify({ file_path: "/app/scorer.py", edits: [{ old_string: "a".repeat(100), new_string: "b".repeat(100) }] }), result: "Applied 1 edit to /app/scorer.py" },
    { id: "call-4", name: "exec_command", arguments: "pytest -q", result: "3 passed" },
    { id: "call-5", name: "exec_command", arguments: JSON.stringify(["pytest", "-q"]), result: "3 passed" },
    { id: "call-6", name: "TaskList", result: "no tasks" },
  ], "Now writing the dense grid."),
  { role: "assistant", content: "Grid written; verifying parity next." },
];

/** The transcript the planner sends the summarizer for `source`. */
function transcriptPayload(): LLMMessage {
  return buildCompactionMapReducePlan(source, compactionPlanOptions(source)).chunks[0]!.messages[0]!;
}

describe("runtime emergency summarizer", () => {
  test("map stage keeps the original request, latest state and dropped counts, and never exceeds the reserve", () => {
    const summarize = createRuntimeEmergencySummarizer();
    const body = JSON.parse(summarize({ stage: "map", messages: [transcriptPayload()], allowedSourceRefIds: ["ref-1"], maxOutputTokens: 4_096 })) as
      { narrative: string; facts: unknown[]; open_actions: unknown[] };
    expect(body.facts).toEqual([]);
    expect(body.open_actions).toEqual([]);
    expect(body.narrative).toContain("Runtime emergency compaction: the model summarizer could not reduce this context; 10 messages and 6 tool calls (exec_command×2, FileRead×1, Write×1, MultiEdit×1, TaskList×1) were dropped.");
    expect(body.narrative).toContain("Original request:\nPlease migrate the parity scorer.");
    expect(body.narrative).toContain("Latest assistant text:\nGrid written; verifying parity next.");
    // The transcript sends parsed arguments with sorted keys. The target path
    // still leads, ahead of the long content or edits cut at the byte bound.
    expect(body.narrative).toMatch(/\nLatest tool calls:\nWrite\(\{"file_path":"\/app\/grid\.py","content":"x{100,} \[…\]\)\nMultiEdit\(\{"file_path":"\/app\/scorer\.py","edits":\[\{"new_string":"b{100}","old_string":"a+ \[…\]\)\nexec_command\(pytest -q\)\nexec_command\(\["pytest","-q"\]\)\nTaskList$/u);
    expect(body.narrative).not.toContain("def score()");

    const tiny = summarize({ stage: "map", messages: [transcriptPayload()], allowedSourceRefIds: ["ref-1"], maxOutputTokens: 64 });
    expect(conservativeOutputTokenEstimate(tiny)).toBeLessThanOrEqual(64);
    expect((JSON.parse(tiny) as { narrative: string }).narrative).toContain("Runtime emergency compaction");
  });

  test("reduce stage merges children: earliest request, latest state, summed counts", () => {
    const summarize = createRuntimeEmergencySummarizer();
    const child = (request: string, latest: string, messages: number) => ({
      ref_id: `s-${messages}`,
      body: { narrative: `Runtime emergency compaction: the model summarizer could not reduce this context; ${messages} messages and 1 tool calls (Read×1) were dropped. Re-read files before relying on earlier contents.\n\nOriginal request:\n${request}\n\nLatest assistant text:\n${latest}`, facts: [], open_actions: [] },
    });
    const reduced = JSON.parse(summarize({ stage: "reduce", allowedSourceRefIds: ["s-4", "s-2"], maxOutputTokens: 4_096, messages: structuredReductionMessages({
      children: [child("first ask", "state one", 4), child("second ask", "state two", 2)],
      stage: "reduce",
    }) })) as { narrative: string };
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
      // The emergency tier renders the same model-facing projection.
      expect(JSON.parse(String(history[1]?.content))).toEqual({
        facts: [],
        kind: "agenc_compaction_context_v2",
        narrative: committed.payload.summary.body.narrative,
        open_actions: [],
        trust: "untrusted_historical_data",
        version: 2,
      });
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
