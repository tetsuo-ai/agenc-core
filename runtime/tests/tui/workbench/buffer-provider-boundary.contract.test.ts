import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchBufferStore } from "../../../src/tui/workbench/buffer/BufferStore.js";
import { BufferProviderController } from "../../../src/tui/workbench/buffer/providers/BufferProviderController.js";
import { InlineBufferProvider } from "../../../src/tui/workbench/buffer/providers/inline/InlineBufferProvider.js";
import { NeovimBufferProvider } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import { bufferProviderConfigFromEnv, selectBufferEditorProvider } from "../../../src/tui/workbench/buffer/providers/selectBufferEditorProvider.js";
import { NeovimStartupCleanupError } from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";
import {
  emptyProviderSnapshot,
  type BufferEditorProvider,
  type BufferProviderIdentity,
  type BufferProviderSnapshot,
} from "../../../src/tui/workbench/buffer/providers/types.js";

const usableDiscovery = {
  usable: true,
  executable: "/usr/bin/nvim",
  version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
  args: ["--embed", "--clean"],
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
    const delayedFailureExecutable = join(dir, "nvim-delayed-fail");
    const failedEmbedExecutable = join(dir, "nvim-failed-embed");
    await writeFile(usableExecutable, "#!/bin/sh\nprintf 'NVIM v0.12.0\\n'\n", "utf8");
    await writeFile(failingExecutable, "#!/bin/sh\necho 'bad probe' >&2\nexit 2\n", "utf8");
    await writeFile(
      delayedFailureExecutable,
      "#!/bin/sh\n(sleep 0.05; echo 'delayed bad probe' >&2) &\nexit 2\n",
      "utf8",
    );
    await writeFile(
      failedEmbedExecutable,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'NVIM v0.12.0\\n'; exit 0; fi\n(sleep 0.35; echo 'delayed embed failure' >&2) &\nexit 2\n",
      "utf8",
    );
    await chmod(usableExecutable, 0o755);
    await chmod(failingExecutable, 0o755);
    await chmod(delayedFailureExecutable, 0o755);
    await chmod(failedEmbedExecutable, 0o755);

    const usableSelection = await selectBufferEditorProvider({
      mode: "auto",
      executable: usableExecutable,
      timeoutMs: 500,
    });
    expect(usableSelection.kind).toBe("neovim");
    expect(usableSelection.provider.identity.capabilities.vimExact).toBe(true);
    if (usableSelection.kind !== "neovim") {
      throw new Error("expected auto mode to select embedded Neovim");
    }
    expect(usableSelection.startupFailureFallback).toBeDefined();

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

    const delayedFailure = await selectBufferEditorProvider({
      mode: "neovim",
      executable: delayedFailureExecutable,
      timeoutMs: 500,
      inlineStore: new WorkbenchBufferStore(),
    });
    expect(delayedFailure.kind).toBe("inline");
    expect(delayedFailure.reason).toContain("exit 2");
    expect(delayedFailure.reason).not.toContain("delayed bad probe");

    const failedEmbed = await selectBufferEditorProvider({
      mode: "neovim",
      executable: failedEmbedExecutable,
      timeoutMs: 500,
      useUserInit: false,
      inlineStore: new WorkbenchBufferStore(),
    });
    expect(failedEmbed.kind).toBe("neovim");
    expect(failedEmbed.discovery).toMatchObject({
      usable: true,
      args: ["--embed", "--clean"],
      useUserInit: false,
    });
    if (failedEmbed.kind !== "neovim") {
      throw new Error("expected explicit Neovim selection");
    }
    expect(failedEmbed.startupFailureFallback).toBeUndefined();
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

  it("parses provider configuration from environment with user-init default preference", () => {
    expect(bufferProviderConfigFromEnv({
      AGENC_BUFFER_PROVIDER: "neovim",
      AGENC_BUFFER_NVIM: "custom-nvim",
      AGENC_BUFFER_NVIM_USE_INIT: "true",
      AGENC_BUFFER_NVIM_TIMEOUT_MS: "250",
      AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS: "15000",
      AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS: "2500",
    } as NodeJS.ProcessEnv)).toMatchObject({
      mode: "neovim",
      executable: "custom-nvim",
      useUserInit: true,
      timeoutMs: 250,
      startupTimeoutMs: 15000,
      cleanupTimeoutMs: 2500,
    });

    expect(bufferProviderConfigFromEnv({
      AGENC_BUFFER_PROVIDER: "external",
    } as NodeJS.ProcessEnv)).toMatchObject({
      mode: "external",
      useUserInit: undefined,
    });

    expect(bufferProviderConfigFromEnv({
      AGENC_BUFFER_PROVIDER: "bogus",
      AGENC_BUFFER_NVIM_USE_INIT: "0",
      AGENC_BUFFER_NVIM_TIMEOUT_MS: "-1",
      AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS: "0",
      AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS: "not-a-number",
    } as NodeJS.ProcessEnv)).toMatchObject({
      mode: "auto",
      useUserInit: false,
      timeoutMs: undefined,
      startupTimeoutMs: undefined,
      cleanupTimeoutMs: undefined,
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

  it("falls back inline after both auto-init startup attempts fail safely and latches that provider", async () => {
    const discovery = {
      ...usableDiscovery,
      args: ["--embed"],
      useUserInit: true,
      fallback: {
        args: ["--embed", "--clean"],
        useUserInit: false,
      },
    } as const;
    const startSession = vi.fn()
      .mockRejectedValueOnce(new Error("user init failed"))
      .mockRejectedValueOnce(new Error("clean init failed"));
    const neovim = new NeovimBufferProvider({
      discovery,
      startSession,
      readFileSnapshot: async (filePath) => ({
        filePath,
        absolutePath: `/workspace/${filePath}`,
        content: "alpha\n",
        mtimeMs: 1,
        size: 6,
        encoding: "utf8",
        lineEndings: "LF",
      }),
    });
    const inline = createFakeProvider("inline");
    const createProvider = vi.fn(() => inline);
    const selectionFactory = vi.fn(async () => ({
      kind: "neovim" as const,
      provider: neovim,
      discovery,
      startupFailureFallback: {
        failureReason: () => neovim.safeStartupFailureReason(),
        createProvider,
      },
    }));
    const controller = new BufferProviderController(selectionFactory);

    await controller.open("first.txt", 4);

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(startSession.mock.calls[0]?.[0].args).toEqual(["--embed"]);
    expect(startSession.mock.calls[1]?.[0].args).toEqual([
      "--embed",
      "--clean",
    ]);
    expect(createProvider).toHaveBeenCalledWith(
      expect.stringContaining("clean-init fallback failed: clean init failed"),
    );
    expect(inline.open).toHaveBeenCalledWith({ filePath: "first.txt", line: 4 });
    expect(controller.getSnapshot().provider.kind).toBe("inline");

    await controller.open("second.txt", 7);

    expect(selectionFactory).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(inline.open).toHaveBeenLastCalledWith({
      filePath: "second.txt",
      line: 7,
    });
    await controller.cleanup();
  });

  it("prefers a verified safe-startup marker when provider open also rejects", async () => {
    const neovim = createFakeProvider("neovim");
    const inline = createFakeProvider("inline");
    neovim.open.mockRejectedValueOnce(new Error("open reported startup failure"));
    const createProvider = vi.fn(() => inline);
    const controller = new BufferProviderController(async () => ({
      kind: "neovim",
      provider: neovim,
      discovery: usableDiscovery,
      startupFailureFallback: {
        failureReason: () => "contained startup failed with cleanup confirmed",
        createProvider,
      },
    }));

    await controller.open("target.txt", 3);

    expect(createProvider).toHaveBeenCalledWith(
      "contained startup failed with cleanup confirmed",
    );
    expect(neovim.cleanup).toHaveBeenCalledTimes(1);
    expect(inline.open).toHaveBeenCalledWith({ filePath: "target.txt", line: 3 });
    expect(controller.getSnapshot().provider.kind).toBe("inline");
    await controller.cleanup();
  });

  it("keeps explicit Neovim mode in error after both startup attempts fail", async () => {
    const discovery = {
      ...usableDiscovery,
      args: ["--embed"],
      useUserInit: true,
      fallback: {
        args: ["--embed", "--clean"],
        useUserInit: false,
      },
    } as const;
    const startSession = vi.fn()
      .mockRejectedValueOnce(new Error("user init failed"))
      .mockRejectedValueOnce(new Error("clean init failed"));
    const neovim = new NeovimBufferProvider({
      discovery,
      startSession,
      readFileSnapshot: async (filePath) => ({
        filePath,
        absolutePath: `/workspace/${filePath}`,
        content: "alpha\n",
        mtimeMs: 1,
        size: 6,
        encoding: "utf8",
        lineEndings: "LF",
      }),
    });
    const controller = new BufferProviderController(async () => ({
      kind: "neovim",
      provider: neovim,
      discovery,
    }));

    await controller.open("target.txt", 1);

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      provider: { kind: "neovim" },
      providerStatus: "error",
      error: expect.stringContaining("clean-init fallback failed"),
    });
    await controller.cleanup();
  });

  it("never falls back inline while clean-init startup cleanup remains uncertain", async () => {
    const discovery = {
      ...usableDiscovery,
      args: ["--embed"],
      useUserInit: true,
      fallback: {
        args: ["--embed", "--clean"],
        useUserInit: false,
      },
    } as const;
    const retryCleanup = vi.fn(async () => {});
    const startSession = vi.fn()
      .mockRejectedValueOnce(new Error("user init failed"))
      .mockRejectedValueOnce(new NeovimStartupCleanupError(
        new Error("clean init failed"),
        new Error("clean child still alive"),
        retryCleanup,
      ));
    const neovim = new NeovimBufferProvider({
      discovery,
      startSession,
      readFileSnapshot: async (filePath) => ({
        filePath,
        absolutePath: `/workspace/${filePath}`,
        content: "alpha\n",
        mtimeMs: 1,
        size: 6,
        encoding: "utf8",
        lineEndings: "LF",
      }),
    });
    const inline = createFakeProvider("inline");
    const createProvider = vi.fn(() => inline);
    const controller = new BufferProviderController(async () => ({
      kind: "neovim",
      provider: neovim,
      discovery,
      startupFailureFallback: {
        failureReason: () => neovim.safeStartupFailureReason(),
        createProvider,
      },
    }));

    await controller.open("target.txt", 1);

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(createProvider).not.toHaveBeenCalled();
    expect(inline.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      provider: { kind: "neovim" },
      providerStatus: "error",
      error: expect.stringContaining("Neovim startup cleanup failed"),
    });

    await controller.cleanup();
    expect(retryCleanup).toHaveBeenCalledTimes(1);
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

  it("does not reopen a provider when cleanup wins during provider installation", async () => {
    const provider = createFakeProvider("neovim");
    let controller!: BufferProviderController;
    let cleanup: Promise<void> | null = null;
    provider.subscribe.mockImplementation(() => {
      cleanup = controller.cleanup();
      return () => {};
    });
    controller = new BufferProviderController(async () => ({
      kind: "neovim",
      provider,
      discovery: usableDiscovery,
    }));

    const opening = controller.open("late.txt", 1);
    await opening;
    await cleanup;

    expect(provider.cleanup).toHaveBeenCalledTimes(1);
    expect(provider.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
    });
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

  it("retains a dirty provider when another file is requested and retries after save", async () => {
    const provider = createFakeProvider("inline");
    const replacement = createFakeProvider("neovim");
    provider.close.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const selectionFactory = vi.fn()
      .mockResolvedValueOnce({
        kind: "inline" as const,
        provider,
        discovery: null,
        reason: "initial",
      })
      .mockResolvedValue({
        kind: "neovim" as const,
        provider: replacement,
        discovery: usableDiscovery,
      });
    const controller = new BufferProviderController(selectionFactory);
    await controller.open("first.txt", 1);
    provider.setSnapshot({
      status: "ready",
      providerStatus: "ready",
      filePath: "first.txt",
      absolutePath: "/workspace/first.txt",
      dirty: true,
    });
    provider.emit();

    await expect(controller.open("second.txt", 2)).resolves.toBeUndefined();

    expect(selectionFactory).toHaveBeenCalledTimes(2);
    expect(provider.close).toHaveBeenCalledWith({ discard: false });
    expect(provider.cleanup).not.toHaveBeenCalled();
    expect(provider.open).toHaveBeenCalledTimes(1);
    expect(replacement.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      filePath: "first.txt",
      dirty: true,
      error: "Unsaved edits. Save, revert, or close-discard before opening another file.",
    });

    provider.setSnapshot({
      status: "ready",
      providerStatus: "ready",
      providerMessage: null,
      error: null,
      conflictKind: null,
      dirty: false,
    });
    provider.emit();
    await controller.reopen();

    expect(provider.cleanup).toHaveBeenCalledTimes(1);
    expect(replacement.open).toHaveBeenCalledWith({ filePath: "second.txt", line: 2 });
  });

  it("restarts the provider at the buffer selected natively before a crash", async () => {
    const provider = createFakeProvider("neovim");
    provider.open.mockImplementation(async ({ filePath, line = 1 }) => {
      provider.setSnapshot({
        status: "ready",
        providerStatus: "ready",
        filePath,
        absolutePath: `/workspace/${filePath}`,
        position: { line, column: 0, offset: 0 },
      });
      provider.emit();
    });
    const controller = new BufferProviderController(async () => ({
      kind: "neovim",
      provider,
      discovery: usableDiscovery,
    }));
    await controller.open("first.txt", 1);
    provider.setSnapshot({
      status: "ready",
      providerStatus: "ready",
      filePath: "first.txt",
      absolutePath: "/workspace/first.txt",
      position: { line: 2, column: 0, offset: 0 },
    });
    provider.emit();
    provider.setSnapshot({
      filePath: "second.txt",
      absolutePath: "/workspace/second.txt",
      position: { line: 9, column: 0, offset: 0 },
    });
    provider.emit();
    provider.setSnapshot({
      status: "idle",
      providerStatus: "closed",
      providerExit: {
        kind: "crash",
        code: 1,
        signal: null,
        stderrTail: "plugin failed",
      },
    });
    provider.emit();
    provider.open.mockClear();

    await expect(controller.restartAfterCrash("configured")).resolves.toBe(true);

    expect(provider.open).toHaveBeenCalledWith({
      filePath: "second.txt",
      line: 9,
    });
  });

  it("keeps changed config off a live workspace and applies it on configured restart", async () => {
    const active = Object.assign(createFakeProvider("neovim"), {
      inspectDirtyBuffers: vi.fn(async () => []),
      saveAll: vi.fn(async () => ({ saved: true as const, buffers: [] })),
    });
    const replacement = Object.assign(createFakeProvider("neovim"), {
      inspectDirtyBuffers: vi.fn(async () => []),
      saveAll: vi.fn(async () => ({ saved: true as const, buffers: [] })),
    });
    active.open.mockImplementation(async ({ filePath, line = 1 }) => {
      active.setSnapshot({
        status: "ready",
        providerStatus: "ready",
        filePath,
        absolutePath: `/workspace/${filePath}`,
        position: { line, column: 0, offset: 0 },
      });
      active.emit();
    });
    replacement.open.mockImplementation(async ({ filePath, line = 1 }) => {
      replacement.setSnapshot({
        status: "ready",
        providerStatus: "ready",
        filePath,
        absolutePath: `/workspace/${filePath}`,
        position: { line, column: 0, offset: 0 },
      });
      replacement.emit();
    });
    const selectionFactory = vi.fn()
      .mockResolvedValueOnce({
        kind: "neovim" as const,
        provider: active,
        discovery: usableDiscovery,
      })
      .mockResolvedValue({
        kind: "neovim" as const,
        provider: replacement,
        discovery: usableDiscovery,
      });
    const controller = new BufferProviderController(selectionFactory);
    const env = {} as NodeJS.ProcessEnv;
    const initialContext = { workspaceRoot: "/workspace" };
    controller.configure(
      { provider: "neovim", neovim: { init: "user" } },
      env,
      initialContext,
    );
    await controller.open("first.txt", 1);

    controller.configure(
      { provider: "neovim", neovim: { init: "clean" } },
      env,
      { workspaceRoot: "/workspace" },
    );
    await controller.open("second.txt", 7);

    expect(selectionFactory).toHaveBeenCalledTimes(1);
    expect(active.open).toHaveBeenLastCalledWith({
      filePath: "second.txt",
      line: 7,
    });

    active.setSnapshot({
      status: "idle",
      providerStatus: "closed",
      providerExit: {
        kind: "crash",
        code: 1,
        signal: null,
        stderrTail: "old init crashed",
      },
    });
    active.emit();

    await expect(controller.restartAfterCrash("configured")).resolves.toBe(true);

    expect(active.cleanup).toHaveBeenCalledTimes(1);
    expect(selectionFactory).toHaveBeenCalledTimes(2);
    expect(replacement.open).toHaveBeenCalledWith({
      filePath: "second.txt",
      line: 7,
    });
  });

  it("uses a live close handshake for same-path provider switches", async () => {
    const active = createFakeProvider("inline");
    const replacement = createFakeProvider("neovim");
    active.close.mockResolvedValueOnce(false);
    const controller = new BufferProviderController(
      vi.fn()
        .mockResolvedValueOnce({
          kind: "inline",
          provider: active,
          discovery: null,
          reason: "initial",
        })
        .mockResolvedValueOnce({
          kind: "neovim",
          provider: replacement,
          discovery: usableDiscovery,
        }),
    );
    await controller.open("same.txt", 1);
    active.setSnapshot({
      status: "ready",
      providerStatus: "ready",
      filePath: "same.txt",
      absolutePath: "/workspace/same.txt",
      dirty: true,
    });
    active.emit();

    await controller.open("same.txt", 2);

    expect(active.close).toHaveBeenCalledWith({ discard: false });
    expect(active.cleanup).not.toHaveBeenCalled();
    expect(replacement.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      filePath: "same.txt",
      dirty: true,
    });
  });

  it("trusts provider close over a stale clean snapshot during replacement", async () => {
    const active = createFakeProvider("inline");
    const replacement = createFakeProvider("neovim");
    active.close.mockImplementationOnce(async () => {
      active.setSnapshot({
        status: "conflict",
        providerStatus: "conflict",
        providerMessage: "edit arrived before close",
        error: "edit arrived before close",
        conflictKind: "disk",
        dirty: true,
      });
      active.emit();
      return false;
    });
    const controller = new BufferProviderController(
      vi.fn()
        .mockResolvedValueOnce({
          kind: "inline",
          provider: active,
          discovery: null,
          reason: "initial",
        })
        .mockResolvedValueOnce({
          kind: "neovim",
          provider: replacement,
          discovery: usableDiscovery,
        }),
    );
    await controller.open("first.txt", 1);
    active.setSnapshot({
      status: "ready",
      providerStatus: "ready",
      filePath: "first.txt",
      absolutePath: "/workspace/first.txt",
      dirty: false,
    });
    active.emit();

    await controller.open("second.txt", 2);

    expect(active.cleanup).not.toHaveBeenCalled();
    expect(replacement.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      dirty: true,
      error: "edit arrived before close",
    });
  });

  it("serializes A-to-B teardown before a newer A-kind open", async () => {
    const activeA = createFakeProvider("neovim");
    const staleB = createFakeProvider("inline");
    const winningA = createFakeProvider("neovim");
    const cleanupStarted = controlled<void>();
    const releaseCleanup = controlled<void>();
    activeA.cleanup.mockImplementationOnce(async () => {
      cleanupStarted.resolve(undefined);
      await releaseCleanup.promise;
    });
    const controller = new BufferProviderController(
      vi.fn()
        .mockResolvedValueOnce({
          kind: "neovim",
          provider: activeA,
          discovery: usableDiscovery,
        })
        .mockResolvedValueOnce({
          kind: "inline",
          provider: staleB,
          discovery: null,
          reason: "stale replacement",
        })
        .mockResolvedValueOnce({
          kind: "neovim",
          provider: winningA,
          discovery: usableDiscovery,
        }),
    );
    await controller.open("first.txt", 1);

    const staleOpen = controller.open("second.txt", 2);
    await cleanupStarted.promise;
    const winningOpen = controller.open("third.txt", 3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(activeA.open).toHaveBeenCalledTimes(1);
    expect(winningA.open).not.toHaveBeenCalled();

    releaseCleanup.resolve(undefined);
    await Promise.all([staleOpen, winningOpen]);

    expect(activeA.cleanup).toHaveBeenCalledTimes(1);
    expect(activeA.open).toHaveBeenCalledTimes(1);
    expect(staleB.open).not.toHaveBeenCalled();
    expect(winningA.open).toHaveBeenCalledWith({ filePath: "third.txt", line: 3 });
    expect(controller.getSnapshot().provider.kind).toBe("neovim");
  });

  it("does not let a slow close clear a newer controller open request", async () => {
    const provider = createFakeProvider("inline");
    const closeResult = controlled<boolean>();
    provider.close.mockImplementationOnce(() => closeResult.promise);
    const controller = new BufferProviderController(async () => ({
      kind: "inline",
      provider,
      discovery: null,
      reason: "test",
    }));

    await controller.open("package.json", 1);
    const closing = controller.close();
    await controller.open("README.md", 4);
    closeResult.resolve(true);

    await expect(closing).resolves.toBe(false);
    await controller.reopen();
    expect(provider.open).toHaveBeenNthCalledWith(3, { filePath: "README.md", line: 4 });
  });

  it("cancels a pending selection when close wins before a provider is installed", async () => {
    const selection = controlled<Awaited<ReturnType<typeof selectBufferEditorProvider>>>();
    const provider = createFakeProvider("external");
    const controller = new BufferProviderController(vi.fn(() => selection.promise));

    const pendingOpen = controller.open("late.txt", 1);
    await expect(controller.close()).resolves.toBe(true);
    selection.resolve({
      kind: "external",
      provider,
      discovery: null,
      reason: "late selection",
    });
    await pendingOpen;

    expect(provider.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
    });
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

  it("contains selection, selected-open, and active-close failures", async () => {
    const selectionController = new BufferProviderController(
      vi.fn().mockRejectedValue(new Error("selection failed")),
    );

    await expect(selectionController.open("package.json", 1)).resolves.toBeUndefined();
    expect(selectionController.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "BUFFER provider open failed: selection failed",
    });

    const failingOpen = createFakeProvider("inline");
    failingOpen.open.mockRejectedValueOnce(new Error("provider open failed"));
    const openController = new BufferProviderController(async () => ({
      kind: "inline" as const,
      provider: failingOpen,
      discovery: null,
      reason: "test",
    }));

    await expect(openController.open("package.json", 1)).resolves.toBeUndefined();
    expect(openController.getSnapshot()).toMatchObject({
      provider: { kind: "inline" },
      providerStatus: "error",
      error: "BUFFER provider open failed: provider open failed",
    });

    const active = createFakeProvider("inline");
    const replacement = createFakeProvider("neovim");
    active.close.mockRejectedValueOnce(new Error("provider close failed"));
    const replacementController = new BufferProviderController(
      vi.fn()
        .mockResolvedValueOnce({
          kind: "inline",
          provider: active,
          discovery: null,
          reason: "initial",
        })
        .mockResolvedValueOnce({
          kind: "neovim",
          provider: replacement,
          discovery: usableDiscovery,
        }),
    );

    await replacementController.open("package.json", 1);
    await expect(replacementController.open("README.md", 2)).resolves.toBeUndefined();
    expect(replacement.open).not.toHaveBeenCalled();
    expect(replacementController.getSnapshot()).toMatchObject({
      provider: { kind: "inline" },
      providerStatus: "error",
      error: "BUFFER provider close failed: provider close failed",
    });
  });

  it("keeps failed provider cleanup transactional and visible until a retry succeeds", async () => {
    const provider = createFakeProvider("neovim");
    provider.cleanup.mockRejectedValueOnce(new Error("process tree survived"));
    const selectionFactory = vi.fn(async () => ({
      kind: "neovim" as const,
      provider,
      discovery: usableDiscovery,
    }));
    const controller = new BufferProviderController(selectionFactory);

    await controller.open("package.json", 1);
    await expect(controller.cleanup()).rejects.toThrow("process tree survived");

    expect(controller.getSnapshot()).toMatchObject({
      provider: { kind: "neovim" },
      providerStatus: "error",
      error: "BUFFER provider cleanup failed: process tree survived",
    });

    await expect(controller.cleanup()).resolves.toBeUndefined();
    expect(provider.cleanup).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      provider: { kind: "inline" },
      providerStatus: "idle",
      error: null,
    });
  });

  it("blocks an open racing failed teardown without replacing the owned provider", async () => {
    const active = createFakeProvider("inline");
    const replacement = createFakeProvider("neovim");
    const cleanup = controlled<void>();
    active.cleanup.mockImplementationOnce(() => cleanup.promise);
    const selectionFactory = vi.fn()
      .mockResolvedValueOnce({
        kind: "inline",
        provider: active,
        discovery: null,
        reason: "initial",
      })
      .mockResolvedValueOnce({
        kind: "neovim",
        provider: replacement,
        discovery: usableDiscovery,
      });
    const controller = new BufferProviderController(selectionFactory);

    await controller.open("package.json", 1);
    const teardown = controller.cleanup();
    const racingOpen = controller.open("README.md", 2);
    cleanup.reject(new Error("process tree survived"));

    await expect(teardown).rejects.toThrow("process tree survived");
    await expect(racingOpen).resolves.toBeUndefined();
    expect(selectionFactory).toHaveBeenCalledTimes(1);
    expect(replacement.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      provider: { kind: "inline" },
      providerStatus: "error",
      error: "BUFFER provider cleanup failed: process tree survived",
    });
  });

  it("does not unsubscribe or replace an active provider when replacement cleanup fails", async () => {
    const active = createFakeProvider("inline");
    const replacement = createFakeProvider("neovim");
    active.cleanup.mockRejectedValueOnce(new Error("process tree survived"));
    const controller = new BufferProviderController(
      vi.fn()
        .mockResolvedValueOnce({
          kind: "inline",
          provider: active,
          discovery: null,
          reason: "initial",
        })
        .mockResolvedValueOnce({
          kind: "neovim",
          provider: replacement,
          discovery: usableDiscovery,
        }),
    );

    await controller.open("package.json", 1);
    await expect(controller.open("README.md", 2)).resolves.toBeUndefined();

    expect(replacement.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      provider: { kind: "inline" },
      providerStatus: "error",
      error: "BUFFER provider cleanup failed: process tree survived",
    });
    active.setSnapshot({
      status: "error",
      providerStatus: "error",
      providerMessage: "retained provider diagnostic",
      error: "retained provider diagnostic",
    });
    active.emit();
    expect(controller.getSnapshot().error).toBe("retained provider diagnostic");
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
    expect(discarded.cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an unopened same-kind selection cannot be cleaned", async () => {
    const active = createFakeProvider("inline");
    const discarded = createFakeProvider("inline");
    discarded.cleanup.mockRejectedValueOnce(new Error("candidate resource survived"));
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

    expect(active.open).toHaveBeenCalledTimes(1);
    expect(discarded.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      provider: { kind: "inline" },
      providerStatus: "error",
      error:
        "Unused BUFFER provider cleanup failed: candidate resource survived",
    });
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

  it("delegates project path synchronization and republishes the verified provider snapshot", async () => {
    const provider = createFakeProvider("neovim");
    provider.synchronizePathRename.mockImplementationOnce(async () => {
      provider.setSnapshot({ filePath: "lib/app.ts", absolutePath: "/workspace/lib/app.ts" });
      return { ok: true as const, affectedBufferHandles: [7, 9] };
    });
    provider.synchronizePathDelete.mockResolvedValueOnce({
      ok: true as const,
      affectedBufferHandles: [9],
    });
    const controller = new BufferProviderController(async () => ({
      kind: "neovim",
      provider,
      discovery: usableDiscovery,
    }));
    await controller.open("src/app.ts", 1);

    expect(controller.beginProjectPathMutation()).toBe(true);
    expect(provider.beginProjectPathMutation).toHaveBeenCalledOnce();
    await expect(controller.synchronizePathRename("src", "lib")).resolves.toEqual({
      ok: true,
      affectedBufferHandles: [7, 9],
    });
    expect(provider.synchronizePathRename).toHaveBeenCalledWith("src", "lib");
    expect(controller.getSnapshot()).toMatchObject({
      filePath: "lib/app.ts",
      absolutePath: "/workspace/lib/app.ts",
    });

    await expect(controller.synchronizePathDelete("lib/hidden.ts")).resolves.toEqual({
      ok: true,
      affectedBufferHandles: [9],
    });
    expect(provider.synchronizePathDelete).toHaveBeenCalledWith("lib/hidden.ts");
    controller.endProjectPathMutation();
    expect(provider.endProjectPathMutation).toHaveBeenCalledOnce();
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
  readonly setSnapshot: (snapshot: Partial<BufferProviderSnapshot>) => void;
  readonly open: ReturnType<typeof vi.fn>;
  readonly save: ReturnType<typeof vi.fn>;
  readonly synchronizePathRename: ReturnType<typeof vi.fn>;
  readonly synchronizePathDelete: ReturnType<typeof vi.fn>;
  readonly beginProjectPathMutation: ReturnType<typeof vi.fn>;
  readonly endProjectPathMutation: ReturnType<typeof vi.fn>;
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
  let snapshot = emptyProviderSnapshot(identity);
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
    synchronizePathRename: vi.fn(async () => ({
      ok: true as const,
      affectedBufferHandles: [],
    })),
    synchronizePathDelete: vi.fn(async () => ({
      ok: true as const,
      affectedBufferHandles: [],
    })),
    beginProjectPathMutation: vi.fn(() => true),
    endProjectPathMutation: vi.fn(),
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
    setSnapshot: (next) => {
      snapshot = { ...snapshot, ...next };
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
