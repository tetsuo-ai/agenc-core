import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  feature: vi.fn((_flag: string) => false),
  getCurrentInstallationType: vi.fn(async () => "npm-global"),
  isAutoUpdaterDisabled: vi.fn(() => false),
  logForDebugging: vi.fn(),
  logError: vi.fn(),
  rendered: [] as Array<{
    kind: "standard" | "native" | "package-manager";
    props: Record<string, unknown>;
  }>,
}));

vi.mock("bun:bundle", () => ({
  feature: harness.feature,
}));

vi.mock("../../utils/config.js", () => ({
  isAutoUpdaterDisabled: harness.isAutoUpdaterDisabled,
}));

vi.mock("../../utils/doctorDiagnostic.js", () => ({
  getCurrentInstallationType: harness.getCurrentInstallationType,
}));

vi.mock("src/utils/debug.js", () => ({
  logForDebugging: harness.logForDebugging,
}));

vi.mock("../../utils/log.js", () => ({
  logError: harness.logError,
}));

vi.mock("./AutoUpdater.js", () => ({
  AutoUpdater: (props: Record<string, unknown>) => {
    harness.rendered.push({ kind: "standard", props });
    return null;
  },
}));

vi.mock("./NativeAutoUpdater.js", () => ({
  NativeAutoUpdater: (props: Record<string, unknown>) => {
    harness.rendered.push({ kind: "native", props });
    return null;
  },
}));

vi.mock("./PackageManagerAutoUpdater.js", () => ({
  PackageManagerAutoUpdater: (props: Record<string, unknown>) => {
    harness.rendered.push({ kind: "package-manager", props });
    return null;
  },
}));

import { createRoot } from "../ink/root.js";
import { AutoUpdaterWrapper } from "./AutoUpdaterWrapper.js";

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (_mode: boolean) => void;
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
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(10);
    }
  }

  if (lastError) {
    throw lastError;
  }
  assertion();
}

function resetHarness(): void {
  vi.clearAllMocks();
  harness.feature.mockReturnValue(false);
  harness.getCurrentInstallationType.mockResolvedValue("npm-global");
  harness.isAutoUpdaterDisabled.mockReturnValue(false);
  harness.logError.mockReset();
  harness.rendered = [];
}

async function renderWrapper(
  installationType: string,
  props: {
    isUpdating?: boolean;
    showSuccessMessage?: boolean;
    verbose?: boolean;
  } = {},
): Promise<{
  child: (typeof harness.rendered)[number];
  callbacks: {
    onAutoUpdaterResult: ReturnType<typeof vi.fn>;
    onChangeIsUpdating: ReturnType<typeof vi.fn>;
  };
  result: { status: "success"; version: string };
}> {
  resetHarness();
  harness.getCurrentInstallationType.mockResolvedValueOnce(installationType);

  const callbacks = {
    onAutoUpdaterResult: vi.fn(),
    onChangeIsUpdating: vi.fn(),
  };
  const result = { status: "success" as const, version: "2.0.0" };
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  try {
    root.render(
      <AutoUpdaterWrapper
        autoUpdaterResult={result}
        isUpdating={props.isUpdating ?? false}
        onAutoUpdaterResult={callbacks.onAutoUpdaterResult}
        onChangeIsUpdating={callbacks.onChangeIsUpdating}
        showSuccessMessage={props.showSuccessMessage ?? true}
        verbose={props.verbose ?? false}
      />,
    );

    await waitFor(() => {
      expect(harness.rendered).toHaveLength(1);
    });

    return { callbacks, child: harness.rendered[0]!, result };
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
  }
}

describe("AutoUpdaterWrapper wave200 coverage", () => {
  test("routes detected installation types and leaves disabled detection blank", async () => {
    const packageManager = await renderWrapper("package-manager", {
      isUpdating: true,
      showSuccessMessage: false,
      verbose: true,
    });

    expect(packageManager.child.kind).toBe("package-manager");
    expect(packageManager.child.props).toMatchObject({
      autoUpdaterResult: packageManager.result,
      isUpdating: true,
      showSuccessMessage: false,
      verbose: true,
    });
    expect(packageManager.child.props.onAutoUpdaterResult).toBe(
      packageManager.callbacks.onAutoUpdaterResult,
    );
    expect(packageManager.child.props.onChangeIsUpdating).toBe(
      packageManager.callbacks.onChangeIsUpdating,
    );
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      "AutoUpdaterWrapper: Installation type: package-manager",
    );

    const native = await renderWrapper("native");

    expect(native.child.kind).toBe("native");
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      "AutoUpdaterWrapper: Installation type: native",
    );

    const standard = await renderWrapper("npm-global");

    expect(standard.child.kind).toBe("standard");
    expect(harness.logForDebugging).toHaveBeenCalledWith(
      "AutoUpdaterWrapper: Installation type: npm-global",
    );

    resetHarness();
    harness.feature.mockImplementation(
      (flag) => flag === "SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED",
    );
    harness.isAutoUpdaterDisabled.mockReturnValue(true);

    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AutoUpdaterWrapper
          autoUpdaterResult={null}
          isUpdating={false}
          onAutoUpdaterResult={vi.fn()}
          onChangeIsUpdating={vi.fn()}
          showSuccessMessage={true}
          verbose={false}
        />,
      );

      await waitFor(() => {
        expect(harness.logForDebugging).toHaveBeenCalledWith(
          "AutoUpdaterWrapper: Skipping detection, auto-updates disabled",
        );
      });

      expect(harness.rendered).toEqual([]);
      expect(harness.getCurrentInstallationType).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  test("logs rejected installation detection and leaves updater hidden", async () => {
    resetHarness();
    const error = new Error("doctor probe failed");
    harness.getCurrentInstallationType.mockRejectedValueOnce(error);

    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AutoUpdaterWrapper
          autoUpdaterResult={null}
          isUpdating={false}
          onAutoUpdaterResult={vi.fn()}
          onChangeIsUpdating={vi.fn()}
          showSuccessMessage={true}
          verbose={false}
        />,
      );

      await waitFor(() => {
        expect(harness.getCurrentInstallationType).toHaveBeenCalledOnce();
      });
      await sleep(20);

      expect(harness.logError).toHaveBeenCalledWith(error);
      expect(harness.rendered).toEqual([]);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
