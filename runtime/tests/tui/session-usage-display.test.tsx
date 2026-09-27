import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { CostReport } from "../../src/commands/cost.js";
import { CostUsageModal } from "../../src/tui/components/v2/CostUsageModal.js";
import { renderToString } from "../../src/utils/staticRender.js";

vi.mock("../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybindings: () => {},
}));

describe("canonical session usage display", () => {
  it("marks estimated totals and model/agent rows in the modal", async () => {
    const report: CostReport = {
      totalCostUsd: 0.045, totalIsEstimated: true, hasUnknownCost: false,
      models: [{ label: "unpriced", inputTokens: 100, outputTokens: 50, costUsd: 0.03, costEstimated: true }],
      agents: [{ label: "worker", status: "completed", costUsd: 0.015, costEstimated: true }],
    };
    const output = await renderToString(<CostUsageModal report={report} onDone={() => {}} active={false} />, 120);
    expect(output).toContain("$0.045 est.");
    expect(output).toContain("$0.030 est.");
    expect(output).toContain("$0.015 est.");
  });

  it("renders recorded worker cost instead of its competing token estimate", async () => {
    const report: CostReport = {
      totalCostUsd: 1.071394005, hasUnknownCost: false, models: [],
      agents: [{ label: "test worker", status: "completed", costUsd: 0.230392001, estimatedCostUsd: 9 }],
    };
    const output = await renderToString(<CostUsageModal report={report} onDone={() => {}} active={false} />, 120);
    expect(output).toContain("$1.07");
    expect(output).toContain("$0.23");
    expect(output).not.toContain("$9.00");
  });

});
