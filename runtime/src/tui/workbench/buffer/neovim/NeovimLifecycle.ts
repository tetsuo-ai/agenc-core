import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { getCwd } from "../../../../utils/cwd.js";
import { NeovimUi, type NeovimUiSize } from "./NeovimUi.js";
import {
  captureNeovimProcessDescendants,
  spawnNeovimProcess,
  waitForNeovimExit,
  type NeovimProcessHandle,
} from "./NeovimProcess.js";
import {
  NeovimRpcError,
  NeovimRpcRequestTimeoutError,
  NeovimRpcTransport,
  type RpcParams,
  type RpcValue,
} from "./NeovimRpc.js";
import type { NeovimRenderSnapshot } from "./NeovimGrid.js";
import type {
  BufferCaptureRequest,
  BufferCapturedContext,
  BufferIntegrationIntent,
} from "../providers/types.js";

export type StartEmbeddedNeovimOptions = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly size: NeovimUiSize;
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly agencHome?: string;
  readonly beforeOpenFile?: (
    context: EmbeddedNeovimStartupContext,
  ) => Promise<EmbeddedNeovimStartupPreparation | void>;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  /** Force the deterministic broker boundary in Linux containment tests. */
  readonly linuxContainment?: "auto" | "subreaper";
  readonly onSnapshot: (snapshot: NeovimRenderSnapshot) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onWorkspaceChange?: () => void;
  readonly onIntegrationIntent?: (intent: BufferIntegrationIntent) => void;
  readonly onRecoveryDetected?: (recovery: {
    readonly swapFile: string;
    readonly filePath: string;
  }) => void;
  readonly onFatalError?: (error: Error) => void;
  readonly onError: (error: Error) => void;
  readonly onExit: (exit: NeovimExitInfo) => void;
};

export type EmbeddedNeovimStartupContext = {
  readonly workspaceRoot: string;
  readonly agencHome?: string;
  readonly command: (command: string) => Promise<void>;
  readonly execLua: (source: string, args?: readonly RpcValue[]) => Promise<RpcValue>;
};

export type EmbeddedNeovimRecoveryInfo = {
  readonly root: string;
  readonly swap: string;
  readonly undo: string;
  readonly copies: string;
  readonly shada: string;
  readonly manifest: string;
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
  readonly swapFiles: readonly string[];
};

export type EmbeddedNeovimStartupPreparation = {
  readonly recovery?: EmbeddedNeovimRecoveryInfo;
};

export type NeovimExitInfo = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
};

export type EmbeddedNeovimBuffer = {
  readonly handle: number;
  readonly changedtick: number | null;
  readonly name: string;
  readonly listed: boolean;
  readonly loaded: boolean;
  readonly modified: boolean;
  readonly current: boolean;
  readonly bufferType: string;
  readonly modifiable: boolean;
  readonly readOnly: boolean;
  readonly saveable: boolean;
};

export type EmbeddedNeovimBufferManifest = {
  readonly activeBufferHandle: number | null;
  readonly buffers: readonly EmbeddedNeovimBuffer[];
};

export type EmbeddedNeovimSaveAllResult =
  | {
      readonly saved: true;
      readonly buffers: readonly EmbeddedNeovimBuffer[];
    }
  | {
      readonly saved: false;
      readonly reason: string;
      readonly blockedBuffers: readonly EmbeddedNeovimBuffer[];
    };

export type EmbeddedNeovimBufferRename = {
  readonly handle: number;
  readonly fromPath: string;
  readonly toPath: string;
};

export type EmbeddedNeovimBufferDelete = {
  readonly handle: number;
  readonly path: string;
};

export type NeovimCloseResult =
  | { readonly closed: true }
  | {
      readonly closed: false;
      readonly reason: string;
      readonly dirtyState?: "dirty" | "unknown";
    };

const DEFAULT_CLEANUP_TIMEOUT_MS = 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DIRTY_CLOSE_REASON = "Unsaved Neovim edits. Save or use force quit before closing BUFFER.";
const DIRTY_STATE_UNAVAILABLE_CLOSE_REASON =
  "Unable to verify whether Neovim has unsaved edits. Retry or use force quit before closing BUFFER.";
const SAFE_CLOSE_UNCONFIRMED_REASON =
  "Embedded Neovim did not confirm a safe close. Retry or use force quit before closing BUFFER.";
const BUFFER_MANIFEST_PROBE = [
  "local current = vim.api.nvim_get_current_buf()",
  "local buffers = {}",
  "for _, buffer in ipairs(vim.api.nvim_list_bufs()) do",
  "  local loaded = vim.api.nvim_buf_is_loaded(buffer)",
  "  if loaded then",
  "    local name = vim.api.nvim_buf_get_name(buffer)",
  "    local modified = vim.api.nvim_get_option_value('modified', { buf = buffer })",
  "    local listed = vim.api.nvim_get_option_value('buflisted', { buf = buffer })",
  "    local buffer_type = vim.api.nvim_get_option_value('buftype', { buf = buffer })",
  "    local modifiable = vim.api.nvim_get_option_value('modifiable', { buf = buffer })",
  "    local read_only = vim.api.nvim_get_option_value('readonly', { buf = buffer })",
  "    table.insert(buffers, {",
  "      handle = buffer,",
  "      changedtick = vim.api.nvim_buf_get_changedtick(buffer),",
  "      name = name,",
  "      listed = listed,",
  "      loaded = loaded,",
  "      modified = modified,",
  "      current = buffer == current,",
  "      buffer_type = buffer_type,",
  "      modifiable = modifiable,",
  "      read_only = read_only,",
  "      saveable = name ~= '' and buffer_type == '' and modifiable,",
  "    })",
  "  end",
  "end",
  "return { active = current, buffers = buffers }",
].join("\n");

const SAVE_BUFFER = [
  "local buffer, force, expected_changedtick = ...",
  "if not vim.api.nvim_buf_is_valid(buffer) or not vim.api.nvim_buf_is_loaded(buffer) then",
  "  error('buffer is no longer loaded: ' .. tostring(buffer))",
  "end",
  "if expected_changedtick ~= nil",
  "    and vim.api.nvim_buf_get_changedtick(buffer) ~= expected_changedtick then",
  "  error('buffer changed before write: ' .. tostring(buffer))",
  "end",
  "vim.api.nvim_buf_call(buffer, function()",
  "  vim.cmd(force and 'write!' or 'write')",
  "end)",
  "return true",
].join("\n");

