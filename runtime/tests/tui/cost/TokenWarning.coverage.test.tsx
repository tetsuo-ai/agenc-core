import React from "react";
import { describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  autoCompactEnabled: false,
  percentLeft: 7,
  suppressWarning: false,
  upgradeMessage: "/model sonnet[1m]",
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}));

vi.mock("../../services/compact/autoCompact.js", () => ({
  calculateTokenWarningState: () => ({
    isAboveAutoCompactThreshold: false,
    isAboveErrorThreshold: false,
    isAboveWarningThreshold: true,
    isAtBlockingLimit: false,
    percentLeft: harness.percentLeft,
  }),
  getEffectiveContextWindowSize: () => 200_000,
  isAutoCompactEnabled: () => harness.autoCompactEnabled,
}));

vi.mock("../../services/compact/compactWarningHook.js", () => ({
  useCompactWarningSuppression: () => harness.suppressWarning,
}));

vi.mock("../../services/contextCollapse/index.js", () => ({
  isContextCollapseEnabled: () => false,
}));

vi.mock("../../utils/model/contextWindowUpgradeCheck.js", () => ({
  getUpgradeMessage: () => harness.upgradeMessage,
}));

import { renderToString } from "../../utils/staticRender.js";
import { TokenWarning } from "./TokenWarning.js";

describe("TokenWarning coverage", () => {
  test("renders the manual compact warning with upgrade guidance", async () => {
    const output = await renderToString(
      <TokenWarning tokenUsage={193_000} model="sonnet" />,
      120,
    );

    expect(output).toContain("Context low (7% remaining)");
    expect(output).toContain("/model sonnet[1m]");
    expect(output).not.toContain("Run /compact to compact & continue");
  });
});
