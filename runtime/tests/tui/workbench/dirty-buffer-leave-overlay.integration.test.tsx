import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseTextInput } from "../../../src/tui/components/BaseTextInput.js";
import { Text } from "../../../src/tui/ink.js";
import { createRoot } from "../../../src/tui/ink/root.js";
import type { Key } from "../../../src/tui/ink.js";
import { KeybindingSetup } from "../../../src/tui/keybindings/KeybindingProviderSetup.js";
import { useRegisterKeybindingContext } from "../../../src/tui/keybindings/KeybindingContext.js";
import { useInputCapture } from "../../../src/tui/keybindings/useKeybinding.js";
import {
  AppStateProvider,
  getDefaultAppState,
  type AppState,
} from "../../../src/tui/state/AppState.js";
import type { BaseInputState } from "../../../src/types/textInputTypes.js";
import { DirtyBufferLeaveOverlay } from "../../../src/tui/workbench/DirtyBufferLeaveOverlay.js";
import {
  emptyProviderSnapshot,
  type BufferProviderSnapshot,
} from "../../../src/tui/workbench/buffer/providers/types.js";

const orderingHarness = vi.hoisted(() => ({
  controller: {
    discardAll: vi.fn(),
    getSnapshot: vi.fn(),
    prepareDiscardAll: vi.fn(),
    saveAll: vi.fn(),
  },
  snapshot: null as unknown,
}));

vi.mock(
  "../../../src/tui/workbench/buffer/providers/BufferProviderController.js",
  () => ({
    getWorkbenchBufferProviderController: () => orderingHarness.controller,
  }),
);

vi.mock(
  "../../../src/tui/workbench/buffer/useBufferStore.js",
  () => ({
    useBufferStore: () => orderingHarness.snapshot,
  }),
);

const PROVIDER = {
  kind: "neovim" as const,
  label: "embedded Neovim",
  fallbackReason: null,
  capabilities: {
    vimExact: true,
    terminalUi: true,
    mouse: true,
    clipboard: true,
    dirtyState: true,
    lspPassthrough: true,
    multiBuffer: true,
  },
};

type Focus = "buffer" | "composer";

type RenderedOrdering = {
  readonly bufferInputs: readonly string[];
  readonly composerInputs: readonly string[];
  readonly composerValue: () => string;
  readonly latestState: () => AppState;
  readonly output: () => string;
  readonly press: (input: string) => Promise<void>;
  readonly unmount: () => void;
};

const renderedOrderings: RenderedOrdering[] = [];

beforeEach(() => {
  orderingHarness.snapshot = dirtySnapshot();
  orderingHarness.controller.getSnapshot.mockReset().mockImplementation(
    () => orderingHarness.snapshot,
  );
  orderingHarness.controller.saveAll.mockReset().mockResolvedValue({
    saved: false,
    reason: "save refused for ordering test",
    blockedBuffers: [],
  });
  orderingHarness.controller.prepareDiscardAll.mockReset().mockResolvedValue(
    "discard-confirmation",
  );
  orderingHarness.controller.discardAll.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  for (const rendered of renderedOrderings.splice(0)) rendered.unmount();
});

describe("DirtyBufferLeaveOverlay input ordering", () => {
  it.each(["buffer", "composer"] as const)(
    "owns every key before underlying %s input while the decision is pending",
    async (focus) => {
      const rendered = await renderOrdering(focus);

      await rendered.press("x");
      expect(rendered.latestState().workbench.pendingBlockedOverlay).not.toBeNull();

      await rendered.press("S");
      await waitFor(() => orderingHarness.controller.saveAll.mock.calls.length === 1);
      expect(rendered.latestState().workbench.pendingBlockedOverlay).not.toBeNull();

      await rendered.press("D");
      expect(orderingHarness.controller.discardAll).not.toHaveBeenCalled();
      expect(rendered.latestState().workbench.pendingBlockedOverlay).not.toBeNull();

      await rendered.press("D");
      await waitFor(
        () => orderingHarness.controller.discardAll.mock.calls.length === 1,
      );
      expect(rendered.latestState().workbench.pendingBlockedOverlay).not.toBeNull();

      await rendered.press("\u001b");
      await waitFor(
        () => rendered.latestState().workbench.pendingBlockedOverlay === null,
      );

      expect(rendered.bufferInputs).toEqual([]);
      expect(rendered.composerInputs).toEqual([]);
      expect(rendered.composerValue()).toBe("draft");
      expect(rendered.latestState().workbench).toMatchObject({
        activeSurfaceMode: "buffer",
        focusedPane: focus === "buffer" ? "surface" : "composer",
        pendingBlockedOverlay: null,
      });
    },
  );
});

function FocusedBufferCapture({
  active,
  inputs,
}: {
  readonly active: boolean;
  readonly inputs: string[];
}): null {
  useRegisterKeybindingContext("Buffer", active);
  useInputCapture(
    (input) => {
      inputs.push(input);
      return true;
    },
    { context: "Buffer", isActive: active },
  );
  return null;
}

