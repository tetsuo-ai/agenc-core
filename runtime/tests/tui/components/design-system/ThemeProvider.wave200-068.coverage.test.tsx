import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../../ink/root.js";
import { Text } from "../../ink.js";
import {
  ThemeProvider,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from "./ThemeProvider.js";

const mocks = vi.hoisted(() => {
  const getCanonicalSettingsAuthority = vi.fn(() => ({}));
  const getExecutionAuthoritySettings = vi.fn(() => ({ tui: { theme: "auto" } }));
  const logError = vi.fn();
  const savedConfigs: unknown[] = [];
  const updateSettingsForSource = vi.fn(async (_source: string, update: unknown) => {
    savedConfigs.push(update);
    return { error: null };
  });
  const getTerminalBackground = vi.fn(() => "light");
  const stopWatchingTerminalBackground = vi.fn();
  const watchTerminalBackground = vi.fn(
    () => stopWatchingTerminalBackground,
  );

  return {
    getCanonicalSettingsAuthority,
    getExecutionAuthoritySettings,
    getTerminalBackground,
    logError,
    savedConfigs,
    updateSettingsForSource,
    stopWatchingTerminalBackground,
    watchTerminalBackground,
  };
});

vi.mock("../../../utils/settings/canonicalAuthority.js", () => ({
  getCanonicalSettingsAuthority: mocks.getCanonicalSettingsAuthority,
}));

vi.mock("../../../utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: mocks.getExecutionAuthoritySettings,
  updateSettingsForSource: mocks.updateSettingsForSource,
}));

vi.mock("../../../utils/terminalBackground.js", () => ({
  getTerminalBackground: mocks.getTerminalBackground,
}));

vi.mock("../../../utils/terminalBackgroundWatcher.js", () => ({
  watchTerminalBackground: mocks.watchTerminalBackground,
}));

vi.mock("../../../utils/log.js", () => ({
  logError: mocks.logError,
}));

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

type ThemeSnapshot = {
  setting: "auto" | "dark" | "light";
  theme: "dark" | "light";
};

type ProbeControls = {
  readonly setTheme: (setting: "auto" | "dark" | "light") => void;
  readonly preview: ReturnType<typeof usePreviewTheme>;
};