const DISCARD_ALL_BUFFERS = [
  "local expected = ...",
  "local dirty = {}",
  "for _, buffer in ipairs(vim.api.nvim_list_bufs()) do",
  "  if vim.api.nvim_buf_is_valid(buffer) and vim.api.nvim_buf_is_loaded(buffer)",
  "      and vim.api.nvim_get_option_value('modified', { buf = buffer }) then",
  "    table.insert(dirty, {",
  "      handle = buffer,",
  "      name = vim.api.nvim_buf_get_name(buffer),",
  "      changedtick = vim.api.nvim_buf_get_changedtick(buffer),",
  "    })",
  "  end",
  "end",
  "if #dirty ~= #expected then return false end",
  "local expected_by_handle = {}",
  "for _, item in ipairs(expected) do expected_by_handle[item.handle] = item end",
  "for _, item in ipairs(dirty) do",
  "  local frozen = expected_by_handle[item.handle]",
  "  if frozen == nil or frozen.name ~= item.name",
  "      or frozen.changedtick ~= item.changedtick then",
  "    return false",
  "  end",
  "end",
  "for _, item in ipairs(expected) do",
  "  local buffer = item.handle",
  "  if not vim.api.nvim_buf_is_valid(buffer) or not vim.api.nvim_buf_is_loaded(buffer) then",
  "    return false",
  "  end",
  "  local name = vim.api.nvim_buf_get_name(buffer)",
  "  local buffer_type = vim.api.nvim_get_option_value('buftype', { buf = buffer })",
  "  if name ~= '' and buffer_type == '' then",
      "      vim.api.nvim_buf_call(buffer, function() vim.cmd('silent keepalt noautocmd edit!') end)",
  "  else",
  "    vim.api.nvim_buf_call(buffer, function()",
  "      vim.cmd('silent noautocmd %delete _')",
  "      vim.api.nvim_set_option_value('modified', false, { buf = buffer })",
  "    end)",
  "  end",
  "end",
  "return true",
].join("\n");

const REBASE_FILE_BUFFERS = [
  "local changes = ...",
  "local moving = {}",
  "local targets = {}",
  "for _, change in ipairs(changes) do",
  "  local buffer = change.handle",
  "  if not vim.api.nvim_buf_is_valid(buffer) or not vim.api.nvim_buf_is_loaded(buffer) then",
  "    error('cannot rebase unloaded buffer ' .. tostring(buffer))",
  "  end",
  "  if vim.api.nvim_get_option_value('buftype', { buf = buffer }) ~= '' then",
  "    error('cannot rebase non-file buffer ' .. tostring(buffer))",
  "  end",
  "  if vim.api.nvim_get_option_value('modified', { buf = buffer }) then",
  "    error('cannot rebase modified buffer ' .. tostring(buffer))",
  "  end",
  "  local actual = vim.api.nvim_buf_get_name(buffer)",
  "  if actual ~= change.from_path then",
  "    error('buffer ' .. tostring(buffer) .. ' moved before rename synchronization: ' .. actual)",
  "  end",
  "  if targets[change.to_path] ~= nil then",
  "    error('multiple buffers would be rebased to ' .. change.to_path)",
  "  end",
  "  moving[buffer] = true",
  "  targets[change.to_path] = buffer",
  "end",
  "for _, buffer in ipairs(vim.api.nvim_list_bufs()) do",
  "  if vim.api.nvim_buf_is_valid(buffer) and vim.api.nvim_buf_is_loaded(buffer) and not moving[buffer] then",
  "    local name = vim.api.nvim_buf_get_name(buffer)",
  "    if name ~= '' and targets[name] ~= nil then",
  "      error('rename target is already loaded in buffer ' .. tostring(buffer) .. ': ' .. name)",
  "    end",
  "  end",
  "end",
  "local completed = {}",
  "for _, change in ipairs(changes) do",
  "  local ok, failure = pcall(vim.api.nvim_buf_set_name, change.handle, change.to_path)",
  "  if not ok then",
  "    for index = #completed, 1, -1 do",
  "      local rollback = completed[index]",
  "      pcall(vim.api.nvim_buf_set_name, rollback.handle, rollback.from_path)",
  "    end",
  "    error('failed to rebase buffer ' .. tostring(change.handle) .. ': ' .. tostring(failure))",
  "  end",
  "  table.insert(completed, change)",
  "end",
  "return true",
].join("\n");

const DELETE_FILE_BUFFERS = [
  "local deletions = ...",
  "local current = vim.api.nvim_get_current_buf()",
  "for _, deletion in ipairs(deletions) do",
  "  local buffer = deletion.handle",
  "  if not vim.api.nvim_buf_is_valid(buffer) or not vim.api.nvim_buf_is_loaded(buffer) then",
  "    error('cannot unload missing buffer ' .. tostring(buffer))",
  "  end",
  "  if vim.api.nvim_get_option_value('buftype', { buf = buffer }) ~= '' then",
  "    error('cannot unload non-file buffer ' .. tostring(buffer))",
  "  end",
  "  if vim.api.nvim_get_option_value('modified', { buf = buffer }) then",
  "    error('cannot unload modified buffer ' .. tostring(buffer))",
  "  end",
  "  local actual = vim.api.nvim_buf_get_name(buffer)",
  "  if actual ~= deletion.path then",
  "    error('buffer ' .. tostring(buffer) .. ' moved before delete synchronization: ' .. actual)",
  "  end",
  "end",
  "for _, deletion in ipairs(deletions) do",
  "  if deletion.handle ~= current then",
  "    vim.api.nvim_buf_delete(deletion.handle, { force = false })",
  "  end",
  "end",
  "for _, deletion in ipairs(deletions) do",
  "  if deletion.handle == current and vim.api.nvim_buf_is_valid(current) then",
  "    vim.api.nvim_buf_delete(current, { force = false })",
  "  end",
  "end",
  "return true",
].join("\n");

