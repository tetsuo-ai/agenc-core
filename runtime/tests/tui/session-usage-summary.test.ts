import { describe, expect, it } from "vitest";
import type { AdmissionUsageSummary, AdmissionUsageTotals } from "../../src/budget/admission-types.js";
import { buildCostReport, formatCostReport } from "../../src/commands/cost.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { CostSidecar } from "../../src/session/cost.js";
import { isAdmissionUsageSummary, latestSessionUsage } from "../../src/session/usage-summary.js";
import {
  adaptTranscriptEvents,
  appendSessionTranscriptBatchForTesting,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
  type SessionTranscriptEvent,
} from "../../src/tui/session-transcript.js";

function totals(costUsd: number): AdmissionUsageTotals {
  return { costUsd, inputTokens: 20, outputTokens: 10, totalTokens: 30, modelCalls: 1, hasUnknownCost: false, heldCostUsd: 0 };
}

function summary(sequence = 10, costUsd = 1.071394005): AdmissionUsageSummary {
  return {
    ...totals(costUsd), runId: "parent", sequence,
    models: [{ ...totals(costUsd), model: "grok-4.6", provider: "grok" }],
    agents: [{ ...totals(0.230392001), runId: "worker" }],
  };
}

function usageEvent(value: unknown, seq = 1): SessionTranscriptEvent {
  return { id: `event-${seq}`, seq, type: "session_usage", payload: value };
}

function commandContext(usage?: AdmissionUsageSummary): SlashCommandContext {
  return {
    session: { services: { costSidecar: new CostSidecar() } } as SlashCommandContext["session"],
    argsRaw: "", cwd: "/tmp/project", home: "/tmp",
    appState: {
      ...(usage !== undefined ? { getSessionUsage: () => usage } : {}),
      getAppState: () => ({ tasks: {
        worker: { agentId: "worker", type: "local_agent", agentType: "runner", description: "Worker", status: "completed", model: "grok-4.6", progress: { tokenCount: 80000 } },
      } }),
    },
  };
}

