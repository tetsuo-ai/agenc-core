import {
  WorkbenchBufferStore,
  type BufferVisibleLine,
} from "../../BufferStore.js";
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
import { INLINE_BUFFER_CAPABILITIES, withProviderSnapshot } from "../types.js";

export type InlineBufferProviderOptions = {
  readonly reason: string | null;
  readonly store?: WorkbenchBufferStore;
};

export class InlineBufferProvider implements BufferEditorProvider {
  readonly identity: BufferProviderIdentity;
  readonly #store: WorkbenchBufferStore;

  constructor(options: InlineBufferProviderOptions) {
    this.#store = options.store ?? new WorkbenchBufferStore();
    this.identity = {
      kind: "inline",
      label: "basic inline BUFFER fallback",
      fallbackReason: options.reason,
      capabilities: INLINE_BUFFER_CAPABILITIES,
    };
  }

  subscribe(listener: BufferProviderListener): () => void {
    return this.#store.subscribe(listener);
  }

  getSnapshot(): BufferProviderSnapshot {
    const snapshot = this.#store.getSnapshot();
    return withProviderSnapshot(snapshot, this.identity);
  }

  getVisibleLines(): readonly BufferVisibleLine[] {
    return this.#store.getVisibleLines();
  }

  async open(options: BufferProviderOpenOptions): Promise<void> {
    await this.#store.open(options.filePath, options.line ?? 1);
  }

  async save(options: BufferProviderSaveOptions = {}): Promise<boolean> {
    return this.#store.save(options);
  }

  async revert(): Promise<void> {
    await this.#store.revert();
  }

  async close(options: BufferProviderCloseOptions = {}): Promise<boolean> {
    return this.#store.close(options);
  }

  async openExternalEditor(): Promise<boolean> {
    return this.#store.openExternalEditor();
  }

  undo(): boolean {
    this.#store.undo();
    return true;
  }

  redo(): boolean {
    this.#store.redo();
    return true;
  }

  move(move: BufferMove, options: { readonly extend?: boolean; readonly pageSize?: number } = {}): boolean {
    this.#store.move(move, options);
    return true;
  }

  requestHover(): Promise<string | null> {
    return this.#store.requestHover();
  }

  goToDefinition(): Promise<boolean> {
    return this.#store.goToDefinition();
  }

  handleInput(event: BufferProviderInput): boolean {
    return this.#store.handleVimInput(
      event.input,
      event.key,
      Math.max(20, event.context.columns),
      event.onInlineCommand,
    );
  }

  click(_row: number, _column: number): boolean {
    return false;
  }

  resize(size: BufferProviderResize): void {
    this.#store.setViewportRows(size.rows);
  }

  focus(_focused: boolean): void {
  }

  async cleanup(): Promise<void> {
    this.#store.close({ discard: true });
  }
}