const APPLY_RECOVERY = [
  "local action, swap_file, copy_path = ...",
  "local buffer = vim.api.nvim_get_current_buf()",
  "local original_path = vim.api.nvim_buf_get_name(buffer)",
  "local original_lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)",
  "local original_modified = vim.api.nvim_get_option_value('modified', { buf = buffer })",
  "local original_readonly = vim.api.nvim_get_option_value('readonly', { buf = buffer })",
  "local original_eol = vim.api.nvim_get_option_value('eol', { buf = buffer })",
  "local original_fixeol = vim.api.nvim_get_option_value('fixeol', { buf = buffer })",
  "vim.api.nvim_set_option_value('modifiable', true, { buf = buffer })",
  "vim.api.nvim_set_option_value('readonly', false, { buf = buffer })",
  "vim.cmd('silent recover! ' .. vim.fn.fnameescape(swap_file))",
  "local recovered_buffer = vim.api.nvim_get_current_buf()",
  "if vim.api.nvim_buf_get_name(recovered_buffer) ~= original_path then",
  "  vim.api.nvim_buf_set_name(recovered_buffer, original_path)",
  "end",
  "if action == 'save-copy' then",
  "  vim.cmd('silent write! ' .. vim.fn.fnameescape(copy_path))",
  "  vim.api.nvim_buf_set_lines(recovered_buffer, 0, -1, false, original_lines)",
  "  vim.api.nvim_set_option_value('fixeol', original_fixeol, { buf = recovered_buffer })",
  "  vim.api.nvim_set_option_value('eol', original_eol, { buf = recovered_buffer })",
  "  vim.api.nvim_set_option_value('modified', original_modified, { buf = recovered_buffer })",
  "  vim.api.nvim_set_option_value('readonly', original_readonly, { buf = recovered_buffer })",
  "elseif action == 'compare' then",
  "  local recovered_window = vim.api.nvim_get_current_win()",
  "  vim.cmd('diffthis')",
  "  vim.cmd('rightbelow vertical new')",
  "  local disk_buffer = vim.api.nvim_get_current_buf()",
  "  local disk_lines = vim.fn.readfile(original_path, 'b')",
  "  local disk_has_eol = #disk_lines > 0 and disk_lines[#disk_lines] == ''",
  "  if disk_has_eol then table.remove(disk_lines) end",
  "  if #disk_lines == 0 then disk_lines = { '' } end",
  "  vim.api.nvim_buf_set_lines(disk_buffer, 0, -1, false, disk_lines)",
  "  vim.api.nvim_buf_set_name(disk_buffer, '[disk] ' .. original_path)",
  "  vim.api.nvim_set_option_value('buftype', 'nofile', { buf = disk_buffer })",
  "  vim.api.nvim_set_option_value('bufhidden', 'wipe', { buf = disk_buffer })",
  "  vim.api.nvim_set_option_value('buflisted', false, { buf = disk_buffer })",
  "  vim.api.nvim_set_option_value('fixeol', false, { buf = disk_buffer })",
  "  vim.api.nvim_set_option_value('eol', disk_has_eol, { buf = disk_buffer })",
  "  vim.api.nvim_set_option_value('swapfile', false, { buf = disk_buffer })",
  "  vim.api.nvim_set_option_value('modified', false, { buf = disk_buffer })",
  "  vim.api.nvim_set_option_value('modifiable', false, { buf = disk_buffer })",
  "  vim.api.nvim_set_option_value('readonly', true, { buf = disk_buffer })",
  "  vim.cmd('diffthis')",
  "  vim.api.nvim_set_current_win(recovered_window)",
  "end",
  "return recovered_buffer",
].join("\n");

