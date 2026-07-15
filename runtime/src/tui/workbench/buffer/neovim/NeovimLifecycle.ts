import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { getCwd } from "../../../../utils/cwd.js";
import { NeovimUi, type NeovimUiSize } from "./NeovimUi.js";
import { spawnNeovimProcess, waitForNeovimExit, type NeovimProcessHandle } from "./NeovimProcess.js";
import { NeovimRpcError, NeovimRpcTransport, type RpcValue } from "./NeovimRpc.js";
import type { NeovimRenderSnapshot } from "./NeovimGrid.js";

export type StartEmbeddedNeovimOptions = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly size: NeovimUiSize;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly onSnapshot: (snapshot: NeovimRenderSnapshot) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onError: (error: Error) => void;
  readonly onExit: () => void;
};

export type NeovimCloseResult =
  | { readonly closed: true }
  | { readonly closed: false; readonly reason: string };

const DEFAULT_CLEANUP_TIMEOUT_MS = 1000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DIRTY_CLOSE_REASON = "Unsaved Neovim edits. Save or use force quit before closing BUFFER.";
const DIRTY_STATE_UNAVAILABLE_CLOSE_REASON =
  "Unable to verify whether Neovim has unsaved edits. Retry or use force quit before closing BUFFER.";
const SAFE_CLOSE_UNCONFIRMED_REASON =
  "Embedded Neovim did not confirm a safe close. Retry or use force quit before closing BUFFER.";
const ALL_BUFFER_DIRTY_PROBE = [
  "for _, buffer in ipairs(vim.api.nvim_list_bufs()) do",
  "  if vim.api.nvim_buf_is_loaded(buffer) and vim.api.nvim_get_option_value('modified', { buf = buffer }) then",
  "    return true",
  "  end",
  "end",
  "return false",
].join("\n");

class NeovimOperationTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms.`);
    this.name = "NeovimOperationTimeoutError";
  }
}

export class NeovimStartupCleanupError extends AggregateError {
  readonly #retryCleanupOperation: () => Promise<void>;
  #cleanupComplete = false;
  #cleanupPromise: Promise<void> | null = null;

  constructor(
    startupError: unknown,
    cleanupError: unknown,
    retryCleanupOperation: () => Promise<void>,
  ) {
    const startupMessage = errorMessage(startupError);
    const cleanupMessage = errorMessage(cleanupError);
    super(
      [startupError, cleanupError],
      `${startupMessage}; Neovim startup cleanup failed: ${cleanupMessage}`,
    );
    this.name = "NeovimStartupCleanupError";
    this.#retryCleanupOperation = retryCleanupOperation;
  }

  async retryCleanup(): Promise<void> {
    if (this.#cleanupComplete) return;
    if (this.#cleanupPromise) return this.#cleanupPromise;
    const attempt = this.#retryCleanupOperation();
    this.#cleanupPromise = attempt;
    try {
      await attempt;
      this.#cleanupComplete = true;
    } finally {
      if (this.#cleanupPromise === attempt) this.#cleanupPromise = null;
    }
  }
}

export class EmbeddedNeovimSession {
  readonly #handle: NeovimProcessHandle;
  readonly #rpc: NeovimRpcTransport;
  readonly #ui: NeovimUi;
  readonly #cleanupTimeoutMs: number;
  #closed = false;
  #cleanupComplete = false;
  #cleanupPromise: Promise<void> | null = null;
  #quitPromise: Promise<NeovimCloseResult> | null = null;

  constructor(
    handle: NeovimProcessHandle,
    rpc: NeovimRpcTransport,
    ui: NeovimUi,
    cleanupTimeoutMs: number,
  ) {
    this.#handle = handle;
    this.#rpc = rpc;
    this.#ui = ui;
    this.#cleanupTimeoutMs = cleanupTimeoutMs;
  }

  get pid(): number {
    return this.#handle.pid;
  }

  async input(keys: string): Promise<boolean> {
    if (this.#closed || keys.length === 0) return false;
    await this.#rpc.request("nvim_input", [keys]);
    return true;
  }

  async paste(text: string): Promise<void> {
    if (this.#closed || text.length === 0) return;
    await this.#rpc.request("nvim_paste", [text, true, -1]);
  }

  async resize(size: NeovimUiSize): Promise<void> {
    if (this.#closed) return;
    await this.#ui.resize(size);
  }

  async focus(focused: boolean): Promise<void> {
    if (this.#closed) return;
    await this.#rpc.request("nvim_ui_set_focus", [focused]);
  }

  async click(row: number, column: number): Promise<void> {
    if (this.#closed) return;
    const safeRow = Math.max(0, Math.floor(row));
    const safeColumn = Math.max(0, Math.floor(column));
    await this.#rpc.request("nvim_input_mouse", ["left", "press", "", 0, safeRow, safeColumn]);
    await this.#rpc.request("nvim_input_mouse", ["left", "release", "", 0, safeRow, safeColumn]);
  }

  async save(force: boolean): Promise<boolean> {
    if (this.#closed) return false;
    await this.#rpc.request("nvim_command", [force ? "write!" : "write"]);
    return true;
  }

  async isDirty(): Promise<boolean> {
    if (this.#closed) {
      if (childHasExited(this.#handle.child)) return false;
      throw new Error("Embedded Neovim is still exiting; its dirty state is unavailable.");
    }
    try {
      const value = await settleWithin(
        this.#rpc.request("nvim_buf_get_option", [0, "modified"]),
        this.#cleanupTimeoutMs,
        "Embedded Neovim dirty-state probe",
      );
      return value === true;
    } catch (error) {
      // Once the child has exited there is no live buffer left to preserve. A
      // transport failure while it is still alive remains unknown and must fail
      // closed at handoff/close call sites.
      if (childHasExited(this.#handle.child)) return false;
      throw error;
    }
  }

  async hasUnsavedBuffers(): Promise<boolean> {
    if (this.#closed) {
      if (childHasExited(this.#handle.child)) return false;
      throw new Error("Embedded Neovim is still exiting; its dirty state is unavailable.");
    }
    try {
      const value = await settleWithin(
        this.#rpc.request("nvim_exec_lua", [ALL_BUFFER_DIRTY_PROBE, []]),
        this.#cleanupTimeoutMs,
        "Embedded Neovim all-buffer dirty-state probe",
      );
      return value === true;
    } catch (error) {
      if (childHasExited(this.#handle.child)) return false;
      throw error;
    }
  }

  async quit(discard: boolean): Promise<NeovimCloseResult> {
    if (this.#closed) {
      await this.cleanup();
      return { closed: true };
    }
    if (this.#quitPromise) {
      const result = await this.#quitPromise;
      if (!result.closed && discard) return this.quit(true);
      return result;
    }
    this.#quitPromise = this.#quitWithDirtyCheck(discard).finally(() => {
      if (!this.#closed) this.#quitPromise = null;
    });
    return this.#quitPromise;
  }

  async #quitWithDirtyCheck(discard: boolean): Promise<NeovimCloseResult> {
    if (!discard) {
      let dirty: boolean;
      try {
        dirty = await this.isDirty();
      } catch {
        return { closed: false, reason: DIRTY_STATE_UNAVAILABLE_CLOSE_REASON };
      }
      if (dirty) return { closed: false, reason: DIRTY_CLOSE_REASON };
    }
    return this.#quitOnce(discard);
  }

  async #quitOnce(discard: boolean): Promise<NeovimCloseResult> {
    if (discard) {
      await this.cleanup();
      return { closed: true };
    }
    try {
      await settleWithin(
        this.#rpc.request("nvim_command", ["qa"]),
        this.#cleanupTimeoutMs,
        "Embedded Neovim safe close",
      );
    } catch (error) {
      // A clean-check and :qa are not atomic: edits can arrive between them.
      // Neovim rejects the all-buffer close in that race. Preserve every live
      // buffer instead of falling through to cleanup(), whose final qa!
      // intentionally discards.
      if (error instanceof NeovimOperationTimeoutError) {
        return { closed: false, reason: SAFE_CLOSE_UNCONFIRMED_REASON };
      }
      if (error instanceof NeovimRpcError) {
        return { closed: false, reason: DIRTY_CLOSE_REASON };
      }
      if (
        !childHasExited(this.#handle.child) &&
        !await waitForObservedExit(this.#handle.child, this.#cleanupTimeoutMs)
      ) {
        return {
          closed: false,
          reason: SAFE_CLOSE_UNCONFIRMED_REASON,
        };
      }
    }
    await this.cleanup();
    return { closed: true };
  }

  async cleanup(): Promise<void> {
    if (this.#cleanupComplete) return;
    if (this.#cleanupPromise) return this.#cleanupPromise;
    const attempt = this.#cleanupOnce();
    this.#cleanupPromise = attempt;
    try {
      await attempt;
      this.#cleanupComplete = true;
    } finally {
      if (this.#cleanupPromise === attempt) this.#cleanupPromise = null;
    }
  }

  async #cleanupOnce(): Promise<void> {
    this.#closed = true;
    this.#ui.dispose();
    // The force-quit request is best effort. Ending stdin immediately after the
    // queued frame preserves stream ordering while ensuring an unresponsive RPC
    // cannot postpone the supervised exit/SIGKILL deadline.
    void this.#rpc.request("nvim_command", ["qa!"]).catch(() => null);
    if (!this.#handle.child.stdin.writableEnded) this.#handle.child.stdin.end();
    try {
      await waitForNeovimExit(this.#handle.child, this.#cleanupTimeoutMs);
    } finally {
      this.#rpc.close("session cleanup");
      this.#handle.kill("SIGKILL");
    }
  }
}

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForObservedExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  const safeTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : DEFAULT_CLEANUP_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), safeTimeoutMs);
    timer.unref();
    child.once("exit", onExit);
    // The child can exit between the optimistic check above and listener
    // installation. Re-read its terminal state so that edge cannot turn a
    // confirmed safe close into a false timeout.
    if (childHasExited(child)) finish(true);
  });
}

export async function startEmbeddedNeovim(
  options: StartEmbeddedNeovimOptions,
): Promise<EmbeddedNeovimSession> {
  const startupAbort = createStartupAbort(
    options.signal,
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
  );
  try {
    startupAbort.signal.throwIfAborted();
    const handle = spawnNeovimProcess({
      executable: options.executable,
      args: options.args,
      cwd: options.cwd ?? getCwd(),
    });
    const rpc = new NeovimRpcTransport(handle.child.stdout, handle.child.stdin);
    const ui = new NeovimUi(rpc, options.size, options.onSnapshot);
    wireProcessErrors(handle.child, rpc, options.onError, options.onExit);
    if (options.onDirtyChange) {
      rpc.onNotification("agenc_buffer_dirty_changed", (params) => {
        options.onDirtyChange?.(dirtyFlagFromRpcNotificationParams(params));
      });
    }
    rpc.onError(options.onError);
    rpc.start();
    const abortStartup = (): void => {
      rpc.close("startup aborted");
    };
    startupAbort.signal.addEventListener("abort", abortStartup, { once: true });
    try {
      try {
        await ui.attach();
        await editFile(rpc, options.filePath, options.line, options.column);
        await configureEmbeddedEditing(rpc);
        await installDirtyAutocmds(rpc);
        startupAbort.signal.throwIfAborted();
      } catch (error) {
        const startupError = startupAbort.signal.aborted
          ? startupAbortReason(startupAbort.signal, error)
          : error;
        ui.dispose();
        rpc.close("startup failed");
        handle.child.stdin.end();
        let cleanupError: unknown;
        try {
          await waitForNeovimExit(
            handle.child,
            options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
          );
        } catch (waitError) {
          cleanupError = waitError;
        } finally {
          handle.kill("SIGKILL");
        }
        if (cleanupError !== undefined) {
          throw new NeovimStartupCleanupError(
            startupError,
            cleanupError,
            async () => {
              ui.dispose();
              rpc.close("startup cleanup retry");
              if (!handle.child.stdin.writableEnded) handle.child.stdin.end();
              try {
                await waitForNeovimExit(
                  handle.child,
                  options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
                );
              } finally {
                handle.kill("SIGKILL");
              }
            },
          );
        }
        throw startupError;
      }
      return new EmbeddedNeovimSession(
        handle,
        rpc,
        ui,
        options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      );
    } finally {
      startupAbort.signal.removeEventListener("abort", abortStartup);
    }
  } finally {
    startupAbort.dispose();
  }
}

function createStartupAbort(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const safeTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : DEFAULT_STARTUP_TIMEOUT_MS;
  const timer = setTimeout(() => {
    controller.abort(new Error(`Embedded Neovim startup timed out after ${safeTimeoutMs}ms.`));
  }, safeTimeoutMs);
  timer.unref();

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function startupAbortReason(signal: AbortSignal, fallback: unknown): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (signal.reason !== undefined) return new Error(String(signal.reason), { cause: fallback });
  return new Error("Embedded Neovim startup was aborted.", { cause: fallback });
}

function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  const safeTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : DEFAULT_CLEANUP_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new NeovimOperationTimeoutError(operationName, safeTimeoutMs));
    }, safeTimeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function editFile(
  rpc: NeovimRpcTransport,
  filePath: string,
  line: number,
  column: number,
): Promise<void> {
  const escaped = await rpc.request("nvim_call_function", ["fnameescape", [filePath]]);
  await rpc.request("nvim_command", [`edit ${stringValue(escaped)}`]);
  await rpc.request("nvim_win_set_cursor", [0, [Math.max(1, line), Math.max(0, column)]]);
}

async function configureEmbeddedEditing(rpc: NeovimRpcTransport): Promise<void> {
  for (const command of [
    "set termguicolors",
    "syntax enable",
    "filetype plugin indent on",
  ]) {
    await rpc.request("nvim_command", [command]);
  }
}

async function installDirtyAutocmds(rpc: NeovimRpcTransport): Promise<void> {
  await rpc.request("nvim_command", ["augroup AgenCBufferDirtyState"]);
  await rpc.request("nvim_command", ["autocmd!"]);
  await rpc.request("nvim_command", [
    "autocmd TextChanged,TextChangedI,TextChangedP,BufWritePost,FileChangedShellPost * call rpcnotify(0, 'agenc_buffer_dirty_changed', &modified)",
  ]);
  await rpc.request("nvim_command", ["augroup END"]);
  await rpc.request("nvim_command", ["call rpcnotify(0, 'agenc_buffer_dirty_changed', &modified)"]);
}

export function dirtyFlagFromRpcNotificationParams(params: readonly RpcValue[]): boolean {
  return params[0] === true;
}

function wireProcessErrors(
  child: ChildProcessWithoutNullStreams,
  rpc: NeovimRpcTransport,
  onError: (error: Error) => void,
  onExit: () => void,
): void {
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
  });
  child.on("error", onError);
  child.on("exit", (code, signal) => {
    rpc.close(`process exited ${signal ?? code}`);
    if (code !== 0 && signal === null && stderr.trim().length > 0) {
      onError(new Error(stderr.trim()));
    }
    onExit();
  });
}

function stringValue(value: RpcValue): string {
  return String(value);
}
