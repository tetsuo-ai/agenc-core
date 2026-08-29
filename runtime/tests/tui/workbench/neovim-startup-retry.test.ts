import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_BUFFERED_NEOVIM_STARTUP_EVENTS,
  MAX_BUFFERED_NEOVIM_STARTUP_TERMINAL_EVENTS,
  retryTimedOutEmbeddedNeovimStartup,
} from "../../helpers/neovim-startup-retry.js";
import { createNeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import {
  NeovimStartupCleanupError,
  type EmbeddedNeovimSession,
  type NeovimExitInfo,
  type StartEmbeddedNeovimOptions,
} from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";
import { NeovimBufferProvider } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";

const usableDiscovery = {
  usable: true,
  executable: "/usr/bin/nvim",
  version: { major: 0, minor: 12, patch: 1, raw: "NVIM v0.12.1" },
  args: ["--embed", "--clean"],
  useUserInit: false,
} as const;

const startupTimeout = new Error(
  "Embedded Neovim startup timed out after 60000ms while attaching the embedded UI.",
);

function renderSnapshot(text: string) {
  return {
    ...createNeovimRenderSnapshot(3, 24),
    lines: [text, "", ""],
  };
}

function minimalSession(): EmbeddedNeovimSession {
  return {
    pid: 12_345,
    recovery: null,
    inspectBuffers: vi.fn(async () => ({
      activeBufferHandle: null,
      buffers: [],
    })),
    cleanup: vi.fn(async () => {}),
  } as unknown as EmbeddedNeovimSession;
}

function baseOptions(
  callbacks: {
    readonly onError?: (error: Error) => void;
    readonly onExit?: (exit: NeovimExitInfo) => void;
  } = {},
): StartEmbeddedNeovimOptions {
  return {
    executable: "/usr/bin/nvim",
    args: ["--embed", "--clean"],
    filePath: resolve("neovim-startup-retry-target.ts"),
    line: 1,
    column: 0,
    size: { rows: 3, columns: 24 },
    onSnapshot: () => {},
    onError: callbacks.onError ?? (() => {}),
    onExit: callbacks.onExit ?? (() => {}),
  };
}

describe("real-Neovim startup retry isolation", () => {
  it("does not let a timed-out attempt close or corrupt the successful provider session", async () => {
    const filePath = resolve("neovim-startup-retry-provider.ts");
    const session = minimalSession();
    let firstOptions: StartEmbeddedNeovimOptions | null = null;
    let successfulOptions: StartEmbeddedNeovimOptions | null = null;
    const startAttempt = vi.fn(
      async (
        options: StartEmbeddedNeovimOptions,
      ): Promise<EmbeddedNeovimSession> => {
        if (startAttempt.mock.calls.length === 1) {
          firstOptions = options;
          options.onSnapshot(renderSnapshot("stale frame"));
          options.onDirtyChange?.(true);
          options.onError(new Error("stale startup error"));
          options.onExit({
            code: null,
            signal: "SIGKILL",
            stderrTail: "stale process",
          });
          throw startupTimeout;
        }
        successfulOptions = options;
        options.onSnapshot(renderSnapshot("fresh frame"));
        return session;
      },
    );
    const provider = new NeovimBufferProvider({
      discovery: usableDiscovery,
      workspaceRoot: resolve("."),
      readFileSnapshot: vi.fn(async () => ({
        filePath,
        absolutePath: filePath,
        content: "export const ready = true;\n",
        mtimeMs: 1,
        size: 27,
        encoding: "utf8" as const,
        lineEndings: "LF" as const,
      })),
      startSession: (options) =>
        retryTimedOutEmbeddedNeovimStartup(options, startAttempt),
    });

    await provider.open({ filePath });

    expect(startAttempt).toHaveBeenCalledTimes(2);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      dirty: false,
      error: null,
      terminal: { lines: ["fresh frame", "", ""] },
    });

    firstOptions?.onError(new Error("late stale error"));
    firstOptions?.onExit({
      code: 9,
      signal: null,
      stderrTail: "late stale exit",
    });
    expect(provider.getSnapshot().providerStatus).toBe("ready");

    successfulOptions?.onExit({
      code: 0,
      signal: null,
      stderrTail: "",
    });
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "closed",
      providerExit: {
        kind: "intentional",
        code: 0,
        signal: null,
        stderrTail: "",
      },
    });
  });

  it("publishes only the final attempt callbacks when the retry also fails", async () => {
    const errors: Error[] = [];
    const exits: NeovimExitInfo[] = [];
    const observerFailure = new Error("observer failed during replay");
    const finalError = new Error("retry failed after startup");
    const staleExit = {
      code: null,
      signal: "SIGKILL",
      stderrTail: "stale",
    } satisfies NeovimExitInfo;
    const finalExit = {
      code: 1,
      signal: null,
      stderrTail: "final",
    } satisfies NeovimExitInfo;
    const startAttempt = vi.fn(async (options: StartEmbeddedNeovimOptions) => {
      if (startAttempt.mock.calls.length === 1) {
        options.onError(new Error("stale error"));
        options.onExit(staleExit);
        throw startupTimeout;
      }
      options.onError(finalError);
      options.onExit(finalExit);
      throw finalError;
    });

    await expect(
      retryTimedOutEmbeddedNeovimStartup(
        baseOptions({
          onError: (error) => {
            errors.push(error);
            throw observerFailure;
          },
          onExit: (exit) => {
            exits.push(exit);
            throw observerFailure;
          },
        }),
        startAttempt,
      ),
    ).rejects.toBe(finalError);

    expect(startAttempt).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([finalError]);
    expect(exits).toEqual([finalExit]);
  });

  it("contains queued observer failures after returning a live session", async () => {
    const observerFailure = new Error("queued observer failed");
    const delivered: string[] = [];
    const session = minimalSession();
    const exit = {
      code: 0,
      signal: null,
      stderrTail: "",
    } satisfies NeovimExitInfo;
    const startAttempt = vi.fn(async (options: StartEmbeddedNeovimOptions) => {
      options.onError(observerFailure);
      options.onExit(exit);
      return session;
    });

    await expect(
      retryTimedOutEmbeddedNeovimStartup(
        baseOptions({
          onError: () => {
            delivered.push("error");
            throw observerFailure;
          },
          onExit: () => delivered.push("exit"),
        }),
        startAttempt,
      ),
    ).resolves.toBe(session);

    expect(delivered).toEqual(["error", "exit"]);
    await session.cleanup();
    expect(session.cleanup).toHaveBeenCalledOnce();
  });

  it("does not retry when a timed-out startup has unproven cleanup", async () => {
    const exits: NeovimExitInfo[] = [];
    const cleanupRetry = vi.fn(async () => {});
    const failure = new NeovimStartupCleanupError(
      startupTimeout,
      new Error("process tree still alive"),
      cleanupRetry,
    );
    const exit = {
      code: null,
      signal: "SIGKILL",
      stderrTail: "cleanup unproven",
    } satisfies NeovimExitInfo;
    const startAttempt = vi.fn(async (options: StartEmbeddedNeovimOptions) => {
      options.onExit(exit);
      throw failure;
    });

    await expect(
      retryTimedOutEmbeddedNeovimStartup(
        baseOptions({
          onExit: (value) => {
            exits.push(value);
            throw new Error("cleanup observer failed");
          },
        }),
        startAttempt,
      ),
    ).rejects.toBe(failure);

    expect(startAttempt).toHaveBeenCalledOnce();
    expect(exits).toEqual([exit]);
    expect(cleanupRetry).not.toHaveBeenCalled();
  });

  it("coalesces state and bounds queued events while startup is pending", async () => {
    const snapshots: string[] = [];
    const dirtyChanges: boolean[] = [];
    const recoveryEvents: string[] = [];
    const terminalEvents: string[] = [];
    let workspaceChanges = 0;
    const session = minimalSession();
    const snapshotCount = 10_000;
    const eventCount = MAX_BUFFERED_NEOVIM_STARTUP_EVENTS * 4;
    const terminalCount = MAX_BUFFERED_NEOVIM_STARTUP_TERMINAL_EVENTS * 4;
    const startAttempt = vi.fn(async (options: StartEmbeddedNeovimOptions) => {
      for (let index = 0; index < snapshotCount; index += 1) {
        options.onSnapshot(renderSnapshot(`frame-${index}`));
        options.onDirtyChange?.(index % 2 === 0);
        options.onWorkspaceChange?.();
      }
      for (let index = 0; index < eventCount; index += 1) {
        options.onRecoveryDetected?.({
          swapFile: `recovery-${index}`,
          filePath: "/workspace/file.ts",
        });
      }
      for (let index = 0; index < terminalCount; index += 1) {
        options.onError(new Error(`terminal-${index}`));
      }
      options.onExit({ code: 1, signal: null, stderrTail: "final exit" });
      return session;
    });
    const options = {
      ...baseOptions(),
      onSnapshot: (snapshot: ReturnType<typeof renderSnapshot>) => {
        snapshots.push(snapshot.lines[0] ?? "");
      },
      onDirtyChange: (dirty: boolean) => dirtyChanges.push(dirty),
      onWorkspaceChange: () => {
        workspaceChanges += 1;
      },
      onRecoveryDetected: (recovery: {
        readonly swapFile: string;
        readonly filePath: string;
      }) => recoveryEvents.push(recovery.swapFile),
      onError: (error: Error) => terminalEvents.push(error.message),
      onExit: () => terminalEvents.push("exit"),
    } satisfies StartEmbeddedNeovimOptions;

    await expect(
      retryTimedOutEmbeddedNeovimStartup(options, startAttempt),
    ).resolves.toBe(session);

    expect(snapshots).toEqual([`frame-${snapshotCount - 1}`]);
    expect(dirtyChanges).toEqual([(snapshotCount - 1) % 2 === 0]);
    expect(workspaceChanges).toBe(1);
    expect(recoveryEvents).toEqual(
      Array.from(
        { length: MAX_BUFFERED_NEOVIM_STARTUP_EVENTS },
        (_, offset) =>
          `recovery-${eventCount - MAX_BUFFERED_NEOVIM_STARTUP_EVENTS + offset}`,
      ),
    );
    expect(terminalEvents).toEqual([
      ...Array.from(
        { length: MAX_BUFFERED_NEOVIM_STARTUP_TERMINAL_EVENTS - 1 },
        (_, offset) =>
          `terminal-${terminalCount - MAX_BUFFERED_NEOVIM_STARTUP_TERMINAL_EVENTS + 1 + offset}`,
      ),
      "exit",
    ]);
  });

  it("passes startup request callbacks through to both physical attempts", async () => {
    const beforeOpenFile: NonNullable<
      StartEmbeddedNeovimOptions["beforeOpenFile"]
    > = vi.fn(async () => undefined);
    const onBeforeWorkspaceWrite: NonNullable<
      StartEmbeddedNeovimOptions["onBeforeWorkspaceWrite"]
    > = vi.fn(async () => ({ allowed: true }));
    const options = {
      ...baseOptions(),
      beforeOpenFile,
      onBeforeWorkspaceWrite,
    } satisfies StartEmbeddedNeovimOptions;
    const session = minimalSession();
    const startAttempt = vi.fn(
      async (attemptOptions: StartEmbeddedNeovimOptions) => {
        expect(attemptOptions.beforeOpenFile).toBe(beforeOpenFile);
        expect(attemptOptions.onBeforeWorkspaceWrite).toBe(
          onBeforeWorkspaceWrite,
        );
        if (startAttempt.mock.calls.length === 1) throw startupTimeout;
        return session;
      },
    );

    await expect(
      retryTimedOutEmbeddedNeovimStartup(options, startAttempt),
    ).resolves.toBe(session);
    expect(startAttempt).toHaveBeenCalledTimes(2);
  });
});
