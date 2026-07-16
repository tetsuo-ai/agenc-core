import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AutoUpdaterResult } from "../../../src/utils/autoUpdater.js";

const harness = vi.hoisted(() => ({
  getCurrentInstallationType: vi.fn(),
  getGlobalConfig: vi.fn(),
  getInitialSettings: vi.fn(),
  getLatestVersion: vi.fn(),
  getMaxVersion: vi.fn(),
  installGlobalPackage: vi.fn(),
  installOrUpdateAgenCPackage: vi.fn(),
  intervalDelay: undefined as number | null | undefined,
  isAutoUpdaterDisabled: vi.fn(),
  localInstallationExists: vi.fn(),
  logError: vi.fn(),
  logForDebugging: vi.fn(),
  removeInstalledSymlink: vi.fn(),
  shouldSkipVersion: vi.fn(),
  updateNotificationValue: true,
}));

vi.mock("usehooks-ts", () => ({
  useInterval: (_callback: () => void, delay: number | null) => {
    harness.intervalDelay = delay;
  },
}));

vi.mock("../../../src/tui/hooks/useUpdateNotification.js", () => ({
  useUpdateNotification: () => harness.updateNotificationValue,
}));

vi.mock("../../../src/utils/autoUpdater.js", () => ({
  getLatestVersion: harness.getLatestVersion,
  getMaxVersion: harness.getMaxVersion,
  installGlobalPackage: harness.installGlobalPackage,
  shouldSkipVersion: harness.shouldSkipVersion,
}));

vi.mock("../../../src/utils/config.js", () => ({
  getGlobalConfig: harness.getGlobalConfig,
  isAutoUpdaterDisabled: harness.isAutoUpdaterDisabled,
  saveGlobalConfig: vi.fn(),
}));

vi.mock("../../../src/utils/debug.js", () => ({
  logForDebugging: harness.logForDebugging,
}));

vi.mock("../../../src/utils/log.js", () => ({
  logError: harness.logError,
}));

vi.mock("../../../src/utils/doctorDiagnostic.js", () => ({
  getCurrentInstallationType: harness.getCurrentInstallationType,
}));

vi.mock("../../../src/utils/localInstaller.js", () => ({
  installOrUpdateAgenCPackage: harness.installOrUpdateAgenCPackage,
  localInstallationExists: harness.localInstallationExists,
}));

vi.mock("../../../src/utils/nativeInstaller/installer.js", () => ({
  removeInstalledSymlink: harness.removeInstalledSymlink,
}));

vi.mock("../../../src/utils/semver.js", () => {
  const compareVersions = (left: string, right: string): number => {
    const leftParts = left.split(".").map(Number);
    const rightParts = right.split(".").map(Number);

    for (let index = 0; index < 3; index += 1) {
      const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
      if (delta !== 0) {
        return delta;
      }
    }

    return 0;
  };

  return {
    gt: (left: string, right: string) => compareVersions(left, right) > 0,
    gte: (left: string, right: string) => compareVersions(left, right) >= 0,
  };
});

vi.mock("../../../src/utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: harness.getInitialSettings,
  getInitialSettings: harness.getInitialSettings,
}));

import { AutoUpdater } from "../../../src/tui/components/AutoUpdater.js";
import { createRoot } from "../../../src/tui/ink/root.js";

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS;
const originalMacro = (globalThis as Record<string, unknown>).MACRO;
const originalNodeEnv = process.env.NODE_ENV;

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  readonly stdout: PassThrough;
};

type RenderedRoot = {
  readonly cleanup: () => Promise<void>;
  readonly readOutput: () => string;
  readonly render: (node: React.ReactNode) => void;
};