function ComposerTextInput({
  active,
  inputs,
  onValue,
}: {
  readonly active: boolean;
  readonly inputs: string[];
  readonly onValue: (value: string) => void;
}): React.ReactElement {
  const [value, setValue] = React.useState("draft");
  const offset = value.length;
  onValue(value);
  const inputState: BaseInputState = {
    cursorColumn: offset,
    cursorLine: 0,
    offset,
    onInput: (input: string, key: Key) => {
      inputs.push(input);
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setValue((current) => current + input);
      }
    },
    renderedValue: value,
    setOffset: () => {},
    setValue: (next) => setValue(next),
    value,
    viewportCharEnd: value.length,
    viewportCharOffset: 0,
  };
  return (
    <>
      <BaseTextInput
        columns={80}
        cursorOffset={offset}
        focus={active}
        inputState={inputState}
        onChange={setValue}
        onChangeCursorOffset={() => {}}
        showCursor={active}
        terminalFocus={true}
        value={value}
      />
      <Text>{`draft:${value}`}</Text>
    </>
  );
}

async function renderOrdering(focus: Focus): Promise<RenderedOrdering> {
  const io = stdio();
  const root = await createRoot({
    stdin: io.stdin as unknown as NodeJS.ReadStream,
    stdout: io.stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });
  const initialState = blockedState(focus);
  const changes: AppState[] = [];
  const bufferInputs: string[] = [];
  const composerInputs: string[] = [];
  let composerValue = "draft";

  root.render(
    <AppStateProvider
      initialState={initialState}
      onChangeAppState={({ newState }) => changes.push(newState)}
    >
      <KeybindingSetup>
        <FocusedBufferCapture
          active={focus === "buffer"}
          inputs={bufferInputs}
        />
        <ComposerTextInput
          active={focus === "composer"}
          inputs={composerInputs}
          onValue={(value) => {
            composerValue = value;
          }}
        />
        <DirtyBufferLeaveOverlay />
      </KeybindingSetup>
    </AppStateProvider>,
  );
  await waitFor(
    () =>
      io.output().includes("Unsaved BUFFER changes block") &&
      (changes.at(-1) ?? initialState).activeOverlays.has(
        "dirty-buffer-leave",
      ),
    `Timed out waiting for initial dirty overlay; output=${
      JSON.stringify(io.output())
    }; overlays=${
      JSON.stringify([...(changes.at(-1) ?? initialState).activeOverlays])
    }`,
  );

  const rendered: RenderedOrdering = {
    bufferInputs,
    composerInputs,
    composerValue: () => composerValue,
    latestState: () => changes.at(-1) ?? initialState,
    output: io.output,
    press: async (input) => {
      io.stdin.write(input);
      await flush();
    },
    unmount: () => {
      root.unmount();
      io.stdin.end();
      io.stdout.end();
    },
  };
  renderedOrderings.push(rendered);
  return rendered;
}

function blockedState(focus: Focus): AppState {
  const base = getDefaultAppState();
  return {
    ...base,
    workbench: {
      ...base.workbench,
      focusedPane: focus === "buffer" ? "surface" : "composer",
      activeSurfaceMode: "buffer",
      activeFilePath: "/workspace/current.ts",
      pendingBlockedOverlay: {
        kind: "buffer-dirty",
        requestId: "ordering-test",
        attemptedAction: "leaving BUFFER",
        deferredCommand: { type: "closeSurface" },
      },
    },
  };
}

function dirtySnapshot(): BufferProviderSnapshot {
  return {
    ...emptyProviderSnapshot(PROVIDER),
    status: "ready",
    providerStatus: "ready",
    filePath: "/workspace/current.ts",
    absolutePath: "/workspace/current.ts",
    dirty: true,
    dirtyBufferCount: 1,
    activeBufferHandle: 1,
    buffers: [
      {
        handle: 1,
        name: "/workspace/current.ts",
        filePath: "/workspace/current.ts",
        absolutePath: "/workspace/current.ts",
        listed: true,
        loaded: true,
        modified: true,
        current: true,
        bufferType: "",
        modifiable: true,
        readOnly: false,
        saveable: true,
      },
    ],
  };
}

function stdio(): {
  readonly stdin: PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  readonly stdout: PassThrough;
  readonly output: () => string;
} {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean })
    .columns = 100;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean })
    .rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean })
    .isTTY = true;
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return {
    stdin,
    stdout,
    output: () =>
      stripAnsi(output.replace(
        /\u001b\[(\d*)C/gu,
        (_match, columns: string) => " ".repeat(Number(columns || "1")),
      )),
  };
}

async function waitFor(
  check: () => boolean,
  message = "Timed out waiting for dirty overlay input ordering",
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}
