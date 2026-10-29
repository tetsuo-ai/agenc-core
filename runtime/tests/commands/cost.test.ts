import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { CostUsageModal } from "../../src/tui/components/v2/CostUsageModal.js";
import { renderToString } from "../../src/utils/staticRender.js";

import {
  buildCostReport,
  costCommand,
  formatCostReport,
} from "../../src/commands/cost.js";
import { buildDefaultRegistry } from "../../src/commands/registry.js";
import type {
  SlashCommandContext,
  SlashCommandResult,
} from "../../src/commands/types.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));

it("shows billed and peak accounting estimates in both /cost surfaces with the unknown prefix", async () => {
  const ctx = contextWith({});
  ctx.appState = {
    getSessionUsage: () => ({ runId: "session-1", sequence: 3, costUsd: 1, billedEstimateUsd: 0.75,
      inputTokens: 20, outputTokens: 10, totalTokens: 30, modelCalls: 2, heldCostUsd: 0.5,
      hasUnknownCost: true, models: [], agents: [] }),
  };
  const report = buildCostReport(ctx);
  expect(report).toMatchObject({ totalCostUsd: 1, billedEstimateUsd: 0.75, hasUnknownCost: true });
  const text = formatCostReport(report);
  expect(text).toContain("Session cost: ≥$1.00 (accounting; peak rates before off-peak discounts)");
  expect(text).toContain("Billed estimate: ≥$0.750");
  const modal = await renderToString(createElement(CostUsageModal, { report, onDone: () => {}, active: false }),
    { columns: 120, rows: 40 });
  expect(modal).toContain("≥$1.00");
  expect(modal).toContain("peak rates before off-peak discounts");
  expect(modal).toContain("billed estimate");
  expect(modal).toContain("≥$0.750");
});

/**
 * A fake CostSidecar exposing only the accessors `/cost` reads. The values
 * are real, provider-reported-shaped numbers so the assertions exercise the
 * actual formatting path rather than placeholders.
 */
function fakeCostSidecar() {
  return {
    getTotalCostUsd: () => 1.2345,
    getTotalInputTokens: () => 120_000,
    getTotalOutputTokens: () => 30_000,
    getTotalTurns: () => 7,
    hasUnknownModelCost: () => false,
    getSessionModelUsage: () => [
      {
        model: "claude-opus-4-7",
        provider: "anthropic",
        inputTokens: 120_000,
        outputTokens: 30_000,
        totalTokens: 150_000,
        costUsd: 1.2345,
      },
    ],
  };
}

function contextWith(opts: {
  sidecar?: unknown;
  appState?: unknown;
  setToolJSX?: (jsx: unknown) => void;
}): SlashCommandContext {
  return {
    session: {
      conversationId: "session-1",
      services: opts.sidecar !== undefined ? { costSidecar: opts.sidecar } : {},
    } as SlashCommandContext["session"],
    argsRaw: "",
    cwd: "/tmp/project",
    home: "/tmp",
    ...(opts.appState !== undefined || opts.setToolJSX !== undefined
      ? {
          appState: {
            ...(opts.appState !== undefined
              ? { getAppState: () => opts.appState }
              : {}),
            ...(opts.setToolJSX !== undefined
              ? { setToolJSX: opts.setToolJSX }
              : {}),
          },
        }
      : {}),
  };
}

function text(result: SlashCommandResult): string {
  expect(result.kind).toBe("text");
  return result.kind === "text" ? result.text : "";
}

const AGENT_APP_STATE = {
  tasks: {
    worker: {
      id: "agent-1",
      type: "local_agent",
      status: "running",
      agentType: "runner",
      model: "claude-opus-4-7",
      description: "build the parser",
      agentId: "agent-1",
      progress: { toolUseCount: 4, tokenCount: 40_000 },
    },
    mainSession: {
      id: "main",
      type: "local_agent",
      status: "running",
      agentType: "main-session",
      description: "orchestrator",
      agentId: "main",
      progress: { toolUseCount: 1, tokenCount: 9_000 },
    },
  },
};