function resetHarness(): void {
  harness.getCurrentInstallationType.mockReset().mockResolvedValue("npm-global");
  harness.getGlobalConfig
    .mockReset()
    .mockReturnValue({ installMethod: "global", theme: "dark" });
  harness.getInitialSettings
    .mockReset()
    .mockReturnValue({ autoUpdatesChannel: "stable" });
  harness.getLatestVersion.mockReset().mockResolvedValue("2.0.0");
  harness.getMaxVersion.mockReset().mockResolvedValue(null);
  harness.installGlobalPackage.mockReset().mockResolvedValue("success");
  harness.installOrUpdateAgenCPackage.mockReset().mockResolvedValue("success");
  harness.isAutoUpdaterDisabled.mockReset().mockReturnValue(false);
  harness.localInstallationExists.mockReset().mockResolvedValue(false);
  harness.logError.mockReset();
  harness.logForDebugging.mockReset();
  harness.removeInstalledSymlink.mockReset().mockResolvedValue(undefined);
  harness.shouldSkipVersion.mockReset().mockReturnValue(false);
  harness.intervalDelay = undefined;
  harness.updateNotificationValue = true;
}

function setMacro(version = "1.0.0"): void {
  (globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: "@tetsuo-ai/agenc",
    VERSION: version,
  };
}

