import { openFileInBufferExternalEditor, type BufferExternalEditorLauncher } from "../../externalEditor.js";
import {
  BufferSaveConflictError,
  readBufferFileSnapshot,
  type BufferFileEncoding,
  type BufferFileSnapshot,
  type BufferLineEndings,
} from "../../fileSnapshot.js";
import { startEmbeddedNeovim, type EmbeddedNeovimSession, type StartEmbeddedNeovimOptions } from "../../neovim/NeovimLifecycle.js";
import type { NeovimDiscoveryResult } from "../../neovim/NeovimDiscovery.js";
import { translateKeyToNeovimInput, translatePasteToNeovimInput } from "../../neovim/NeovimInput.js";
import { createNeovimRenderSnapshot, type NeovimRenderSnapshot } from "../../neovim/NeovimGrid.js";
import type { BufferMove } from "../../editing.js";
import type {
  BufferEditorProvider,
  BufferProviderCloseOptions,
  BufferProviderIdentity,
  BufferProviderInput,
  BufferProviderListener,
  BufferProviderOpenOptions,
  BufferProviderResize,
  BufferProviderSaveOptions,
  BufferProviderSnapshot,
} from "../types.js";
import {
  emptyProviderSnapshot,
  NEOVIM_BUFFER_CAPABILITIES,
  positionFromNeovimCursor,
} from "../types.js";

export type NeovimBufferProviderOptions = {
  readonly discovery: Extract<NeovimDiscoveryResult, { readonly usable: true }>;
  readonly openExternalEditor?: BufferExternalEditorLauncher;
  readonly readFileSnapshot?: (filePath: string) => Promise<BufferFileSnapshot>;
  readonly startSession?: (options: StartEmbeddedNeovimOptions) => Promise<EmbeddedNeovimSession>;
  readonly cleanupTimeoutMs?: number;
};

export class NeovimBufferProvider implements BufferEditorProvider {
  readonly identity: BufferProviderIdentity;
  readonly #listeners = new Set<BufferProviderListener>();
  readonly #discovery: Extract<NeovimDiscoveryResult, { readonly usable: true }>;
  readonly #cleanupTimeoutMs: number | undefined;
  readonly #openExternalEditor: BufferExternalEditorLauncher;
  readonly #readFileSnapshot: (filePath: string) => Promise<BufferFileSnapshot>;
  readonly #startSession: (options: StartEmbeddedNeovimOptions) => Promise<EmbeddedNeovimSession>;
  #session: EmbeddedNeovimSession | null = null;
  #snapshot: BufferProviderSnapshot;
  #terminal: NeovimRenderSnapshot = createNeovimRenderSnapshot(20, 80);
  #size: BufferProviderResize = { rows: 20, columns: 80 };
  #filePath: string | null = null;
  #absolutePath: string | null = null;
  #fileSnapshot: BufferFileSnapshot | null = null;
  #encoding: BufferFileEncoding | null = null;
  #lineEndings: BufferLineEndings | null = null;
  #dirty = false;
  #statusMessage: string | null = null;
  #openGeneration = 0;

  constructor(options: NeovimBufferProviderOptions) {
    this.#discovery = options.discovery;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs;
    this.#openExternalEditor = options.openExternalEditor ?? openFileInBufferExternalEditor;
    this.#readFileSnapshot = options.readFileSnapshot ?? readBufferFileSnapshot;
    this.#startSession = options.startSession ?? startEmbeddedNeovim;
    this.identity = {
      kind: "neovim",
      label: `embedded Neovim ${options.discovery.version.raw}`,
      fallbackReason: null,
      capabilities: NEOVIM_BUFFER_CAPABILITIES,
    };
    this.#snapshot = emptyProviderSnapshot(this.identity);
  }

  subscribe(listener: BufferProviderListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): BufferProviderSnapshot {
    return this.#snapshot;
  }

  getVisibleLines(): readonly [] {
    return [];
  }

