import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { CostReport } from "../../src/commands/cost.js";
import { CostUsageModal } from "../../src/tui/components/v2/CostUsageModal.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { AgentsRail } from "../../src/tui/workbench/agents/AgentsRail.js";
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

  it.each([false, true])("renders aggregate rail spending with unknown=%s", async (unknown) => {
    const output = await renderToString(
      <AppStateProvider initialState={getDefaultAppState()}>
        <AgentsRail width={45} focused={false} sessionCostUsd={1.071394005} sessionCostUnknown={unknown} />
      </AppStateProvider>,
      100,
    );
    expect(output).toContain("$1.07");
    expect(output.includes("$1.07+?")).toBe(unknown);
  });
});