const FINISH_RECOVERY = [
  "local buffer, keep_recovered = ...",
  "local reload_from_disk = buffer == 0",
  "if buffer == 0 then buffer = vim.api.nvim_get_current_buf() end",
  "if not vim.api.nvim_buf_is_valid(buffer) then return false end",
  "vim.api.nvim_buf_call(buffer, function()",
  "  vim.api.nvim_set_option_value('modifiable', true, { buf = buffer })",
  "  vim.api.nvim_set_option_value('readonly', false, { buf = buffer })",
  "  if reload_from_disk then vim.cmd('silent edit!') end",
  "  pcall(vim.api.nvim_buf_del_var, buffer, 'agenc_recovery_pending')",
  "  vim.api.nvim_set_option_value('swapfile', true, { buf = buffer })",
  "  if keep_recovered then",
  "    vim.api.nvim_set_option_value('modified', true, { buf = buffer })",
  "    vim.cmd('preserve')",
  "  end",
  "end)",
  "local replacement = vim.fn.swapname(buffer)",
  "if keep_recovered and replacement == '' then",
  "  error('Neovim did not create a replacement recovery swap')",
  "end",
  "return replacement",
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
  readonly #operationTimeoutMs: number;
  readonly #recovery: EmbeddedNeovimRecoveryInfo | null;
  readonly #onFatalError: ((error: Error) => void) | undefined;
  readonly #sessionOperations = new AbortController();
  #closed = false;
  #poisoned = false;
  #cleanupComplete = false;
  #cleanupPromise: Promise<void> | null = null;
  #quitPromise: Promise<NeovimCloseResult> | null = null;

  constructor(
    handle: NeovimProcessHandle,
    rpc: NeovimRpcTransport,
    ui: NeovimUi,
    cleanupTimeoutMs: number,
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    recovery: EmbeddedNeovimRecoveryInfo | null = null,
    onFatalError?: (error: Error) => void,
  ) {
    this.#handle = handle;
    this.#rpc = rpc;
    this.#ui = ui;
    this.#cleanupTimeoutMs = cleanupTimeoutMs;
    this.#operationTimeoutMs = operationTimeoutMs;
    this.#recovery = recovery;
    this.#onFatalError = onFatalError;
  }

  get pid(): number {
    return this.#handle.pid;
  }

  get recovery(): EmbeddedNeovimRecoveryInfo | null {
    return this.#recovery;
  }

  /**
   * Signal the supervised Neovim boundary.
   *
   * On broker-backed platforms `pid` identifies the containment owner rather
   * than the editor process itself. Callers which need to simulate or force a
   * process exit must therefore route the signal through the handle so the
   * broker can reap descendants and publish its cleanup proof.
   */
  kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): boolean {
    return this.#handle.kill(signal);
  }

  async input(keys: string): Promise<boolean> {
    if (this.#closed || keys.length === 0) return false;
    return this.#runRpcOperation(
      "Embedded Neovim input",
      true,
      async (signal, timeoutMs) => {
        await this.#request("nvim_input", [keys], signal, timeoutMs);
        return true;
      },
    );
  }

  async paste(text: string): Promise<void> {
    if (this.#closed || text.length === 0) return;
    await this.#runRpcOperation(
      "Embedded Neovim paste",
      true,
      async (signal, timeoutMs) => {
        await this.#request("nvim_paste", [text, true, -1], signal, timeoutMs);
      },
    );
  }

  async resize(size: NeovimUiSize): Promise<void> {
    if (this.#closed) return;
    await this.#runRpcOperation(
      "Embedded Neovim resize",
      true,
      (signal, timeoutMs) =>
        this.#ui.resize(size, { signal, timeoutMs }),
    );
  }

  async focus(focused: boolean): Promise<void> {
    if (this.#closed) return;
    await this.#runRpcOperation(
      "Embedded Neovim focus",
      true,
      async (signal, timeoutMs) => {
        await this.#request(
          "nvim_ui_set_focus",
          [focused],
          signal,
          timeoutMs,
        );
      },
    );
  }

  async click(row: number, column: number): Promise<void> {
    if (this.#closed) return;
    const safeRow = Math.max(0, Math.floor(row));
    const safeColumn = Math.max(0, Math.floor(column));
    await this.#runRpcOperation(
      "Embedded Neovim mouse click",
      true,
      async (signal, timeoutMs) => {
        await this.#request(
          "nvim_input_mouse",
          ["left", "press", "", 0, safeRow, safeColumn],
          signal,
          timeoutMs,
        );
        await this.#request(
          "nvim_input_mouse",
          ["left", "release", "", 0, safeRow, safeColumn],
          signal,
          timeoutMs,
        );
      },
    );
  }

  async save(force: boolean): Promise<boolean> {
    if (this.#closed) return false;
    return this.#runRpcOperation(
      "Embedded Neovim save",
      true,
      async (signal, timeoutMs) => {
        await this.#request(
          "nvim_command",
          [force ? "write!" : "write"],
          signal,
          timeoutMs,
        );
        return true;
      },
    );
  }

  async openFile(filePath: string, line = 1, column = 0): Promise<boolean> {
    if (this.#closed) return false;
    return this.#runRpcOperation(
      "Embedded Neovim file navigation",
      true,
      async (signal, timeoutMs) => {
        await editFile(
          this.#rpc,
          filePath,
          line,
          column,
          signal,
          timeoutMs,
        );
        return true;
      },
    );
  }

  async inspectBuffers(timeoutMs = this.#operationTimeoutMs): Promise<EmbeddedNeovimBufferManifest> {
    if (this.#closed) {
      if (childHasExited(this.#handle.child)) {
        return { activeBufferHandle: null, buffers: [] };
      }
      throw new Error("Embedded Neovim is still exiting; its buffer state is unavailable.");
    }
    try {
      const value = await this.#runRpcOperation(
        "Embedded Neovim buffer manifest probe",
        false,
        (signal, safeTimeoutMs) =>
          this.#request(
            "nvim_exec_lua",
            [BUFFER_MANIFEST_PROBE, []],
            signal,
            safeTimeoutMs,
          ),
        timeoutMs,
      );
      return bufferManifestFromRpcValue(value);
    } catch (error) {
      if (childHasExited(this.#handle.child)) {
        return { activeBufferHandle: null, buffers: [] };
      }
      throw error;
    }
  }

  async inspectDirtyBuffers(
    timeoutMs = this.#operationTimeoutMs,
  ): Promise<readonly EmbeddedNeovimBuffer[]> {
    const manifest = await this.inspectBuffers(timeoutMs);
    return manifest.buffers.filter((buffer) => buffer.modified);
  }

  async selectBuffer(handle: number): Promise<boolean> {
    if (this.#closed) return false;
    const normalizedHandle = normalizeBufferHandle(handle);
    await this.#runRpcOperation(
      `Embedded Neovim buffer ${handle} selection`,
      true,
      async (signal, timeoutMs) => {
        await this.#request(
          "nvim_set_current_buf",
          [normalizedHandle],
          signal,
          timeoutMs,
        );
      },
    );
    return true;
  }

  async saveBuffer(
    handle: number,
    force = false,
    expectedChangedtick?: number,
  ): Promise<boolean> {
    if (this.#closed) return false;
    const normalizedHandle = normalizeBufferHandle(handle);
    if (
      expectedChangedtick !== undefined &&
      (!Number.isSafeInteger(expectedChangedtick) || expectedChangedtick < 0)
    ) {
      throw new Error(
        `Invalid Neovim buffer changedtick: ${String(expectedChangedtick)}`,
      );
    }
    await this.#runRpcOperation(
      `Embedded Neovim buffer ${handle} save`,
      true,
      async (signal, timeoutMs) => {
        await this.#request(
          "nvim_exec_lua",
          [
            SAVE_BUFFER,
            [normalizedHandle, force, expectedChangedtick ?? null],
          ],
          signal,
          timeoutMs,
        );
      },
    );
    return true;
  }

  async rebaseFileBuffers(
    changes: readonly EmbeddedNeovimBufferRename[],
  ): Promise<void> {
    if (this.#closed) {
      throw new Error("Embedded Neovim is closed; file buffers cannot be rebased.");
    }
    const normalized = changes.map((change) => ({
      handle: normalizeBufferHandle(change.handle),
      from_path: change.fromPath,
      to_path: change.toPath,
    }));
    await this.#runRpcOperation(
      "Embedded Neovim project rename synchronization",
      true,
      (signal, timeoutMs) =>
        this.#request(
          "nvim_exec_lua",
          [REBASE_FILE_BUFFERS, [normalized]],
          signal,
          timeoutMs,
        ),
    );
  }

  async deleteFileBuffers(
    deletions: readonly EmbeddedNeovimBufferDelete[],
  ): Promise<void> {
    if (this.#closed) {
      throw new Error("Embedded Neovim is closed; deleted file buffers cannot be unloaded.");
    }
    const normalized = deletions.map((deletion) => ({
      handle: normalizeBufferHandle(deletion.handle),
      path: deletion.path,
    }));
    await this.#runRpcOperation(
      "Embedded Neovim project delete synchronization",
      true,
      (signal, timeoutMs) =>
        this.#request(
          "nvim_exec_lua",
          [DELETE_FILE_BUFFERS, [normalized]],
          signal,
          timeoutMs,
        ),
    );
  }

  async readBufferText(handle: number): Promise<string> {
    if (this.#closed) {
      throw new Error("Embedded Neovim is closed; its buffer content is unavailable.");
    }
    const normalizedHandle = normalizeBufferHandle(handle);
    const [linesValue, eolValue] = await this.#runRpcOperation(
      `Embedded Neovim buffer ${handle} content probe`,
      false,
      (signal, timeoutMs) =>
        Promise.all([
          this.#request(
            "nvim_buf_get_lines",
            [normalizedHandle, 0, -1, false],
            signal,
            timeoutMs,
          ),
          this.#request(
            "nvim_get_option_value",
            ["eol", { buf: normalizedHandle }],
            signal,
            timeoutMs,
          ),
        ]),
    );
    if (!Array.isArray(linesValue) || !linesValue.every((line) => typeof line === "string")) {
      throw new Error(`Neovim returned invalid text for buffer ${handle}.`);
    }
    const content = linesValue.join("\n");
    return eolValue === true ? `${content}\n` : content;
  }

  async captureContext(
    request: BufferCaptureRequest,
  ): Promise<BufferCapturedContext | null> {
    if (this.#closed) return null;
    const value = await this.#runRpcOperation(
      "Embedded Neovim context capture",
      false,
      (signal, timeoutMs) =>
        this.#request(
          "nvim_exec_lua",
          [
            "return _G.AgenCBufferCaptureContext(...)",
            [{
              kind: request.kind,
              max_lines: request.maxLines ?? 2000,
              visual: request.kind === "selection",
            }],
          ],
          signal,
          timeoutMs,
        ),
    );
    return capturedContextFromRpcValue(value, request);
  }

  async applyRecovery(
    action: "recover" | "compare" | "save-copy",
    swapFile: string,
    copyPath?: string,
  ): Promise<number> {
    if (this.#closed) throw new Error("Embedded Neovim is closed.");
    const value = await this.#runRpcOperation(
      "Embedded Neovim recovery application",
      true,
      (signal, timeoutMs) =>
        this.#request(
          "nvim_exec_lua",
          [APPLY_RECOVERY, [action, swapFile, copyPath ?? ""]],
          signal,
          timeoutMs,
        ),
    );
    const handle = finiteInteger(value);
    if (handle === null || handle <= 0) {
      throw new Error("Neovim did not return the recovered buffer handle.");
    }
    return handle;
  }

  async finishRecovery(
    bufferHandle: number,
    keepRecovered: boolean,
  ): Promise<string | null> {
    if (this.#closed) {
      throw new Error("Embedded Neovim closed before recovery could be confirmed.");
    }
    const value = await this.#runRpcOperation(
      "Embedded Neovim recovery finalization",
      true,
      (signal, timeoutMs) =>
        this.#request(
          "nvim_exec_lua",
          [FINISH_RECOVERY, [bufferHandle, keepRecovered]],
          signal,
          timeoutMs,
        ),
    );
    if (typeof value !== "string") {
      throw new Error("Neovim did not confirm its post-recovery swap state.");
    }
    return value.length > 0 ? value : null;
  }

  async saveAll(force = false): Promise<EmbeddedNeovimSaveAllResult> {
    const manifest = await this.inspectBuffers();
    const dirtyBuffers = manifest.buffers.filter((buffer) => buffer.modified);
    const blockedBuffers = dirtyBuffers.filter(
      (buffer) =>
        !buffer.saveable ||
        buffer.changedtick === null ||
        (buffer.readOnly && !force),
    );
    if (blockedBuffers.length > 0) {
      return {
        saved: false,
        reason: blockedBuffers.some((buffer) => buffer.name.length === 0)
          ? "One or more modified Neovim buffers have no file name."
          : blockedBuffers.some((buffer) => buffer.changedtick === null)
            ? "One or more modified Neovim buffers have no stable changedtick."
            : "One or more modified Neovim buffers cannot be written.",
        blockedBuffers,
      };
    }
    for (const buffer of dirtyBuffers) {
      if (!await this.saveBuffer(
        buffer.handle,
        force,
        buffer.changedtick ?? undefined,
      )) {
        return {
          saved: false,
          reason: `Neovim buffer ${buffer.handle} closed before it could be written.`,
          blockedBuffers: [buffer],
        };
      }
    }
    const remaining = await this.inspectDirtyBuffers();
    if (remaining.length > 0) {
      return {
        saved: false,
        reason: "Neovim still has modified buffers after Save All.",
        blockedBuffers: remaining,
      };
    }
    return { saved: true, buffers: dirtyBuffers };
  }

  async discardAll(
    expectedBuffers?: readonly EmbeddedNeovimBuffer[],
  ): Promise<boolean> {
    if (this.#closed) return childHasExited(this.#handle.child);
    const frozen = expectedBuffers ?? await this.inspectDirtyBuffers();
    if (frozen.some((buffer) => buffer.changedtick === null)) return false;
    const discarded = await this.#runRpcOperation(
      "Embedded Neovim Discard All",
      true,
      (signal, timeoutMs) =>
        this.#request(
          "nvim_exec_lua",
          [
            DISCARD_ALL_BUFFERS,
            [frozen.map((buffer) => ({
              handle: buffer.handle,
              name: buffer.name,
              changedtick: buffer.changedtick,
            }))],
          ],
          signal,
          timeoutMs,
        ),
    );
    if (discarded !== true) return false;
    return (await this.inspectDirtyBuffers()).length === 0;
  }

  async isDirty(): Promise<boolean> {
    if (this.#closed) {
      if (childHasExited(this.#handle.child)) return false;
      throw new Error("Embedded Neovim is still exiting; its dirty state is unavailable.");
    }
    try {
      const value = await this.#runRpcOperation(
        "Embedded Neovim dirty-state probe",
        false,
        (signal, timeoutMs) =>
          this.#request(
            "nvim_buf_get_option",
            [0, "modified"],
            signal,
            timeoutMs,
          ),
        this.#cleanupTimeoutMs,
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

  async hasUnsavedBuffers(timeoutMs = this.#operationTimeoutMs): Promise<boolean> {
    return (await this.inspectDirtyBuffers(timeoutMs)).length > 0;
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
        dirty = await this.hasUnsavedBuffers(this.#cleanupTimeoutMs);
      } catch {
        return {
          closed: false,
          reason: DIRTY_STATE_UNAVAILABLE_CLOSE_REASON,
          dirtyState: "unknown",
        };
      }
      if (dirty) {
        return {
          closed: false,
          reason: DIRTY_CLOSE_REASON,
          dirtyState: "dirty",
        };
      }
    }
    return this.#quitOnce(discard);
  }

  async #quitOnce(discard: boolean): Promise<NeovimCloseResult> {
    if (discard) {
      await this.cleanup();
      return { closed: true };
    }
    try {
      await this.#runRpcOperation(
        "Embedded Neovim safe close",
        true,
        (signal, timeoutMs) =>
          this.#request("nvim_command", ["qa"], signal, timeoutMs),
        this.#cleanupTimeoutMs,
      );
    } catch (error) {
      // A clean-check and :qa are not atomic: edits can arrive between them.
      // Neovim rejects the all-buffer close in that race. Preserve every live
      // buffer instead of falling through to cleanup(), whose final qa!
      // intentionally discards.
      if (isOperationTimeout(error)) {
        return {
          closed: false,
          reason: SAFE_CLOSE_UNCONFIRMED_REASON,
          dirtyState: "unknown",
        };
      }
      if (error instanceof NeovimRpcError) {
        return {
          closed: false,
          reason: DIRTY_CLOSE_REASON,
          dirtyState: "dirty",
        };
      }
      if (
        !childHasExited(this.#handle.child) &&
        !await waitForObservedExit(this.#handle.child, this.#cleanupTimeoutMs)
      ) {
        return {
          closed: false,
          reason: SAFE_CLOSE_UNCONFIRMED_REASON,
          dirtyState: "unknown",
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
    this.#sessionOperations.abort(
      new Error("Embedded Neovim session cleanup started."),
    );
    if (!this.#poisoned) this.#ui.dispose();
    captureNeovimProcessDescendants(this.#handle.child);
    // The force-quit request is best effort. Ending stdin immediately after the
    // queued frame preserves stream ordering while ensuring an unresponsive RPC
    // cannot postpone the supervised exit/SIGKILL deadline.
    if (!this.#poisoned) {
      void this.#rpc.request("nvim_command", ["qa!"]).catch(() => null);
      if (!this.#handle.child.stdin.writableEnded) {
        this.#handle.child.stdin.end();
      }
    }
    try {
      await waitForNeovimExit(this.#handle.child, this.#cleanupTimeoutMs);
    } finally {
      this.#rpc.close("session cleanup");
      this.#handle.kill("SIGKILL");
    }
  }

  async #runRpcOperation<T>(
    operationName: string,
    mutating: boolean,
    operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
    timeoutMs = this.#operationTimeoutMs,
  ): Promise<T> {
    const safeTimeoutMs = normalizeTimeout(timeoutMs, this.#operationTimeoutMs);
    const controller = new AbortController();
    const sessionSignal = this.#sessionOperations.signal;
    const abortFromSession = (): void => {
      controller.abort(sessionSignal.reason);
    };
    if (sessionSignal.aborted) abortFromSession();
    else sessionSignal.addEventListener("abort", abortFromSession, { once: true });

    try {
      // The transport deadline retires its request ID. The outer bound remains
      // a defense for alternate/test transports; aborting below ensures even
      // that path cannot leave a live request or resume a sequential command.
      const result = await settleWithin(
        operation(controller.signal, safeTimeoutMs),
        safeTimeoutMs,
        operationName,
      );
      captureNeovimProcessDescendants(this.#handle.child);
      return result;
    } catch (error) {
      if (mutating && isOperationTimeout(error)) {
        this.#poisonAfterMutatingTimeout(error);
      }
      throw error;
    } finally {
      sessionSignal.removeEventListener("abort", abortFromSession);
      if (!controller.signal.aborted) {
        controller.abort(new Error(`${operationName} settled.`));
      }
    }
  }

  #request(
    method: string,
    params: RpcParams,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<RpcValue> {
    return this.#rpc.request(method, params, { signal, timeoutMs });
  }

  #poisonAfterMutatingTimeout(error: unknown): void {
    if (this.#closed) return;
    const reason = error instanceof Error
      ? error
      : new Error(String(error));
    // Neovim may have applied a timed-out mutation without delivering its
    // reply. Continuing would make host and editor state diverge (and a late
    // mouse press could otherwise advance into its release request), so sever
    // the session while leaving supervised cleanup able to preserve recovery.
    this.#poisoned = true;
    this.#closed = true;
    this.#sessionOperations.abort(reason);
    this.#ui.dispose();
    this.#rpc.close(`mutating operation timed out: ${reason.message}`);
    if (!this.#handle.child.stdin.writableEnded) {
      this.#handle.child.stdin.end();
    }
    try {
      this.#onFatalError?.(reason);
    } catch {
      // A UI observer cannot be allowed to prevent owned-process cleanup.
    }
    void this.cleanup().catch((cleanupError) => {
      const fatal = new AggregateError(
        [reason, cleanupError],
        `${reason.message}; supervised Neovim cleanup failed`,
      );
      try {
        this.#onFatalError?.(fatal);
      } catch {
        // The process-exit backstop retains ownership for another attempt.
      }
    });
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
      cwd: options.cwd ?? options.workspaceRoot ?? getCwd(),
      ...(options.linuxContainment !== undefined
        ? { linuxContainment: options.linuxContainment }
        : {}),
    });
    const rpc = new NeovimRpcTransport(handle.child.stdout, handle.child.stdin);
    const ui = new NeovimUi(rpc, options.size, options.onSnapshot);
    let preparation: EmbeddedNeovimStartupPreparation | void;
    wireProcessErrors(handle.child, rpc, options.onError, options.onExit);
    if (options.onDirtyChange) {
      rpc.onNotification("agenc_buffer_dirty_changed", (params) => {
        options.onDirtyChange?.(dirtyFlagFromRpcNotificationParams(params));
      });
    }
    if (options.onWorkspaceChange) {
      rpc.onNotification("agenc_buffer_workspace_changed", () => {
        options.onWorkspaceChange?.();
      });
    }
    if (options.onIntegrationIntent) {
      rpc.onNotification("agenc_buffer_integration", (params) => {
        const intent = integrationIntentFromRpcParams(params);
        if (intent) {
          options.onIntegrationIntent?.(intent);
        } else if (captureExceedsLimits(params[2], {})) {
          options.onError(
            new Error(
              "Editor context exceeds the exact-capture limit (64 KiB or 2,000 lines). Select a smaller range.",
            ),
          );
        }
      });
    }
    if (options.onRecoveryDetected) {
      rpc.onNotification("agenc_buffer_recovery_detected", (params) => {
        const swapFile = params[0];
        const filePath = params[1];
        if (
          typeof swapFile === "string" &&
          swapFile.length > 0 &&
          typeof filePath === "string" &&
          filePath.length > 0
        ) {
          options.onRecoveryDetected?.({ swapFile, filePath });
        }
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
        await configureEmbeddedEditing(rpc);
        await installAgentBridge(rpc);
        preparation = await options.beforeOpenFile?.({
          workspaceRoot: options.workspaceRoot ?? options.cwd ?? getCwd(),
          agencHome: options.agencHome,
          command: async (command) => {
            await rpc.request("nvim_command", [command]);
          },
          execLua: (source, args = []) =>
            rpc.request("nvim_exec_lua", [source, args]),
        });
        await editFile(
          rpc,
          options.filePath,
          options.line,
          options.column,
          startupAbort.signal,
          options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
        );
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
      captureNeovimProcessDescendants(handle.child);
      return new EmbeddedNeovimSession(
        handle,
        rpc,
        ui,
        options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
        options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
        preparation?.recovery ?? null,
        options.onFatalError,
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

function normalizeTimeout(timeoutMs: number, fallbackMs: number): number {
  const candidate = Number.isFinite(timeoutMs)
    ? timeoutMs
    : Number.isFinite(fallbackMs)
      ? fallbackMs
      : DEFAULT_OPERATION_TIMEOUT_MS;
  return Math.max(1, Math.floor(candidate));
}

function isOperationTimeout(error: unknown): boolean {
  return error instanceof NeovimOperationTimeoutError ||
    error instanceof NeovimRpcRequestTimeoutError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function editFile(
  rpc: NeovimRpcTransport,
  filePath: string,
  line: number,
  column: number,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  const currentName = await rpc.request(
    "nvim_buf_get_name",
    [0],
    { signal, timeoutMs },
  );
  if (stringValue(currentName) !== filePath) {
    const escaped = await rpc.request(
      "nvim_call_function",
      ["fnameescape", [filePath]],
      { signal, timeoutMs },
    );
    await rpc.request(
      "nvim_command",
      [`edit ${stringValue(escaped)}`],
      { signal, timeoutMs },
    );
  }
  await rpc.request(
    "nvim_win_set_cursor",
    [0, [Math.max(1, line), Math.max(0, column)]],
    { signal, timeoutMs },
  );
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

const AGENT_BRIDGE_LUA = String.raw`
local MAX_CAPTURE_BYTES = 64 * 1024

local function bounded_lines(buffer, first, last, max_lines)
  local safe_first = math.max(0, first)
  local safe_last = math.max(safe_first, last)
  safe_last = math.min(safe_last, safe_first + max_lines)
  return vim.api.nvim_buf_get_lines(buffer, safe_first, safe_last, false)
end

local function utf8_end_exclusive(line, byte_column, inclusive)
  local column = math.max(0, math.min(#line, tonumber(byte_column) or 0))
  if not inclusive or column >= #line then return column end
  local lead = string.byte(line, column + 1)
  if lead == nil then return column end
  local width = 1
  if lead >= 240 then
    width = 4
  elseif lead >= 224 then
    width = 3
  elseif lead >= 192 then
    width = 2
  end
  return math.min(#line, column + width)
end

local function capture(request)
  request = request or {}
  local buffer = vim.api.nvim_get_current_buf()
  local path = vim.api.nvim_buf_get_name(buffer)
  local max_lines = math.max(1, math.min(2000, tonumber(request.max_lines) or 2000))
  local kind = request.kind or 'buffer'
  local line_count = vim.api.nvim_buf_line_count(buffer)
  local start_line = 1
  local end_line = math.max(1, line_count)
  local start_column = 0
  local end_column = 0
  local selection_mode = nil
  local diagnostic = nil
  local truncated = false
  local lines = {}

  if kind == 'diagnostic' then
    local cursor = vim.api.nvim_win_get_cursor(0)
    local entries = vim.diagnostic.get(buffer, { lnum = cursor[1] - 1 })
    local entry = entries[1]
    if entry == nil then return nil end
    start_line = (entry.lnum or cursor[1] - 1) + 1
    end_line = (entry.end_lnum or entry.lnum or cursor[1] - 1) + 1
    start_column = entry.col or 0
    end_column = entry.end_col or start_column
    lines = bounded_lines(buffer, start_line - 1, end_line, max_lines)
    truncated = (end_line - start_line + 1) > max_lines
    diagnostic = {
      message = tostring(entry.message or ''),
      severity = entry.severity,
      source = entry.source,
      code = entry.code,
    }
  elseif kind == 'selection' then
    local first = request.start_line
    local last = request.end_line
    local first_column = request.start_column
    local last_column = request.end_column
    selection_mode = request.selection_mode
    if request.visual then
      local active_mode = vim.api.nvim_get_mode().mode
      if active_mode == 'v' or active_mode == 'V' or active_mode == '\22' then
        local anchor = vim.fn.getpos('v')
        local cursor = vim.api.nvim_win_get_cursor(0)
        first, first_column = anchor[2], math.max(0, anchor[3] - 1)
        last, last_column = cursor[1], cursor[2]
        selection_mode = active_mode
      else
        local a = vim.api.nvim_buf_get_mark(buffer, '<')
        local b = vim.api.nvim_buf_get_mark(buffer, '>')
        first, first_column = a[1], a[2]
        last, last_column = b[1], b[2]
        selection_mode = vim.fn.visualmode()
      end
    end
    first = tonumber(first) or vim.api.nvim_win_get_cursor(0)[1]
    last = tonumber(last) or first
    first_column = tonumber(first_column) or 0
    last_column = tonumber(last_column)
    local block_selection =
      selection_mode == '\22' or request.selection_mode == 'block'
    if block_selection then
      if first > last then first, last = last, first end
      last_column = last_column or first_column
      if first_column > last_column then
        first_column, last_column = last_column, first_column
      end
    elseif first > last or
        (first == last and first_column > (last_column or first_column)) then
      first, last = last, first
      first_column, last_column = last_column or 0, first_column
    end
    start_line, end_line = first, last
    start_column = math.max(0, first_column)
    lines = bounded_lines(buffer, first - 1, last, max_lines)
    truncated = (last - first + 1) > max_lines
    if selection_mode == 'V' or request.selection_mode == 'line' then
      selection_mode = 'line'
      end_column = #(lines[#lines] or '')
    elseif block_selection then
      selection_mode = 'block'
      local inclusive = vim.api.nvim_get_option_value('selection', {}) ~= 'exclusive'
      end_column = math.max(start_column, last_column or start_column)
      local last_finish = end_column
      for index, line in ipairs(lines) do
        local finish = utf8_end_exclusive(line, end_column, inclusive)
        if index == #lines then last_finish = finish end
        lines[index] = string.sub(line, start_column + 1, finish)
      end
      end_column = last_finish
    else
      selection_mode = 'character'
      local inclusive = vim.api.nvim_get_option_value('selection', {}) ~= 'exclusive'
      local last_line = lines[#lines] or ''
      end_column = utf8_end_exclusive(
        last_line,
        math.max(0, last_column or #last_line),
        inclusive
      )
      if #lines == 1 then
        lines[1] = string.sub(lines[1], start_column + 1, end_column)
      elseif #lines > 1 then
        lines[1] = string.sub(lines[1], start_column + 1)
        lines[#lines] = string.sub(lines[#lines], 1, end_column)
      end
    end
  else
    kind = 'buffer'
    lines = bounded_lines(buffer, 0, line_count, max_lines)
    truncated = line_count > max_lines
    end_line = math.max(1, math.min(line_count, max_lines))
    end_column = #(lines[#lines] or '')
  end

  return {
    kind = kind,
    buffer = buffer,
    path = path,
    range = {
      start = { line = start_line, column = start_column },
      ['end'] = { line = end_line, column = end_column },
    },
    content = table.concat(lines, '\n'),
    dirty = vim.api.nvim_get_option_value('modified', { buf = buffer }),
    selection_mode = selection_mode,
    diagnostic = diagnostic,
    changedtick = vim.api.nvim_buf_get_changedtick(buffer),
    truncated = truncated,
  }
end

local function notification_context(context)
  if context == nil then return nil end
  if context.truncated == true
      or (type(context.content) == 'string' and #context.content > MAX_CAPTURE_BYTES) then
    return { truncated = true }
  end
  return context
end

_G.AgenCBufferCaptureContext = capture
_G.AgenCBufferAction = function(action, prompt, visual, line1, line2)
  local selection_mode = nil
  if not visual and line1 ~= nil and line2 ~= nil then
    selection_mode = 'line'
  end
  local context = notification_context(capture({
    kind = (visual or (line1 ~= nil and line2 ~= nil)) and 'selection' or 'buffer',
    visual = visual == true,
    start_line = line1,
    end_line = line2,
    selection_mode = selection_mode,
    max_lines = 2000,
  }))
  if context ~= nil then
    vim.rpcnotify(0, 'agenc_buffer_integration', action, prompt or '', context)
  end
end

local actions = {
  Attach = 'attach',
  Ask = 'ask',
  Fix = 'fix',
  Explain = 'explain',
  Review = 'review',
}
for suffix, action in pairs(actions) do
  vim.api.nvim_create_user_command('AgenC' .. suffix, function(opts)
    local ranged = opts.range > 0
    _G.AgenCBufferAction(
      action,
      opts.args,
      false,
      ranged and opts.line1 or nil,
      ranged and opts.line2 or nil
    )
  end, { nargs = '*', range = true, force = true })
  vim.keymap.set('n', '<Plug>(AgenC' .. suffix .. ')', function()
    _G.AgenCBufferAction(action, '', false, nil, nil)
  end, { silent = true })
  vim.keymap.set('x', '<Plug>(AgenC' .. suffix .. ')', function()
    _G.AgenCBufferAction(action, '', true, nil, nil)
  end, { silent = true })
end
return true
`;

async function installAgentBridge(rpc: NeovimRpcTransport): Promise<void> {
  await rpc.request("nvim_exec_lua", [AGENT_BRIDGE_LUA, []]);
}

async function installDirtyAutocmds(rpc: NeovimRpcTransport): Promise<void> {
  const publishState = [
    "function! AgenCBufferPublishState() abort",
    "  let l:dirty = v:false",
    "  for l:buffer in nvim_list_bufs()",
    "    if nvim_buf_is_loaded(l:buffer) && nvim_get_option_value('modified', {'buf': l:buffer})",
    "      let l:dirty = v:true",
    "      break",
    "    endif",
    "  endfor",
    "  call rpcnotify(0, 'agenc_buffer_dirty_changed', l:dirty)",
    "  call rpcnotify(0, 'agenc_buffer_workspace_changed')",
    "endfunction",
  ].join("\n");
  await rpc.request("nvim_exec2", [publishState, {}]);
  await rpc.request("nvim_command", ["augroup AgenCBufferDirtyState"]);
  await rpc.request("nvim_command", ["autocmd!"]);
  await rpc.request("nvim_command", [
    "autocmd BufAdd,BufDelete,BufEnter,BufModifiedSet,BufWritePost,FileChangedShellPost,TextChanged,TextChangedI,TextChangedP * call AgenCBufferPublishState()",
  ]);
  await rpc.request("nvim_command", ["augroup END"]);
  await rpc.request("nvim_command", ["call AgenCBufferPublishState()"]);
}

export function dirtyFlagFromRpcNotificationParams(params: readonly RpcValue[]): boolean {
  return params[0] === true;
}

const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_CAPTURE_LINES = 2000;

export function integrationIntentFromRpcParams(
  params: readonly RpcValue[],
): BufferIntegrationIntent | null {
  const kind = params[0];
  if (
    kind !== "attach" &&
    kind !== "ask" &&
    kind !== "fix" &&
    kind !== "explain" &&
    kind !== "review"
  ) {
    return null;
  }
  const context = capturedContextFromRpcValue(params[2], {});
  if (!context) return null;
  const prompt = typeof params[1] === "string"
    ? truncateUtf8(params[1], 8192)
    : "";
  return {
    kind,
    ...(prompt.trim().length > 0 ? { prompt } : {}),
    context,
  };
}

export function capturedContextFromRpcValue(
  value: RpcValue | undefined,
  request: Pick<BufferCaptureRequest, "maxBytes" | "maxLines">,
): BufferCapturedContext | null {
  const record = rpcRecord(value);
  const kind = record?.kind;
  const bufferHandle = positiveInteger(record?.buffer);
  const path = record?.path;
  const range = rpcRecord(record?.range);
  const start = rpcRecord(range?.start);
  const end = rpcRecord(range?.end);
  const startLine = positiveInteger(start?.line);
  const startColumn = nonNegativeInteger(start?.column);
  const endLine = positiveInteger(end?.line);
  const endColumn = nonNegativeInteger(end?.column);
  const changedtick = nonNegativeInteger(record?.changedtick);
  if (
    (kind !== "selection" && kind !== "buffer" && kind !== "diagnostic") ||
    bufferHandle === null ||
    typeof path !== "string" ||
    startLine === null ||
    startColumn === null ||
    endLine === null ||
    endColumn === null ||
    changedtick === null
  ) {
    return null;
  }
  const rawContent = typeof record?.content === "string"
    ? record.content
    : undefined;
  if (captureExceedsLimits(value, request)) return null;
  const content = rawContent;
  const selectionMode = record?.selection_mode === "line" ||
      record?.selection_mode === "block" ||
      record?.selection_mode === "character"
    ? record.selection_mode
    : undefined;
  const rawDiagnostic = rpcRecord(record?.diagnostic);
  const diagnosticMessage = rawDiagnostic?.message;
  const diagnostic = kind === "diagnostic" && typeof diagnosticMessage === "string"
    ? {
        message: truncateUtf8(diagnosticMessage, 8192),
        severity: typeof rawDiagnostic?.severity === "number"
          ? rawDiagnostic.severity
          : null,
        ...(typeof rawDiagnostic?.source === "string"
          ? { source: truncateUtf8(rawDiagnostic.source, 256) }
          : {}),
        ...(typeof rawDiagnostic?.code === "string" || typeof rawDiagnostic?.code === "number"
          ? { code: rawDiagnostic.code }
          : {}),
      }
    : undefined;
  return {
    kind,
    bufferHandle,
    path,
    range: {
      start: { line: startLine, column: startColumn },
      end: { line: endLine, column: endColumn },
    },
    ...(content !== undefined ? { content } : {}),
    dirty: record?.dirty === true,
    ...(selectionMode ? { selectionMode } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    changedtick,
  };
}

function captureExceedsLimits(
  value: RpcValue | undefined,
  request: Pick<BufferCaptureRequest, "maxBytes" | "maxLines">,
): boolean {
  const record = rpcRecord(value);
  const content = record?.content;
  if (record?.truncated === true) return true;
  if (typeof content !== "string") return false;
  const maxLines = Math.min(
    MAX_CAPTURE_LINES,
    positiveInteger(request.maxLines) ?? MAX_CAPTURE_LINES,
  );
  const maxBytes = Math.min(
    MAX_CAPTURE_BYTES,
    positiveInteger(request.maxBytes) ?? MAX_CAPTURE_BYTES,
  );
  return content.split("\n").length > maxLines ||
    Buffer.byteLength(content, "utf8") > maxBytes;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

function positiveInteger(value: RpcValue | number | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: RpcValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function wireProcessErrors(
  child: ChildProcessWithoutNullStreams,
  rpc: NeovimRpcTransport,
  onError: (error: Error) => void,
  onExit: (exit: NeovimExitInfo) => void,
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
    onExit({
      code,
      signal,
      stderrTail: stderr.trim(),
    });
  });
}

function stringValue(value: RpcValue): string {
  return String(value);
}

export function bufferManifestFromRpcValue(value: RpcValue): EmbeddedNeovimBufferManifest {
  const record = rpcRecord(value);
  const active = finiteInteger(record?.active);
  const rawBuffers = Array.isArray(record?.buffers) ? record.buffers : [];
  const buffers: EmbeddedNeovimBuffer[] = [];
  for (const rawBuffer of rawBuffers) {
    const buffer = rpcRecord(rawBuffer);
    const handle = finiteInteger(buffer?.handle);
    if (handle === null) continue;
    const name = typeof buffer?.name === "string" ? buffer.name : "";
    const bufferType = typeof buffer?.buffer_type === "string" ? buffer.buffer_type : "";
    const changedtick = nonNegativeInteger(buffer?.changedtick);
    const loaded = buffer?.loaded === true;
    const modifiable = buffer?.modifiable === true;
    buffers.push({
      handle,
      changedtick,
      name,
      listed: buffer?.listed === true,
      loaded,
      modified: buffer?.modified === true,
      current: buffer?.current === true || handle === active,
      bufferType,
      modifiable,
      readOnly: buffer?.read_only === true,
      saveable: buffer?.saveable === true ||
        (name.length > 0 && bufferType.length === 0 && modifiable),
    });
  }
  return {
    activeBufferHandle: active,
    buffers,
  };
}

function normalizeBufferHandle(handle: number): number {
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    throw new Error(`Invalid Neovim buffer handle: ${String(handle)}`);
  }
  return handle;
}

function finiteInteger(value: RpcValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function rpcRecord(value: RpcValue | undefined): { readonly [key: string]: RpcValue } | null {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    return null;
  }
  return value as { readonly [key: string]: RpcValue };
}
