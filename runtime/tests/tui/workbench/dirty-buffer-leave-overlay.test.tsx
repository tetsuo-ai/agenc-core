import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRoot } from "../../../src/tui/ink/root.js";
import {
  AppStateProvider,
  getDefaultAppState,
  type AppState,
  useSetAppState,
} from "../../../src/tui/state/AppState.js";
import {
  emptyProviderSnapshot,
  type BufferProviderBuffer,
  type BufferProviderSnapshot,
  type BufferProviderSaveAllResult,
} from "../../../src/tui/workbench/buffer/providers/types.js";

type InputEvent = {
  readonly stopImmediatePropagation: ReturnType<typeof vi.fn>;
};

type CapturedInput = {
  readonly handler: (
    input: string,
    key: { readonly escape?: boolean },
    event: InputEvent,
  ) => boolean;
  readonly options: {
    readonly context?: string;
    readonly isActive?: boolean;
  };
};

const overlayHarness = vi.hoisted(() => ({
  controller: {
    discardAll: vi.fn<(confirmationToken?: string) => Promise<boolean>>(),
    getSnapshot: vi.fn<() => unknown>(),
    prepareDiscardAll: vi.fn<() => Promise<string | null>>(),
    saveAll:
      vi.fn<
        (options: { readonly hasInFlightAgent?: boolean }) => Promise<unknown>
      >(),
  },
  input: null as CapturedInput | null,
  inputVersion: 0,
  snapshot: null as unknown,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: (
    handler: CapturedInput["handler"],
    options: CapturedInput["options"],
  ) => {
    overlayHarness.input = { handler, options };
    overlayHarness.inputVersion += 1;
  },
}));

vi.mock(
  "../../../src/tui/workbench/buffer/providers/BufferProviderController.js",
  () => ({
    getWorkbenchBufferProviderController: () => overlayHarness.controller,
  }),
);

vi.mock("../../../src/tui/workbench/buffer/useBufferStore.js", () => ({
  useBufferStore: () => overlayHarness.snapshot,
}));

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

type RenderedOverlay = {
  readonly changes: readonly AppState[];
  readonly latestState: () => AppState;
  readonly output: () => string;
  readonly unmount: () => void;
};

const renderedOverlays: RenderedOverlay[] = [];
let nextBufferHandle = 1;
let setAppState: ReturnType<typeof useSetAppState> | null = null;

beforeEach(() => {
  nextBufferHandle = 1;
  setAppState = null;
  overlayHarness.input = null;
  overlayHarness.inputVersion = 0;
  overlayHarness.snapshot = dirtySnapshot([
    buffer({ filePath: "/workspace/src/current.ts", current: true }),
  ]);
  overlayHarness.controller.discardAll.mockReset().mockResolvedValue(true);
  overlayHarness.controller.getSnapshot
    .mockReset()
    .mockImplementation(() => overlayHarness.snapshot);
  overlayHarness.controller.prepareDiscardAll
    .mockReset()
    .mockResolvedValue("discard-confirmation");
  overlayHarness.controller.saveAll.mockReset().mockResolvedValue({
    saved: true,
    buffers: [],
  });
});

afterEach(() => {
  for (const rendered of renderedOverlays.splice(0)) rendered.unmount();
});