  async open(options: BufferProviderOpenOptions): Promise<void> {
    const generation = this.#openGeneration + 1;
    this.#openGeneration = generation;
    await this.#session?.cleanup();
    this.#session = null;
    this.#fileSnapshot = null;
    this.#setSnapshot("loading", null);
    try {
      const file = await this.#readFileSnapshot(options.filePath);
      if (generation !== this.#openGeneration) return;
      this.#filePath = file.filePath;
      this.#absolutePath = file.absolutePath;
      this.#fileSnapshot = file;
      this.#encoding = file.encoding;
      this.#lineEndings = file.lineEndings;
      this.#terminal = createNeovimRenderSnapshot(this.#size.rows, this.#size.columns);
      const isCurrentOpen = () => generation === this.#openGeneration;
      const session = await this.#startSession({
        executable: this.#discovery.executable,
        args: this.#discovery.args,
        filePath: file.absolutePath,
        line: options.line ?? 1,
        column: options.column ?? 0,
        size: this.#size,
        cleanupTimeoutMs: this.#cleanupTimeoutMs,
        onSnapshot: (terminal) => {
          if (!isCurrentOpen()) return;
          this.#terminal = terminal;
          this.#setSnapshot("ready", null);
        },
        onDirtyChange: (dirty) => {
          if (!isCurrentOpen()) return;
          this.#handleDirtyChange(dirty);
        },
        onError: (error) => {
          if (!isCurrentOpen()) return;
          this.#setSnapshot("error", error.message);
        },
        onExit: () => {
          if (!isCurrentOpen()) return;
          this.#session = null;
          this.#setSnapshot("closed", "Embedded Neovim exited.");
        },
      });
      if (generation !== this.#openGeneration) {
        await session.cleanup().catch(() => {});
        return;
      }
      this.#session = session;
      await this.#refreshDirty();
      this.#setSnapshot("ready", null);
    } catch (error) {
      if (generation !== this.#openGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#setSnapshot("error", message);
    }
  }

