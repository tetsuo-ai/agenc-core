import { openFileInBufferExternalEditor, type BufferExternalEditorLauncher } from "../../externalEditor.js";
import {
  BufferSaveConflictError,
  readBufferFileSnapshot,
  type BufferFileEncoding,
  type BufferFileSnapshot,
  type BufferLineEndings,
} from "../../fileSnapshot.js";
import {
  NeovimStartupCleanupError,
  startEmbeddedNeovim,
  type EmbeddedNeovimSession,
  type NeovimCloseResult,
  type StartEmbeddedNeovimOptions,
} from "../../neovim/NeovimLifecycle.js";
import type { NeovimDiscoveryResult } from "../../neovim/NeovimDiscovery.js";
import { translateKeyToNeovimInput } from "../../neovim/NeovimInput.js";
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
  readonly startupTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
};

type NeovimProviderOwnership = {
  readonly generation: number;
  readonly session: EmbeddedNeovimSession;
  readonly filePath: string | null;
  readonly absolutePath: string | null;
};

type NeovimOperationOwnership = NeovimProviderOwnership & {
  readonly openGeneration: number;
};

type NeovimFileOwnership = Omit<NeovimProviderOwnership, "session"> & {
  readonly openGeneration: number;
};

type NeovimPendingSessionStart = {
  readonly controller: AbortController;
  readonly promise: Promise<EmbeddedNeovimSession>;
  session: EmbeddedNeovimSession | null;
  disposalPromise: Promise<void> | null;
};

export class NeovimBufferProvider implements BufferEditorProvider {
  readonly identity: BufferProviderIdentity;
  readonly #listeners = new Set<BufferProviderListener>();
  readonly #discovery: Extract<NeovimDiscoveryResult, { readonly usable: true }>;
  readonly #startupTimeoutMs: number | undefined;
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
  #pendingTransitionGeneration: number | null = null;
  #ownershipGeneration = 0;
  #pendingSessionStart: NeovimPendingSessionStart | null = null;

