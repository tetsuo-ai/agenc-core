import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type AutoUpdaterResult = {
  status: "success" | "install_failed";
  version: string | null;
};

const harness = vi.hoisted(() => ({
  installLatest: vi.fn(),
  intervalDelay: undefined as number | null | undefined,
  isAutoUpdaterDisabled: vi.fn(() => false),
  logError: vi.fn(),
  logForDebugging: vi.fn(),
  settings: { autoUpdatesChannel: "beta" } as
    | { autoUpdatesChannel?: string }
    | null,
  updateResults: [] as AutoUpdaterResult[],
  updatingStates: [] as boolean[],
}));

vi.mock("usehooks-ts", () => ({
  useInterval: (_callback: () => void, delay: number | null) => {
    harness.intervalDelay = delay;
  },
}));

vi.mock("../hooks/useUpdateNotification.js", () => ({
  useUpdateNotification: (version: string | null | undefined) =>
    version ? "available" : null,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: harness.logForDebugging,
}));

vi.mock("../../utils/log.js", () => ({
  logError: harness.logError,
}));

vi.mock("../../utils/config.js", () => ({
  getGlobalConfig: () => ({ theme: "dark" }),
  isAutoUpdaterDisabled: harness.isAutoUpdaterDisabled,
  saveGlobalConfig: vi.fn(),
}));

vi.mock("../../utils/nativeInstaller/installer.js", () => ({
  installLatest: harness.installLatest,
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => harness.settings,
  getInitialSettings: () => harness.settings,
}));

import { createRoot } from "../ink/root.js";
import { renderToString } from "../../utils/staticRender.js";
import { NativeAutoUpdater } from "../components/NativeAutoUpdater.js";

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
  (stdout as unknown as { columns: number; rows: number }).columns = 160;
  (stdout as unknown as { columns: number; rows: number }).rows = 24;

  return { stdin, stdout };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function StatefulNativeAutoUpdater(): React.ReactNode {
  const [isUpdating, setIsUpdating] = React.useState(false);
  const [autoUpdaterResult, setAutoUpdaterResult] =
    React.useState<AutoUpdaterResult | null>(null);
  const onAutoUpdaterResult = React.useCallback((result: AutoUpdaterResult) => {
    harness.updateResults.push(result);
    setAutoUpdaterResult(result);
  }, []);
  const onChangeIsUpdating = React.useCallback((nextIsUpdating: boolean) => {
    harness.updatingStates.push(nextIsUpdating);
    setIsUpdating(nextIsUpdating);
  }, []);

  return (
    <NativeAutoUpdater
      autoUpdaterResult={autoUpdaterResult}
      isUpdating={isUpdating}
      onAutoUpdaterResult={onAutoUpdaterResult}
      onChangeIsUpdating={onChangeIsUpdating}
      showSuccessMessage={true}
      verbose={true}
    />
  );
}

async function renderStatefulUpdater(): Promise<{
  cleanup: () => void;
  readOutput: () => string;
}> {
  let output = "";
  const { stdin, stdout } = createStreams();
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  root.render(<StatefulNativeAutoUpdater />);

  return {
    cleanup: () => {
      root.unmount();
      stdin.end();
      stdout.end();
    },
    readOutput: () => stripAnsi(output),
  };
}

function resetHarness(): void {
  harness.installLatest.mockReset();
  harness.isAutoUpdaterDisabled.mockReset();
  harness.isAutoUpdaterDisabled.mockReturnValue(false);
  harness.logError.mockClear();
  harness.logForDebugging.mockClear();
  harness.intervalDelay = undefined;
  harness.settings = { autoUpdatesChannel: "beta" };
  harness.updateResults = [];
  harness.updatingStates = [];
}

