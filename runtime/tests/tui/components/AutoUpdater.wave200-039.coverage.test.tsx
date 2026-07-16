import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AutoUpdaterResult } from "../../utils/autoUpdater.js";

const harness = vi.hoisted(() => ({
  getCurrentInstallationType: vi.fn(async () => "unknown"),
  getGlobalConfig: vi.fn(() => ({ installMethod: "local" })),
  getLatestVersion: vi.fn(async () => "9.0.0"),
  getMaxVersion: vi.fn(async () => "2.0.0"),
  installGlobalPackage: vi.fn(async () => "success"),
  installOrUpdateAgenCPackage: vi.fn(async () => "install_failed"),
  intervalDelay: undefined as number | null | undefined,
  isAutoUpdaterDisabled: vi.fn(() => false),
  localInstallationExists: vi.fn(async () => true),
  logError: vi.fn(),
  logForDebugging: vi.fn(),
  removeInstalledSymlink: vi.fn(async () => {}),
  shouldSkipVersion: vi.fn(() => false),
}));

vi.mock("usehooks-ts", () => ({
  useInterval: (_callback: () => void, delay: number | null) => {
    harness.intervalDelay = delay;
  },
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: harness.logForDebugging,
}));

vi.mock("../../utils/log.js", () => ({
  logError: harness.logError,
}));

vi.mock("../../utils/autoUpdater.js", () => ({
  getLatestVersion: harness.getLatestVersion,
  getMaxVersion: harness.getMaxVersion,
  installGlobalPackage: harness.installGlobalPackage,
  shouldSkipVersion: harness.shouldSkipVersion,
}));

vi.mock("../../utils/config.js", () => ({
  getGlobalConfig: harness.getGlobalConfig,
  isAutoUpdaterDisabled: harness.isAutoUpdaterDisabled,
}));

vi.mock("../../utils/doctorDiagnostic.js", () => ({
  getCurrentInstallationType: harness.getCurrentInstallationType,
}));

vi.mock("../../utils/localInstaller.js", () => ({
  installOrUpdateAgenCPackage: harness.installOrUpdateAgenCPackage,
  localInstallationExists: harness.localInstallationExists,
}));

vi.mock("../../utils/nativeInstaller/installer.js", () => ({
  removeInstalledSymlink: harness.removeInstalledSymlink,
}));

vi.mock("../../utils/semver.js", () => {
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

vi.mock("../../utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({ autoUpdatesChannel: "stable" }),
  getInitialSettings: () => ({ autoUpdatesChannel: "stable" }),
}));

import { createRoot } from "../ink/root.js";
import { AutoUpdater } from "./AutoUpdater.js";

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

async function waitForOutput(
  readOutput: () => string,
  expectedText: string,
): Promise<string> {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    const plainOutput = stripAnsi(readOutput());
    if (plainOutput.includes(expectedText)) {
      return plainOutput;
    }
    await sleep(10);
  }

  return stripAnsi(readOutput());
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

function Harness(): React.ReactNode {
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

describe("AutoUpdater wave200 coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.intervalDelay = undefined;
    harness.logError.mockReset();
    process.env.AGENC_TUI_GLYPHS = "ascii";
    process.env.NODE_ENV = "production";
    (globalThis as Record<string, unknown>).MACRO = {
      PACKAGE_URL: "@tetsuo-ai/agenc",
      VERSION: "1.0.0",
    };
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

  test("renders the local repair command when a capped fallback local update fails", async () => {
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

    try {
      root.render(<Harness />);

      const rendered = await waitForOutput(() => output, "Auto-update failed");

      expect(rendered).toContain("globalVersion: 1.0.0 - latestVersion: 2.0.0");
      expect(rendered).toContain("ERR Auto-update failed - Try agenc doctor");
      expect(rendered).toContain(
        "cd ~/.agenc/local && npm update @tetsuo-ai/agenc",
      );
      expect(harness.intervalDelay).toBe(1_800_000);
      expect(harness.getLatestVersion).toHaveBeenCalledWith("stable");
      expect(harness.getMaxVersion).toHaveBeenCalledOnce();
      expect(harness.shouldSkipVersion).toHaveBeenCalledWith("2.0.0");
      expect(harness.removeInstalledSymlink).toHaveBeenCalledOnce();
      expect(harness.getCurrentInstallationType).toHaveBeenCalledOnce();
      expect(harness.installOrUpdateAgenCPackage).toHaveBeenCalledWith("stable");
      expect(harness.installGlobalPackage).not.toHaveBeenCalled();
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "AutoUpdater: maxVersion 2.0.0 is set, capping update from 9.0.0 to 2.0.0",
      );
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "AutoUpdater: Unknown installation type, falling back to config",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  test("logs rejected local-install probes without leaking async failures", async () => {
    process.env.NODE_ENV = "development";
    const error = new Error("local install probe failed");
    harness.localInstallationExists.mockRejectedValueOnce(error);
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AutoUpdater
          autoUpdaterResult={null}
          isUpdating={false}
          onAutoUpdaterResult={() => {}}
          onChangeIsUpdating={() => {}}
          showSuccessMessage={true}
          verbose={true}
        />,
      );

      await waitFor(
        () => harness.localInstallationExists.mock.calls.length > 0,
        "local installation probe",
      );
      await sleep(20);

      expect(harness.logError).toHaveBeenCalledWith(error);
      expect(harness.getLatestVersion).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  test("logs rejected update installs and clears the updating flag", async () => {
    const error = new Error("global install failed");
    harness.getCurrentInstallationType.mockResolvedValue("npm-global");
    harness.installGlobalPackage.mockRejectedValueOnce(error);
    const onChangeIsUpdating = vi.fn();
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
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
        () => harness.installGlobalPackage.mock.calls.length > 0,
        "global install attempt",
      );
      await sleep(20);

      expect(harness.logError).toHaveBeenCalledWith(error);
      expect(onChangeIsUpdating).toHaveBeenNthCalledWith(1, true);
      expect(onChangeIsUpdating).toHaveBeenLastCalledWith(false);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
