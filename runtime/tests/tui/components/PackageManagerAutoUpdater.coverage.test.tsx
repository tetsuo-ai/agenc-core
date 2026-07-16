import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getLatestVersionFromGcs: vi.fn(async () => "9.0.0"),
  getMaxVersion: vi.fn(async () => "2.0.0"),
  getPackageManager: vi.fn(async () => "homebrew"),
  intervalCallback: undefined as (() => void) | undefined,
  intervalDelay: undefined as number | null | undefined,
  isAutoUpdaterDisabled: vi.fn(() => false),
  logForDebugging: vi.fn(),
  logError: vi.fn(),
  shouldSkipVersion: vi.fn(() => false),
}));

vi.mock("usehooks-ts", () => ({
  useInterval: (callback: () => void, delay: number | null) => {
    harness.intervalCallback = callback;
    harness.intervalDelay = delay;
  },
}));

vi.mock("../../utils/autoUpdater.js", () => ({
  getLatestVersionFromGcs: harness.getLatestVersionFromGcs,
  getMaxVersion: harness.getMaxVersion,
  shouldSkipVersion: harness.shouldSkipVersion,
}));

vi.mock("../../utils/config.js", () => ({
  isAutoUpdaterDisabled: harness.isAutoUpdaterDisabled,
}));

vi.mock("../../utils/nativeInstaller/packageManagers.js", () => ({
  getPackageManager: harness.getPackageManager,
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

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: harness.logForDebugging,
}));

vi.mock("../../utils/log.js", () => ({
  logError: harness.logError,
}));

import { createRoot } from "../ink/root.js";
import { PackageManagerAutoUpdater } from "./PackageManagerAutoUpdater.js";

const originalMacro = (globalThis as Record<string, unknown>).MACRO;

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
  (stdout as unknown as { columns: number; rows: number }).columns = 120;
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

describe("PackageManagerAutoUpdater coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.intervalCallback = undefined;
    harness.intervalDelay = undefined;
    harness.logError.mockReset();
    (globalThis as Record<string, unknown>).MACRO = {
      VERSION: "1.0.0",
    };
  });

  afterEach(() => {
    if (originalMacro === undefined) {
      delete (globalThis as Record<string, unknown>).MACRO;
    } else {
      (globalThis as Record<string, unknown>).MACRO = originalMacro;
    }
  });

  test("renders the capped Homebrew update command from the async check", async () => {
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
      root.render(
        <PackageManagerAutoUpdater
          autoUpdaterResult={null}
          isUpdating={false}
          onAutoUpdaterResult={() => {}}
          onChangeIsUpdating={() => {}}
          showSuccessMessage={false}
          verbose={true}
        />,
      );

      const rendered = await waitForOutput(() => output, "brew upgrade");

      expect(rendered).toContain("currentVersion: 1.0.0");
      expect(rendered).toContain("Update available! Run:");
      expect(rendered).toContain("brew upgrade agenc-code");
      expect(rendered).not.toContain("your package manager update command");
      expect(harness.intervalDelay).toBe(1_800_000);
      expect(harness.isAutoUpdaterDisabled).toHaveBeenCalledOnce();
      expect(harness.getPackageManager).toHaveBeenCalledOnce();
      expect(harness.getLatestVersionFromGcs).toHaveBeenCalledWith("stable");
      expect(harness.getMaxVersion).toHaveBeenCalledOnce();
      expect(harness.shouldSkipVersion).toHaveBeenCalledWith("2.0.0");
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "PackageManagerAutoUpdater: maxVersion 2.0.0 is set, capping update from 9.0.0 to 2.0.0",
      );
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "PackageManagerAutoUpdater: Update available 1.0.0 -> 2.0.0",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  test("logs rejected package-manager probes and leaves the prompt hidden", async () => {
    const error = new Error("package-manager probe failed");
    harness.getPackageManager.mockRejectedValueOnce(error);
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
      root.render(
        <PackageManagerAutoUpdater
          autoUpdaterResult={null}
          isUpdating={false}
          onAutoUpdaterResult={() => {}}
          onChangeIsUpdating={() => {}}
          showSuccessMessage={false}
          verbose={true}
        />,
      );

      await waitForOutput(() => `${harness.getPackageManager.mock.calls.length}`, "1");
      await sleep(20);

      expect(harness.logError).toHaveBeenCalledWith(error);
      expect(stripAnsi(output)).not.toContain("Update available");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  test("logs rejected interval checks without leaking async failures", async () => {
    const error = new Error("latest-version probe failed");
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
      root.render(
        <PackageManagerAutoUpdater
          autoUpdaterResult={null}
          isUpdating={false}
          onAutoUpdaterResult={() => {}}
          onChangeIsUpdating={() => {}}
          showSuccessMessage={false}
          verbose={false}
        />,
      );

      await waitForOutput(() => output, "brew upgrade");
      harness.logError.mockReset();
      harness.getLatestVersionFromGcs.mockRejectedValueOnce(error);
      harness.intervalCallback?.();
      await sleep(20);

      expect(harness.logError).toHaveBeenCalledWith(error);
      expect(stripAnsi(output)).toContain("brew upgrade agenc-code");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
