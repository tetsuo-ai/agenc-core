import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { encode } from "@msgpack/msgpack";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bufferManifestFromRpcValue,
  dirtyFlagFromRpcNotificationParams,
  EmbeddedNeovimSession,
  NeovimStartupCleanupError,
  startEmbeddedNeovim,
} from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";
import {
  NeovimRpcError,
  NeovimRpcRequestTimeoutError,
} from "../../../src/tui/workbench/buffer/neovim/NeovimRpc.js";
import {
  cleanupTrackedNeovimProcesses,
  getTrackedNeovimProcessCountForTesting,
  killNeovimChild,
  normalizeNeovimPid,
  runTrackedNeovimProcessExitCleanupForTesting,
  spawnNeovimProcess,
  waitForNeovimExit,
} from "../../../src/tui/workbench/buffer/neovim/NeovimProcess.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-nvim-lifecycle-"));
});

afterEach(async () => {
  cleanupTrackedNeovimProcesses("SIGKILL");
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("embedded Neovim lifecycle", () => {
  it("covers process cleanup branches without spawning real Neovim", async () => {
    mockMissingProcessGroups();
    const killedChild = fakeChild({
      killed: true,
      pid: 2_000_000_111,
      signalCode: "SIGTERM",
    });
    expect(normalizeNeovimPid(123)).toBe(123);
    expect(normalizeNeovimPid(undefined)).toBe(0);
    killNeovimChild(killedChild, true, "SIGTERM");
    expect(killedChild.kill).not.toHaveBeenCalled();

    const noPidChild = fakeChild({ pid: undefined });
    killNeovimChild(noPidChild, true, "SIGTERM");
    expect(noPidChild.kill).toHaveBeenCalledWith("SIGTERM");

    const attachedChild = fakeChild({
      killed: true,
      pid: syntheticNeovimPid(222),
    });
    killNeovimChild(attachedChild, false, "SIGKILL");
    expect(attachedChild.kill).toHaveBeenCalledWith("SIGKILL");

    const detachedChild = fakeChild({ pid: syntheticNeovimPid(333) });
    killNeovimChild(detachedChild, true, "SIGTERM");
    expect(detachedChild.kill).toHaveBeenCalledWith("SIGTERM");

    const exitedChild = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(444),
    });
    await expect(waitForNeovimExit(exitedChild, 10)).resolves.toBeUndefined();

    const hangingChild = fakeChild({ pid: syntheticNeovimPid(555) });
    await expect(waitForNeovimExit(hangingChild, 1)).resolves.toBeUndefined();
    expect(hangingChild.kill).toHaveBeenCalledWith("SIGTERM");

    const delayedExitChild = fakeChild({ pid: syntheticNeovimPid(556) });
    const forceKillObserved = controlled<void>();
    delayedExitChild.kill = vi.fn(() => {
      delayedExitChild.killed = true;
      forceKillObserved.resolve();
      return true;
    });
    let waitResolved = false;
    const delayedExitWait = waitForNeovimExit(delayedExitChild, 1).then(() => {
      waitResolved = true;
    });
    await forceKillObserved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(waitResolved).toBe(false);
    delayedExitChild.signalCode = "SIGKILL";
    delayedExitChild.emit("exit");
    await delayedExitWait;

    const unkillableChild = fakeChild({ pid: syntheticNeovimPid(557) });
    unkillableChild.kill = vi.fn(() => true);
    await expect(waitForNeovimExit(unkillableChild, 1)).rejects.toThrow(
      "Neovim process 2000000557 did not exit after SIGKILL",
    );
  });

  it("guards closed embedded sessions and keeps cleanup idempotent", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ exitCode: 0, pid: syntheticNeovimPid(777) });
    const handle = {
      child,
      pid: syntheticNeovimPid(777),
      kill: vi.fn(),
    };
    const rpc = {
      request: vi.fn(async (method: string, args: readonly any[]) => {
        if (method === "nvim_buf_get_option") return true;
        if (method === "nvim_exec_lua") return bufferManifest(true);
        return args[0] ?? true;
      }),
      close: vi.fn(),
    };
    const ui = {
      resize: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
    );

    await session.input("");
    await session.input("i");
    await session.paste("");
    await session.paste("text");
    await session.resize({ rows: 2, columns: 3 });
    await session.focus(true);
    await session.click(2.9, 4.2);
    await expect(session.save(false)).resolves.toBe(true);
    await expect(session.isDirty()).resolves.toBe(true);
    await expect(session.hasUnsavedBuffers()).resolves.toBe(true);
    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_exec_lua",
      [expect.stringContaining("nvim_list_bufs"), []],
      {
        timeoutMs: 10_000,
        signal: expect.any(AbortSignal),
      },
    );
    await expect(session.quit(false)).resolves.toMatchObject({ closed: false });

    await Promise.all([session.cleanup(), session.cleanup()]);
    await session.input("x");
    await session.paste("x");
    await session.resize({ rows: 4, columns: 5 });
    await session.focus(false);
    await session.click(1, 1);
    await expect(session.save(true)).resolves.toBe(false);
    await expect(session.isDirty()).resolves.toBe(false);
    await expect(session.hasUnsavedBuffers()).resolves.toBe(false);
    await expect(session.quit(true)).resolves.toEqual({ closed: true });

    expect(ui.dispose).toHaveBeenCalledTimes(1);
    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_input_mouse",
      ["left", "press", "", 0, 2, 4],
      {
        timeoutMs: 10_000,
        signal: expect.any(AbortSignal),
      },
    );
    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_input_mouse",
      ["left", "release", "", 0, 2, 4],
      {
        timeoutMs: 10_000,
        signal: expect.any(AbortSignal),
      },
    );
    expect(
      rpc.request.mock.calls.filter(
        (call) => call[0] === "nvim_command" && call[1]?.[0] === "qa!",
      ),
    ).toHaveLength(1);
    expect(rpc.close).toHaveBeenCalledWith("session cleanup");
    expect(handle.kill).toHaveBeenCalledWith("SIGKILL");

    const cleanChild = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(778),
    });
    const cleanHandle = {
      child: cleanChild,
      pid: syntheticNeovimPid(778),
      kill: vi.fn(),
    };
    const cleanRpc = {
      request: vi.fn(async (method: string) =>
        method === "nvim_buf_get_option" ? false : true,
      ),
      close: vi.fn(),
    };
    const cleanSession = new EmbeddedNeovimSession(
      cleanHandle as any,
      cleanRpc as any,
      ui as any,
      5,
    );
    await expect(cleanSession.quit(false)).resolves.toEqual({ closed: true });
    expect(cleanRpc.request).toHaveBeenCalledWith("nvim_command", ["qa"], {
      timeoutMs: 5,
      signal: expect.any(AbortSignal),
    });

    const racedChild = fakeChild({ pid: syntheticNeovimPid(783) });
    const racedHandle = {
      child: racedChild,
      pid: syntheticNeovimPid(783),
      kill: vi.fn(),
    };
    const racedRpc = {
      request: vi.fn(async (method: string, args: readonly any[]) => {
        if (method === "nvim_buf_get_option") return false;
        if (method === "nvim_command" && args[0] === "qa") {
          throw new NeovimRpcError(
            "nvim_command",
            1,
            "E37: No write since last change",
          );
        }
        return true;
      }),
      close: vi.fn(),
    };
    const racedSession = new EmbeddedNeovimSession(
      racedHandle as any,
      racedRpc as any,
      ui as any,
      5,
    );
    await expect(racedSession.quit(false)).resolves.toEqual({
      closed: false,
      reason:
        "Unsaved Neovim edits. Save or use force quit before closing BUFFER.",
      dirtyState: "dirty",
    });
    expect(racedHandle.kill).not.toHaveBeenCalled();
    expect(racedRpc.close).not.toHaveBeenCalled();
    await expect(racedSession.quit(true)).resolves.toEqual({ closed: true });

    const dirtyGate = controlled<boolean>();
    const concurrentChild = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(780),
    });
    const concurrentHandle = {
      child: concurrentChild,
      pid: syntheticNeovimPid(780),
      kill: vi.fn(),
    };
    const concurrentRpc = {
      request: vi.fn(async (method: string) =>
        method === "nvim_exec_lua"
          ? dirtyGate.promise.then((dirty) => bufferManifest(dirty))
          : true,
      ),
      close: vi.fn(),
    };
    const concurrentSession = new EmbeddedNeovimSession(
      concurrentHandle as any,
      concurrentRpc as any,
      ui as any,
      5,
    );
    const firstCleanClose = concurrentSession.quit(false);
    const secondCleanClose = concurrentSession.quit(false);
    expect(concurrentRpc.request).toHaveBeenCalledTimes(1);
    dirtyGate.resolve(false);
    await expect(
      Promise.all([firstCleanClose, secondCleanClose]),
    ).resolves.toEqual([{ closed: true }, { closed: true }]);
    expect(
      concurrentRpc.request.mock.calls.filter(
        (call) => call[0] === "nvim_command" && call[1]?.[0] === "qa",
      ),
    ).toHaveLength(1);

    const dirtyDiscardGate = controlled<boolean>();
    const dirtyDiscardChild = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(781),
    });
    const dirtyDiscardHandle = {
      child: dirtyDiscardChild,
      pid: syntheticNeovimPid(781),
      kill: vi.fn(),
    };
    const dirtyDiscardRpc = {
      request: vi.fn(async (method: string) =>
        method === "nvim_exec_lua"
          ? dirtyDiscardGate.promise.then((dirty) => bufferManifest(dirty))
          : true,
      ),
      close: vi.fn(),
    };
    const dirtyDiscardSession = new EmbeddedNeovimSession(
      dirtyDiscardHandle as any,
      dirtyDiscardRpc as any,
      ui as any,
      5,
    );
    const blockedDirtyClose = dirtyDiscardSession.quit(false);
    const forcedDirtyClose = dirtyDiscardSession.quit(true);
    expect(dirtyDiscardRpc.request).toHaveBeenCalledTimes(1);
    dirtyDiscardGate.resolve(true);
    await expect(
      Promise.all([blockedDirtyClose, forcedDirtyClose]),
    ).resolves.toEqual([
      {
        closed: false,
        reason:
          "Unsaved Neovim edits. Save or use force quit before closing BUFFER.",
        dirtyState: "dirty",
      },
      { closed: true },
    ]);
    expect(
      dirtyDiscardRpc.request.mock.calls.filter(
        (call) => call[0] === "nvim_command" && call[1]?.[0] === "qa!",
      ),
    ).toHaveLength(1);

    const closeChild = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(779),
    });
    const closeHandle = {
      child: closeChild,
      pid: syntheticNeovimPid(779),
      kill: vi.fn(),
    };
    const closeRpc = {
      request: vi.fn(async () => true),
      close: vi.fn(),
    };
    const closeSession = new EmbeddedNeovimSession(
      closeHandle as any,
      closeRpc as any,
      ui as any,
      5,
    );
    await Promise.all([closeSession.quit(true), closeSession.quit(true)]);
    expect(
      closeRpc.request.mock.calls.filter(
        (call) => call[0] === "nvim_command" && call[1]?.[0] === "qa!",
      ),
    ).toHaveLength(1);

    const unkillableChild = fakeChild({ pid: syntheticNeovimPid(782) });
    unkillableChild.kill = vi.fn(() => true);
    const unkillableHandle = {
      child: unkillableChild,
      pid: syntheticNeovimPid(782),
      kill: vi.fn(),
    };
    const unkillableRpc = {
      request: vi.fn(async () => true),
      close: vi.fn(),
    };
    const unkillableSession = new EmbeddedNeovimSession(
      unkillableHandle as any,
      unkillableRpc as any,
      ui as any,
      1,
    );
    await expect(unkillableSession.cleanup()).rejects.toThrow(
      `Neovim process ${syntheticNeovimPid(782)} did not exit after SIGKILL`,
    );
    expect(unkillableRpc.close).toHaveBeenCalledWith("session cleanup");
    expect(unkillableHandle.kill).toHaveBeenCalledWith("SIGKILL");

    await expect(unkillableSession.quit(true)).rejects.toThrow(
      `Neovim process ${syntheticNeovimPid(782)} did not exit after SIGKILL`,
    );
    unkillableChild.exitCode = 0;
    await expect(unkillableSession.quit(true)).resolves.toEqual({
      closed: true,
    });
  });

  it("routes explicit process signals through the supervised Neovim boundary", () => {
    const child = fakeChild({ pid: syntheticNeovimPid(778) });
    const handle = {
      child,
      pid: syntheticNeovimPid(778),
      kill: vi.fn(() => true),
    };
    const session = new EmbeddedNeovimSession(
      handle as any,
      { request: vi.fn(), close: vi.fn() } as any,
      { dispose: vi.fn() } as any,
      5,
    );

    expect(session.kill("SIGKILL")).toBe(true);
    expect(handle.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("applies the configured deadline and an abort signal to every interactive RPC", async () => {
    const child = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(791),
    });
    const handle = {
      child,
      pid: syntheticNeovimPid(791),
      kill: vi.fn(),
    };
    const liveSignals: boolean[] = [];
    const rpc = {
      request: vi.fn(
        async (
          method: string,
          args: readonly any[],
          options?: {
            readonly timeoutMs?: number;
            readonly signal?: AbortSignal;
          },
        ) => {
          liveSignals.push(options?.signal?.aborted === false);
          if (
            method === "nvim_exec_lua" &&
            String(args[0]).includes("nvim_list_bufs")
          ) {
            return bufferManifest(false);
          }
          if (method === "nvim_buf_get_lines") return ["alpha", "beta"];
          if (method === "nvim_get_option_value") return true;
          return true;
        },
      ),
      close: vi.fn(),
    };
    const ui = {
      resize: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
      25,
    );

    await session.input("i");
    await session.paste("text");
    await session.focus(true);
    await session.click(3, 7);
    await session.save(false);
    await session.inspectBuffers();
    await session.saveBuffer(1);
    await session.rebaseFileBuffers([
      {
        handle: 1,
        fromPath: "/workspace/src/app.ts",
        toPath: "/workspace/lib/app.ts",
      },
    ]);
    await session.deleteFileBuffers([
      {
        handle: 2,
        path: "/workspace/lib/hidden.ts",
      },
    ]);
    await expect(session.readBufferText(1)).resolves.toBe("alpha\nbeta\n");
    await session.resize({ rows: 8, columns: 40 });

    expect(rpc.request).toHaveBeenCalledTimes(12);
    expect(liveSignals).toEqual(Array.from({ length: 12 }, () => true));
    for (const call of rpc.request.mock.calls) {
      expect(call[2]).toEqual({
        timeoutMs: 25,
        signal: expect.any(AbortSignal),
      });
    }
    expect(ui.resize).toHaveBeenCalledWith(
      { rows: 8, columns: 40 },
      {
        timeoutMs: 25,
        signal: expect.any(AbortSignal),
      },
    );
    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_exec_lua",
      [
        expect.stringContaining("nvim_buf_set_name"),
        [
          [
            {
              handle: 1,
              from_path: "/workspace/src/app.ts",
              to_path: "/workspace/lib/app.ts",
            },
          ],
        ],
      ],
      {
        timeoutMs: 25,
        signal: expect.any(AbortSignal),
      },
    );
    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_exec_lua",
      [
        expect.stringContaining("nvim_buf_delete"),
        [
          [
            {
              handle: 2,
              path: "/workspace/lib/hidden.ts",
            },
          ],
        ],
      ],
      {
        timeoutMs: 25,
        signal: expect.any(AbortSignal),
      },
    );

    await session.cleanup();
  });

  it("reloads a clean loaded path through a guarded Neovim buffer call", async () => {
    const child = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(792),
    });
    const rpc = {
      request: vi.fn(async () => ({
        ok: true,
        reloaded: true,
      })),
      close: vi.fn(),
    };
    const session = new EmbeddedNeovimSession(
      { child, pid: syntheticNeovimPid(792), kill: vi.fn() } as any,
      rpc as any,
      { resize: vi.fn(), dispose: vi.fn() } as any,
      5,
      25,
    );

    await expect(
      session.reloadCleanPath("/workspace/src/app.ts"),
    ).resolves.toEqual({ ok: true, reloaded: true });
    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_exec_lua",
      [
        expect.stringContaining("buffer has unsaved changes"),
        ["/workspace/src/app.ts"],
      ],
      {
        timeoutMs: 25,
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("translates code-prediction context, staging, and dismissal RPCs", async () => {
    const child = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(798),
    });
    const handle = {
      child,
      pid: syntheticNeovimPid(798),
      kill: vi.fn(),
    };
    let reportFileBytes = true;
    const rpc = {
      request: vi.fn(async (method: string, args: readonly any[]) => {
        if (method !== "nvim_exec_lua") return true;
        const source = String(args[0]);
        if (source.includes("AgenCCaptureCodePredictionContext")) {
          const context = {
            buffer_handle: 4,
            path: "/workspace/src/app.ts",
            changedtick: 17,
            cursor: { line: 2, byte_column: 9 },
            prefix: "const app",
            suffix: " = true;",
            language: "typescript",
          };
          return reportFileBytes ? { ...context, file_bytes: 8_192 } : context;
        }
        return true;
      }),
      close: vi.fn(),
    };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      { resize: vi.fn(async () => {}), dispose: vi.fn() } as any,
      5,
      25,
    );

    await expect(session.captureCodePredictionContext()).resolves.toEqual({
      bufferHandle: 4,
      path: "/workspace/src/app.ts",
      changedtick: 17,
      fileBytes: 8_192,
      cursor: { line: 2, byteColumn: 9 },
      prefix: "const app",
      suffix: " = true;",
      language: "typescript",
    });
    reportFileBytes = false;
    await expect(session.captureCodePredictionContext()).resolves.toBeNull();
    reportFileBytes = true;
    await expect(
      session.stageCodePrediction({
        requestId: "prediction-1",
        generation: 3,
        bufferHandle: 4,
        changedtick: 17,
        cursor: { line: 2, byteColumn: 9 },
        text: "lication",
        latencyMs: 12,
      }),
    ).resolves.toBe(true);
    await expect(session.clearCodePrediction("prediction-1")).resolves.toBe(
      true,
    );

    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_exec_lua",
      [
        "return _G.AgenCStageCodePrediction(...)",
        [
          {
            request_id: "prediction-1",
            generation: 3,
            buffer_handle: 4,
            changedtick: 17,
            cursor: { line: 2, byte_column: 9 },
            text: "lication",
            latency_ms: 12,
          },
        ],
      ],
      {
        timeoutMs: 25,
        signal: expect.any(AbortSignal),
      },
    );
    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_exec_lua",
      ["return _G.AgenCDismissCodePrediction(...)", ["prediction-1", false]],
      {
        timeoutMs: 25,
        signal: expect.any(AbortSignal),
      },
    );
    await session.cleanup();
  });

  it("retires timed-out read probes so pending RPCs stay bounded and late replies are ignored", async () => {
    const child = fakeChild({ pid: syntheticNeovimPid(792) });
    const handle = {
      child,
      pid: syntheticNeovimPid(792),
      kill: vi.fn(),
    };
    const rpc = createDeadlineRpcHarness();
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      { resize: vi.fn(async () => {}), dispose: vi.fn() } as any,
      5,
      10,
    );

    await expect(session.inspectBuffers()).rejects.toBeInstanceOf(
      NeovimRpcRequestTimeoutError,
    );
    expect(rpc.pendingCount()).toBe(0);
    expect(rpc.reply(1, bufferManifest(false))).toBe(false);

    await expect(session.readBufferText(1)).rejects.toBeInstanceOf(
      NeovimRpcRequestTimeoutError,
    );
    expect(rpc.pendingCount()).toBe(0);
    expect(rpc.maxPendingCount()).toBeLessThanOrEqual(2);
    expect(rpc.reply(2, ["late"])).toBe(false);
    expect(rpc.reply(3, true)).toBe(false);

    await session.cleanup();
  });

  it("poisons the session when a timed-out mutation could otherwise continue late", async () => {
    const child = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(793),
    });
    const handle = {
      child,
      pid: syntheticNeovimPid(793),
      kill: vi.fn(),
    };
    const rpc = createDeadlineRpcHarness();
    const ui = { resize: vi.fn(async () => {}), dispose: vi.fn() };
    const onFatalError = vi.fn();
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
      10,
      null,
      onFatalError,
    );

    await expect(session.click(4, 9)).rejects.toBeInstanceOf(
      NeovimRpcRequestTimeoutError,
    );

    const mouseCalls = rpc.request.mock.calls.filter(
      (call) => call[0] === "nvim_input_mouse",
    );
    expect(mouseCalls).toHaveLength(1);
    expect(mouseCalls[0]?.[1]?.[1]).toBe("press");
    expect(rpc.pendingCount()).toBe(0);
    expect(rpc.reply(1, true)).toBe(false);
    expect(rpc.close).not.toHaveBeenCalled();
    expect(ui.dispose).toHaveBeenCalledOnce();
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(onFatalError).toHaveBeenNthCalledWith(
      1,
      expect.any(NeovimRpcRequestTimeoutError),
    );
    expect(onFatalError).toHaveBeenNthCalledWith(2, expect.any(AggregateError));
    await expect(session.save(false)).resolves.toBe(false);
    expect(rpc.request).toHaveBeenCalledTimes(1);
    expect(handle.kill).not.toHaveBeenCalled();
    await expect(session.cleanup()).rejects.toThrow(
      "exact recovery preservation was not confirmed",
    );
  });

  it("bounds file navigation and prevents a late edit reply from moving the cursor", async () => {
    const child = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(794),
    });
    const handle = {
      child,
      pid: syntheticNeovimPid(794),
      kill: vi.fn(),
    };
    const rpc = createDeadlineRpcHarness();
    const onFatalError = vi.fn();
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      { resize: vi.fn(async () => {}), dispose: vi.fn() } as any,
      5,
      50,
      null,
      onFatalError,
    );

    const navigation = session.openFile("/workspace/next file.ts", 8, 3);
    const navigationFailure = navigation.catch((error: unknown) => error);
    expect(rpc.reply(1, "/workspace/current.ts")).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rpc.pendingCount()).toBe(1);
    expect(rpc.reply(2, "/workspace/next\\ file.ts")).toBe(true);

    expect(await navigationFailure).toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    expect(rpc.request.mock.calls.map((call) => call[0])).toEqual([
      "nvim_buf_get_name",
      "nvim_call_function",
      "nvim_command",
    ]);
    expect(rpc.reply(3, true)).toBe(false);
    expect(rpc.request).not.toHaveBeenCalledWith(
      "nvim_win_set_cursor",
      expect.anything(),
      expect.anything(),
    );
    expect(onFatalError).toHaveBeenCalledTimes(2);
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("retains a hung child when a mutating timeout cannot prove recovery", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ pid: syntheticNeovimPid(797) });
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        child.signalCode = "SIGKILL";
        queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      }
      return true;
    });
    const handle = {
      child,
      pid: syntheticNeovimPid(797),
      kill: vi.fn(),
    };
    const rpc = createDeadlineRpcHarness();
    const onFatalError = vi.fn();
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      { resize: vi.fn(async () => {}), dispose: vi.fn() } as any,
      2,
      5,
      null,
      onFatalError,
    );

    await expect(session.input("i")).rejects.toBeInstanceOf(
      NeovimRpcRequestTimeoutError,
    );
    await vi.waitFor(() => {
      expect(onFatalError).toHaveBeenCalledTimes(2);
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(handle.kill).not.toHaveBeenCalled();
    expect(rpc.close).not.toHaveBeenCalled();
    await expect(session.save(false)).resolves.toBe(false);
  });

  it("poisons ambiguous Discard All and safe-close timeouts instead of applying them late", async () => {
    const makeTimedSession = (pid: number) => {
      const child = fakeChild({ exitCode: 0, pid });
      const handle = { child, pid, kill: vi.fn() };
      const rpc = createDeadlineRpcHarness();
      const onFatalError = vi.fn();
      const session = new EmbeddedNeovimSession(
        handle as any,
        rpc as any,
        { resize: vi.fn(async () => {}), dispose: vi.fn() } as any,
        5,
        10,
        null,
        onFatalError,
      );
      return { handle, onFatalError, rpc, session };
    };

    const discard = makeTimedSession(795);
    await expect(discard.session.discardAll()).rejects.toBeInstanceOf(
      NeovimRpcRequestTimeoutError,
    );
    expect(discard.rpc.request.mock.calls.map((call) => call[0])).toEqual([
      "nvim_exec_lua",
      "nvim_exec_lua",
    ]);
    expect(discard.rpc.reply(1, true)).toBe(false);
    expect(discard.onFatalError).toHaveBeenCalledTimes(2);

    const safeClose = makeTimedSession(796);
    const closing = safeClose.session.quit(false);
    expect(safeClose.rpc.reply(1, bufferManifest(false))).toBe(true);
    await expect(closing).resolves.toMatchObject({
      closed: false,
      dirtyState: "unknown",
    });
    expect(safeClose.rpc.request.mock.calls.map((call) => call[0])).toEqual([
      "nvim_exec_lua",
      "nvim_command",
    ]);
    expect(safeClose.rpc.reply(2, true)).toBe(false);
    expect(safeClose.onFatalError).toHaveBeenCalledTimes(2);
    expect(discard.handle.kill).not.toHaveBeenCalled();
    expect(safeClose.handle.kill).not.toHaveBeenCalled();
  });

  it("bounds cleanup when Neovim never answers the graceful quit RPC", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ pid: syntheticNeovimPid(784) });
    const handle = {
      child,
      pid: syntheticNeovimPid(784),
      kill: vi.fn(),
    };
    const neverReplies = controlled<unknown>();
    const rpc = {
      request: vi.fn(() => neverReplies.promise),
      close: vi.fn(),
    };
    const ui = {
      dispose: vi.fn(),
    };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
    );

    const outcome = await Promise.race([
      session.cleanup().then(() => "cleaned" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 250),
      ),
    ]);

    expect(outcome).toBe("cleaned");
    expect(rpc.request).toHaveBeenCalledWith("nvim_command", ["qa!"]);
    expect(rpc.close).toHaveBeenCalledWith("session cleanup");
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(handle.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("preserves recovery and never sends qa! during abnormal cleanup", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ pid: syntheticNeovimPid(7841) });
    const handle = {
      child,
      pid: syntheticNeovimPid(7841),
      kill: vi.fn(),
    };
    const rpc = {
      request: vi.fn(async (method: string) =>
        method === "nvim_exec_lua"
          ? [
              {
                handle: 1,
                changedtick: 7,
                end_of_line: true,
                swap: "/private/swap/recovery.swp",
                size: 4096,
              },
            ]
          : true,
      ),
      close: vi.fn(),
    };
    const ui = { dispose: vi.fn() };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
    );

    await session.cleanup({ preserveRecovery: true });

    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_exec_lua",
      [expect.stringContaining("silent preserve"), []],
      { timeoutMs: 5 },
    );
    expect(rpc.request).not.toHaveBeenCalledWith("nvim_command", ["qa!"]);
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(rpc.close).toHaveBeenCalledWith("abnormal session cleanup");
    expect(handle.kill).toHaveBeenCalledWith("SIGKILL");
    expect(session.recoveryPreservationProven).toBe(true);
    expect(rpc.request.mock.invocationCallOrder[0]).toBeLessThan(
      handle.kill.mock.invocationCallOrder[0]!,
    );
  });

  it("leaves the live process intact when abnormal recovery preservation is unproven", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ pid: syntheticNeovimPid(7842) });
    const handle = {
      child,
      pid: syntheticNeovimPid(7842),
      kill: vi.fn(),
    };
    const rpc = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error("preserve transport failed"))
        .mockResolvedValueOnce([
          {
            handle: 1,
            changedtick: 8,
            end_of_line: true,
            swap: "/private/swap/retry.swp",
            size: 4096,
          },
        ]),
      close: vi.fn(),
    };
    const ui = { dispose: vi.fn() };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
    );

    await expect(session.cleanup({ preserveRecovery: true })).rejects.toThrow(
      "exact recovery preservation was not confirmed: preserve transport failed",
    );

    expect(handle.kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(rpc.close).not.toHaveBeenCalled();

    // The preservation requirement is latched: even a retry without options
    // must obtain valid proof before it may stop the retained process.
    await session.cleanup();
    expect(rpc.request).toHaveBeenCalledTimes(2);
    expect(session.recoveryPreservationProven).toBe(true);
    expect(rpc.close).toHaveBeenCalledWith("abnormal session cleanup");
    expect(handle.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("fails a non-discarding close closed when the dirty probe never settles", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ pid: syntheticNeovimPid(785) });
    const handle = {
      child,
      pid: syntheticNeovimPid(785),
      kill: vi.fn(),
    };
    const neverReplies = controlled<unknown>();
    const rpc = {
      request: vi.fn(() => neverReplies.promise),
      close: vi.fn(),
    };
    const ui = { dispose: vi.fn() };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
    );

    const outcome = await Promise.race([
      session.quit(false),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 250),
      ),
    ]);

    expect(outcome).toMatchObject({
      closed: false,
      reason: expect.stringContaining("Unable to verify"),
    });
    expect(rpc.request).toHaveBeenCalledWith(
      "nvim_exec_lua",
      [expect.stringContaining("nvim_list_bufs"), []],
      {
        timeoutMs: 5,
        signal: expect.any(AbortSignal),
      },
    );
    expect(rpc.close).not.toHaveBeenCalled();
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(handle.kill).not.toHaveBeenCalled();
    expect(ui.dispose).not.toHaveBeenCalled();
  });

  it("retires but preserves a clean-probed session when all-buffer quit is ambiguous", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ pid: syntheticNeovimPid(786) });
    const handle = {
      child,
      pid: syntheticNeovimPid(786),
      kill: vi.fn(),
    };
    const neverReplies = controlled<unknown>();
    const rpc = {
      request: vi.fn((method: string, args: readonly unknown[]) => {
        if (method === "nvim_buf_get_option") return Promise.resolve(false);
        if (method === "nvim_command" && args[0] === "qa")
          return neverReplies.promise;
        return Promise.resolve(true);
      }),
      close: vi.fn(),
    };
    const ui = { dispose: vi.fn() };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
    );

    const outcome = await Promise.race([
      session.quit(false),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 250),
      ),
    ]);

    expect(outcome).toMatchObject({ closed: false });
    expect(rpc.request).toHaveBeenCalledWith("nvim_command", ["qa"], {
      timeoutMs: 5,
      signal: expect.any(AbortSignal),
    });
    expect(
      rpc.request.mock.calls.filter(
        (call) => call[0] === "nvim_command" && call[1]?.[0] === "qa!",
      ),
    ).toHaveLength(0);
    expect(rpc.close).not.toHaveBeenCalled();
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("waits for a transport-raced safe exit without killing the live child", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ pid: syntheticNeovimPid(789) });
    const handle = {
      child,
      pid: syntheticNeovimPid(789),
      kill: vi.fn(),
    };
    const rpc = {
      request: vi.fn(async (method: string, args: readonly unknown[]) => {
        if (method === "nvim_buf_get_option") return false;
        if (method === "nvim_command" && args[0] === "qa") {
          throw new Error("RPC transport closed during safe exit");
        }
        return true;
      }),
      close: vi.fn(),
    };
    const ui = { dispose: vi.fn() };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      50,
    );

    const closing = session.quit(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handle.kill).not.toHaveBeenCalled();
    expect(child.stdin.end).not.toHaveBeenCalled();

    child.exitCode = 0;
    child.emit("exit", 0, null);
    await expect(closing).resolves.toEqual({ closed: true });
    expect(rpc.request).toHaveBeenCalledWith("nvim_command", ["qa"], {
      timeoutMs: 50,
      signal: expect.any(AbortSignal),
    });
    expect(ui.dispose).toHaveBeenCalledTimes(1);
  });

  it("requires an all-buffer safe close before force teardown can begin", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ pid: syntheticNeovimPid(788) });
    const handle = {
      child,
      pid: syntheticNeovimPid(788),
      kill: vi.fn(),
    };
    const rpc = {
      request: vi.fn(async (method: string, args: readonly unknown[]) => {
        if (method === "nvim_buf_get_option") return false;
        if (method === "nvim_command" && args[0] === "qa") {
          throw new NeovimRpcError(
            "nvim_command",
            2,
            "E37: another buffer has unsaved changes",
          );
        }
        if (method === "nvim_command" && args[0] === "quit") return true;
        return true;
      }),
      close: vi.fn(),
    };
    const ui = { dispose: vi.fn() };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
    );

    await expect(session.quit(false)).resolves.toEqual({
      closed: false,
      reason:
        "Unsaved Neovim edits. Save or use force quit before closing BUFFER.",
      dirtyState: "dirty",
    });

    expect(rpc.request).toHaveBeenCalledWith("nvim_command", ["qa"], {
      timeoutMs: 5,
      signal: expect.any(AbortSignal),
    });
    expect(rpc.request).not.toHaveBeenCalledWith("nvim_command", ["quit"]);
    expect(rpc.request).not.toHaveBeenCalledWith("nvim_command", ["qa!"]);
    expect(rpc.close).not.toHaveBeenCalled();
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("forces a bounded supervised cleanup without awaiting a stuck quit RPC", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ pid: syntheticNeovimPid(787) });
    const handle = {
      child,
      pid: syntheticNeovimPid(787),
      kill: vi.fn(),
    };
    const neverReplies = controlled<unknown>();
    const rpc = {
      request: vi.fn(() => neverReplies.promise),
      close: vi.fn(),
    };
    const ui = { dispose: vi.fn() };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      ui as any,
      5,
    );

    const outcome = await Promise.race([
      session.quit(true),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 250),
      ),
    ]);

    expect(outcome).toEqual({ closed: true });
    expect(rpc.request).toHaveBeenCalledWith("nvim_command", ["qa!"]);
    expect(rpc.close).toHaveBeenCalledWith("session cleanup");
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(handle.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("maps embedded dirty notifications to boolean dirty state", () => {
    expect(dirtyFlagFromRpcNotificationParams([true])).toBe(true);
    expect(dirtyFlagFromRpcNotificationParams([false])).toBe(false);
    expect(dirtyFlagFromRpcNotificationParams(["true"])).toBe(false);
    expect(dirtyFlagFromRpcNotificationParams([])).toBe(false);
  });

  it("preflights every dirty buffer before Save All and writes by stable handle", async () => {
    const child = fakeChild({
      exitCode: 0,
      pid: syntheticNeovimPid(790),
    });
    const handle = {
      child,
      pid: syntheticNeovimPid(790),
      kill: vi.fn(),
    };
    let manifest = {
      active: 1,
      buffers: [
        rpcBuffer(1, "/workspace/a.txt", true, true),
        rpcBuffer(2, "", true, false),
      ],
    };
    const savedHandles: number[] = [];
    const rpc = {
      request: vi.fn(async (method: string, args: readonly any[]) => {
        if (method !== "nvim_exec_lua") return true;
        const source = String(args[0]);
        if (source.includes("buffer is no longer loaded")) {
          const target = Number(args[1]?.[0]);
          savedHandles.push(target);
          manifest = {
            ...manifest,
            buffers: manifest.buffers.map((buffer) =>
              buffer.handle === target
                ? { ...buffer, modified: false }
                : buffer,
            ),
          };
          return true;
        }
        if (source.includes("silent keepalt noautocmd edit!")) {
          manifest = {
            ...manifest,
            buffers: manifest.buffers.map((buffer) => ({
              ...buffer,
              modified: false,
            })),
          };
          return true;
        }
        return manifest;
      }),
      close: vi.fn(),
    };
    const session = new EmbeddedNeovimSession(
      handle as any,
      rpc as any,
      { dispose: vi.fn() } as any,
      10,
      20,
    );

    await expect(session.saveAll()).resolves.toMatchObject({
      saved: false,
      blockedBuffers: [expect.objectContaining({ handle: 2 })],
    });
    expect(savedHandles).toEqual([]);

    manifest = {
      active: 1,
      buffers: [
        rpcBuffer(1, "/workspace/a.txt", true, true),
        rpcBuffer(2, "/workspace/b.txt", true, false),
      ],
    };
    await expect(session.saveAll()).resolves.toMatchObject({ saved: true });
    expect(savedHandles).toEqual([1, 2]);
    await expect(session.inspectDirtyBuffers()).resolves.toEqual([]);

    manifest = {
      ...manifest,
      buffers: manifest.buffers.map((buffer) => ({
        ...buffer,
        modified: true,
      })),
    };
    await expect(session.discardAll()).resolves.toBe(true);
    await expect(session.inspectDirtyBuffers()).resolves.toEqual([]);
    await expect(session.saveBuffer(0)).rejects.toThrow(
      "Invalid Neovim buffer handle",
    );
  });

  it("normalizes authoritative buffer manifests from RPC values", () => {
    expect(
      bufferManifestFromRpcValue({
        active: 7,
        buffers: [
          rpcBuffer(7, "/workspace/current.txt", true, false),
          { handle: "invalid", modified: true },
        ],
      }),
    ).toEqual({
      activeBufferHandle: 7,
      buffers: [
        {
          handle: 7,
          changedtick: 70,
          endOfLine: true,
          name: "/workspace/current.txt",
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
    });
  });

  it("reports stderr from a child that exits during startup", async () => {
    const errors: string[] = [];

    await expect(
      startEmbeddedNeovim({
        executable: process.execPath,
        args: ["-e", "process.stderr.write('startup boom'); process.exit(1)"],
        filePath: join(dir, "target.txt"),
        line: 1,
        column: 0,
        size: { rows: 2, columns: 10 },
        onSnapshot: () => {},
        onError: (error) => {
          errors.push(error.message);
        },
        onExit: () => {},
      }),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toContain("startup boom");
  });

  it("aborts a hanging startup and tears down its supervised process group", async () => {
    const pidFile = join(dir, "aborted-startup.pid");
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const controller = new AbortController();
    const startup = startEmbeddedNeovim({
      executable: process.execPath,
      args: ["-e", script],
      filePath: join(dir, "target.txt"),
      line: 1,
      column: 0,
      size: { rows: 2, columns: 10 },
      signal: controller.signal,
      startupTimeoutMs: 5000,
      cleanupTimeoutMs: 20,
      onSnapshot: () => {},
      onError: () => {},
      onExit: () => {},
    });
    const pid = await waitForPidFile(pidFile);

    controller.abort(new Error("startup superseded"));

    await expect(startup).rejects.toThrow("startup superseded");
    await waitUntilDead(pid);
    expect(isProcessAlive(pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });

  it("bounds a hanging startup with a timeout and tears down its process group", async () => {
    const pidFile = join(dir, "timed-out-startup.pid");
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const startup = startEmbeddedNeovim({
      executable: process.execPath,
      args: ["-e", script],
      filePath: join(dir, "target.txt"),
      line: 1,
      column: 0,
      size: { rows: 2, columns: 10 },
      startupTimeoutMs: 1000,
      cleanupTimeoutMs: 20,
      onSnapshot: () => {},
      onError: () => {},
      onExit: () => {},
    });
    const pid = await waitForPidFile(pidFile);

    await expect(startup).rejects.toThrow(
      "Embedded Neovim startup timed out after 1000ms",
    );
    await waitUntilDead(pid);
    expect(isProcessAlive(pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });

  it("releases the containment owner when the target executable cannot start", async () => {
    const trackedBefore = getTrackedNeovimProcessCountForTesting();
    const handle = spawnNeovimProcess({
      executable: join(dir, "guaranteed-missing-neovim"),
      args: [],
      cwd: dir,
    });
    const outcome = new Promise<"error" | "close">((resolve) => {
      handle.child.once("error", () => resolve("error"));
      handle.child.once("close", () => resolve("close"));
    });

    // Direct spawn reports ENOENT through `error`; the Linux cgroup and
    // Windows Job Object brokers report the target failure by exiting. Both
    // forms must release the ownership boundary without leaking a tracked
    // process.
    await expect(outcome).resolves.toMatch(/^(error|close)$/u);
    await expect(waitForNeovimExit(handle.child, 100)).resolves.toBeUndefined();
    expect(getTrackedNeovimProcessCountForTesting()).toBe(trackedBefore);
  });

  it("kills a live child when startup setup rejects after spawn", async () => {
    const frame = Buffer.from(encode([1, 1, "attach failed", null])).toString(
      "base64",
    );
    const pidFile = join(dir, "child.pid");
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `process.stdout.write(Buffer.from("${frame}", "base64"));`,
      "setInterval(() => {}, 1000);",
    ].join("");

    await expect(
      startEmbeddedNeovim({
        executable: process.execPath,
        args: ["-e", script],
        filePath: join(dir, "target.txt"),
        line: 1,
        column: 0,
        size: { rows: 2, columns: 10 },
        cleanupTimeoutMs: 20,
        onSnapshot: () => {},
        onError: () => {},
        onExit: () => {},
      }),
    ).rejects.toThrow("attach failed");

    const pid = Number(await readFile(pidFile, "utf8"));
    await waitUntilDead(pid);
    expect(isProcessAlive(pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });

  it("preserves retryable cleanup ownership in its typed startup error", async () => {
    const retryCleanup = vi.fn(async () => {});
    const failure = new NeovimStartupCleanupError(
      new NeovimRpcError("attach failed"),
      new Error("Neovim process did not exit after SIGKILL"),
      retryCleanup,
    );

    expect(failure).toMatchObject({
      message: expect.stringContaining("Neovim startup cleanup failed"),
    });
    expect(failure.errors).toHaveLength(2);
    expect(String(failure.errors[0])).toContain("attach failed");
    expect(String(failure.errors[1])).toContain("did not exit after SIGKILL");

    await Promise.all([failure.retryCleanup(), failure.retryCleanup()]);
    await failure.retryCleanup();
    expect(retryCleanup).toHaveBeenCalledTimes(1);
  });

  it("kills a supervised child process group during cleanup", async () => {
    const handle = spawnNeovimProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
    });

    handle.kill("SIGTERM");
    await waitForNeovimExit(handle.child, 500);

    expect(isProcessAlive(handle.pid)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "cleans tracked descendants when a detached Neovim leader exits",
    async () => {
      const descendantPidFile = join(dir, "descendant.pid");
      const descendantScript = "setInterval(() => {}, 1000)";
      const leaderScript = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
        "child.unref();",
      ].join("");
      const handle = spawnNeovimProcess({
        executable: process.execPath,
        args: ["-e", leaderScript],
        cwd: dir,
      });

      let descendantPid = 0;
      try {
        await waitForNeovimExit(handle.child, 500);
        descendantPid = Number(await readFile(descendantPidFile, "utf8"));

        cleanupTrackedNeovimProcesses("SIGKILL");
        await waitUntilDead(descendantPid);

        expect(isProcessAlive(descendantPid)).toBe(false);
        expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
      } finally {
        try {
          process.kill(-handle.pid, "SIGKILL");
        } catch {
          // The process group is already gone after successful cleanup.
        }
      }
    },
  );

  it("parent cleanup kills tracked Neovim children when graceful paths are unavailable", async () => {
    const handle = spawnNeovimProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      cwd: dir,
    });

    expect(getTrackedNeovimProcessCountForTesting()).toBeGreaterThan(0);
    cleanupTrackedNeovimProcesses("SIGTERM");
    await waitForNeovimExit(handle.child, 500);

    expect(isProcessAlive(handle.pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });

  it("runs the registered process-exit cleanup path for tracked children", async () => {
    const handle = spawnNeovimProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      cwd: dir,
    });

    expect(getTrackedNeovimProcessCountForTesting()).toBeGreaterThan(0);
    runTrackedNeovimProcessExitCleanupForTesting();
    await waitForNeovimExit(handle.child, 500);

    expect(isProcessAlive(handle.pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });

  it("honors direct SIGKILL cleanup without a second graceful pass", async () => {
    const handle = spawnNeovimProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
    });

    expect(getTrackedNeovimProcessCountForTesting()).toBeGreaterThan(0);
    cleanupTrackedNeovimProcesses("SIGKILL");
    await waitForNeovimExit(handle.child, 500);

    expect(isProcessAlive(handle.pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });
});

function bufferManifest(modified: boolean) {
  return {
    active: 1,
    buffers: [
      {
        handle: 1,
        changedtick: 1,
        end_of_line: true,
        name: "/workspace/target.txt",
        listed: true,
        loaded: true,
        modified,
        current: true,
        buffer_type: "",
        modifiable: true,
        read_only: false,
        saveable: true,
      },
    ],
  };
}

function rpcBuffer(
  handle: number,
  name: string,
  modified: boolean,
  current: boolean,
) {
  return {
    handle,
    changedtick: handle * 10,
    end_of_line: true,
    name,
    listed: true,
    loaded: true,
    modified,
    current,
    buffer_type: "",
    modifiable: true,
    read_only: false,
    saveable: name.length > 0,
  };
}

/**
 * Keep mocked process roots outside every supported native PID range.
 *
 * Low fixed PIDs can belong to a concurrently running Vitest worker. The
 * production teardown intentionally inspects the native process table, so a
 * collision would make an already-exited fake appear to own that real worker.
 */
function syntheticNeovimPid(suffix: number): number {
  return 2_000_000_000 + suffix;
}

function fakeChild(options: {
  readonly killed?: boolean;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}) {
  const child = new EventEmitter() as any;
  child.killed = options.killed ?? false;
  child.pid = options.pid;
  child.exitCode = options.exitCode ?? null;
  child.signalCode = options.signalCode ?? null;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killed = true;
    child.signalCode = signal ?? "SIGTERM";
    child.emit("exit");
    return true;
  });
  child.stdin = {
    end: vi.fn(),
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function controlled<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createDeadlineRpcHarness() {
  type RequestOptions = {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  };
  type Pending = {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly cleanup: () => void;
  };

  let closed = false;
  let nextRequestId = 1;
  let maximumPending = 0;
  const pending = new Map<number, Pending>();
  const request = vi.fn(
    (
      method: string,
      _args: readonly unknown[] = [],
      options: RequestOptions = {},
    ): Promise<unknown> => {
      if (closed) return Promise.reject(new Error("closed"));
      const requestId = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const onAbort = (): void => {
          const active = pending.get(requestId);
          if (!active) return;
          pending.delete(requestId);
          active.cleanup();
          reject(new Error(`${method} aborted`));
        };
        const cleanup = (): void => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        };
        pending.set(requestId, { resolve, reject, cleanup });
        maximumPending = Math.max(maximumPending, pending.size);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        if (options.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            const active = pending.get(requestId);
            if (!active) return;
            pending.delete(requestId);
            active.cleanup();
            reject(
              new NeovimRpcRequestTimeoutError(
                method,
                requestId,
                options.timeoutMs!,
              ),
            );
          }, options.timeoutMs);
        }
      });
    },
  );
  const close = vi.fn((reason = "closed") => {
    if (closed) return;
    closed = true;
    for (const [requestId, active] of pending) {
      pending.delete(requestId);
      active.cleanup();
      active.reject(new Error(reason));
    }
  });

  return {
    request,
    close,
    pendingCount: () => pending.size,
    maxPendingCount: () => maximumPending,
    reply: (requestId: number, value: unknown): boolean => {
      const active = pending.get(requestId);
      if (!active) return false;
      pending.delete(requestId);
      active.cleanup();
      active.resolve(value);
      return true;
    },
  };
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pid = Number(await readFile(path, "utf8").catch(() => "0"));
    if (pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for pid file ${path}`);
}

function mockMissingProcessGroups(): void {
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (pid < 0) {
      throw Object.assign(new Error(`process group ${-pid} does not exist`), {
        code: "ESRCH",
      });
    }
    return true;
  });
}
