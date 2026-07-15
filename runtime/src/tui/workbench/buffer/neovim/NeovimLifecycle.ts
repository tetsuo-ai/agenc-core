import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { getCwd } from "../../../../utils/cwd.js";
import { NeovimUi, type NeovimUiSize } from "./NeovimUi.js";
import { spawnNeovimProcess, waitForNeovimExit, type NeovimProcessHandle } from "./NeovimProcess.js";
import { NeovimRpcTransport, type RpcValue } from "./NeovimRpc.js";
import type { NeovimRenderSnapshot } from "./NeovimGrid.js";

export type StartEmbeddedNeovimOptions = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly size: NeovimUiSize;
  readonly cwd?: string;
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
const DIRTY_CLOSE_REASON = "Unsaved Neovim edits. Save or use force quit before closing BUFFER.";

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

  async input(keys: string): Promise<void> {
    if (this.#closed || keys.length === 0) return;
    await this.#rpc.request("nvim_input", [keys]);
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
    if (this.#closed) return false;
    // The transport can close independently of the session (stdin EPIPE before
    // the child's exit); during that window this request rejects. The quit/close
    // path awaits isDirty() (BufferSurface's void-invoked :q/:wq and buffer:close
    // handlers), so an uncaught rejection here escapes as an unhandled rejection.
    // Treat an unreachable Neovim as not-dirty — mirrors #readCurrentDirtyState's
    // then(ok, fallback). There is nothing to save once the transport is gone.
    const value = await this.#rpc
      .request("nvim_buf_get_option", [0, "modified"])
      .catch(() => false);
    return value === true;
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
    if (!discard && await this.isDirty()) {
      return { closed: false, reason: DIRTY_CLOSE_REASON };
    }
    return this.#quitOnce(discard);
  }

  async #quitOnce(discard: boolean): Promise<NeovimCloseResult> {
    try {
      await this.#rpc.request("nvim_command", [discard ? "quit!" : "quit"]);
    } catch {
      // A clean-check and :quit are not atomic: edits can arrive between them.
      // Neovim rejects :quit in that race. Preserve the live buffer instead of
      // falling through to cleanup(), whose final qa! intentionally discards.
      if (!discard && !childHasExited(this.#handle.child)) {
        return { closed: false, reason: DIRTY_CLOSE_REASON };
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
    await this.#rpc.request("nvim_command", ["qa!"]).catch(() => null);
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

export async function startEmbeddedNeovim(
  options: StartEmbeddedNeovimOptions,
): Promise<EmbeddedNeovimSession> {
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
  try {
    await ui.attach();
    await editFile(rpc, options.filePath, options.line, options.column);
    await configureEmbeddedEditing(rpc);
    await installDirtyAutocmds(rpc);
  } catch (error) {
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
      const primaryMessage = error instanceof Error ? error.message : String(error);
      const cleanupMessage = cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
      throw new AggregateError(
        [error, cleanupError],
        `${primaryMessage}; Neovim startup cleanup failed: ${cleanupMessage}`,
      );
    }
    throw error;
  }
  return new EmbeddedNeovimSession(
    handle,
    rpc,
    ui,
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
  );
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