function createStreams(): TestStreams {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStreams["stdin"];

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number }).columns = 240;
  (stdout as unknown as { columns: number; rows: number }).rows = 24;

  return { stdin, stdout };
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function renderInRoot(node: React.ReactNode): Promise<RenderedRoot> {
  let output = "";
  const { stdin, stdout } = createStreams();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  root.render(node);

  return {
    readOutput: () => stripAnsi(output),
    render: (updatedNode: React.ReactNode) => {
      root.render(updatedNode);
    },
    cleanup: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep(0);
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForOutput(
  rendered: RenderedRoot,
  expectedText: string,
): Promise<string> {
  await waitFor(
    () => rendered.readOutput().includes(expectedText),
    `output containing ${expectedText}`,
  );
  return rendered.readOutput();
}

function StatefulAutoUpdater(): React.ReactNode {
  const [isUpdating, setIsUpdating] = React.useState(false);
  const [autoUpdaterResult, setAutoUpdaterResult] =
    React.useState<AutoUpdaterResult | null>(null);

  return (
    <AutoUpdater
      autoUpdaterResult={autoUpdaterResult}
      isUpdating={isUpdating}
      onAutoUpdaterResult={setAutoUpdaterResult}
      onChangeIsUpdating={setIsUpdating}
      showSuccessMessage={true}
      verbose={true}
    />
  );
}

function StaticAutoUpdater({
  autoUpdaterResult = null,
  isUpdating = false,
}: {
  readonly autoUpdaterResult?: AutoUpdaterResult | null;
  readonly isUpdating?: boolean;
}): React.ReactNode {
  return (
    <AutoUpdater
      autoUpdaterResult={autoUpdaterResult}
      isUpdating={isUpdating}
      onAutoUpdaterResult={() => {}}
      onChangeIsUpdating={() => {}}
      showSuccessMessage={true}
      verbose={true}
    />
  );
}

describe("AutoUpdater coverage swarm row 050", () => {
  beforeEach(() => {
    resetHarness();
    process.env.AGENC_TUI_GLYPHS = "ascii";
    process.env.NODE_ENV = "production";
    setMacro();
  });

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS;
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalMacro === undefined) {
      delete (globalThis as Record<string, unknown>).MACRO;
    } else {
      (globalThis as Record<string, unknown>).MACRO = originalMacro;
    }
  });

  test("skips checks in development and while another update is active", async () => {
    process.env.NODE_ENV = "development";
    let rendered = await renderInRoot(<StaticAutoUpdater />);

    try {
      await waitFor(
        () =>
          harness.logForDebugging.mock.calls.some(
            ([message]) =>
              message ===
              "AutoUpdater: Skipping update check in test/dev environment",
          ),
        "development update-check skip",
      );
      expect(harness.getLatestVersion).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }

    resetHarness();
    process.env.NODE_ENV = "production";
    rendered = await renderInRoot(
      <StaticAutoUpdater
        autoUpdaterResult={{ status: "success", version: "2.0.0" }}
        isUpdating={true}
      />,
    );

    try {
      const output = await waitForOutput(rendered, "Auto-updating...");
      expect(output).toContain("globalVersion:");
      await sleep(20);
      expect(harness.getLatestVersion).not.toHaveBeenCalled();
      expect(
        harness.logForDebugging.mock.calls.some(([message]) =>
          String(message).startsWith("AutoUpdater:"),
        ),
      ).toBe(false);
    } finally {
      await rendered.cleanup();
    }
  });

  test("does not start an install when updating begins during a version check", async () => {
    let resolveLatestVersion!: (version: string) => void;
    harness.getLatestVersion.mockReturnValueOnce(
      new Promise(resolve => {
        resolveLatestVersion = resolve;
      }),
    );
    const onAutoUpdaterResult = vi.fn();
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={onAutoUpdaterResult}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    try {
      await waitFor(
        () => harness.getLatestVersion.mock.calls.length > 0,
        "version check start",
      );
      rendered.render(
        <AutoUpdater
          autoUpdaterResult={null}
          isUpdating={true}
          onAutoUpdaterResult={onAutoUpdaterResult}
          onChangeIsUpdating={onChangeIsUpdating}
          showSuccessMessage={true}
          verbose={true}
        />,
      );
      await sleep(0);

      resolveLatestVersion("2.0.0");
      await sleep(20);

      expect(harness.getMaxVersion).not.toHaveBeenCalled();
      expect(harness.removeInstalledSymlink).not.toHaveBeenCalled();
      expect(harness.getCurrentInstallationType).not.toHaveBeenCalled();
      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
      expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
      expect(onChangeIsUpdating).not.toHaveBeenCalled();
      expect(onAutoUpdaterResult).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }
  });

  test("does not start an install when updating begins during a max-version check", async () => {
    let resolveMaxVersion!: (version: string | null) => void;
    harness.getMaxVersion.mockReturnValueOnce(
      new Promise(resolve => {
        resolveMaxVersion = resolve;
      }),
    );
    const onAutoUpdaterResult = vi.fn();
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={onAutoUpdaterResult}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    try {
      await waitFor(
        () => harness.getMaxVersion.mock.calls.length > 0,
        "max-version check start",
      );
      rendered.render(
        <AutoUpdater
          autoUpdaterResult={null}
          isUpdating={true}
          onAutoUpdaterResult={onAutoUpdaterResult}
          onChangeIsUpdating={onChangeIsUpdating}
          showSuccessMessage={true}
          verbose={true}
        />,
      );
      await sleep(0);

      resolveMaxVersion(null);
      await sleep(20);

      expect(harness.removeInstalledSymlink).not.toHaveBeenCalled();
      expect(harness.getCurrentInstallationType).not.toHaveBeenCalled();
      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
      expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
      expect(onChangeIsUpdating).not.toHaveBeenCalled();
      expect(onAutoUpdaterResult).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }
  });

  test("logs local installation probe failures without blocking checks", async () => {
    const error = new Error("local probe failed");
    process.env.NODE_ENV = "development";
    harness.localInstallationExists.mockRejectedValueOnce(error);
    const rendered = await renderInRoot(<StaticAutoUpdater />);

    try {
      await waitFor(
        () => harness.logError.mock.calls.some(([value]) => value === error),
        "local installation probe error",
      );

      expect(harness.getLatestVersion).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }
  });

  test("drops local installation probe results after unmount", async () => {
    let resolveLocalExists!: (exists: boolean) => void;
    harness.localInstallationExists.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        resolveLocalExists = resolve;
      }),
    );
    const rendered = await renderInRoot(
      <StaticAutoUpdater
        autoUpdaterResult={{ status: "install_failed", version: "2.0.0" }}
      />,
    );

    await rendered.cleanup();
    resolveLocalExists(true);
    await sleep(20);

    expect(rendered.readOutput()).not.toContain("cd ~/.agenc/local");
  });

  test("uses latest channel when initial settings are unavailable", async () => {
    harness.getInitialSettings.mockReturnValue(undefined);
    const rendered = await renderInRoot(<StaticAutoUpdater />);

    try {
      await waitFor(
        () => harness.getLatestVersion.mock.calls.length > 0,
        "default channel update check",
      );

      expect(harness.getLatestVersion).toHaveBeenCalledWith("latest");
    } finally {
      await rendered.cleanup();
    }
  });

  test("logs version-check errors before an update starts", async () => {
    const error = new Error("version lookup failed");
    harness.getLatestVersion.mockRejectedValueOnce(error);
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={() => {}}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    try {
      await waitFor(
        () => harness.logError.mock.calls.some(([value]) => value === error),
        "version check error",
      );

      expect(onChangeIsUpdating).not.toHaveBeenCalled();
      expect(harness.getMaxVersion).not.toHaveBeenCalled();
      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }
  });

  test("caps to maxVersion and returns when current version already meets it", async () => {
    setMacro("2.0.0");
    harness.getLatestVersion.mockResolvedValue("9.0.0");
    harness.getMaxVersion.mockResolvedValue("2.0.0");
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={() => {}}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    try {
      await waitFor(
        () =>
          harness.logForDebugging.mock.calls.some(
            ([message]) =>
              message ===
              "AutoUpdater: current version 2.0.0 is already at or above maxVersion 2.0.0, skipping update",
          ),
        "max-version current-version skip",
      );

      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "AutoUpdater: maxVersion 2.0.0 is set, capping update from 9.0.0 to 2.0.0",
      );
      expect(harness.shouldSkipVersion).not.toHaveBeenCalled();
      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
      expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
      expect(harness.removeInstalledSymlink).not.toHaveBeenCalled();
      expect(onChangeIsUpdating).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }
  });

  test("caps install target to maxVersion when current version is below the cap", async () => {
    harness.getLatestVersion.mockResolvedValue("9.0.0");
    harness.getMaxVersion.mockResolvedValue("2.0.0");
    harness.getCurrentInstallationType.mockResolvedValue("npm-global");
    const rendered = await renderInRoot(<StatefulAutoUpdater />);

    try {
      await waitForOutput(rendered, "Update installed");

      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "AutoUpdater: maxVersion 2.0.0 is set, capping update from 9.0.0 to 2.0.0",
      );
      expect(harness.installGlobalPackage).toHaveBeenCalledOnce();
    } finally {
      await rendered.cleanup();
    }
  });

  test("installs with the npm-global path and keeps native symlinks untouched", async () => {
    harness.getGlobalConfig.mockReturnValue({
      installMethod: "native",
      theme: "dark",
    });
    harness.getCurrentInstallationType.mockResolvedValue("npm-global");
    const rendered = await renderInRoot(<StatefulAutoUpdater />);

    try {
      const output = await waitForOutput(rendered, "Update installed");

      expect(output).toContain("globalVersion: 1.0.0 - latestVersion: 2.0.0");
      expect(output).toContain("OK Update installed - Restart to apply");
      expect(harness.intervalDelay).toBe(1_800_000);
      expect(harness.getLatestVersion).toHaveBeenCalledWith("stable");
      expect(harness.removeInstalledSymlink).not.toHaveBeenCalled();
      expect(harness.getCurrentInstallationType).toHaveBeenCalledOnce();
      expect(harness.installGlobalPackage).toHaveBeenCalledOnce();
      expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "AutoUpdater: Detected installation type: npm-global",
      );
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "AutoUpdater: Using global update method",
      );
    } finally {
      await rendered.cleanup();
    }
  });

  test("clears the parent updating flag when unmounted after starting an update", async () => {
    let resolveInstall!: (status: "success") => void;
    const installPromise = new Promise<"success">(resolve => {
      resolveInstall = resolve;
    });
    harness.getCurrentInstallationType.mockResolvedValue("npm-global");
    harness.installGlobalPackage.mockReturnValueOnce(installPromise);
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={() => {}}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    await waitFor(
      () => onChangeIsUpdating.mock.calls.some(([value]) => value === true),
      "update start",
    );
    await rendered.cleanup();
    resolveInstall("success");
    await sleep(20);

    expect(onChangeIsUpdating).toHaveBeenNthCalledWith(1, true);
    expect(onChangeIsUpdating).toHaveBeenLastCalledWith(false);
  });

  test("installs with the npm-local path and records migrated success", async () => {
    harness.getCurrentInstallationType.mockResolvedValue("npm-local");
    const rendered = await renderInRoot(<StatefulAutoUpdater />);

    try {
      await waitForOutput(rendered, "Update installed");

      expect(harness.removeInstalledSymlink).toHaveBeenCalledOnce();
      expect(harness.installOrUpdateAgenCPackage).toHaveBeenCalledWith("stable");
      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "AutoUpdater: Using local update method",
      );
    } finally {
      await rendered.cleanup();
    }
  });

  test("skips unexpected native installation in the JS updater and clears updating", async () => {
    harness.getCurrentInstallationType.mockResolvedValue("native");
    const onAutoUpdaterResult = vi.fn();
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={onAutoUpdaterResult}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    try {
      await waitFor(
        () =>
          harness.logForDebugging.mock.calls.some(
            ([message]) =>
              message ===
              "AutoUpdater: Unexpected native installation in non-native updater",
          ),
        "native install skip",
      );

      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
      expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
      expect(onChangeIsUpdating).toHaveBeenNthCalledWith(1, true);
      expect(onChangeIsUpdating).toHaveBeenLastCalledWith(false);
      expect(onAutoUpdaterResult).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }
  });

  test("skips development installation type and clears updating", async () => {
    harness.getCurrentInstallationType.mockResolvedValue("development");
    const onAutoUpdaterResult = vi.fn();
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={onAutoUpdaterResult}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    try {
      await waitFor(
        () =>
          harness.logForDebugging.mock.calls.some(
            ([message]) =>
              message === "AutoUpdater: Cannot auto-update development build",
          ),
        "development install skip",
      );

      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
      expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
      expect(onChangeIsUpdating).toHaveBeenNthCalledWith(1, true);
      expect(onChangeIsUpdating).toHaveBeenLastCalledWith(false);
      expect(onAutoUpdaterResult).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }
  });

  test("clears updating when unmounted during installation-type detection", async () => {
    let resolveInstallationType!: (installationType: "npm-global") => void;
    harness.getCurrentInstallationType.mockReturnValueOnce(
      new Promise(resolve => {
        resolveInstallationType = resolve;
      }),
    );
    const onAutoUpdaterResult = vi.fn();
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={onAutoUpdaterResult}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    await waitFor(
      () => harness.getCurrentInstallationType.mock.calls.length > 0,
      "installation type check start",
    );
    await rendered.cleanup();
    resolveInstallationType("npm-global");
    await sleep(20);

    expect(onChangeIsUpdating).toHaveBeenNthCalledWith(1, true);
    expect(onChangeIsUpdating).toHaveBeenLastCalledWith(false);
    expect(harness.installGlobalPackage).not.toHaveBeenCalled();
    expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
    expect(onAutoUpdaterResult).not.toHaveBeenCalled();
  });

  test("clears updating when unmounted after symlink cleanup", async () => {
    let resolveRemoveSymlink!: () => void;
    harness.removeInstalledSymlink.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveRemoveSymlink = resolve;
      }),
    );
    const onAutoUpdaterResult = vi.fn();
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={onAutoUpdaterResult}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    await waitFor(
      () => harness.removeInstalledSymlink.mock.calls.length > 0,
      "symlink cleanup start",
    );
    await rendered.cleanup();
    resolveRemoveSymlink();
    await sleep(20);

    expect(onChangeIsUpdating).toHaveBeenNthCalledWith(1, true);
    expect(onChangeIsUpdating).toHaveBeenLastCalledWith(false);
    expect(harness.getCurrentInstallationType).not.toHaveBeenCalled();
    expect(harness.installGlobalPackage).not.toHaveBeenCalled();
    expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
    expect(onAutoUpdaterResult).not.toHaveBeenCalled();
  });

  test("does not install when disabled, already current, or user-skipped", async () => {
    const cases = [
      {
        label: "disabled",
        arrange: () => {
          harness.isAutoUpdaterDisabled.mockReturnValue(true);
        },
        wait: () => harness.getMaxVersion.mock.calls.length > 0,
        shouldSkipCalls: 0,
      },
      {
        label: "already current",
        arrange: () => {
          harness.getLatestVersion.mockResolvedValue("1.0.0");
        },
        wait: () => harness.getMaxVersion.mock.calls.length > 0,
        shouldSkipCalls: 0,
      },
      {
        label: "user skipped",
        arrange: () => {
          harness.shouldSkipVersion.mockReturnValue(true);
        },
        wait: () => harness.shouldSkipVersion.mock.calls.length > 0,
        shouldSkipCalls: 1,
      },
    ];

    for (const testCase of cases) {
      resetHarness();
      testCase.arrange();
      const rendered = await renderInRoot(<StaticAutoUpdater />);

      try {
        await waitFor(testCase.wait, `${testCase.label} skip`);
        await sleep(10);
        expect(harness.installGlobalPackage, testCase.label).not.toHaveBeenCalled();
        expect(
          harness.installOrUpdateAgenCPackage,
          testCase.label,
        ).not.toHaveBeenCalled();
        expect(harness.removeInstalledSymlink, testCase.label).not.toHaveBeenCalled();
        expect(harness.shouldSkipVersion, testCase.label).toHaveBeenCalledTimes(
          testCase.shouldSkipCalls,
        );
      } finally {
        await rendered.cleanup();
      }
    }
  });

  test("renders the global repair command for fallback no-permissions failures", async () => {
    harness.getCurrentInstallationType.mockResolvedValue("unknown");
    harness.installGlobalPackage.mockResolvedValue("no_permissions");
    const rendered = await renderInRoot(<StatefulAutoUpdater />);

    try {
      const output = await waitForOutput(rendered, "Auto-update failed");

      expect(output).toContain("ERR Auto-update failed - Try agenc doctor");
      expect(output).toContain("npm i -g @tetsuo-ai/agenc");
      expect(harness.localInstallationExists).toHaveBeenCalledOnce();
      expect(harness.installGlobalPackage).toHaveBeenCalledOnce();
      expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "AutoUpdater: Unknown installation type, falling back to config",
      );
    } finally {
      await rendered.cleanup();
    }
  });

  test("renders the local repair command for migrated fallback failures", async () => {
    harness.getGlobalConfig.mockReturnValue({
      installMethod: "local",
      theme: "dark",
    });
    harness.getCurrentInstallationType.mockResolvedValue("unknown");
    harness.installOrUpdateAgenCPackage.mockResolvedValue("no_permissions");
    harness.localInstallationExists.mockResolvedValue(true);
    const rendered = await renderInRoot(<StatefulAutoUpdater />);

    try {
      const output = await waitForOutput(rendered, "Auto-update failed");

      expect(output).toContain("ERR Auto-update failed - Try agenc doctor");
      expect(output).toContain("cd ~/.agenc/local && npm update @tetsuo-ai/agenc");
      expect(harness.localInstallationExists).toHaveBeenCalledOnce();
      expect(harness.installOrUpdateAgenCPackage).toHaveBeenCalledWith("stable");
      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }
  });

  test("logs errors and clears updating after a started update fails before install", async () => {
    const error = new Error("remove symlink failed");
    harness.removeInstalledSymlink.mockRejectedValueOnce(error);
    const onAutoUpdaterResult = vi.fn();
    const onChangeIsUpdating = vi.fn();
    const rendered = await renderInRoot(
      <AutoUpdater
        autoUpdaterResult={null}
        isUpdating={false}
        onAutoUpdaterResult={onAutoUpdaterResult}
        onChangeIsUpdating={onChangeIsUpdating}
        showSuccessMessage={true}
        verbose={true}
      />,
    );

    try {
      await waitFor(
        () => onChangeIsUpdating.mock.calls.some(([value]) => value === false),
        "failed update cleanup",
      );

      expect(harness.getCurrentInstallationType).not.toHaveBeenCalled();
      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
      expect(harness.installOrUpdateAgenCPackage).not.toHaveBeenCalled();
      expect(onChangeIsUpdating).toHaveBeenNthCalledWith(1, true);
      expect(onChangeIsUpdating).toHaveBeenLastCalledWith(false);
      expect(onAutoUpdaterResult).not.toHaveBeenCalled();
    } finally {
      await rendered.cleanup();
    }
  });
});