describe("DirtyBufferLeaveOverlay", () => {
  it("saves every buffer and replays the exact deferred action only once the live snapshot is clean", async () => {
    overlayHarness.controller.saveAll.mockImplementationOnce(async () => {
      overlayHarness.snapshot = cleanSnapshot();
      return {
        saved: true,
        buffers: [],
      } satisfies BufferProviderSaveAllResult;
    });
    const rendered = await renderOverlay();

    const saveEvent = await press("S");
    await waitFor(
      () => rendered.latestState().workbench.pendingBlockedOverlay === null,
    );

    expect(saveEvent.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.saveAll).toHaveBeenCalledWith({
      hasInFlightAgent: false,
    });
    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "transcript",
      pendingBlockedOverlay: null,
    });

    const freshEdit = dirtySnapshot([
      buffer({ filePath: "/workspace/src/fresh-edit.ts", current: true }),
    ]);
    overlayHarness.snapshot = freshEdit;
    overlayHarness.controller.saveAll.mockResolvedValueOnce({
      saved: true,
      buffers: freshEdit.buffers,
    });
    const rechecked = await renderOverlay();

    await press("s");
    await waitFor(
      () => overlayHarness.controller.saveAll.mock.calls.length === 2,
    );

    expect(rechecked.latestState().workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      pendingBlockedOverlay: {
        requestId: "dirty-leave",
        deferredCommand: { type: "closeSurface" },
      },
    });
  });

  it("keeps the transaction open and explains Save All refusals and errors", async () => {
    const blocked = buffer({
      filePath: "/workspace/generated/blocked.ts",
      current: false,
      saveable: false,
    });
    overlayHarness.controller.saveAll
      .mockResolvedValueOnce({
        saved: false,
        reason: "Read-only buffers were not written.",
        blockedBuffers: [blocked],
      })
      .mockRejectedValueOnce(new Error("write pipeline failed"));
    const rendered = await renderOverlay();

    await press("s");
    await waitFor(() =>
      rendered
        .output()
        .includes("Read-only buffers were not written. (blocked.ts)"),
    );
    expect(
      rendered.latestState().workbench.pendingBlockedOverlay,
    ).not.toBeNull();

    await press("S");
    await waitFor(() => rendered.output().includes("write pipeline failed"));

    expect(overlayHarness.controller.saveAll).toHaveBeenCalledTimes(2);
    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      pendingBlockedOverlay: { requestId: "dirty-leave" },
    });
  });

  it("requires two D presses, never mutates on the first, and keeps a refused discard open", async () => {
    overlayHarness.controller.discardAll.mockResolvedValueOnce(false);
    const rendered = await renderOverlay();

    const first = await press("D");
    await waitFor(() =>
      rendered
        .output()
        .includes("Press D again to discard every listed change"),
    );

    expect(first.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.prepareDiscardAll).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.discardAll).not.toHaveBeenCalled();
    expect(
      rendered.latestState().workbench.pendingBlockedOverlay,
    ).not.toBeNull();

    await press("d");
    await waitFor(
      () => overlayHarness.controller.discardAll.mock.calls.length === 1,
    );
    await waitFor(() =>
      rendered
        .output()
        .includes(
          "The dirty-buffer set changed or Neovim did not confirm Discard All.",
        ),
    );

    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      pendingBlockedOverlay: { requestId: "dirty-leave" },
    });

    await press("d");
    await flush();
    expect(overlayHarness.controller.discardAll).toHaveBeenCalledTimes(1);
    expect(overlayHarness.controller.prepareDiscardAll).toHaveBeenCalledTimes(
      2,
    );
  });

  it("rechecks live dirty state after a confirmed discard before deferred replay", async () => {
    const rendered = await renderOverlay();

    const firstConfirmationFrames = occurrenceCount(
      rendered.output(),
      "Press D again to discard every listed change",
    );
    await press("D");
    await waitFor(
      () =>
        occurrenceCount(
          rendered.output(),
          "Press D again to discard every listed change",
        ) > firstConfirmationFrames,
    );
    await press("D");
    await waitFor(
      () => overlayHarness.controller.discardAll.mock.calls.length === 1,
    );
    await flush();

    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      pendingBlockedOverlay: { requestId: "dirty-leave" },
    });

    overlayHarness.snapshot = cleanSnapshot();
    const nextConfirmationFrames = occurrenceCount(
      rendered.output(),
      "Press D again to discard every listed change",
    );
    await press("d", {}, false);
    await waitFor(
      () => overlayHarness.controller.prepareDiscardAll.mock.calls.length === 2,
    );
    await waitFor(
      () =>
        occurrenceCount(
          rendered.output(),
          "Press D again to discard every listed change",
        ) > nextConfirmationFrames,
    );
    await press("d");
    await waitFor(
      () => rendered.latestState().workbench.pendingBlockedOverlay === null,
    );

    expect(overlayHarness.controller.discardAll).toHaveBeenCalledTimes(2);
    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "transcript",
      pendingBlockedOverlay: null,
    });
  });

  it("cancels with Escape without saving, discarding, or replaying the deferred action", async () => {
    const rendered = await renderOverlay();

    const escape = await press("", { escape: true });
    await waitFor(
      () => rendered.latestState().workbench.pendingBlockedOverlay === null,
    );

    expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.saveAll).not.toHaveBeenCalled();
    expect(overlayHarness.controller.discardAll).not.toHaveBeenCalled();
    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      pendingBlockedOverlay: null,
    });
  });

  it("cancels with C before an operation starts", async () => {
    const rendered = await renderOverlay();

    const cancel = await press("C");
    await waitFor(
      () => rendered.latestState().workbench.pendingBlockedOverlay === null,
    );

    expect(cancel.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.saveAll).not.toHaveBeenCalled();
    expect(overlayHarness.controller.discardAll).not.toHaveBeenCalled();
    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      pendingBlockedOverlay: null,
    });
  });

  it("names hidden and unnamed dirty buffers in the blocking transaction", async () => {
    overlayHarness.snapshot = dirtySnapshot([
      buffer({
        filePath: "/workspace/src/current.ts",
        current: true,
      }),
      buffer({
        filePath: "/workspace/src/hidden.ts",
        current: false,
        listed: false,
      }),
      buffer({
        filePath: null,
        absolutePath: null,
        name: "",
        current: false,
        saveable: false,
      }),
    ]);

    const rendered = await renderOverlay();
    await waitFor(() =>
      rendered.output().includes("current.ts, hidden.ts, [No Name]"),
    );

    expect(rendered.output()).toContain(
      "Unsaved BUFFER changes block leaving BUFFER.",
    );
  });

  it("keeps a busy Save All fail-closed while consuming Escape and C", async () => {
    const save = deferred<BufferProviderSaveAllResult>();
    overlayHarness.controller.saveAll.mockReturnValueOnce(save.promise);
    const rendered = await renderOverlay();

    await press("s");
    await waitFor(() => rendered.output().includes("Saving all buffers"));
    expect(rendered.output()).not.toContain("Saving all buffers…   Esc Cancel");

    const unrelated = await press("x", {}, false);
    const discard = await press("d", {}, false);
    const escape = await press("", { escape: true }, false);
    const cancel = await press("c", {}, false);

    expect(unrelated.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(discard.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(cancel.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.saveAll).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.discardAll).not.toHaveBeenCalled();
    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      pendingBlockedOverlay: { requestId: "dirty-leave" },
    });

    overlayHarness.snapshot = cleanSnapshot();
    save.resolve({ saved: true, buffers: [] });
    await waitFor(
      () => rendered.latestState().workbench.pendingBlockedOverlay === null,
    );

    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "transcript",
      pendingBlockedOverlay: null,
    });
  });

  it("keeps a busy confirmed Discard All fail-closed while consuming Escape and C", async () => {
    const discard = deferred<boolean>();
    overlayHarness.controller.discardAll.mockReturnValueOnce(discard.promise);
    const rendered = await renderOverlay();

    const confirmationFrames = occurrenceCount(
      rendered.output(),
      "Press D again to discard every listed change",
    );
    await press("d");
    await waitFor(
      () =>
        occurrenceCount(
          rendered.output(),
          "Press D again to discard every listed change",
        ) > confirmationFrames,
    );
    const firstDiscard = pressSynchronously("d");
    const burstDiscard = pressSynchronously("D");
    await flush();
    await waitFor(() => rendered.output().includes("Discarding all buffers"));
    expect(rendered.output()).not.toContain(
      "Discarding all buffers…   Esc Cancel",
    );
    expect(firstDiscard.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(burstDiscard.stopImmediatePropagation).toHaveBeenCalledOnce();

    const escape = await press("", { escape: true }, false);
    const cancel = await press("C", {}, false);
    const save = await press("s", {}, false);

    expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(cancel.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(save.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.discardAll).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.saveAll).not.toHaveBeenCalled();
    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "buffer",
      pendingBlockedOverlay: { requestId: "dirty-leave" },
    });

    overlayHarness.snapshot = cleanSnapshot();
    discard.resolve(true);
    await waitFor(
      () => rendered.latestState().workbench.pendingBlockedOverlay === null,
    );

    expect(rendered.latestState().workbench).toMatchObject({
      activeSurfaceMode: "transcript",
      pendingBlockedOverlay: null,
    });
  });

  it("serializes a replacement request behind the in-flight mutation", async () => {
    const firstSave = deferred<BufferProviderSaveAllResult>();
    overlayHarness.controller.saveAll.mockReturnValueOnce(firstSave.promise);
    const rendered = await renderOverlay();

    await press("s");
    await waitFor(() => rendered.output().includes("Saving all buffers"));
    setAppState?.((state) => ({
      ...state,
      workbench: {
        ...state.workbench,
        pendingBlockedOverlay: {
          kind: "buffer-dirty",
          requestId: "replacement-leave",
          attemptedAction: "opening a replacement surface",
          deferredCommand: { type: "openSurface", mode: "diff" },
        },
      },
    }));
    await waitFor(
      () =>
        rendered.latestState().workbench.pendingBlockedOverlay?.requestId ===
        "replacement-leave",
    );

    await press("s", {}, false);
    await press("d", {}, false);
    expect(overlayHarness.controller.saveAll).toHaveBeenCalledOnce();
    expect(overlayHarness.controller.discardAll).not.toHaveBeenCalled();

    const inputVersion = overlayHarness.inputVersion;
    firstSave.resolve({ saved: true, buffers: [] });
    await waitFor(() => overlayHarness.inputVersion > inputVersion);
    expect(
      rendered.latestState().workbench.pendingBlockedOverlay,
    ).toMatchObject({
      requestId: "replacement-leave",
      deferredCommand: { type: "openSurface", mode: "diff" },
    });

    await press("s");
    expect(overlayHarness.controller.saveAll).toHaveBeenCalledTimes(2);
  });
});

