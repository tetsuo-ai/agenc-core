import React from "react";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

import { getNextPermissionMode } from "../../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import { createRoot, Text, useInput } from "../../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { KeybindingSetup } from "../../../src/tui/keybindings/KeybindingProviderSetup.js";
import { useKeybinding } from "../../../src/tui/keybindings/useKeybinding.js";

test("terminal Meta+M and Shift+Tab cycle modes while plain m stays in the composer", async () => {
  let context = createEmptyToolPermissionContext();
  let draft = "";
  const cycled: string[] = [];

  function Composer(): React.ReactNode {
    useKeybinding("chat:cycleMode", () => {
      const next = getNextPermissionMode(context.mode, context);
      context = { ...context, mode: next };
      cycled.push(context.mode);
    }, { context: "Chat" });
    useInput((input, key) => {
      if (!key.meta && !key.ctrl && !key.tab) draft += input;
    });
    return <Text>composer</Text>;
  }

  const stdin = Object.assign(new PassThrough(), { isTTY: true, ref() {}, unref() {}, setRawMode() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  stdout.resume();
  const root = await createRoot({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false });
  try {
    root.render(<AppStateProvider initialState={getDefaultAppState()}><KeybindingSetup><Composer /></KeybindingSetup></AppStateProvider>);
    await new Promise(resolve => setTimeout(resolve, 40));
    stdin.write("\x1bm");
    await vi.waitFor(() => expect(cycled).toEqual(["acceptEdits"]));
    stdin.write("\x1b[Z");
    await vi.waitFor(() => expect(cycled).toEqual(["acceptEdits", "plan"]));
    stdin.write("m");
    await vi.waitFor(() => expect(draft).toBe("m"));
    expect(context.mode).toBe("plan");
    expect(cycled).toEqual(["acceptEdits", "plan"]);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
  }
});
