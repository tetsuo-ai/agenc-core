import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { CostReport } from "../../src/commands/cost.js";
import { CostUsageModal } from "../../src/tui/components/v2/CostUsageModal.js";
import { renderToString } from "../../src/utils/staticRender.js";

vi.mock("../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybindings: () => {},
}));

describe("canonical session usage display", () => {
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
