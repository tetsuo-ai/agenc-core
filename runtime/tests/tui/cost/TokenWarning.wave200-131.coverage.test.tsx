import React from "react";
import { describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  autoCompactEnabled: true,
  collapseEnabled: false,
  effectiveWindow: 200_000,
  enabledFeatures: new Set<string>(),
  growthEnabled: false,
  percentLeft: 9,
  upgradeMessage: null as string | null,
}));

vi.mock("bun:bundle", () => ({
  feature: (flag: string) => harness.enabledFeatures.has(flag),
}));

vi.mock("../../services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => harness.growthEnabled,
}));

vi.mock("../../services/compact/autoCompact.js", () => ({
  calculateTokenWarningState: () => ({
    isAboveAutoCompactThreshold: true,
    isAboveErrorThreshold: false,
    isAboveWarningThreshold: true,
    isAtBlockingLimit: false,
    percentLeft: harness.percentLeft,
  }),
  getEffectiveContextWindowSize: () => harness.effectiveWindow,
  isAutoCompactEnabled: () => harness.autoCompactEnabled,
}));

vi.mock("../../services/compact/compactWarningHook.js", () => ({
  useCompactWarningSuppression: () => false,
}));

vi.mock("../../services/contextCollapse/index.js", () => ({
  isContextCollapseEnabled: () => harness.collapseEnabled,
}));

vi.mock("../../utils/model/contextWindowUpgradeCheck.js", () => ({
  getUpgradeMessage: () => harness.upgradeMessage,
}));

import { renderToString } from "../../utils/staticRender.js";
import { TokenWarning } from "./TokenWarning.js";

describe("TokenWarning wave 200 worker 131 coverage", () => {
  test("renders auto-compact labels from reactive and collapse context modes", async () => {
    harness.enabledFeatures = new Set(["REACTIVE_COMPACT"]);
    harness.growthEnabled = true;
    harness.collapseEnabled = false;

    const reactiveOutput = await renderToString(
      <TokenWarning tokenUsage={190_000} model="sonnet" />,
      120,
    );

    expect(reactiveOutput).toContain("95% context used");
    expect(reactiveOutput).not.toContain("Context low");

    harness.enabledFeatures = new Set(["CONTEXT_COLLAPSE"]);
    harness.growthEnabled = false;
    harness.collapseEnabled = true;

    const collapseOutput = await renderToString(
      <TokenWarning tokenUsage={190_000} model="sonnet" />,
      120,
    );

    expect(collapseOutput).toContain("5% until auto-compact");
    expect(collapseOutput).not.toContain("Run /compact");
  });
});
