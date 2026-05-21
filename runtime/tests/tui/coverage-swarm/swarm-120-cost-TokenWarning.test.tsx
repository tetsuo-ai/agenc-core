import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  autoCompactEnabled: false,
  collapseEnabled: false,
  effectiveWindow: 200_000,
  enabledFeatures: new Set<string>(),
  errorThreshold: false,
  growthEnabled: false,
  percentLeft: 8,
  suppressWarning: false,
  upgradeMessage: null as string | null,
  warningThreshold: true,
}));

vi.mock("bun:bundle", () => ({
  feature: (flag: string) => state.enabledFeatures.has(flag),
}));

vi.mock("../../services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => state.growthEnabled,
}));

vi.mock("../../services/compact/autoCompact.js", () => ({
  calculateTokenWarningState: () => ({
    isAboveAutoCompactThreshold: state.autoCompactEnabled,
    isAboveErrorThreshold: state.errorThreshold,
    isAboveWarningThreshold: state.warningThreshold,
    isAtBlockingLimit: false,
    percentLeft: state.percentLeft,
  }),
  getEffectiveContextWindowSize: () => state.effectiveWindow,
  isAutoCompactEnabled: () => state.autoCompactEnabled,
}));

vi.mock("../../services/compact/compactWarningHook.js", () => ({
  useCompactWarningSuppression: () => state.suppressWarning,
}));

vi.mock("../../services/contextCollapse/index.js", () => ({
  isContextCollapseEnabled: () => state.collapseEnabled,
}));

vi.mock("../../utils/model/contextWindowUpgradeCheck.js", () => ({
  getUpgradeMessage: () => state.upgradeMessage,
}));

import { renderToString } from "../../utils/staticRender.js";
import { TokenWarning } from "../cost/TokenWarning.js";

async function renderWarning(tokenUsage = 192_000): Promise<string> {
  return renderToString(
    <TokenWarning tokenUsage={tokenUsage} model="sonnet" />,
    { columns: 120 },
  );
}

describe("TokenWarning coverage swarm row 120", () => {
  beforeEach(() => {
    state.autoCompactEnabled = false;
    state.collapseEnabled = false;
    state.effectiveWindow = 200_000;
    state.enabledFeatures = new Set();
    state.errorThreshold = false;
    state.growthEnabled = false;
    state.percentLeft = 8;
    state.suppressWarning = false;
    state.upgradeMessage = null;
    state.warningThreshold = true;
  });

  test("renders nothing below the warning threshold or while suppressed", async () => {
    state.warningThreshold = false;
    expect((await renderWarning()).trim()).toBe("");

    state.warningThreshold = true;
    state.suppressWarning = true;
    expect((await renderWarning()).trim()).toBe("");
  });

  test("renders the manual compact fallback without upgrade guidance", async () => {
    state.errorThreshold = true;
    state.percentLeft = 3;

    const output = await renderWarning();

    expect(output).toContain("Context low (3% remaining)");
    expect(output).toContain("Run /compact to compact & continue");
  });

  test("renders auto-compact guidance with upgrade text", async () => {
    state.autoCompactEnabled = true;
    state.percentLeft = 11;
    state.upgradeMessage = "/model larger";

    const output = await renderWarning();

    expect(output).toContain("11% until auto-compact");
    expect(output).toContain("/model larger");
    expect(output).not.toContain("Context low");
  });

  test("uses effective context percentages for reactive and collapse modes", async () => {
    state.autoCompactEnabled = true;
    state.effectiveWindow = 100;
    state.enabledFeatures = new Set(["REACTIVE_COMPACT"]);
    state.growthEnabled = true;

    const reactiveOutput = await renderWarning(125);

    expect(reactiveOutput).toContain("100% context used");

    state.enabledFeatures = new Set(["CONTEXT_COLLAPSE"]);
    state.growthEnabled = false;
    state.collapseEnabled = true;

    const collapseOutput = await renderWarning(75);

    expect(collapseOutput).toContain("25% until auto-compact");
  });
});
