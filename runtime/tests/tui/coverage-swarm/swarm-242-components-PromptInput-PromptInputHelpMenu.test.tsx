import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { PromptInputHelpMenu } from "../../../src/tui/components/PromptInput/PromptInputHelpMenu.js";
import { renderToString } from "../../../src/utils/staticRender.js";

const harness = vi.hoisted(() => ({
  featureEnabled: false,
  getFeatureValue: vi.fn((_key: string, fallback: boolean) => fallback),
  platform: "linux",
  shortcuts: new Map<string, string>(),
}));

vi.mock("bun:bundle", () => ({
  feature: () => harness.featureEnabled,
}));

vi.mock("../../../src/tui/keybindings/useShortcutDisplay.js", () => ({
  useShortcutDisplay: (_action: string, _context: string, fallback: string) =>
    harness.shortcuts.get(_action) ?? fallback,
}));

vi.mock("../../../src/tui/keybindings/loadUserBindings.js", () => ({
  isKeybindingCustomizationEnabled: () => false,
}));

vi.mock("../../../src/services/analytics/growthbook.js", () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: harness.getFeatureValue,
}));

vi.mock("../../../src/utils/fastMode.js", () => ({
  isFastModeAvailable: () => false,
  isFastModeEnabled: () => false,
}));

vi.mock("../../../src/utils/platform.js", () => ({
  getPlatform: () => harness.platform,
}));

beforeEach(() => {
  harness.featureEnabled = false;
  harness.platform = "linux";
  harness.shortcuts.clear();
  harness.getFeatureValue.mockReset();
  harness.getFeatureValue.mockImplementation(
    (_key: string, fallback: boolean) => fallback,
  );
});

async function renderHelpMenu(): Promise<string> {
  return renderToString(
    <PromptInputHelpMenu dimColor fixedWidth gap={2} paddingX={1} />,
    { columns: 140, rows: 30 },
  );
}

describe("PromptInputHelpMenu coverage swarm row 242", () => {
  test("renders the terminal panel shortcut when both rollout gates are enabled", async () => {
    harness.featureEnabled = true;
    harness.platform = "windows";
    harness.shortcuts.set("app:toggleTerminal", "meta+shift+j");
    harness.getFeatureValue.mockReturnValue(true);

    const output = await renderHelpMenu();

    expect(output).toContain("meta + shift + j for terminal");
    expect(output).not.toContain("ctrl + z to suspend");
    expect(harness.getFeatureValue).toHaveBeenCalledWith(
      "agenc_terminal_panel",
      false,
    );
  });

  test("keeps the terminal shortcut hidden when the rollout value is false", async () => {
    harness.featureEnabled = true;
    harness.getFeatureValue.mockReturnValue(false);

    const output = await renderHelpMenu();

    expect(output).not.toContain("for terminal");
    expect(output).toContain("ctrl + z to suspend");
    expect(harness.getFeatureValue).toHaveBeenCalledWith(
      "agenc_terminal_panel",
      false,
    );
  });
});
