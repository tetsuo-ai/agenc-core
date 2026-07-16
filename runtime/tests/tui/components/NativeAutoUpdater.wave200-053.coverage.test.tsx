import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  installLatest: vi.fn(),
  intervalDelay: undefined as number | null | undefined,
  isAutoUpdaterDisabled: vi.fn(() => false),
  logError: vi.fn(),
  logForDebugging: vi.fn(),
  updateResults: [] as Array<{ status: string; version: string | null }>,
  updatingStates: [] as boolean[],
}));

vi.mock("usehooks-ts", () => ({
  useInterval: (_callback: () => void, delay: number | null) => {
    harness.intervalDelay = delay;
  },
}));

vi.mock("../hooks/useUpdateNotification.js", () => ({
  useUpdateNotification: (version: string | null | undefined) =>
    version ? "9.9.9" : null,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: harness.logForDebugging,
}));

vi.mock("../../utils/log.js", () => ({
  logError: harness.logError,
}));

vi.mock("../../utils/config.js", () => ({
  isAutoUpdaterDisabled: harness.isAutoUpdaterDisabled,
}));

vi.mock("../../utils/nativeInstaller/installer.js", () => ({
  installLatest: harness.installLatest,
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({ autoUpdatesChannel: "nightly" }),
  getInitialSettings: () => ({ autoUpdatesChannel: "nightly" }),
}));

import { createRoot } from "../ink/root.js";
import { NativeAutoUpdater } from "./NativeAutoUpdater.js";

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS;
const originalMacro = (globalThis as Record<string, unknown>).MACRO;
const originalNodeEnv = process.env.NODE_ENV;

type AutoUpdaterResult = {
  status: "success" | "install_failed";
  version: string | null;
};

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

function NativeAutoUpdaterHarness(): React.ReactNode {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

describe("NativeAutoUpdater installer failure coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.intervalDelay = undefined;
    harness.updateResults = [];
    harness.updatingStates = [];
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

  test("reports and renders an installer failure from the active update check", async () => {
    const installError = new Error("network outage while installing");
    harness.installLatest.mockRejectedValueOnce(installError);

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

    try {
      root.render(<NativeAutoUpdaterHarness />);

      const rendered = await waitForOutput(() => output, "Auto-update failed");

      expect(harness.intervalDelay).toBe(1_800_000);
      expect(harness.isAutoUpdaterDisabled).toHaveBeenCalledOnce();
      expect(harness.installLatest).toHaveBeenCalledWith("nightly");
      expect(harness.logError).toHaveBeenCalledWith(installError);
      expect(harness.updateResults).toEqual([
        { status: "install_failed", version: null },
      ]);
      expect(harness.updatingStates).toEqual([true, false]);
      expect(rendered).toContain("ERR Auto-update failed - Try /status");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
