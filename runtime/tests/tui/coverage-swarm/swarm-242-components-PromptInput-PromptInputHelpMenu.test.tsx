import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { PromptInputHelpMenu } from "../../../src/tui/components/PromptInput/PromptInputHelpMenu.js";
import { renderToString } from "../../../src/utils/staticRender.js";

const harness = vi.hoisted(() => ({
  featureEnabled: false,
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
});

async function renderHelpMenu(): Promise<string> {
  return renderToString(
    <PromptInputHelpMenu dimColor fixedWidth gap={2} paddingX={1} />,
    { columns: 140, rows: 30 },
  );
}

describe("PromptInputHelpMenu coverage swarm row 242", () => {
  test("never renders the terminal panel shortcut in open builds", async () => {
    // The terminal panel rollout is permanently disabled in open builds, so
    // the terminal shortcut row is always null even when the build-time
    // TERMINAL_PANEL feature is on and a binding is configured.
    harness.featureEnabled = true;
    harness.shortcuts.set("app:toggleTerminal", "meta+shift+j");

    const output = await renderHelpMenu();

    expect(output).not.toContain("for terminal");
    expect(output).toContain("ctrl + z to suspend");
  });

  test("hides the suspend hint on windows", async () => {
    harness.platform = "windows";

    const output = await renderHelpMenu();

    expect(output).not.toContain("for terminal");
    expect(output).not.toContain("ctrl + z to suspend");
  });
});