  async save(options: BufferProviderSaveOptions = {}): Promise<boolean> {
    if (options.hasInFlightAgent) {
      this.#setSnapshot(
        "conflict",
        "An agent appears to be editing this file. Wait or force save from Neovim when intentional.",
        "agent",
      );
      return false;
    }
    if (!this.#session) return false;
    this.#setSnapshot("saving", null);
    try {
      await this.#assertNoDiskConflict(options.force === true);
      await this.#session.save(options.force === true);
      await this.#refreshDirty();
      this.#setSnapshot("ready", null);
      return true;
    } catch (error) {
      if (error instanceof BufferSaveConflictError) {
        this.#setSnapshot("conflict", error.message, "disk");
        return false;
      }
      this.#setSnapshot("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async revert(): Promise<void> {
    if (!this.#session) return;
    await this.#session.input("<Esc>:edit!<CR>");
    await this.#refreshDirty();
    this.#setSnapshot("ready", null);
  }

  async close(options: BufferProviderCloseOptions = {}): Promise<boolean> {
    const session = this.#session;
    if (!session) {
      this.#setSnapshot("idle", null);
      return true;
    }
    const result = await session.quit(options.discard === true);
    if (!result.closed) {
      this.#setSnapshot("conflict", result.reason);
      return false;
    }
    this.#session = null;
    this.#fileSnapshot = null;
    this.#dirty = false;
    this.#setSnapshot("idle", null);
    return true;
  }

  async openExternalEditor(): Promise<boolean> {
    if (!this.#absolutePath) return false;
    if (await this.#readCurrentDirtyState()) {
      this.#setSnapshot("conflict", "Save or force quit embedded Neovim edits before opening an external editor.");
      return false;
    }
    const line = this.#terminal.cursor.row + 1;
    let opened = false;
    try {
      opened = this.#openExternalEditor(this.#absolutePath, line);
    } catch (error) {
      this.#setSnapshot("error", error instanceof Error ? error.message : String(error));
      return false;
    }
    if (!opened) {
      this.#setSnapshot("error", "No external editor is available for BUFFER. Set VISUAL or EDITOR.");
      return false;
    }
    await this.open({ filePath: reloadPathAfterExternalEditor(this.#filePath, this.#absolutePath), line });
    return true;
  }

  undo(): boolean {
    void this.#session?.input("u");
    return true;
  }

  redo(): boolean {
    void this.#session?.input("<C-r>");
    return true;
  }

  move(_move: BufferMove): boolean {
    return false;
  }

  async requestHover(): Promise<string | null> {
    return null;
  }

  async goToDefinition(): Promise<boolean> {
    return false;
  }

  handleInput(event: BufferProviderInput): boolean {
    const session = this.#session;
    if (!session) return false;
    if (event.input.length > 1 && !hasSpecialKey(event.key)) {
      for (const translated of translatePasteToNeovimInput(event.input)) {
        if (translated.type === "keys") void session.input(translated.keys);
        if (translated.type === "paste") void session.paste(translated.text);
      }
      void this.#refreshDirty();
      return true;
    }
    const keys = translateKeyToNeovimInput(event.input, event.key);
    if (!keys) return false;
    void session.input(keys).then(() => this.#refreshDirty());
    return true;
  }

  click(row: number, column: number): boolean {
    const session = this.#session;
    if (!session) return false;
    void session.click(row, column).catch((error) => {
      this.#setSnapshot("error", error instanceof Error ? error.message : String(error));
    });
    return true;
  }

  resize(size: BufferProviderResize): void {
    this.#size = {
      rows: Math.max(1, Math.floor(size.rows)),
      columns: Math.max(1, Math.floor(size.columns)),
    };
    void this.#session?.resize(this.#size).catch((error) => {
      this.#setSnapshot("error", error instanceof Error ? error.message : String(error));
    });
  }

  focus(focused: boolean): void {
    void this.#session?.focus(focused).catch((error) => {
      this.#setSnapshot("error", error instanceof Error ? error.message : String(error));
    });
  }

  async cleanup(): Promise<void> {
    this.#openGeneration += 1;
    await this.#session?.cleanup();
    this.#session = null;
    this.#filePath = null;
    this.#absolutePath = null;
    this.#fileSnapshot = null;
    this.#encoding = null;
    this.#lineEndings = null;
    this.#dirty = false;
    this.#setSnapshot("idle", null);
  }

  async #refreshDirty(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    this.#dirty = await this.#readCurrentDirtyState();
    if (!this.#dirty) await this.#refreshFileSnapshot();
    this.#emitSnapshot();
  }

  async #readCurrentDirtyState(): Promise<boolean> {
    const session = this.#session;
    if (!session) return this.#dirty;
    return session.isDirty().then((dirty) => {
      this.#dirty = dirty;
      return dirty;
    }, () => this.#dirty);
  }

  #handleDirtyChange(dirty: boolean): void {
    this.#dirty = dirty;
    if (dirty) {
      this.#emitSnapshot();
      return;
    }
    void this.#refreshFileSnapshot().finally(() => {
      this.#emitSnapshot();
    });
  }

  async #assertNoDiskConflict(force: boolean): Promise<void> {
    const snapshot = this.#fileSnapshot;
    if (force || !snapshot) return;
    const current = await this.#readFileSnapshot(snapshot.absolutePath).catch(() => {
      throw new BufferSaveConflictError(snapshot.filePath);
    });
    if (current.mtimeMs !== snapshot.mtimeMs || current.content !== snapshot.content) {
      throw new BufferSaveConflictError(snapshot.filePath);
    }
  }

  async #refreshFileSnapshot(): Promise<void> {
    const paths = refreshableFileSnapshotPaths(this.#absolutePath, this.#filePath);
    if (!paths) return;
    try {
      const file = await this.#readFileSnapshot(paths.absolutePath);
      this.#fileSnapshot = { ...file, filePath: paths.filePath };
      this.#encoding = file.encoding;
      this.#lineEndings = file.lineEndings;
    } catch {
      return;
    }
  }

  #setSnapshot(
    status: BufferProviderSnapshot["providerStatus"],
    message: string | null,
    conflictKind: BufferProviderSnapshot["conflictKind"] = status === "conflict" ? "disk" : null,
  ): void {
    this.#statusMessage = message;
    this.#snapshot = {
      ...this.#snapshot,
      status: status === "closed" ? "idle" : status,
      providerStatus: status,
      providerMessage: message,
      error: status === "error" || status === "conflict" ? message : null,
      conflictKind,
      filePath: this.#filePath,
      absolutePath: this.#absolutePath,
      dirty: this.#dirty,
      lineCount: this.#terminal.lines.length,
      position: positionFromNeovimCursor(this.#terminal.cursor.row + 1, this.#terminal.cursor.column),
      selection: { anchor: 0, head: 0 },
      viewportRows: this.#size.rows,
      encoding: this.#encoding,
      lineEndings: this.#lineEndings,
      terminal: this.#terminal,
      vimMode: neovimModeToVimMode(this.#terminal.mode),
      vimCommandLine: this.#terminal.commandLine,
    };
    this.#emit();
  }

  #emitSnapshot(): void {
    this.#snapshot = {
      ...this.#snapshot,
      dirty: this.#dirty,
      providerMessage: this.#statusMessage,
      encoding: this.#encoding,
      lineEndings: this.#lineEndings,
    };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export function reloadPathAfterExternalEditor(filePath: string | null, absolutePath: string): string {
  return filePath ?? absolutePath;
}

export function refreshableFileSnapshotPaths(
  absolutePath: string | null,
  filePath: string | null,
): { readonly absolutePath: string; readonly filePath: string } | null {
  return absolutePath && filePath ? { absolutePath, filePath } : null;
}

function neovimModeToVimMode(mode: string): BufferProviderSnapshot["vimMode"] {
  if (mode.startsWith("insert")) return "INSERT";
  if (mode.startsWith("visual") || mode === "v" || mode === "V") return "VISUAL";
  return "NORMAL";
}

function hasSpecialKey(key: BufferProviderInput["key"]): boolean {
  return key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageDown || key.pageUp ||
    key.home || key.end || key.return || key.escape || key.tab || key.backspace || key.delete ||
    key.wheelUp || key.wheelDown;
}