  constructor(options: NeovimBufferProviderOptions) {
    this.#discovery = options.discovery;
    this.#startupTimeoutMs = options.startupTimeoutMs;
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
    this.#pendingTransitionGeneration = generation;
    try {
      if (this.#pendingSessionStart) {
        await this.#cancelPendingSessionStart().catch((error) => {
          throw cleanupError("before opening another file", error);
        });
      }
      if (generation !== this.#openGeneration) return;
      const previousSession = this.#session;
      if (previousSession) {
        if (options.filePath === this.#filePath && this.#dirty) {
          this.#setSnapshot("ready", null);
          return;
        }
        const previousOwnership = this.#captureOwnership(previousSession);
        const closeResult = await previousSession.quit(false).catch((error) => {
          throw cleanupError("before opening another file", error);
        });
        if (generation !== this.#openGeneration) return;
        if (!closeResult.closed) {
          if (!this.#owns(previousOwnership)) return;
          this.#dirty = true;
          this.#setSnapshot(
            "conflict",
            "Unsaved edits. Save, revert, or close-discard before opening another file.",
            "disk",
          );
          return;
        }
        this.#releaseSession(previousSession);
      }
      // The previous file is no longer owned once its session closes. Clear it
      // before the asynchronous read so external-editor handoff cannot capture
      // and reopen a stale path while the requested file is still loading.
      this.#resetFileState();
      this.#terminal = createNeovimRenderSnapshot(this.#size.rows, this.#size.columns);
      this.#setSnapshot("loading", null);
      const file = await this.#readFileSnapshot(options.filePath);
      if (generation !== this.#openGeneration) return;
      this.#filePath = file.filePath;
      this.#absolutePath = file.absolutePath;
      this.#fileSnapshot = file;
      this.#encoding = file.encoding;
      this.#lineEndings = file.lineEndings;
      let exited = false;
      let committedOwnership: NeovimProviderOwnership | null = null;
      const isCurrentOpen = () => !exited && (
        committedOwnership
          ? this.#owns(committedOwnership)
          : generation === this.#openGeneration
      );
      const startupController = new AbortController();
      const pendingStart: NeovimPendingSessionStart = {
        controller: startupController,
        promise: Promise.resolve().then(() => this.#startSession({
          executable: this.#discovery.executable,
          args: this.#discovery.args,
          filePath: file.absolutePath,
          line: options.line ?? 1,
          column: options.column ?? 0,
          size: this.#size,
          signal: startupController.signal,
          startupTimeoutMs: this.#startupTimeoutMs,
          cleanupTimeoutMs: this.#cleanupTimeoutMs,
          onSnapshot: (terminal) => {
            if (!isCurrentOpen()) return;
            this.#terminal = terminal;
            if (generation === this.#openGeneration) {
              this.#setSnapshot("ready", null);
            } else {
              this.#emitSnapshot();
            }
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
            exited = true;
            if (committedOwnership) this.#releaseSession(committedOwnership.session);
            this.#setSnapshot("closed", "Embedded Neovim exited.");
          },
        })),
        session: null,
        disposalPromise: null,
      };
      this.#pendingSessionStart = pendingStart;
      let session: EmbeddedNeovimSession;
      try {
        session = await pendingStart.promise;
        pendingStart.session = session;
      } catch (error) {
        if (
          !(error instanceof NeovimStartupCleanupError) &&
          generation === this.#openGeneration &&
          this.#pendingSessionStart === pendingStart
        ) {
          this.#pendingSessionStart = null;
        }
        throw error;
      }
      if (generation !== this.#openGeneration || exited) {
        await this.#disposePendingSessionStart(pendingStart).catch((error) => {
          throw cleanupError(
            exited ? "after exiting during startup" : "after startup was superseded",
            error,
          );
        });
        return;
      }
      if (this.#pendingSessionStart === pendingStart) this.#pendingSessionStart = null;
      this.#session = session;
      this.#ownershipGeneration += 1;
      committedOwnership = this.#captureOwnership(session);
      const openingOwnership = this.#captureOperationOwnership(session);
      await this.#refreshDirty(openingOwnership);
      if (exited || !this.#ownsOperation(openingOwnership)) return;
      this.#setSnapshot("ready", null);
    } catch (error) {
      if (generation !== this.#openGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#setSnapshot("error", message);
    } finally {
      if (this.#pendingTransitionGeneration === generation) {
        this.#pendingTransitionGeneration = null;
      }
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
    const session = this.#session;
    if (!session) return false;
    const ownership = this.#captureOperationOwnership(session);
    const fileSnapshot = this.#fileSnapshot;
    const previousSnapshot = this.#snapshot;
    const previousStatusMessage = this.#statusMessage;
    this.#setSnapshot("saving", null);
    try {
      await this.#assertNoDiskConflict(options.force === true, fileSnapshot);
      if (!this.#ownsOperation(ownership)) return false;
      const saved = await session.save(options.force === true);
      if (!this.#ownsOperation(ownership)) return false;
      if (!saved) {
        this.#restoreActionableSnapshot(
          previousSnapshot,
          previousStatusMessage,
          "Embedded Neovim is closed; no file was saved.",
        );
        return false;
      }
      await this.#refreshDirty(ownership);
      if (!this.#ownsOperation(ownership)) return false;
      this.#setSnapshot("ready", null);
      return true;
    } catch (error) {
      if (!this.#ownsOperation(ownership)) return false;
      if (error instanceof BufferSaveConflictError) {
        this.#setSnapshot("conflict", error.message, "disk");
        return false;
      }
      this.#setSnapshot("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async revert(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    const ownership = this.#captureOperationOwnership(session);
    const previousSnapshot = this.#snapshot;
    const previousStatusMessage = this.#statusMessage;
    const reverted = await session.input("<Esc>:edit!<CR>");
    if (!this.#ownsOperation(ownership)) return;
    if (reverted === false) {
      this.#restoreActionableSnapshot(
        previousSnapshot,
        previousStatusMessage,
        "Embedded Neovim is closed; the file was not reverted.",
      );
      return;
    }
    await this.#refreshDirty(ownership);
    if (!this.#ownsOperation(ownership)) return;
    this.#setSnapshot("ready", null);
  }

  async close(options: BufferProviderCloseOptions = {}): Promise<boolean> {
    const generation = this.#openGeneration + 1;
    this.#openGeneration = generation;
    this.#pendingTransitionGeneration = generation;
    try {
      if (this.#pendingSessionStart) {
        try {
          await this.#cancelPendingSessionStart();
        } catch (error) {
          if (generation !== this.#openGeneration) return false;
          this.#setSnapshot("error", cleanupError("while closing BUFFER", error).message);
          return false;
        }
      }
      if (generation !== this.#openGeneration) return false;
      const session = this.#session;
      if (!session) {
        this.#resetFileState();
        this.#setSnapshot("idle", null);
        return true;
      }
      let result: NeovimCloseResult;
      try {
        result = await session.quit(options.discard === true);
      } catch (error) {
        if (generation !== this.#openGeneration) return false;
        this.#setSnapshot("error", cleanupError("while closing BUFFER", error).message);
        return false;
      }
      if (generation !== this.#openGeneration) return false;
      if (!result.closed) {
        this.#setSnapshot("conflict", result.reason);
        return false;
      }
      this.#releaseSession(session);
      this.#resetFileState();
      this.#setSnapshot("idle", null);
      return true;
    } finally {
      if (this.#pendingTransitionGeneration === generation) {
        this.#pendingTransitionGeneration = null;
      }
    }
  }

  async openExternalEditor(): Promise<boolean> {
    if (this.#pendingTransitionGeneration !== null || this.#pendingSessionStart !== null) {
      return false;
    }
    const session = this.#session;
    const fileOwnership = this.#captureFileOwnership();
    if (!fileOwnership.absolutePath) return false;
    const sessionOwnership = session ? this.#captureOperationOwnership(session) : null;
    let dirty = this.#dirty;
    if (sessionOwnership) {
      try {
        // External handoff must cover hidden buffers as well as the active
        // buffer: launching first and relying on a later :qa refusal would let
        // another editor race unsaved in-memory state.
        dirty = await sessionOwnership.session.hasUnsavedBuffers();
      } catch (error) {
        if (this.#ownsOperation(sessionOwnership) && this.#ownsFile(fileOwnership)) {
          this.#setSnapshot(
            "error",
            `Unable to verify embedded Neovim dirty state: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return false;
      }
      if (!this.#ownsOperation(sessionOwnership)) return false;
    }
    if (!this.#ownsFile(fileOwnership)) return false;
    this.#dirty = dirty;
    if (dirty) {
      this.#setSnapshot("conflict", "Save or force quit embedded Neovim edits before opening an external editor.");
      return false;
    }
    const line = this.#terminal.cursor.row + 1;
    let opened = false;
    try {
      opened = this.#openExternalEditor(fileOwnership.absolutePath, line);
    } catch (error) {
      if (this.#ownsFile(fileOwnership)) {
        this.#setSnapshot("error", error instanceof Error ? error.message : String(error));
      }
      return false;
    }
    if (!this.#ownsFile(fileOwnership)) return false;
    if (!opened) {
      this.#setSnapshot("error", "No external editor is available for BUFFER. Set VISUAL or EDITOR.");
      return false;
    }
    await this.open({
      filePath: reloadPathAfterExternalEditor(fileOwnership.filePath, fileOwnership.absolutePath),
      line,
    });
    return true;
  }

  undo(): boolean {
    const session = this.#session;
    if (session) void this.#sendInput(session, "u");
    return true;
  }

  redo(): boolean {
    const session = this.#session;
    if (session) void this.#sendInput(session, "<C-r>");
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
    if (event.isPaste === true) {
      void this.#runSessionAction(session, () => session.paste(event.input));
      return true;
    }
    const keys = translateKeyToNeovimInput(event.input, event.key);
    if (!keys) return false;
    void this.#sendInput(session, keys);
    return true;
  }

  click(row: number, column: number): boolean {
    const session = this.#session;
    if (!session) return false;
    void this.#runSessionAction(session, () => session.click(row, column));
    return true;
  }

  resize(size: BufferProviderResize): void {
    this.#size = {
      rows: Math.max(1, Math.floor(size.rows)),
      columns: Math.max(1, Math.floor(size.columns)),
    };
    const session = this.#session;
    if (session) void this.#runSessionAction(session, () => session.resize(this.#size));
  }

  focus(focused: boolean): void {
    const session = this.#session;
    if (session) void this.#runSessionAction(session, () => session.focus(focused));
  }

  async cleanup(): Promise<void> {
    const generation = this.#openGeneration + 1;
    this.#openGeneration = generation;
    this.#pendingTransitionGeneration = generation;
    let session: EmbeddedNeovimSession | null = null;
    try {
      if (this.#pendingSessionStart) await this.#cancelPendingSessionStart();
      if (generation !== this.#openGeneration) return;
      session = this.#session;
      await session?.cleanup();
    } catch (error) {
      const failure = cleanupError("while releasing BUFFER", error);
      if (generation === this.#openGeneration) this.#setSnapshot("error", failure.message);
      throw failure;
    } finally {
      if (this.#pendingTransitionGeneration === generation) {
        this.#pendingTransitionGeneration = null;
      }
    }
    if (generation !== this.#openGeneration) return;
    if (session) this.#releaseSession(session);
    this.#resetFileState();
    this.#setSnapshot("idle", null);
  }

  async #cancelPendingSessionStart(): Promise<void> {
    const pendingStart = this.#pendingSessionStart;
    if (!pendingStart) return;
    pendingStart.controller.abort(new Error("Embedded Neovim startup was superseded."));
    await this.#disposePendingSessionStart(pendingStart);
  }

  async #disposePendingSessionStart(pendingStart: NeovimPendingSessionStart): Promise<void> {
    pendingStart.controller.abort(new Error("Embedded Neovim startup was superseded."));
    if (pendingStart.disposalPromise) return pendingStart.disposalPromise;

    const attempt = (async () => {
      let session = pendingStart.session;
      if (!session) {
        try {
          session = await pendingStart.promise;
          pendingStart.session = session;
        } catch (error) {
          if (error instanceof NeovimStartupCleanupError) {
            try {
              await error.retryCleanup();
            } catch (retryError) {
              throw new AggregateError(
                [error, retryError],
                `${error.message}; startup cleanup retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
                { cause: error },
              );
            }
            return;
          }
          if (pendingStart.controller.signal.aborted) return;
          throw error;
        }
      }
      try {
        await session.cleanup();
        if (this.#session === session) this.#releaseSession(session);
      } catch (error) {
        if (this.#session === null) {
          this.#session = session;
          this.#ownershipGeneration += 1;
        }
        throw error;
      }
    })();
    pendingStart.disposalPromise = attempt;
    try {
      await attempt;
      if (this.#pendingSessionStart === pendingStart) this.#pendingSessionStart = null;
    } finally {
      if (pendingStart.disposalPromise === attempt) pendingStart.disposalPromise = null;
    }
  }

  #resetFileState(): void {
    this.#ownershipGeneration += 1;
    this.#filePath = null;
    this.#absolutePath = null;
    this.#fileSnapshot = null;
    this.#encoding = null;
    this.#lineEndings = null;
    this.#dirty = false;
  }

  #captureOwnership(session: EmbeddedNeovimSession): NeovimProviderOwnership {
    return {
      generation: this.#ownershipGeneration,
      session,
      filePath: this.#filePath,
      absolutePath: this.#absolutePath,
    };
  }

  #captureOperationOwnership(session: EmbeddedNeovimSession): NeovimOperationOwnership {
    return {
      ...this.#captureOwnership(session),
      openGeneration: this.#openGeneration,
    };
  }

  #captureFileOwnership(): NeovimFileOwnership {
    return {
      generation: this.#ownershipGeneration,
      openGeneration: this.#openGeneration,
      filePath: this.#filePath,
      absolutePath: this.#absolutePath,
    };
  }

  #owns(ownership: NeovimProviderOwnership): boolean {
    return ownership.generation === this.#ownershipGeneration &&
      ownership.session === this.#session &&
      ownership.filePath === this.#filePath &&
      ownership.absolutePath === this.#absolutePath;
  }

  #ownsOperation(ownership: NeovimOperationOwnership): boolean {
    return ownership.openGeneration === this.#openGeneration && this.#owns(ownership);
  }

  #ownsFile(ownership: NeovimFileOwnership): boolean {
    return ownership.generation === this.#ownershipGeneration &&
      ownership.openGeneration === this.#openGeneration &&
      ownership.filePath === this.#filePath &&
      ownership.absolutePath === this.#absolutePath;
  }

  async #refreshDirty(ownership: NeovimOperationOwnership): Promise<void> {
    const dirty = await this.#readCurrentDirtyState(ownership);
    if (!this.#ownsOperation(ownership)) return;
    this.#dirty = dirty;
    if (!this.#dirty) {
      await this.#refreshFileSnapshot(ownership, () => this.#ownsOperation(ownership));
    }
    if (!this.#ownsOperation(ownership)) return;
    this.#emitSnapshot();
  }

  async #sendInput(session: EmbeddedNeovimSession, keys: string): Promise<void> {
    await this.#runSessionAction(session, () => session.input(keys));
  }

  async #runSessionAction(
    session: EmbeddedNeovimSession,
    action: () => Promise<unknown>,
  ): Promise<void> {
    const ownership = this.#captureOperationOwnership(session);
    try {
      await action();
    } catch (error) {
      if (this.#ownsOperation(ownership)) this.#setInputError(error);
    }
  }

  #setInputError(error: unknown): void {
    this.#setSnapshot("error", error instanceof Error ? error.message : String(error));
  }

  #restoreActionableSnapshot(
    snapshot: BufferProviderSnapshot,
    statusMessage: string | null,
    fallbackMessage: string,
  ): void {
    if (
      (snapshot.providerStatus === "error" || snapshot.providerStatus === "conflict") &&
      snapshot.error
    ) {
      this.#snapshot = snapshot;
      this.#statusMessage = statusMessage;
      this.#emit();
      return;
    }
    this.#setSnapshot("error", fallbackMessage);
  }

  async #readCurrentDirtyState(
    ownership: NeovimOperationOwnership | null = this.#session
      ? this.#captureOperationOwnership(this.#session)
      : null,
  ): Promise<boolean> {
    if (!ownership) return this.#dirty;
    return ownership.session.isDirty().then((dirty) => {
      if (!this.#ownsOperation(ownership)) return this.#dirty;
      return dirty;
    }, () => this.#dirty);
  }

  #handleDirtyChange(dirty: boolean): void {
    const session = this.#session;
    if (!session) return;
    const ownership = this.#captureOwnership(session);
    this.#dirty = dirty;
    if (dirty) {
      this.#emitSnapshot();
      return;
    }
    void this.#refreshFileSnapshot(ownership).finally(() => {
      if (this.#owns(ownership)) this.#emitSnapshot();
    });
  }

  #releaseSession(session: EmbeddedNeovimSession): void {
    if (this.#session !== session) return;
    this.#session = null;
    this.#ownershipGeneration += 1;
  }

  async #assertNoDiskConflict(
    force: boolean,
    snapshot: BufferFileSnapshot | null,
  ): Promise<void> {
    if (force || !snapshot) return;
    const current = await this.#readFileSnapshot(snapshot.absolutePath).catch(() => {
      throw new BufferSaveConflictError(snapshot.filePath);
    });
    if (current.mtimeMs !== snapshot.mtimeMs || current.content !== snapshot.content) {
      throw new BufferSaveConflictError(snapshot.filePath);
    }
  }

  async #refreshFileSnapshot(
    ownership: NeovimProviderOwnership,
    owns: () => boolean = () => this.#owns(ownership),
  ): Promise<void> {
    const paths = refreshableFileSnapshotPaths(ownership.absolutePath, ownership.filePath);
    if (!paths) return;
    try {
      const file = await this.#readFileSnapshot(paths.absolutePath);
      if (!owns()) return;
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
      lineCount: this.#terminal.lines.length,
      position: positionFromNeovimCursor(this.#terminal.cursor.row + 1, this.#terminal.cursor.column),
      viewportRows: this.#size.rows,
      terminal: this.#terminal,
      vimMode: neovimModeToVimMode(this.#terminal.mode),
      vimCommandLine: this.#terminal.commandLine,
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

function cleanupError(context: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Embedded Neovim cleanup failed ${context}: ${message}`, { cause: error });
}
