import { createElement } from "react";
import { describe, expect, it, test, vi } from "vitest";

import { buildCostReport, formatCostReport } from "../../src/commands/cost.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { sessionSpendLabel, usagePlanLabel } from "../../src/session/usage-display.js";
import { statusLineRightFacts, statusLineUsageItems, statusUsageScope } from "../../src/tui/components/FullscreenLayout.js";
import { layoutStatusLine, statusLineGroupWidth, type PlacedStatusLineFact, type StatusLineFact } from "../../src/tui/components/statusLineLayout.js";
import { CostUsageModal } from "../../src/tui/components/v2/CostUsageModal.js";
import { renderToString } from "../../src/utils/staticRender.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));

// Job coste2e37 round 2: plain words. The numbers are those of the real sessions the job recorded.
const totals = { heldCostUsd: 0, totalTokens: 0, modelCalls: 0, hasUnknownCost: false };
const sol = { ...totals, model: "gpt-6.1-sol", provider: "openai", costUsd: 0, inputTokens: 149_586, outputTokens: 1_865,
  modelCalls: 15, planCalls: 15, meteredCalls: 0, apiEquivalentUsd: 0.075352, cachedInputTokens: 127_616, cacheInputTokens: 149_586,
  cacheUnreportedCalls: 0, billedEstimateUsd: 0 };
const flash = (runId: string, input: number, cached: number, output: number, peak: number, calls: number) => ({ ...totals, runId,
  model: "deepseek-flash", provider: "deepseek", costUsd: peak, billedEstimateUsd: peak / 2, inputTokens: input, outputTokens: output,
  modelCalls: calls, planCalls: 0, meteredCalls: calls, apiEquivalentUsd: 0, cachedInputTokens: cached, cacheInputTokens: input, cacheUnreportedCalls: 0 });
const swarm = {
  ...totals, runId: "conv-lead", sequence: 9, costUsd: 0.021604, billedEstimateUsd: 0.010802, hasOffPeakDiscount: true,
  planCalls: 15, meteredCalls: 23, apiEquivalentUsd: 0.075352, includesSubagents: true, modelCalls: 38,
  inputTokens: 342_200, outputTokens: 16_121, totalTokens: 358_321, cachedInputTokens: 308_864, cacheInputTokens: 342_200, cacheUnreportedCalls: 0,
  models: [{ ...flash("", 192_614, 181_248, 14_256, 0.021604, 23), runId: undefined }, sol],
  agentModels: [
    flash("c52e4243-bc29-46df-ad5e-aafcee58fdf5", 53_780, 49_536, 3_710, 0.006022, 7),
    { ...sol, runId: "conv-lead" },
    flash("ea79e0bf-a98a-4ad6-a6fa-6fd7e4d92c60", 75_649, 72_192, 6_845, 0.009684, 8),
  ],
  agents: [],
};
const signInLead = { ...totals, costUsd: 0, billedEstimateUsd: 0, planCalls: 3, meteredCalls: 0, cachedInputTokens: 1_152, cacheInputTokens: 2_853,
  cacheUnreportedCalls: 0, models: [{ provider: "openai", planCalls: 3 }] };
const apiKeyLead = { ...totals, costUsd: 0.003514, billedEstimateUsd: 0.003514, planCalls: 0, meteredCalls: 2, cachedInputTokens: 1_180,
  cacheInputTokens: 2_413, cacheUnreportedCalls: 0, models: [{ provider: "openai", planCalls: 0 }] };

const text = (facts: readonly PlacedStatusLineFact[]): string => facts.map(fact => fact.spans.map(span => span.text).join("")).join(" · ");
const zdr = { state: "zdr" } as never;
const left: StatusLineFact[] = ["workspace", "gpt-6.1-sol", "medium effort", "never asks"].map((word, index) => ({
  key: ["folder", "model", "effort", "mode"][index]!, forms: [[{ text: word, color: "text" as const }]] }));

function rightFacts(usage: Parameters<typeof sessionSpendLabel>[0] & Parameters<typeof statusUsageScope>[0], ctx: number, cache: number, running = 0): StatusLineFact[] {
  return statusLineRightFacts(statusLineUsageItems(ctx, cache, sessionSpendLabel(usage), null, "accentSoft",
    statusUsageScope(usage, running), usagePlanLabel(usage)), zdr);
}

