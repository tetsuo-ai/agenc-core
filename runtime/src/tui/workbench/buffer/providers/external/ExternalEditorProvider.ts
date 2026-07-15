import {
  openFileInBufferExternalEditor,
  type BufferExternalEditorLauncher,
} from "../../externalEditor.js";
import { readBufferFileSnapshot, type BufferFileSnapshot } from "../../fileSnapshot.js";
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
import { emptyProviderSnapshot } from "../types.js";

export class ExternalEditorProvider implements BufferEditorProvider {
  readonly identity: BufferProviderIdentity = {
    kind: "external",
    label: "external editor handoff",
    fallbackReason: null,
    capabilities: {
      vimExact: false,
      terminalUi: false,
      mouse: false,
      clipboard: false,
      dirtyState: false,
      lspPassthrough: false,
      multiBuffer: false,
    },
  };
  readonly #listeners = new Set<BufferProviderListener>();
  readonly #launcher: BufferExternalEditorLauncher;
  readonly #readFileSnapshot: (filePath: string) => Promise<BufferFileSnapshot>;
  #snapshot: BufferProviderSnapshot = emptyProviderSnapshot(this.identity);
  #openGeneration = 0;

  constructor(
    launcher: BufferExternalEditorLauncher = openFileInBufferExternalEditor,
    readFileSnapshot: (filePath: string) => Promise<BufferFileSnapshot> = readBufferFileSnapshot,
  ) {
    this.#launcher = launcher;
    this.#readFileSnapshot = readFileSnapshot;
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
    let file: BufferFileSnapshot;
    try {
      file = await this.#readFileSnapshot(options.filePath);
    } catch (error) {
      if (generation !== this.#openGeneration) return;
      throw error;
    }
    if (generation !== this.#openGeneration) return;
    let opened = false;
    let launchError: string | null = null;
    try {
      opened = this.#launcher(file.absolutePath, options.line ?? 1);
    } catch (error) {
      launchError = error instanceof Error ? error.message : String(error);
    }
    this.#snapshot = {
      ...emptyProviderSnapshot(this.identity),
      status: opened ? "ready" : "error",
      providerStatus: opened ? "ready" : "error",
      filePath: file.filePath,
      absolutePath: file.absolutePath,
      error: opened ? null : launchError ?? "No external editor is available for BUFFER. Set VISUAL or EDITOR.",
      providerMessage: opened ? "External editor completed." : "External editor launch failed.",
    };
    this.#emit();
  }

  async save(_options: BufferProviderSaveOptions = {}): Promise<boolean> {
    return false;
  }

  async revert(): Promise<void> {
  }

  async close(_options: BufferProviderCloseOptions = {}): Promise<boolean> {
    this.#openGeneration += 1;
    this.#snapshot = emptyProviderSnapshot(this.identity);
    this.#emit();
    return true;
  }

  async openExternalEditor(): Promise<boolean> {
    return false;
  }

  undo(): boolean {
    return false;
  }

  redo(): boolean {
    return false;
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

  handleInput(_event: BufferProviderInput): boolean {
    return false;
  }

  click(_row: number, _column: number): boolean {
    return false;
  }

  resize(_size: BufferProviderResize): void {
  }

  focus(_focused: boolean): void {
  }

  async cleanup(): Promise<void> {
    await this.close();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
