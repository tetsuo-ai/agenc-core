import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";

;(globalThis as Record<string, unknown>).MACRO = {
  DISPLAY_VERSION: "0.0.0-test",
  NATIVE_PACKAGE_URL: undefined,
  PACKAGE_URL: "@tetsuo-ai/agenc",
  VERSION: "0.0.0-test",
};

vi.mock("usehooks-ts", () => ({
  useInterval: () => {},
}));

vi.mock("../hooks/useUpdateNotification", () => ({
  useUpdateNotification: () => true,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: () => {},
}));

vi.mock("../../utils/log.js", () => ({
  logError: vi.fn(),
}));

vi.mock("../../utils/autoUpdater.js", () => ({
  getLatestVersion: vi.fn(async () => null),
  getMaxVersion: vi.fn(async () => null),
  getMaxVersionMessage: vi.fn(async () => null),
  installGlobalPackage: vi.fn(async () => "success"),
  shouldSkipVersion: vi.fn(() => false),
}));

vi.mock("../../utils/config.js", () => ({
  getGlobalConfig: () => ({}),
  isAutoUpdaterDisabled: () => true,
}));

vi.mock("../../utils/doctorDiagnostic.js", () => ({
  getCurrentInstallationType: vi.fn(async () => "development"),
}));

vi.mock("../../utils/localInstaller.js", () => ({
  installOrUpdateAgenCPackage: vi.fn(async () => "success"),
  localInstallationExists: vi.fn(async () => false),
}));

vi.mock("../../utils/nativeInstaller/installer.js", () => ({
  installLatest: vi.fn(async () => ({
    latestVersion: "1.2.3",
    lockFailed: false,
    wasUpdated: false,
  })),
  removeInstalledSymlink: vi.fn(async () => {}),
}));

vi.mock("../../utils/semver.js", () => ({
  gt: () => false,
  gte: () => true,
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({ autoUpdatesChannel: "latest" }),
  getInitialSettings: () => ({ autoUpdatesChannel: "latest" }),
}));

describe("auto updater ASCII rendering", () => {
  const originalGlyphMode = process.env.AGENC_TUI_GLYPHS;

  beforeEach(() => {
    process.env.AGENC_TUI_GLYPHS = "ascii";
  });

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS;
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode;
    }
  });

  test("JS updater success and failure rows avoid decorative Unicode", async () => {
    const { AutoUpdater } = await import("./AutoUpdater.js");

    const success = await renderToString(
      <AutoUpdater
        isUpdating={false}
        onChangeIsUpdating={() => {}}
        onAutoUpdaterResult={() => {}}
        autoUpdaterResult={{ version: "1.2.3", status: "success" }}
        showSuccessMessage={true}
        verbose={false}
      />,
      100,
    );
    const failure = await renderToString(
      <AutoUpdater
        isUpdating={false}
        onChangeIsUpdating={() => {}}
        onAutoUpdaterResult={() => {}}
        autoUpdaterResult={{ version: "1.2.3", status: "install_failed" }}
        showSuccessMessage={true}
        verbose={false}
      />,
      100,
    );
    const progress = await renderToString(
      <AutoUpdater
        isUpdating={true}
        onChangeIsUpdating={() => {}}
        onAutoUpdaterResult={() => {}}
        autoUpdaterResult={{ version: "1.2.3", status: "success" }}
        showSuccessMessage={true}
        verbose={false}
      />,
      100,
    );

    expect(success).toContain("OK Update installed - Restart to apply");
    expect(failure).toContain("ERR Auto-update failed - Try agenc doctor");
    expect(progress).toContain("Auto-updating...");
    expect(`${success}\n${failure}\n${progress}`).not.toMatch(/[✓✗·…]/u);
  });

  test("native updater success and failure rows avoid decorative Unicode", async () => {
    const { NativeAutoUpdater } = await import("./NativeAutoUpdater.js");

    const success = await renderToString(
      <NativeAutoUpdater
        isUpdating={false}
        onChangeIsUpdating={() => {}}
        onAutoUpdaterResult={() => {}}
        autoUpdaterResult={{ version: "1.2.3", status: "success" }}
        showSuccessMessage={true}
        verbose={false}
      />,
      100,
    );
    const failure = await renderToString(
      <NativeAutoUpdater
        isUpdating={false}
        onChangeIsUpdating={() => {}}
        onAutoUpdaterResult={() => {}}
        autoUpdaterResult={{ version: "1.2.3", status: "install_failed" }}
        showSuccessMessage={true}
        verbose={false}
      />,
      100,
    );

    expect(success).toContain("OK Update installed - Restart to update");
    expect(failure).toContain("ERR Auto-update failed - Try /status");
    expect(`${success}\n${failure}`).not.toMatch(/[✓✗·…]/u);
  });
});