describe("status line wording", () => {
  it("always shows the billed amount and names the plan", () => {
    expect(sessionSpendLabel(signInLead)).toBe("$0.00 billed");
    expect(usagePlanLabel(signInLead)).toBe("ChatGPT plan");
    expect(sessionSpendLabel(swarm)).toBe("swarm $0.011 billed off-peak");
    expect(usagePlanLabel(swarm)).toBe("ChatGPT plan");
    expect(sessionSpendLabel(apiKeyLead)).toBe("$0.0035 billed");
    expect(usagePlanLabel(apiKeyLead)).toBeNull();
    expect(usagePlanLabel({ planCalls: 2, models: [{ provider: "qwen-token-plan", planCalls: 2 }] })).toBe("subscription plan");
    // Sessions recorded before billing routes keep their old figure.
    expect(sessionSpendLabel({ costUsd: 1.25, hasUnknownCost: false })).toBe("$1.25");
  });

  it("reads in whole words on one wide row", () => {
    const wide = (usage: Parameters<typeof rightFacts>[0], ctx: number, cache: number, running = 0): string =>
      text(layoutStatusLine(170, left, rightFacts(usage, ctx, cache, running), { wholeWords: true }).right);
    expect(wide(signInLead, 1, 40)).toBe("ctx 1% · cache 40% · $0.00 billed · ChatGPT plan · ZDR");
    expect(wide(signInLead, 1, 40, 3)).toBe("ctx lead 1% · cache 40% · $0.00 billed · ChatGPT plan · ZDR");
    expect(wide(swarm, 3, 90)).toBe("ctx lead 3% · swarm cache 90% · swarm $0.011 billed off-peak · ChatGPT plan · ZDR");
    expect(wide({ ...swarm, cacheUnreportedCalls: 1 }, 2, 78))
      .toBe("ctx lead 2% · swarm cache 78% (1 call unknown) · swarm $0.011 billed off-peak · ChatGPT plan · ZDR");
    expect(wide({ ...swarm, cacheUnreportedCalls: 2 }, 2, 78)).toContain("swarm cache 78% (2 calls unknown)");
    expect(wide(apiKeyLead, 0, 49)).toBe("ctx 0% · cache 49% · $0.0035 billed · ZDR");
  });

  test.each([100, 60])("keeps every word and percent sign at %i columns", columns => {
    const usage = { ...swarm, cacheUnreportedCalls: 1 };
    const layout = layoutStatusLine(columns, left, rightFacts(usage, 2, 78), { wholeWords: true });
    const rows = [text(layout.left), text(layout.right), text(layout.rightSecond ?? [])].filter(Boolean);
    expect(layout.fits).toBe(true);
    for (const facts of [layout.left, layout.right, layout.rightSecond ?? []]) expect(statusLineGroupWidth(facts)).toBeLessThanOrEqual(columns - 4);
    expect(layout.rows).toBe(3);
    expect(rows).toEqual(["workspace · gpt-6.1-sol · medium effort · never asks",
      "ctx lead 2% · swarm cache 78% (1 call unknown)",
      "swarm $0.011 billed off-peak · ChatGPT plan · ZDR"]);
  });

  it("uses two rows at 100 columns and three at 60 for a swarm with full cache counts", () => {
    const at100 = layoutStatusLine(100, left, rightFacts(swarm, 3, 90), { wholeWords: true });
    expect(at100.rows).toBe(2);
    expect(text(at100.right)).toBe("ctx lead 3% · swarm cache 90% · swarm $0.011 billed off-peak · ChatGPT plan · ZDR");
    const at60 = layoutStatusLine(60, left, rightFacts(swarm, 3, 90), { wholeWords: true });
    expect([at60.rows, text(at60.right), text(at60.rightSecond ?? [])])
      .toEqual([3, "ctx lead 3% · swarm cache 90%", "swarm $0.011 billed off-peak · ChatGPT plan · ZDR"]);
  });

  it("keeps two rows when the usage block fits one in whole words", () => {
    const layout = layoutStatusLine(60, left, rightFacts(apiKeyLead, 0, 49), { wholeWords: false });
    expect(layout.rows).toBe(2);
    expect(text(layout.right)).toBe("ctx 0% · cache 49% · $0.0035 billed · ZDR");
  });
});