describe("NativeAutoUpdater coverage swarm row 043", () => {
  beforeEach(() => {
    resetHarness();
    process.env.AGENC_TUI_GLYPHS = "ascii";
    process.env.NODE_ENV = "production";
    (globalThis as Record<string, unknown>).MACRO = {
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

  test.each(["test", "development"])(
    "skips installer checks in %s mode",
    async (nodeEnv) => {
      process.env.NODE_ENV = nodeEnv;

      const rendered = await renderToString(
        <NativeAutoUpdater
          autoUpdaterResult={null}
          isUpdating={false}
          onAutoUpdaterResult={(result) => {
            harness.updateResults.push(result);
          }}
          onChangeIsUpdating={(nextIsUpdating) => {
            harness.updatingStates.push(nextIsUpdating);
          }}
          showSuccessMessage={true}
          verbose={false}
        />,
        100,
      );

      expect(rendered.trim()).toBe("");
      expect(harness.intervalDelay).toBe(1_800_000);
      expect(harness.installLatest).not.toHaveBeenCalled();
      expect(harness.isAutoUpdaterDisabled).not.toHaveBeenCalled();
      expect(harness.logForDebugging).toHaveBeenCalledWith(
        "NativeAutoUpdater: Skipping update check in test/dev environment",
      );
      expect(harness.updateResults).toEqual([]);
      expect(harness.updatingStates).toEqual([]);
    },
  );

  test("returns before checking when an update is already active", async () => {
    const rendered = await renderToString(
      <NativeAutoUpdater
        autoUpdaterResult={null}
        isUpdating={true}
        onAutoUpdaterResult={(result) => {
          harness.updateResults.push(result);
        }}
        onChangeIsUpdating={(nextIsUpdating) => {
          harness.updatingStates.push(nextIsUpdating);
        }}
        showSuccessMessage={true}
        verbose={true}
      />,
      100,
    );

    expect(rendered.trim()).toBe("");
    expect(harness.intervalDelay).toBe(1_800_000);
    expect(harness.installLatest).not.toHaveBeenCalled();
    expect(harness.isAutoUpdaterDisabled).not.toHaveBeenCalled();
    expect(harness.logForDebugging).not.toHaveBeenCalledWith(
      "NativeAutoUpdater: Skipping update check in test/dev environment",
    );
    expect(harness.updateResults).toEqual([]);
    expect(harness.updatingStates).toEqual([]);
  });

  test("does not start the installer when auto updates are disabled", async () => {
    harness.isAutoUpdaterDisabled.mockReturnValue(true);

    const rendered = await renderStatefulUpdater();
    try {
      await sleep(25);

      expect(harness.intervalDelay).toBe(1_800_000);
      expect(harness.isAutoUpdaterDisabled).toHaveBeenCalledOnce();
      expect(harness.installLatest).not.toHaveBeenCalled();
      expect(harness.updateResults).toEqual([]);
      expect(harness.updatingStates).toEqual([]);
      expect(rendered.readOutput()).not.toContain("Checking for updates");
    } finally {
      rendered.cleanup();
    }
  });

  test("renders successful installer output with fallback channel metadata", async () => {
    harness.settings = null;
    harness.installLatest.mockResolvedValueOnce({
      latestVersion: "2.0.0",
      lockFailed: false,
      wasUpdated: true,
    });

    const rendered = await renderStatefulUpdater();
    try {
      await waitFor(
        () => rendered.readOutput().includes("Update installed"),
        "successful update output",
      );

      expect(rendered.readOutput()).toContain("current: 1.0.0 - latest: 2.0.0");
      expect(rendered.readOutput()).toContain(
        "OK Update installed - Restart to update",
      );
      expect(harness.installLatest).toHaveBeenCalledWith("latest");
      expect(harness.updateResults).toEqual([
        { status: "success", version: "2.0.0" },
      ]);
      expect(harness.updatingStates).toEqual([true, false]);
    } finally {
      rendered.cleanup();
    }
  });

  test("logs lock contention without reporting an updater result", async () => {
    harness.installLatest.mockResolvedValueOnce({
      latestVersion: "2.0.0",
      lockFailed: true,
      wasUpdated: false,
    });

    const rendered = await renderStatefulUpdater();
    try {
      await waitFor(
        () => harness.updatingStates.includes(false),
        "lock contention completion",
      );

      expect(harness.installLatest).toHaveBeenCalledWith("beta");
      expect(harness.logError).not.toHaveBeenCalled();
      expect(harness.updateResults).toEqual([]);
      expect(harness.updatingStates).toEqual([true, false]);
      expect(rendered.readOutput()).not.toContain("Update installed");
      expect(rendered.readOutput()).not.toContain("Auto-update failed");
    } finally {
      rendered.cleanup();
    }
  });

  test("reports the up-to-date installer result without showing a status row", async () => {
    harness.installLatest.mockResolvedValueOnce({
      latestVersion: "1.0.0",
      lockFailed: false,
      wasUpdated: false,
    });

    const rendered = await renderStatefulUpdater();
    try {
      await waitFor(
        () => harness.updatingStates.includes(false),
        "up-to-date completion",
      );

      expect(harness.installLatest).toHaveBeenCalledWith("beta");
      expect(harness.updateResults).toEqual([]);
      expect(harness.updatingStates).toEqual([true, false]);
      expect(rendered.readOutput()).not.toContain("Update installed");
      expect(rendered.readOutput()).not.toContain("Auto-update failed");
    } finally {
      rendered.cleanup();
    }
  });

  test.each([
    "timeout waiting for package",
    "Checksum mismatch for downloaded archive",
    "ENOENT executable not found",
    "EACCES permission denied",
    "ENOSPC writing package",
    "npm failed with exit 1",
    "unexpected archive format",
  ])("surfaces installer failures for %s", async (message) => {
    const installError = new Error(message);
    harness.installLatest.mockRejectedValueOnce(installError);

    const rendered = await renderStatefulUpdater();
    try {
      await waitFor(
        () => harness.updateResults.length === 1,
        "failed update result",
      );
      await waitFor(
        () => rendered.readOutput().includes("Auto-update failed"),
        "failed update output",
      );

      expect(harness.logError).toHaveBeenCalledWith(installError);
      expect(harness.updateResults).toEqual([
        { status: "install_failed", version: null },
      ]);
      expect(harness.updatingStates).toEqual([true, false]);
      expect(rendered.readOutput()).toContain(
        "ERR Auto-update failed - Try /status",
      );
    } finally {
      rendered.cleanup();
    }
  });

  test("hides the success message when the caller suppresses it", async () => {
    process.env.NODE_ENV = "test";

    const rendered = await renderToString(
      <NativeAutoUpdater
        autoUpdaterResult={{ status: "success", version: "2.0.0" }}
        isUpdating={false}
        onAutoUpdaterResult={() => {}}
        onChangeIsUpdating={() => {}}
        showSuccessMessage={false}
        verbose={false}
      />,
      100,
    );

    expect(rendered).not.toContain("Update installed");
  });
});
