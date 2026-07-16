import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getLatestVersionFromGcs: vi.fn(),
  getMaxVersion: vi.fn(),
  getPackageManager: vi.fn(),
  intervalDelay: undefined as number | null | undefined,
  isAutoUpdaterDisabled: vi.fn(),
  logForDebugging: vi.fn(),
  settings: undefined as { autoUpdatesChannel?: string } | null | undefined,
  shouldSkipVersion: vi.fn(),
}));

vi.mock("usehooks-ts", () => ({
  useInterval: (_callback: () => void, delay: number | null) => {
    harness.intervalDelay = delay;
  },
}));

vi.mock("../../../src/utils/autoUpdater.js", () => ({
  getLatestVersionFromGcs: harness.getLatestVersionFromGcs,
  getMaxVersion: harness.getMaxVersion,
  shouldSkipVersion: harness.shouldSkipVersion,
}));

vi.mock("../../../src/utils/config.js", () => ({
  isAutoUpdaterDisabled: harness.isAutoUpdaterDisabled,
}));

vi.mock("../../../src/utils/debug.js", () => ({
  logForDebugging: harness.logForDebugging,
}));

vi.mock("../../../src/utils/nativeInstaller/packageManagers.js", () => ({
  getPackageManager: harness.getPackageManager,
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
  getExecutionAuthoritySettings: () => harness.settings,
  getInitialSettings: () => harness.settings,
}));

import { PackageManagerAutoUpdater } from "../../../src/tui/components/PackageManagerAutoUpdater.js";
import { createRoot } from "../../../src/tui/ink/root.js";

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

type RenderedUpdater = {
  readonly cleanup: () => Promise<void>;
  readonly readOutput: () => string;
};

function resetHarness(): void {
  harness.getLatestVersionFromGcs.mockReset().mockResolvedValue("2.0.0");
  harness.getMaxVersion.mockReset().mockResolvedValue(undefined);
  harness.getPackageManager.mockReset().mockResolvedValue("homebrew");
  harness.intervalDelay = undefined;
  harness.isAutoUpdaterDisabled.mockReset().mockReturnValue(false);
  harness.logForDebugging.mockReset();
  harness.settings = { autoUpdatesChannel: "stable" };
  harness.shouldSkipVersion.mockReset().mockReturnValue(false);
}

function setMacro(version = "1.0.0"): void {
  (globalThis as Record<string, unknown>).MACRO = {
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
  (stdout as unknown as { columns: number; rows: number }).columns = 160;
  (stdout as unknown as { columns: number; rows: number }).rows = 24;

  return { stdin, stdout };
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function renderUpdater({
  verbose = false,
}: {
  readonly verbose?: boolean;
} = {}): Promise<RenderedUpdater> {
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

  root.render(
    <PackageManagerAutoUpdater
      autoUpdaterResult={null}
      isUpdating={false}
      onAutoUpdaterResult={() => {}}
      onChangeIsUpdating={() => {}}
      showSuccessMessage={false}
      verbose={verbose}
    />,
  );

  return {
    cleanup: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep(0);
    },
    readOutput: () => stripAnsi(output),
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
  rendered: RenderedUpdater,
  expectedText: string,
): Promise<string> {
  await waitFor(
    () => rendered.readOutput().includes(expectedText),
    `output containing ${expectedText}`,
  );
  return rendered.readOutput();
}

describe("PackageManagerAutoUpdater coverage swarm row 115", () => {
  beforeEach(() => {
    resetHarness();
    setMacro();
  });

  afterEach(() => {
    if (originalMacro === undefined) {
      delete (globalThis as Record<string, unknown>).MACRO;
    } else {
      (globalThis as Record<string, unknown>).MACRO = originalMacro;
    }
  });

  test("returns before package checks when auto updates are disabled", async () => {
    harness.isAutoUpdaterDisabled.mockReturnValue(true);

    const rendered = await renderUpdater({ verbose: true });
    try {
      await waitFor(
        () => harness.isAutoUpdaterDisabled.mock.calls.length > 0,
        "disabled auto-update check",
      );
      await sleep(20);

      expect(harness.intervalDelay).toBe(1_800_000);
      expect(harness.getPackageManager).not.toHaveBeenCalled();
      expect(harness.getLatestVersionFromGcs).not.toHaveBeenCalled();
      expect(harness.getMaxVersion).not.toHaveBeenCalled();
      expect(harness.shouldSkipVersion).not.toHaveBeenCalled();
      expect(rendered.readOutput()).not.toContain("Update available");
    } finally {
      await rendered.cleanup();
    }
  });

  test("caps to maxVersion and returns when the current version already meets it", async () => {
    setMacro("2.0.0");
    harness.getLatestVersionFromGcs.mockResolvedValue("9.0.0");
    harness.getMaxVersion.mockResolvedValue("2.0.0");

    const rendered = await renderUpdater({ verbose: true });
    try {
      await waitFor(
        () =>
          harness.logForDebugging.mock.calls.some(
            ([message]) =>
              message ===
              "PackageManagerAutoUpdater: current version 2.0.0 is already at or above maxVersion 2.0.0, skipping update",
          ),
        "max-version current-version skip",
      );

      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "PackageManagerAutoUpdater: maxVersion 2.0.0 is set, capping update from 9.0.0 to 2.0.0",
      );
      expect(harness.shouldSkipVersion).not.toHaveBeenCalled();
      expect(rendered.readOutput()).not.toContain("Update available");
    } finally {
      await rendered.cleanup();
    }
  });

  test.each([
    ["winget", "winget upgrade AgenC.AgenCCode"],
    ["apk", "apk upgrade agenc-code"],
    ["unknown", "your package manager update command"],
  ])("renders the %s package-manager command", async (packageManager, command) => {
    harness.getPackageManager.mockResolvedValue(packageManager);
    harness.settings = null;

    const rendered = await renderUpdater({ verbose: false });
    try {
      const output = await waitForOutput(rendered, command);

      expect(output).toContain("Update available! Run:");
      expect(output).not.toContain("currentVersion:");
      expect(harness.getLatestVersionFromGcs).toHaveBeenCalledWith("latest");
      expect(harness.shouldSkipVersion).toHaveBeenCalledWith("2.0.0");
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "PackageManagerAutoUpdater: Update available 1.0.0 -> 2.0.0",
      );
    } finally {
      await rendered.cleanup();
    }
  });

  test.each([
    {
      label: "missing latest version",
      latest: undefined,
      shouldSkip: false,
      shouldSkipCalls: 0,
    },
    {
      label: "already current version",
      latest: "1.0.0",
      shouldSkip: false,
      shouldSkipCalls: 0,
    },
    {
      label: "user skipped target version",
      latest: "2.0.0",
      shouldSkip: true,
      shouldSkipCalls: 1,
    },
  ])(
    "suppresses the update prompt for $label",
    async ({ latest, shouldSkip, shouldSkipCalls }) => {
      harness.getLatestVersionFromGcs.mockResolvedValue(latest);
      harness.shouldSkipVersion.mockReturnValue(shouldSkip);

      const rendered = await renderUpdater({ verbose: true });
      try {
        await waitFor(
          () => harness.getMaxVersion.mock.calls.length > 0,
          "version check completion",
        );
        await sleep(20);

        expect(harness.shouldSkipVersion).toHaveBeenCalledTimes(shouldSkipCalls);
        expect(rendered.readOutput()).not.toContain("Update available");
      } finally {
        await rendered.cleanup();
      }
    },
  );
});
