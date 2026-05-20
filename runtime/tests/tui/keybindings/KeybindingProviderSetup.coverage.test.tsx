import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import Text from "../ink/components/Text.js";
import { createRoot } from "../ink/root.js";
import { useKeybindingContext } from "./KeybindingContext.js";
import { KeybindingSetup } from "./KeybindingProviderSetup.js";
import { parseBindings } from "./parser.js";

const inputHandlers = vi.hoisted(() => [] as unknown[]);
const addNotification = vi.hoisted(() => vi.fn());
const removeNotification = vi.hoisted(() => vi.fn());
const initializeKeybindingWatcher = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
const loadKeybindingsSyncWithWarnings = vi.hoisted(() => vi.fn());
const reloadListeners = vi.hoisted(
  () => [] as Array<(result: unknown) => void>,
);
const unsubscribe = vi.hoisted(() => vi.fn());
const subscribeToKeybindingChanges = vi.hoisted(() =>
  vi.fn((listener: (result: unknown) => void) => {
    reloadListeners.push(listener);
    return unsubscribe;
  }),
);

vi.mock("../ink.js", () => ({
  useInput: (handler: unknown) => {
    inputHandlers.push(handler);
  },
}));

vi.mock("../context/notifications.js", () => ({
  useNotifications: () => ({
    addNotification,
    removeNotification,
  }),
}));

vi.mock("../../utils/debug.js", () => ({
  logForDebugging: () => {},
}));

vi.mock("./loadUserBindings.js", () => ({
  initializeKeybindingWatcher,
  loadKeybindingsSyncWithWarnings,
  subscribeToKeybindingChanges,
}));

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createTestStreams(): {
  stdout: PassThrough;
  stdin: TestStdin;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  stdout.resume();

  return { stdout, stdin };
}

function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(message));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function Probe({ displays }: { displays: string[] }): React.ReactNode {
  const keybindings = useKeybindingContext();

  React.useEffect(() => {
    displays.push(keybindings.getDisplayText("chat:submit", "Chat") ?? "missing");
  }, [displays, keybindings]);

  return <Text>keybinding setup</Text>;
}

describe("KeybindingProviderSetup coverage", () => {
  const originalGlyphMode = process.env.AGENC_TUI_GLYPHS;

  beforeEach(() => {
    process.env.AGENC_TUI_GLYPHS = "ascii";
    inputHandlers.length = 0;
    reloadListeners.length = 0;
    addNotification.mockClear();
    removeNotification.mockClear();
    initializeKeybindingWatcher.mockClear();
    loadKeybindingsSyncWithWarnings.mockReset();
    subscribeToKeybindingChanges.mockClear();
    unsubscribe.mockClear();
  });

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS;
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode;
    }
  });

  test("shows and clears the keybinding warning notification after watched reloads", async () => {
    const initialBindings = parseBindings([
      {
        context: "Chat",
        bindings: {
          enter: "chat:submit",
        },
      },
    ]);
    const displays: string[] = [];
    const { stdout, stdin } = createTestStreams();
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    });

    loadKeybindingsSyncWithWarnings.mockReturnValue({
      bindings: initialBindings,
      warnings: [],
    });

    try {
      root.render(
        <KeybindingSetup>
          <Probe displays={displays} />
        </KeybindingSetup>,
      );

      await waitForCondition(
        () =>
          subscribeToKeybindingChanges.mock.calls.length === 1 &&
          removeNotification.mock.calls.length === 1,
        "KeybindingSetup did not initialize watcher effects",
      );

      expect(loadKeybindingsSyncWithWarnings).toHaveBeenCalledTimes(1);
      expect(initializeKeybindingWatcher).toHaveBeenCalledTimes(1);
      expect(inputHandlers).toHaveLength(1);
      expect(displays).toContain("Enter");
      expect(removeNotification).toHaveBeenCalledWith(
        "keybinding-config-warning",
      );

      reloadListeners[0]?.({
        bindings: initialBindings,
        warnings: [
          {
            message: "reserved",
            severity: "warning",
            type: "reserved",
          },
        ],
      });

      await waitForCondition(
        () => addNotification.mock.calls.length === 1,
        "keybinding warning notification was not added",
      );

      expect(addNotification).toHaveBeenCalledWith({
        key: "keybinding-config-warning",
        text: "Found 1 keybinding warning - /doctor for details",
        color: "warning",
        priority: "high",
        timeoutMs: 60000,
      });

      reloadListeners[0]?.({
        bindings: initialBindings,
        warnings: [],
      });

      await waitForCondition(
        () => removeNotification.mock.calls.length === 2,
        "keybinding warning notification was not cleared",
      );

      expect(removeNotification).toHaveBeenLastCalledWith(
        "keybinding-config-warning",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }

    await waitForCondition(
      () => unsubscribe.mock.calls.length === 1,
      "KeybindingSetup did not unsubscribe on unmount",
    );
  });
});
