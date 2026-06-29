import React from "react";
import { describe, expect, test, vi } from "vitest";

import { renderToString } from "../../../utils/staticRender.js";
import { General } from "./General.js";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../../keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: (_action: string, _context: string, fallback: string) =>
    fallback,
}));

vi.mock("../../keybindings/loadUserBindings.js", () => ({
  isKeybindingCustomizationEnabled: () => false,
}));

vi.mock("../../../utils/fastMode.js", () => ({
  isFastModeAvailable: () => false,
  isFastModeEnabled: () => false,
}));

vi.mock("../../../utils/platform.js", () => ({
  getPlatform: () => "linux",
}));

function RerenderGeneral() {
  const [tick, setTick] = React.useState(0);

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1);
    }
  }, [tick]);

  return <General />;
}

describe("HelpV2 General", () => {
  test("renders the overview copy and shortcut section", async () => {
    const output = await renderToString(<RerenderGeneral />, 120);

    expect(output).toContain("AgenC understands your codebase");
    expect(output).toContain("Shortcuts");
    expect(output).toContain("! for bash mode");
    expect(output).toContain("shift + tab to cycle modes");
  });
});
