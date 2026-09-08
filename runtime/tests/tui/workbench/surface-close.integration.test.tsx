import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRoot, Text } from "../../../src/tui/ink.js";
import { KeybindingSetup } from "../../../src/tui/keybindings/KeybindingProviderSetup.js";
import { useRegisterKeybindingContext } from "../../../src/tui/keybindings/KeybindingContext.js";
import { useInputCapture } from "../../../src/tui/keybindings/useKeybinding.js";
import { AppStateProvider, getDefaultAppState, type AppState } from "../../../src/tui/state/AppState.js";
import { bufferKeybindingContext } from "../../../src/tui/workbench/buffer/keybindingContext.js";
import {
  emptyProviderSnapshot,
  INLINE_BUFFER_CAPABILITIES,
  NEOVIM_BUFFER_CAPABILITIES,
} from "../../../src/tui/workbench/buffer/providers/types.js";
import { ActiveWorkSurface } from "../../../src/tui/workbench/surfaces/ActiveWorkSurface.js";

const closeInput = vi.hoisted(() => ({
  dirty: false,
  terminalUi: false,
  inputs: [] as string[],
}));

function snapshot() {
  return {
    ...emptyProviderSnapshot({
      kind: closeInput.terminalUi ? "neovim" : "inline",
      label: "test editor",
      fallbackReason: null,
      capabilities: closeInput.terminalUi ? NEOVIM_BUFFER_CAPABILITIES : INLINE_BUFFER_CAPABILITIES,
    }),
    filePath: "target.ts",
    dirty: closeInput.dirty,
  };
}

vi.mock("../../../src/tui/workbench/buffer/providers/BufferProviderController.js", () => ({
  getWorkbenchBufferProviderController: () => ({ getSnapshot: snapshot }),
}));

vi.mock("../../../src/tui/workbench/buffer/useBufferStore.js", () => ({
  useBufferStore: snapshot,
}));

vi.mock("../../../src/tui/workbench/surfaces/BufferSurface.js", () => ({
  BufferSurface: ({ focused }: { readonly focused: boolean }) => {
    const context = bufferKeybindingContext(snapshot());
    useRegisterKeybindingContext(context, focused);
    useInputCapture((input) => {
      closeInput.inputs.push(input);
      return true;
    }, { context, isActive: focused });
    return <Text>editor</Text>;
  },
}));

vi.mock("../../../src/tui/workbench/surfaces/PreviewSurface.js", () => ({
  PreviewSurface: () => <Text>preview</Text>,
  EmptySurface: () => null,
  SurfaceHeader: () => null,
}));

beforeEach(() => {
  closeInput.inputs = [];
  closeInput.dirty = false;
  closeInput.terminalUi = false;
});

describe("parent surface close input routing", () => {
  it.each([
    ["preview", false, false, ["q"]],
    ["buffer", false, false, ["\u0018", "q"]],
    ["buffer", false, true, ["\u0018", "q"]],
    ["buffer", false, true, ["\u0018", "x"]],
    ["buffer", true, false, ["\u001bq"]],
    ["buffer", true, true, ["\u001bq"]],
  ] as const)("closes %s with terminalUi=%s and dirty=%s", async (mode, terminalUi, dirty, keys) => {
    closeInput.terminalUi = terminalUi;
    closeInput.dirty = dirty;
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => {},
      ref: () => {},
      unref: () => {},
    });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
    stdout.resume();
    const root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });
    const changes: AppState[] = [];
    const initialState = getDefaultAppState();
    try {
      root.render(
        <AppStateProvider initialState={{
          ...initialState,
          workbench: { ...initialState.workbench, activeSurfaceMode: mode, focusedPane: "surface" },
        }} onChangeAppState={({ newState }) => changes.push(newState)}>
          <KeybindingSetup>
            <ActiveWorkSurface focused transcript={<Text>transcript</Text>} />
          </KeybindingSetup>
        </AppStateProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (mode === "buffer") {
        stdin.write("q");
        await vi.waitFor(() => expect(closeInput.inputs).toEqual(["q"]));
        expect(changes).toHaveLength(0);
      }
      for (const key of keys) {
        stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await vi.waitFor(() => expect(changes).toHaveLength(1));
      expect(changes[0]?.workbench.activeSurfaceMode).toBe(dirty ? "buffer" : "transcript");
      if (dirty) {
        expect(changes[0]?.workbench.pendingBlockedOverlay?.deferredCommand).toEqual({
          type: "closeSurface",
        });
      } else {
        expect(changes[0]?.workbench.pendingBlockedOverlay).toBeNull();
      }
      expect(closeInput.inputs).toEqual(mode === "buffer" ? ["q"] : []);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
