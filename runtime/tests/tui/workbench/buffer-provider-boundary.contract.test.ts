import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchBufferStore } from "../../../src/tui/workbench/buffer/BufferStore.js";
import { BufferProviderController } from "../../../src/tui/workbench/buffer/providers/BufferProviderController.js";
import { InlineBufferProvider } from "../../../src/tui/workbench/buffer/providers/inline/InlineBufferProvider.js";
import { NeovimBufferProvider } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import { bufferProviderConfigFromEnv, selectBufferEditorProvider } from "../../../src/tui/workbench/buffer/providers/selectBufferEditorProvider.js";
import { emptyProviderSnapshot, type BufferEditorProvider, type BufferProviderIdentity } from "../../../src/tui/workbench/buffer/providers/types.js";

const usableDiscovery = {
  usable: true,
  executable: "/usr/bin/nvim",
  version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
  args: ["--embed", "--clean", "-n"],
  useUserInit: false,
} as const;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-provider-boundary-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("embedded Neovim BUFFER provider boundary", () => {
  it("labels inline mode as a basic fallback without exact Vim capabilities", async () => {
    const usableExecutable = join(dir, "nvim-unused");
    await writeFile(usableExecutable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.0\\n'; exit 0; fi\nexit 0\n", "utf8");
    await chmod(usableExecutable, 0o755);

    const selection = await selectBufferEditorProvider({
      mode: "inline",
      executable: usableExecutable,
      timeoutMs: 500,
      inlineStore: new WorkbenchBufferStore(),
    });

    expect(selection.kind).toBe("inline");
    expect(selection.provider.identity.label).toContain("basic inline BUFFER fallback");
    expect(selection.provider.identity.capabilities).toEqual({
      vimExact: false,
      terminalUi: false,
      mouse: false,
      clipboard: false,
      dirtyState: true,
      lspPassthrough: true,
      multiBuffer: false,
    });
    expect(selection.reason).toContain("basic fallback");
  });

  it("keeps external editor handoff as an explicitly selected separate provider", async () => {
    const selection = await selectBufferEditorProvider({
      mode: "external",
      inlineStore: new WorkbenchBufferStore(),
    });

    expect(selection.kind).toBe("external");
    expect(selection.provider.identity.kind).toBe("external");
    expect(selection.provider.identity.label).toContain("external editor handoff");
    expect(selection.provider.identity.capabilities).toEqual({
      vimExact: false,
      terminalUi: false,
      mouse: false,
      clipboard: false,
      dirtyState: false,
      lspPassthrough: false,
      multiBuffer: false,
    });
    expect(selection.reason).toContain("selected explicitly");
  });

  it("selects embedded Neovim in auto mode and labeled inline fallback in forced Neovim mode", async () => {
    const usableExecutable = join(dir, "nvim-good");
    const failingExecutable = join(dir, "nvim-fail");
    await writeFile(usableExecutable, "#!/bin/sh\nprintf 'NVIM v0.12.0\\n'\n", "utf8");
    await writeFile(failingExecutable, "#!/bin/sh\necho 'bad probe' >&2\nexit 2\n", "utf8");
    await chmod(usableExecutable, 0o755);
    await chmod(failingExecutable, 0o755);

    const usableSelection = await selectBufferEditorProvider({
      mode: "auto",
      executable: usableExecutable,
      timeoutMs: 500,
    });
    expect(usableSelection.kind).toBe("neovim");
    expect(usableSelection.provider.identity.capabilities.vimExact).toBe(true);

    const forcedFailure = await selectBufferEditorProvider({
      mode: "neovim",
      executable: failingExecutable,
      timeoutMs: 500,
      inlineStore: new WorkbenchBufferStore(),
    });
    expect(forcedFailure.kind).toBe("inline");
    expect(forcedFailure.reason).toContain("basic fallback");
    expect(forcedFailure.provider.identity.fallbackReason).toContain("bad probe");

    const autoFailure = await selectBufferEditorProvider({
      mode: "auto",
      executable: failingExecutable,
      timeoutMs: 500,
      inlineStore: new WorkbenchBufferStore(),
    });
    expect(autoFailure.kind).toBe("inline");
    expect(autoFailure.reason).toContain("bad probe");
  });

  it("returns concrete inline fallback reasons for missing and unsupported Neovim", async () => {
    const oldExecutable = join(dir, "nvim-old");
    await writeFile(oldExecutable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.8.3\\n'; exit 0; fi\nexit 0\n", "utf8");
    await chmod(oldExecutable, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const missing = await selectBufferEditorProvider({
        mode: "auto",
        executable: "missing-nvim",
        timeoutMs: 50,
        inlineStore: new WorkbenchBufferStore(),
      });
      expect(missing.kind).toBe("inline");
      expect(missing.discovery).toMatchObject({ usable: false, reasonCode: "missing-binary" });
      expect(missing.provider.identity.fallbackReason).toContain("no usable nvim");
    } finally {
      process.env.PATH = previousPath;
    }

    const old = await selectBufferEditorProvider({
      mode: "auto",
      executable: oldExecutable,
      timeoutMs: 500,
      inlineStore: new WorkbenchBufferStore(),
    });
    expect(old.kind).toBe("inline");
    expect(old.discovery).toMatchObject({ usable: false, reasonCode: "unsupported-version" });
    expect(old.reason).toContain("requires nvim");
  });

  it("parses provider configuration from environment with conservative defaults", () => {
    expect(bufferProviderConfigFromEnv({
      AGENC_BUFFER_PROVIDER: "neovim",
      AGENC_BUFFER_NVIM: "custom-nvim",
      AGENC_BUFFER_NVIM_USE_INIT: "true",
      AGENC_BUFFER_NVIM_TIMEOUT_MS: "250",
    } as NodeJS.ProcessEnv)).toMatchObject({
      mode: "neovim",
      executable: "custom-nvim",
      useUserInit: true,
      timeoutMs: 250,
    });

    expect(bufferProviderConfigFromEnv({
      AGENC_BUFFER_PROVIDER: "external",
    } as NodeJS.ProcessEnv)).toMatchObject({
      mode: "external",
    });

    expect(bufferProviderConfigFromEnv({
      AGENC_BUFFER_PROVIDER: "bogus",
      AGENC_BUFFER_NVIM_USE_INIT: "0",
      AGENC_BUFFER_NVIM_TIMEOUT_MS: "-1",
    } as NodeJS.ProcessEnv)).toMatchObject({
      mode: "auto",
      useUserInit: false,
      timeoutMs: undefined,
    });
  });

  it("reports embedded Neovim capabilities truthfully", () => {
    const provider = new NeovimBufferProvider({ discovery: usableDiscovery });

    expect(provider.identity.kind).toBe("neovim");
    expect(provider.identity.capabilities).toEqual({
      vimExact: true,
      terminalUi: true,
      mouse: true,
      clipboard: true,
      dirtyState: true,
      lspPassthrough: false,
      multiBuffer: true,
    });
  });

  it("cleans the active provider once when the controller is cleaned concurrently", async () => {
    let cleanupCount = 0;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const provider = new InlineBufferProvider({
      reason: "test fallback",
      store: new WorkbenchBufferStore(),
    });
    const originalCleanup = provider.cleanup.bind(provider);
    provider.cleanup = async () => {
      cleanupCount += 1;
      await cleanupStarted;
      await originalCleanup();
    };
    const controller = new BufferProviderController(async () => ({
      kind: "inline",
      provider,
      discovery: null,
      reason: "test fallback",
    }));

    await controller.open("package.json", 1);
    const first = controller.cleanup();
    const second = controller.cleanup();
    releaseCleanup();
    await Promise.all([first, second]);

    expect(cleanupCount).toBe(1);
  });

  it("waits for active provider cleanup before opening a replacement provider", async () => {
    const active = createFakeProvider("neovim");
    const replacement = createFakeProvider("inline");
    let cleanupStarted!: () => void;
    const cleanupStartedSignal = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const releaseCleanup = controlled<void>();
    active.cleanup.mockImplementation(async () => {
      cleanupStarted();
      await releaseCleanup.promise;
    });
    const controller = new BufferProviderController(
      vi.fn()
        .mockResolvedValueOnce({
          kind: "neovim",
          provider: active,
          discovery: usableDiscovery,
        })
        .mockResolvedValueOnce({
          kind: "inline",
          provider: replacement,
          discovery: null,
          reason: "replacement",
        }),
    );

    await controller.open("first.txt", 1);
    const replace = controller.open("second.txt", 2);
    await cleanupStartedSignal;

    expect(replacement.open).not.toHaveBeenCalled();
    releaseCleanup.resolve(undefined);
    await replace;

    expect(replacement.open).toHaveBeenCalledWith({ filePath: "second.txt", line: 2 });
    expect(controller.getSnapshot().provider.kind).toBe("inline");
  });

  it("drops an open request that becomes stale while cleanup is still pending", async () => {
    const active = createFakeProvider("neovim");
    const current = createFakeProvider("external");
    const releaseCleanup = controlled<void>();
    active.cleanup.mockImplementation(async () => {
      await releaseCleanup.promise;
    });
    const selectionFactory = vi.fn()
      .mockResolvedValueOnce({
        kind: "neovim",
        provider: active,
        discovery: usableDiscovery,
      })
      .mockResolvedValueOnce({
        kind: "external",
        provider: current,
        discovery: null,
        reason: "current",
      });
    const controller = new BufferProviderController(
      selectionFactory,
    );

    await controller.open("first.txt", 1);
    const cleanup = controller.cleanup();
    const staleOpen = controller.open("stale.txt", 2);
    const currentOpen = controller.open("current.txt", 3);
    releaseCleanup.resolve(undefined);
    await Promise.all([cleanup, staleOpen, currentOpen]);

    expect(selectionFactory).toHaveBeenCalledTimes(2);
    expect(current.open).toHaveBeenCalledWith({ filePath: "current.txt", line: 3 });
    expect(controller.getSnapshot().provider.kind).toBe("external");
  });

  it("drops a selection that resolves after cleanup makes the open stale", async () => {
    const active = createFakeProvider("neovim");
    const stale = createFakeProvider("inline");
    const releaseSelection = controlled<Awaited<ReturnType<typeof selectBufferEditorProvider>>>();
    const controller = new BufferProviderController(
      vi.fn()
        .mockResolvedValueOnce({
          kind: "neovim",
          provider: active,
          discovery: usableDiscovery,
        })
        .mockImplementationOnce(() => releaseSelection.promise),
    );

    await controller.open("first.txt", 1);
    const staleOpen = controller.open("stale.txt", 2);
    await controller.cleanup();
    releaseSelection.resolve({
      kind: "inline",
      provider: stale,
      discovery: null,
      reason: "stale",
    });
    await staleOpen;

    expect(stale.open).not.toHaveBeenCalled();
    expect(stale.cleanup).not.toHaveBeenCalled();
    expect(controller.getSnapshot().provider.fallbackReason).toContain("not opened");
  });

  it("cancels a pending provider open when cleanup runs before selection resolves", async () => {
    const delayedSelection = controlled<Awaited<ReturnType<typeof selectBufferEditorProvider>>>();
    const provider = createFakeProvider("neovim");
    const controller = new BufferProviderController(vi.fn(() => delayedSelection.promise));

    const open = controller.open("late.txt", 1);
    const cleanup = controller.cleanup();
    delayedSelection.resolve({
      kind: "neovim",
      provider,
      discovery: usableDiscovery,
    });
    await Promise.all([open, cleanup]);

    expect(provider.open).not.toHaveBeenCalled();
    expect(provider.cleanup).not.toHaveBeenCalled();
    expect(controller.getSnapshot().provider.fallbackReason).toContain("not opened");
  });

  it("delegates controller actions to the active provider and emits provider snapshots", async () => {
    const provider = createFakeProvider("inline");
    const controller = new BufferProviderController(async () => ({
      kind: "inline",
      provider,
      discovery: null,
      reason: "test fallback",
    }));
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    await controller.open("package.json", 2);
    await controller.save({ force: true });
    await controller.revert();
    await controller.openExternalEditor();
    controller.undo();
    controller.redo();
    controller.move("down", { pageSize: 4 });
    await controller.requestHover();
    await controller.goToDefinition();
    controller.handleInput("x", baseKey(), { rows: 3, columns: 4 });
    expect(controller.click(2, 9)).toBe(true);
    controller.resize({ rows: 5, columns: 6 });
    controller.focus(true);
    await controller.close();

    expect(provider.open).toHaveBeenCalledWith({ filePath: "package.json", line: 2 });
    expect(provider.save).toHaveBeenCalledWith({ force: true });
    expect(provider.revert).toHaveBeenCalled();
    expect(provider.openExternalEditor).toHaveBeenCalled();
    expect(provider.undo).toHaveBeenCalled();
    expect(provider.redo).toHaveBeenCalled();
    expect(provider.move).toHaveBeenCalledWith("down", { pageSize: 4 });
    expect(provider.requestHover).toHaveBeenCalled();
    expect(provider.goToDefinition).toHaveBeenCalled();
    expect(provider.handleInput).toHaveBeenCalledWith(expect.objectContaining({
      input: "x",
      context: { rows: 3, columns: 4 },
    }));
    expect(provider.click).toHaveBeenCalledWith(2, 9);
    expect(provider.resize).toHaveBeenCalledWith({ rows: 5, columns: 6 });
    expect(provider.focus).toHaveBeenCalledWith(true);
    expect(provider.close).toHaveBeenCalled();
    expect(controller.getSnapshot().provider.kind).toBe("inline");
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    provider.emit();
    expect(listener).toHaveBeenCalledTimes(listener.mock.calls.length);
  });

  it("returns conservative fallback values before any provider is selected", async () => {
    const controller = new BufferProviderController(async () => ({
      kind: "inline",
      provider: createFakeProvider("inline"),
      discovery: null,
      reason: "unused",
    }));

    expect(controller.getVisibleLines()).toEqual([]);
    await expect(controller.save()).resolves.toBe(false);
    await expect(controller.revert()).resolves.toBeUndefined();
    await expect(controller.close()).resolves.toBe(true);
    await expect(controller.openExternalEditor()).resolves.toBe(false);
    expect(controller.undo()).toBe(false);
    expect(controller.redo()).toBe(false);
    expect(controller.move("down")).toBe(false);
    await expect(controller.requestHover()).resolves.toBeNull();
    await expect(controller.goToDefinition()).resolves.toBe(false);
    expect(controller.handleInput("x", baseKey(), { rows: 1, columns: 1 })).toBe(false);
    expect(controller.click(1, 1)).toBe(false);
    controller.focus(true);
    await expect(controller.reopen()).resolves.toBeUndefined();
  });

  it("keeps the last open request when the active provider refuses close", async () => {
    const provider = createFakeProvider("inline");
    provider.close.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const controller = new BufferProviderController(async () => ({
      kind: "inline",
      provider,
      discovery: null,
      reason: "test",
    }));

    await controller.open("package.json", 6);
    await expect(controller.close()).resolves.toBe(false);
    await controller.reopen();
    await expect(controller.close()).resolves.toBe(true);

    expect(provider.open).toHaveBeenNthCalledWith(2, { filePath: "package.json", line: 6 });
  });

  it("reopens the last active file while preserving the last requested pane size", async () => {
    const provider = createFakeProvider("neovim");
    const controller = new BufferProviderController(async () => ({
      kind: "neovim",
      provider,
      discovery: usableDiscovery,
    }));

    controller.resize({ rows: 9, columns: 44 });
    await controller.open("package.json", 3);
    await controller.reopen();

    expect(provider.resize).toHaveBeenCalledWith({ rows: 9, columns: 44 });
    expect(provider.open).toHaveBeenNthCalledWith(1, { filePath: "package.json", line: 3 });
    expect(provider.open).toHaveBeenNthCalledWith(2, { filePath: "package.json", line: 3 });
  });

  it("ignores late provider notifications after cleanup removed the active provider", async () => {
    let listener: (() => void) | null = null;
    const provider = createFakeProvider("inline");
    provider.subscribe.mockImplementation((next: () => void) => {
      listener = next;
      return () => {};
    });
    const controller = new BufferProviderController(async () => ({
      kind: "inline",
      provider,
      discovery: null,
      reason: "test",
    }));

    await controller.open("package.json", 1);
    await controller.cleanup();
    listener?.();

    expect(controller.getSnapshot().provider.fallbackReason).toContain("not opened");
  });

  it("drops unopened same-kind selections without disturbing the active provider state", async () => {
    const active = createFakeProvider("inline");
    const discarded = createFakeProvider("inline");
    const controller = new BufferProviderController(
      vi.fn()
        .mockResolvedValueOnce({
          kind: "inline",
          provider: active,
          discovery: null,
          reason: "first",
        })
        .mockResolvedValueOnce({
          kind: "inline",
          provider: discarded,
          discovery: null,
          reason: "second",
        }),
    );

    await controller.open("package.json", 1);
    await controller.open("README.md", 4);

    expect(active.open).toHaveBeenNthCalledWith(1, { filePath: "package.json", line: 1 });
    expect(active.open).toHaveBeenNthCalledWith(2, { filePath: "README.md", line: 4 });
    expect(discarded.open).not.toHaveBeenCalled();
    expect(discarded.cleanup).not.toHaveBeenCalled();
  });

  it("applies the latest pane size to a provider selected after resize", async () => {
    const provider = createFakeProvider("neovim");
    const controller = new BufferProviderController(async () => ({
      kind: "neovim",
      provider,
      discovery: usableDiscovery,
    }));

    controller.resize({ rows: 7, columns: 33 });
    await controller.open("package.json", 1);

    expect(provider.resize).toHaveBeenCalledWith({ rows: 7, columns: 33 });
    expect(provider.open).toHaveBeenCalledWith({ filePath: "package.json", line: 1 });
  });

  it("drops stale selections when a newer open request wins the race", async () => {
    const staleProvider = createFakeProvider("inline");
    const activeProvider = createFakeProvider("neovim");
    const firstSelection = controlled<Awaited<ReturnType<typeof selectBufferEditorProvider>>>();
    const secondSelection = controlled<Awaited<ReturnType<typeof selectBufferEditorProvider>>>();
    const controller = new BufferProviderController(
      vi.fn()
        .mockImplementationOnce(() => firstSelection.promise)
        .mockImplementationOnce(() => secondSelection.promise),
    );

    const staleOpen = controller.open("stale.txt", 1);
    const activeOpen = controller.open("active.txt", 1);
    firstSelection.resolve({
      kind: "inline",
      provider: staleProvider,
      discovery: null,
      reason: "stale",
    });
    secondSelection.resolve({
      kind: "neovim",
      provider: activeProvider,
      discovery: usableDiscovery,
    });
    await Promise.all([staleOpen, activeOpen]);

    expect(staleProvider.cleanup).not.toHaveBeenCalled();
    expect(staleProvider.open).not.toHaveBeenCalled();
    expect(activeProvider.open).toHaveBeenCalledWith({ filePath: "active.txt", line: 1 });
  });
});

function createFakeProvider(kind: BufferProviderIdentity["kind"]): BufferEditorProvider & {
  readonly emit: () => void;
  readonly open: ReturnType<typeof vi.fn>;
  readonly save: ReturnType<typeof vi.fn>;
  readonly revert: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly openExternalEditor: ReturnType<typeof vi.fn>;
  readonly undo: ReturnType<typeof vi.fn>;
  readonly redo: ReturnType<typeof vi.fn>;
  readonly move: ReturnType<typeof vi.fn>;
  readonly requestHover: ReturnType<typeof vi.fn>;
  readonly goToDefinition: ReturnType<typeof vi.fn>;
  readonly handleInput: ReturnType<typeof vi.fn>;
  readonly click: ReturnType<typeof vi.fn>;
  readonly resize: ReturnType<typeof vi.fn>;
  readonly focus: ReturnType<typeof vi.fn>;
  readonly cleanup: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<() => void>();
  const identity: BufferProviderIdentity = {
    kind,
    label: `${kind} test provider`,
    fallbackReason: kind === "inline" ? "test fallback" : null,
    capabilities: capabilitiesForKind(kind),
  };
  const snapshot = emptyProviderSnapshot(identity);
  return {
    identity,
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getSnapshot: vi.fn(() => snapshot),
    getVisibleLines: vi.fn(() => [{ number: 1, text: "line", selected: false, cursorColumn: 0 }]),
    open: vi.fn(async () => {}),
    save: vi.fn(async () => true),
    revert: vi.fn(async () => {}),
    close: vi.fn(async () => true),
    openExternalEditor: vi.fn(async () => true),
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
    move: vi.fn(() => true),
    requestHover: vi.fn(async () => "hover"),
    goToDefinition: vi.fn(async () => true),
    handleInput: vi.fn(() => true),
    click: vi.fn(() => true),
    resize: vi.fn(),
    focus: vi.fn(),
    cleanup: vi.fn(async () => {}),
    emit: () => {
      for (const listener of listeners) listener();
    },
  };
}

function capabilitiesForKind(kind: BufferProviderIdentity["kind"]) {
  if (kind === "neovim") {
    return { vimExact: true, terminalUi: true, mouse: true, clipboard: true, dirtyState: true, lspPassthrough: false, multiBuffer: true };
  }
  if (kind === "external") {
    return { vimExact: false, terminalUi: false, mouse: false, clipboard: false, dirtyState: false, lspPassthrough: false, multiBuffer: false };
  }
  return { vimExact: false, terminalUi: false, mouse: false, clipboard: false, dirtyState: true, lspPassthrough: true, multiBuffer: false };
}

function baseKey() {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    fn: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
  };
}

function controlled<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