describe("session usage projection", () => {
  it("labels estimated session, model and agent costs while preserving priced rows", () => {
    const usage: AdmissionUsageSummary = {
      ...summary(10, 0.045), costEstimated: true,
      models: [
        { ...totals(0.045), model: "unpriced", costEstimated: true },
        { ...totals(0), model: "free" },
      ],
      agents: [
        { ...totals(0.045), runId: "worker", costEstimated: true },
        { ...totals(0), runId: "free-worker" },
      ],
    };
    const transcript = adaptTranscriptEvents([usageEvent(usage)]);
    const report = buildCostReport(commandContext(transcript.sessionUsage!));
    expect(report.totalIsEstimated).toBe(true);
    expect(report.models[0]?.costEstimated).toBe(true);
    expect(report.agents[0]?.costEstimated).toBe(true);
    const output = formatCostReport(report);
    expect(output).toContain("Session cost: $0.045 est.");
    expect(output).toContain("unpriced: 20 in, 10 out ($0.045 est.)");
    expect(output).toContain("completed Worker · runner: 30 tokens · $0.045 est.");
    expect(output).toContain("free: 20 in, 10 out ($0.00)");
    expect(output).toContain("recorded free-worker: 30 tokens · $0.00");
    expect(output).not.toContain("some pricing unknown");
    expect(output).not.toContain("from agent tokens");
  });

  it("uses the same exact aggregate for transcript and cost report without adding worker rows again", () => {
    const usage = summary();
    const transcript = adaptTranscriptEvents([
      { type: "token_count", payload: { promptTokens: 1000, completionTokens: 200, model: "grok-4.6", provider: "grok" } },
      usageEvent(usage),
      { type: "token_count", payload: { promptTokens: 1000, completionTokens: 200, model: "grok-4.6", provider: "grok" } },
    ]);
    const report = buildCostReport(commandContext(usage));
    expect(transcript.sessionCostUsd).toBe(usage.costUsd);
    expect(report.totalCostUsd).toBe(transcript.sessionCostUsd);
    expect(report.totalIsEstimated).toBeUndefined();
    expect(report.agents[0]).toMatchObject({ costUsd: 0.230392001, tokenCount: 30, status: "completed" });
    expect(report.agents[0]!.estimatedCostUsd).toBeUndefined();
    expect(formatCostReport(report)).toContain("Session cost: $1.07");
    expect(transcript.latestUsage?.input_tokens).toBe(1000);
  });

  it("restores a snapshot even when no parent token_count events remain", () => {
    const usage = summary();
    const transcript = adaptTranscriptEvents([usageEvent(usage)]);
    expect(transcript.sessionCostUsd).toBe(usage.costUsd);
    expect(transcript.sessionUsage).toEqual(usage);
    expect(transcript.latestUsage).toBeNull();
  });

  it("preserves cumulative usage over history resets, event eviction and out-of-order batches", () => {
    let state = createSessionTranscriptStateForTesting([usageEvent(summary(), 1)]);
    state = appendSessionTranscriptBatchForTesting(state, Array.from({ length: 4100 }, (_, index) => ({
      type: "warning", id: `padding-${index}`, seq: index + 2, payload: { message: "padding" },
    })));
    expect(state.events.some((event) => "type" in event && event.type === "session_usage")).toBe(false);
    expect(state.sessionUsage?.costUsd).toBe(1.071394005);
    state = appendSessionTranscriptBatchForTesting(state, [
      { type: "history_cleared", id: "clear", seq: 4102, payload: {} },
      usageEvent(summary(11, 1.2), 4103),
      usageEvent(summary(9, 0.9), 2),
    ]);
    expect(state.sessionUsage).toEqual(summary(11, 1.2));
    state = appendSessionTranscriptEventForTesting(state, usageEvent(summary(8, 0.8), 1));
    expect(state.sessionUsage).toEqual(summary(11, 1.2));
    const restored = createSessionTranscriptStateForTesting([usageEvent(summary(11, 1.2))]);
    expect(restored.sessionUsage).toEqual(state.sessionUsage);
  });

  it("ignores replay duplicates and foreign compact-child snapshots", () => {
    const usage = summary();
    expect(latestSessionUsage(usage, usageEvent(summary()))).toBe(usage);
    expect(latestSessionUsage(usage, usageEvent({ ...summary(12), runId: "compact-child" }))).toBe(usage);
    expect(latestSessionUsage(usage, { msg: { type: "session_usage", payload: summary(11, 1.2) } })).toEqual(summary(11, 1.2));
  });

  it.each([
    { costUsd: Number.NaN }, { costUsd: -1 }, { heldCostUsd: Number.POSITIVE_INFINITY },
    { sequence: -1 }, { totalTokens: 1.5 }, { hasUnknownCost: "false" },
    { models: [{}] }, { agents: [{ ...totals(1), runId: "" }] },
  ])("ignores malformed usage fields %j", (invalid) => {
    const usage = summary();
    const malformed = { ...summary(11), ...invalid };
    expect(isAdmissionUsageSummary(malformed)).toBe(false);
    expect(latestSessionUsage(usage, usageEvent(malformed))).toBe(usage);
  });

  it("marks unknown cost and never substitutes the reserved amount for actual spend", () => {
    const usage = { ...summary(), costUsd: 0.4, heldCostUsd: 2, hasUnknownCost: true };
    const report = buildCostReport(commandContext(usage));
    expect(report.totalCostUsd).toBe(0.4);
    expect(report.hasUnknownCost).toBe(true);
    expect(formatCostReport(report)).toContain("some pricing unknown");
  });

  it("preserves actual ledger rows after the worker disappears from the UI task list", () => {
    const context = commandContext(summary());
    const report = buildCostReport({ ...context, appState: { getSessionUsage: () => summary() } });
    expect(report.agents[0]).toMatchObject({ label: "worker", status: "recorded", costUsd: 0.230392001 });
    expect(report.totalCostUsd).toBe(1.071394005);
  });

  it("reads the live admission summary in an in-process command context", () => {
    const usage = summary();
    const context = commandContext();
    const report = buildCostReport({
      ...context,
      session: { services: { executionAdmission: { getUsageSummary: () => usage } } } as SlashCommandContext["session"],
    });
    expect(report.totalCostUsd).toBe(usage.costUsd);
  });

  it("binds real CostSidecar accessors when canonical usage is unavailable", () => {
    expect(() => buildCostReport(commandContext())).not.toThrow();
    expect(buildCostReport(commandContext()).totalCostUsd).toBe(0);
    expect(buildCostReport(commandContext()).hasUnknownCost).toBe(true);
  });
});

describe("transcript cost for fast mode", () => {
  it("prices a fast-served token_count at the model's fast-mode rates", () => {
    // 1M input tokens on Claude Opus 5.5: $4 standard, $8 fast.
    const tokenCount = (speed?: "fast") => ({
      type: "token_count",
      payload: {
        promptTokens: 1_000_000,
        completionTokens: 0,
        model: "claude-opus-5-5",
        provider: "anthropic",
        ...(speed !== undefined ? { speed } : {}),
      },
    });
    expect(adaptTranscriptEvents([tokenCount()]).sessionCostUsd).toBeCloseTo(4, 6);
    expect(adaptTranscriptEvents([tokenCount("fast")]).sessionCostUsd).toBeCloseTo(8, 6);
  });
});

it("prices Haiku 5.5 transcript cache writes at both TTLs and the total prompt tier", () => {
  const transcript = adaptTranscriptEvents([{ type: "token_count", payload: {
    provider: "anthropic", model: "claude-haiku-5-5", promptTokens: 60_001, completionTokens: 1000,
    cachedInputTokens: 20_000, cacheCreationInputTokens: 20_000, cacheCreation1hInputTokens: 10_000,
  } }]);
  expect(transcript.sessionCostUsd).toBeCloseTo((60_001 * 0.5 + 1000 * 2.5 + 20_000 * 0.05 + 10_000 * 0.625 + 10_000) / 1e6, 10);
});