function AppStateSetterProbe(): null {
  setAppState = useSetAppState();
  return null;
}

async function renderOverlay(): Promise<RenderedOverlay> {
  const { DirtyBufferLeaveOverlay } =
    await import("../../../src/tui/workbench/DirtyBufferLeaveOverlay.js");
  const io = stdio();
  const root = await createRoot({
    stdout: io.stdout as unknown as NodeJS.WriteStream,
    stdin: io.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  const initialState = blockedAppState();
  const changes: AppState[] = [];

  root.render(
    <AppStateProvider
      initialState={initialState}
      onChangeAppState={({ newState }) => changes.push(newState)}
    >
      <AppStateSetterProbe />
      <DirtyBufferLeaveOverlay />
    </AppStateProvider>,
  );
  await waitFor(() => overlayHarness.input !== null);
  expect(overlayHarness.input?.options).toEqual({
    context: "Modal",
    isActive: true,
  });

  const rendered = {
    changes,
    latestState: () => changes.at(-1) ?? initialState,
    output: io.output,
    unmount: () => {
      root.unmount();
      io.stdin.end();
      io.stdout.end();
    },
  };
  renderedOverlays.push(rendered);
  return rendered;
}

function blockedAppState(): AppState {
  const base = getDefaultAppState();
  return {
    ...base,
    workbench: {
      ...base.workbench,
      focusedPane: "surface",
      activeSurfaceMode: "buffer",
      activeFilePath: "/workspace/src/current.ts",
      pendingBlockedOverlay: {
        kind: "buffer-dirty",
        requestId: "dirty-leave",
        attemptedAction: "leaving BUFFER",
        deferredCommand: { type: "closeSurface" },
      },
    },
  };
}

function buffer(
  overrides: Partial<BufferProviderBuffer> = {},
): BufferProviderBuffer {
  const handle = overrides.handle ?? nextBufferHandle++;
  const filePath =
    overrides.filePath === undefined
      ? `/workspace/src/buffer-${handle}.ts`
      : overrides.filePath;
  return {
    handle,
    changedtick: overrides.changedtick ?? 1,
    name: overrides.name ?? filePath ?? "",
    filePath,
    absolutePath:
      overrides.absolutePath === undefined ? filePath : overrides.absolutePath,
    listed: overrides.listed ?? true,
    loaded: overrides.loaded ?? true,
    modified: overrides.modified ?? true,
    current: overrides.current ?? false,
    bufferType: overrides.bufferType ?? "",
    modifiable: overrides.modifiable ?? true,
    readOnly: overrides.readOnly ?? false,
    saveable: overrides.saveable ?? true,
  };
}

function dirtySnapshot(
  buffers: readonly BufferProviderBuffer[],
): BufferProviderSnapshot {
  const current = buffers.find((entry) => entry.current) ?? buffers[0] ?? null;
  return {
    ...emptyProviderSnapshot(PROVIDER),
    status: "ready",
    providerStatus: "ready",
    filePath: current?.filePath ?? null,
    absolutePath: current?.absolutePath ?? null,
    dirty: buffers.some((entry) => entry.modified),
    buffers,
    activeBufferHandle: current?.handle ?? null,
    dirtyBufferCount: buffers.filter((entry) => entry.modified).length,
  };
}

function cleanSnapshot(): BufferProviderSnapshot {
  return {
    ...emptyProviderSnapshot(PROVIDER),
    status: "ready",
    providerStatus: "ready",
  };
}

async function press(
  input: string,
  key: { readonly escape?: boolean } = {},
  waitForRender = true,
): Promise<InputEvent> {
  const version = overlayHarness.inputVersion;
  const event = pressSynchronously(input, key);
  if (waitForRender) {
    await waitFor(() => overlayHarness.inputVersion > version);
  } else {
    await flush();
  }
  return event;
}

function pressSynchronously(
  input: string,
  key: { readonly escape?: boolean } = {},
): InputEvent {
  const capture = overlayHarness.input;
  if (capture === null)
    throw new Error("Dirty overlay input was not registered");
  const event = { stopImmediatePropagation: vi.fn() };
  if (capture.handler(input, key, event)) {
    event.stopImmediatePropagation();
  }
  return event;
}

function occurrenceCount(value: string, needle: string): number {
  return value.split(needle).length - 1;
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
  (stdout as unknown as { columns: number; rows: number }).columns = 100;
  (stdout as unknown as { columns: number; rows: number }).rows = 20;
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
    output: () => stripAnsi(output),
  };
}

async function waitFor(
  check: () => boolean,
  message = "Timed out waiting for dirty-buffer overlay",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