describe("/cost", () => {
  it("names an interrupted unpriced call and shows the recorded total as a lower bound", () => {
    const report = buildCostReport({
      ...contextWith({}),
      appState: { getSessionUsage: () => ({
        runId: "session-1", sequence: 2, costUsd: 0.551, heldCostUsd: 0.02, inputTokens: 20, outputTokens: 10,
        totalTokens: 30, modelCalls: 1, hasUnknownCost: true, models: [], agents: [], unpricedCallCount: 1,
        unpricedCalls: [{ reservationId: "r2", runId: "worker-1", stepId: "turn-2", kind: "model_turn", provider: "deepseek",
          model: "deepseek-flash", reason: "cancelled_after_dispatch:interrupted" }],
      }) },
    });
    const out = formatCostReport(report);
    expect(out).toContain("Session cost: ≥$0.551");
    expect(out).toContain("deepseek/deepseek-flash · model call turn-2");
    expect(out).toContain("cancelled after dispatch (interrupted); provider usage unavailable");
    expect(out).toContain("run worker-1");
    expect(out).not.toContain("+?");
  });

  it("is registered with /stats as the default-surface alias", () => {
    const registry = buildDefaultRegistry();
    expect(registry.find("cost")?.name).toBe("cost");
    expect(registry.find("stats")?.name).toBe("cost");
  });

  it("reports real session cost + token totals from the cost sidecar", () => {
    const report = buildCostReport(
      contextWith({ sidecar: fakeCostSidecar() }),
    );
    expect(report.totalCostUsd).toBeCloseTo(1.2345, 4);
    expect(report.inputTokens).toBe(120_000);
    expect(report.outputTokens).toBe(30_000);
    expect(report.totalTokens).toBe(150_000);
    expect(report.turns).toBe(7);
    expect(report.models).toHaveLength(1);
    expect(report.models[0]).toMatchObject({
      label: "anthropic/claude-opus-4-7",
      inputTokens: 120_000,
      outputTokens: 30_000,
    });
    expect(report.models[0]!.costUsd).toBeCloseTo(1.2345, 4);

    const out = formatCostReport(report);
    expect(out).toContain("Session cost: $1.23");
    expect(out).toContain("120.0K in / 30.0K out");
    expect(out).toContain("anthropic/claude-opus-4-7");
  });

  it("derives a per-agent token + estimated-$ breakdown with real numbers", () => {
    const report = buildCostReport(
      contextWith({ sidecar: fakeCostSidecar(), appState: AGENT_APP_STATE }),
    );
    // Only the spawned runner agent is listed; main-session is the orchestrator.
    expect(report.agents).toHaveLength(1);
    const agent = report.agents[0]!;
    expect(agent.label).toBe("build the parser · runner");
    expect(agent.status).toBe("running");
    expect(agent.tokenCount).toBe(40_000);
    // Estimated cost is derived from real tokens + model — NOT a fabricated
    // value, and strictly positive for a known-priced model.
    expect(agent.estimatedCostUsd).toBeDefined();
    expect(agent.estimatedCostUsd!).toBeGreaterThan(0);

    const out = formatCostReport(report);
    expect(out).toContain("running build the parser · runner:");
    expect(out).toContain("40.0K tokens");
    expect(out).toContain("est.");
  });

  it("dashes per-agent spend when the token count is unknown (never $0.00)", () => {
    const report = buildCostReport(
      contextWith({
        sidecar: fakeCostSidecar(),
        appState: {
          tasks: {
            noTokens: {
              id: "a2",
              type: "local_agent",
              status: "running",
              agentType: "runner",
              model: "claude-opus-4-7",
              description: "warming up",
              agentId: "a2",
              progress: { toolUseCount: 0 },
            },
          },
        },
      }),
    );
    expect(report.agents[0]!.estimatedCostUsd).toBeUndefined();
    expect(formatCostReport(report)).toMatch(/warming up · runner: tokens unknown · cost unknown/);
  });

  it("degrades gracefully when no cost sidecar AND no agents", () => {
    const report = buildCostReport(contextWith({}));
    expect(report.totalCostUsd).toBeUndefined();
    expect(report.totalIsEstimated).toBeUndefined();
    expect(formatCostReport(report)).toContain(
      "Session cost: unknown (cost tracking unavailable)",
    );
  });

  it("does not label a partial agent estimate as the session total", () => {
    const report = buildCostReport(contextWith({ appState: AGENT_APP_STATE }));
    expect(report.agents).toHaveLength(1);
    const agentEstimate = report.agents[0]!.estimatedCostUsd;
    expect(agentEstimate).toBeGreaterThan(0);
    expect(report.totalCostUsd).toBeUndefined();
    expect(report.totalIsEstimated).toBeUndefined();
    expect(report.totalTokens).toBeUndefined();

    const out = formatCostReport(report);
    expect(out).toContain("cost tracking unavailable");
    expect(out).not.toContain("40.0K total est.");
  });

  it("opens the cost modal when the interactive TUI surface is available", async () => {
    const setToolJSX = vi.fn();
    const result = await costCommand.execute(
      contextWith({ sidecar: fakeCostSidecar(), setToolJSX }),
    );
    expect(result).toEqual({ kind: "skip" });
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocalJSXCommand: true,
        jsx: expect.anything(),
      }),
    );
  });

  it("falls back to text output (no TUI surface) with the real numbers", async () => {
    const result = await costCommand.execute(
      contextWith({ sidecar: fakeCostSidecar(), appState: AGENT_APP_STATE }),
    );
    const out = text(result);
    expect(out).toContain("Session cost: ≥$1.23");
    expect(out).toContain("build the parser · runner");
  });
});