function context(usage: unknown, tasks: Record<string, unknown>): SlashCommandContext {
  return { session: { conversationId: "conv-lead", services: {} }, argsRaw: "", cwd: "/tmp/project", home: "/tmp",
    appState: { getAppState: () => ({ tasks }), getSessionUsage: () => usage } } as unknown as SlashCommandContext;
}
const task = (agentId: string, description: string) => ({ type: "local_agent", agentId, agentType: "runner", description, status: "completed" });

describe("/cost wording", () => {
  const tasks = {
    a: task("c52e4243-bc29-46df-ad5e-aafcee58fdf5", "SignalJacker"),
    b: task("ea79e0bf-a98a-4ad6-a6fa-6fd7e4d92c60", "Monowire"),
  };

  it("lists the lead first, agents by name, one row each, in both surfaces", async () => {
    const report = buildCostReport(context(swarm, tasks));
    expect(report.agentModels?.map(row => row.agentLabel)).toEqual(["lead", "SignalJacker", "Monowire"]);
    const out = formatCostReport(report);
    const modal = await renderToString(createElement(CostUsageModal, { report, onDone: () => {}, active: false }), { columns: 170, rows: 60 });
    for (const surface of [out, modal]) {
      expect(surface).toContain("ChatGPT plan: 15 calls, covered by your subscription");
      expect(surface).toContain("Same calls on an API key: $0.075 (for comparison, not billed)");
      expect(surface).toContain("lead · openai/gpt-6.1-sol");
      expect(surface).toContain("15 calls · 149.6K in · 85% cached · 1.9K out · $0.00 billed · ChatGPT plan · $0.075 on an API key");
      expect(surface).toContain("SignalJacker · deepseek/deepseek-flash");
      expect(surface).toContain("7 calls · 53.8K in · 92% cached · 3.7K out · $0.0030 billed");
      expect(surface.indexOf("lead · openai")).toBeLessThan(surface.indexOf("SignalJacker · deepseek"));
      expect(surface).toContain("Billed is an estimate. Plan calls are not charged per token.");
      for (const gone of ["c52e4243", "conv-lead", "API-equivalent", "Plan: 15", "no per-token charge", "peak rates, separate tool charges",
        "accounting totals include", "Missing counts", "billing-route", "reported calls only", "—"]) expect(surface).not.toContain(gone);
    }
    expect(modal).toMatch(/at peak rates\s+\$0\.022/);
    expect(modal).not.toContain("$0.0060");
  });

  it("adds eight characters of the id only where two agents share a name", () => {
    const twins = { a: task("c52e4243-bc29-46df-ad5e-aafcee58fdf5", "Twin"), b: task("ea79e0bf-a98a-4ad6-a6fa-6fd7e4d92c60", "Twin") };
    expect(buildCostReport(context(swarm, twins)).agentModels?.map(row => row.agentLabel))
      .toEqual(["lead", "Twin [c52e4243]", "Twin [ea79e0bf]"]);
  });

  it("names the calls without a cache count and lists a failed plan call without marking the money unknown", async () => {
    const usage = { ...swarm, cacheUnreportedCalls: 1, planCalls: 12, unpricedCallCount: 1,
      models: [swarm.models[0], { ...sol, planCalls: 12, modelCalls: 12, cacheUnreportedCalls: 1 }],
      unpricedCalls: [{ reservationId: "r1", runId: "conv-lead", stepId: "model:4", kind: "model_turn", model: "gpt-6.1-sol", provider: "openai",
        reason: "provider_call_failed_after_dispatch", plan: true as const }] };
    const report = buildCostReport(context(usage, tasks));
    const out = formatCostReport(report);
    const modal = await renderToString(createElement(CostUsageModal, { report, onDone: () => {}, active: false }), { columns: 170, rows: 60 });
    for (const surface of [out, modal]) {
      expect(surface).toContain("85% cached (1 call unknown)");
      expect(surface).toContain("Calls without reported usage (plan calls, nothing billed):");
      expect(surface).toContain("lead · openai/gpt-6.1-sol model call · failed after it was sent, no usage reported; ChatGPT plan call, nothing billed");
      expect(surface).not.toContain("≥");
    }
    expect(modal).toMatch(/SESSION\s+\$0\.011 billed/);
  });
});