function createTestStreams(): {
  readonly stderr: PassThrough;
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdout.on("data", () => {});
  stderr.on("data", () => {});
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; isTTY: boolean; rows: number }).columns = 80;
  (stdout as unknown as { columns: number; isTTY: boolean; rows: number }).rows = 24;
  (stdout as unknown as { columns: number; isTTY: boolean; rows: number }).isTTY = true;

  return { stderr, stdin, stdout };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return;
    await sleep(10);
  }

  throw new Error(message);
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.savedConfigs.length = 0;
    mocks.getCanonicalSettingsAuthority.mockReturnValue({});
    mocks.getExecutionAuthoritySettings.mockReturnValue({ tui: { theme: "auto" } });
    mocks.getTerminalBackground.mockReturnValue("light");
    mocks.watchTerminalBackground.mockImplementation(
      () => mocks.stopWatchingTerminalBackground,
    );
  });

  test("uses a dark fallback before config reads are enabled", async () => {
    mocks.getCanonicalSettingsAuthority.mockReturnValueOnce(null);
    const snapshots: ThemeSnapshot[] = [];
    const { stderr, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });

    function Probe() {
      const [theme] = useTheme();
      const setting = useThemeSetting();

      React.useEffect(() => {
        snapshots.push({ setting, theme });
      }, [setting, theme]);

      return <Text>{`${setting}:${theme}`}</Text>;
    }

    try {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );

      await waitFor(
        () => snapshots.some(snapshot => snapshot.setting === "dark" && snapshot.theme === "dark"),
        "dark fallback theme was not used",
      );
      expect(mocks.getExecutionAuthoritySettings).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
    }
  });

  test("resolves cached auto themes, previews changes, and persists default saves", async () => {
    const snapshots: ThemeSnapshot[] = [];
    let controls: ProbeControls | undefined;
    const { stderr, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });

    function Probe() {
      const [theme, setTheme] = useTheme();
      const setting = useThemeSetting();
      const preview = usePreviewTheme();

      React.useEffect(() => {
        snapshots.push({ setting, theme });
        controls = { preview, setTheme };
      }, [preview, setTheme, setting, theme]);

      return <Text>{`${setting}:${theme}`}</Text>;
    }

    try {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );

      await waitFor(
        () => snapshots.some(snapshot => snapshot.setting === "auto" && snapshot.theme === "light"),
        "auto theme did not resolve from the cached system theme",
      );

      expect(mocks.getExecutionAuthoritySettings).toHaveBeenCalledTimes(1);
      expect(mocks.getTerminalBackground).toHaveBeenCalled();
      await waitFor(
        () => mocks.watchTerminalBackground.mock.calls.length > 0,
        "auto theme watcher did not start",
      );

      controls?.preview.savePreview();
      controls?.preview.cancelPreview();
      expect(mocks.updateSettingsForSource).not.toHaveBeenCalled();

      controls?.preview.setPreviewTheme("dark");
      await waitFor(
        () => snapshots.at(-1)?.setting === "auto" && snapshots.at(-1)?.theme === "dark",
        "dark preview was not applied",
      );

      controls?.preview.savePreview();
      await waitFor(
        () => snapshots.at(-1)?.setting === "dark" && snapshots.at(-1)?.theme === "dark",
        "preview was not saved as the persisted theme setting",
      );

      expect(mocks.updateSettingsForSource).toHaveBeenCalledTimes(1);
      expect(mocks.savedConfigs).toContainEqual({ tui: { theme: "dark" } });

      controls?.preview.setPreviewTheme("auto");
      await waitFor(
        () => snapshots.at(-1)?.setting === "dark" && snapshots.at(-1)?.theme === "light",
        "auto preview did not resolve from the cached system theme",
      );

      controls?.preview.cancelPreview();
      await waitFor(
        () => snapshots.at(-1)?.setting === "dark" && snapshots.at(-1)?.theme === "dark",
        "preview cancellation did not restore the saved theme",
      );

      controls?.setTheme("auto");
      await waitFor(
        () => snapshots.at(-1)?.setting === "auto" && snapshots.at(-1)?.theme === "light",
        "explicit auto setting did not resolve from the cached system theme",
      );

      expect(mocks.updateSettingsForSource).toHaveBeenCalledTimes(2);
      expect(mocks.savedConfigs).toContainEqual({ tui: { theme: "auto" } });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
    }
  });

  test("logs auto-theme watcher startup failures without unmounting the provider", async () => {
    const watcherError = new Error("theme watcher startup failed");
    mocks.watchTerminalBackground.mockImplementationOnce(() => {
      throw watcherError;
    });
    const snapshots: ThemeSnapshot[] = [];
    const { stderr, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });

    function Probe() {
      const [theme] = useTheme();
      const setting = useThemeSetting();

      React.useEffect(() => {
        snapshots.push({ setting, theme });
      }, [setting, theme]);

      return <Text>{`${setting}:${theme}`}</Text>;
    }

    try {
      root.render(
        <ThemeProvider initialState="auto" onThemeSave={vi.fn()}>
          <Probe />
        </ThemeProvider>,
      );

      await waitFor(
        () => mocks.watchTerminalBackground.mock.calls.length === 1,
        "auto theme watcher did not start",
      );
      await waitFor(
        () => mocks.logError.mock.calls.some(([error]) => error === watcherError),
        "auto theme watcher startup failure was not logged",
      );

      expect(snapshots.at(-1)).toEqual({ setting: "auto", theme: "light" });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
    }
  });

  test("cleans up the OSC 11 watcher when the provider unmounts", async () => {
    const { stderr, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });

    try {
      root.render(
        <ThemeProvider initialState="auto" onThemeSave={vi.fn()}>
          <Text>auto</Text>
        </ThemeProvider>,
      );

      await waitFor(
        () => mocks.watchTerminalBackground.mock.calls.length === 1,
        "auto theme watcher did not start",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
    }
    expect(mocks.stopWatchingTerminalBackground).toHaveBeenCalledTimes(1);
  });
});
