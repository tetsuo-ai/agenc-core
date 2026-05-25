import type { BufferMove } from "../editing.js";
import {
  getWorkbenchBufferStore,
  type BufferVimCommand,
  type BufferVisibleLine,
} from "../BufferStore.js";
import {
  bufferProviderConfigFromEnv,
  selectBufferEditorProvider,
  type BufferProviderSelection,
} from "./selectBufferEditorProvider.js";
import type {
  BufferEditorProvider,
  BufferProviderCloseOptions,
  BufferProviderInput,
  BufferProviderListener,
  BufferProviderOpenOptions,
  BufferProviderResize,
  BufferProviderSaveOptions,
  BufferProviderSnapshot,
} from "./types.js";
import { emptyProviderSnapshot, INLINE_BUFFER_CAPABILITIES } from "./types.js";

type SelectionFactory = () => Promise<BufferProviderSelection>;

const INITIAL_IDENTITY = {
  kind: "inline" as const,
  label: "basic inline BUFFER fallback",
  fallbackReason: "BUFFER provider has not opened a file yet.",
  capabilities: INLINE_BUFFER_CAPABILITIES,
};

export class BufferProviderController {
  readonly #listeners = new Set<BufferProviderListener>();
  #provider: BufferEditorProvider | null = null;
  #providerUnsubscribe: (() => void) | null = null;
  #selectionFactory: SelectionFactory;
  #snapshot: BufferProviderSnapshot = emptyProviderSnapshot(INITIAL_IDENTITY);
  #lastOpen: BufferProviderOpenOptions | null = null;
  #lastSize: BufferProviderResize | null = null;
  #openGeneration = 0;
  #cleanupPromise: Promise<void> | null = null;

  constructor(selectionFactory: SelectionFactory = defaultSelectionFactory) {
    this.#selectionFactory = selectionFactory;
  }

  setSelectionFactoryForTesting(selectionFactory: SelectionFactory): void {
    this.#selectionFactory = selectionFactory;
  }

  subscribe = (listener: BufferProviderListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): BufferProviderSnapshot => this.#snapshot;

  getVisibleLines(): readonly BufferVisibleLine[] {
    return this.#provider?.getVisibleLines() ?? [];
  }

  async open(filePath: string, line = 1): Promise<void> {
    const generation = this.#openGeneration + 1;
    this.#openGeneration = generation;
    this.#lastOpen = { filePath, line };
    const cleanupPromise = this.#cleanupPromise;
    if (cleanupPromise) {
      await cleanupPromise;
      if (generation !== this.#openGeneration) {
        return;
      }
    }
    const selection = await this.#selectionFactory();
    if (generation !== this.#openGeneration) {
      return;
    }
    const selectedProvider = selection.provider;
    const provider = this.#provider?.identity.kind === selectedProvider.identity.kind
      ? this.#provider
      : selectedProvider;
    await this.#replaceProvider(provider);
    await provider.open({ filePath, line });
    this.#syncSnapshot();
  }

  async save(options: BufferProviderSaveOptions = {}): Promise<boolean> {
    return this.#provider?.save(options) ?? false;
  }

  async revert(): Promise<void> {
    await this.#provider?.revert();
  }

  async close(options: BufferProviderCloseOptions = {}): Promise<boolean> {
    const closed = await this.#provider?.close(options) ?? true;
    if (closed) this.#lastOpen = null;
    return closed;
  }

  async openExternalEditor(): Promise<boolean> {
    return this.#provider?.openExternalEditor() ?? false;
  }

  undo(): boolean {
    return this.#provider?.undo() ?? false;
  }

  redo(): boolean {
    return this.#provider?.redo() ?? false;
  }

  move(move: BufferMove, options: { readonly extend?: boolean; readonly pageSize?: number } = {}): boolean {
    return this.#provider?.move(move, options) ?? false;
  }

  requestHover(): Promise<string | null> {
    return this.#provider?.requestHover() ?? Promise.resolve(null);
  }

  goToDefinition(): Promise<boolean> {
    return this.#provider?.goToDefinition() ?? Promise.resolve(false);
  }

  handleInput(
    input: string,
    key: BufferProviderInput["key"],
    context: BufferProviderInput["context"],
    onInlineCommand?: (command: BufferVimCommand) => void,
  ): boolean {
    return this.#provider?.handleInput({ input, key, context, onInlineCommand }) ?? false;
  }

  click(row: number, column: number): boolean {
    return this.#provider?.click(row, column) ?? false;
  }

  resize(size: BufferProviderResize): void {
    this.#lastSize = size;
    this.#provider?.resize(size);
  }

  focus(focused: boolean): void {
    this.#provider?.focus(focused);
  }

  async cleanup(): Promise<void> {
    this.#openGeneration += 1;
    if (this.#cleanupPromise) return this.#cleanupPromise;
    const provider = this.#provider;
    const unsubscribe = this.#providerUnsubscribe;
    this.#provider = null;
    this.#providerUnsubscribe = null;
    this.#lastOpen = null;
    this.#snapshot = emptyProviderSnapshot(INITIAL_IDENTITY);
    unsubscribe?.();
    this.#cleanupPromise = (async () => {
      await provider?.cleanup();
    })().finally(() => {
      this.#cleanupPromise = null;
    });
    this.#emit();
    return this.#cleanupPromise;
  }

  async reopen(): Promise<void> {
    const lastOpen = this.#lastOpen;
    if (lastOpen) await this.open(lastOpen.filePath, lastOpen.line);
  }

  async #replaceProvider(provider: BufferEditorProvider): Promise<void> {
    if (this.#provider === provider) return;
    this.#providerUnsubscribe?.();
    await this.#provider?.cleanup();
    this.#provider = provider;
    this.#providerUnsubscribe = provider.subscribe(() => this.#syncSnapshot());
    if (this.#lastSize) provider.resize(this.#lastSize);
    this.#syncSnapshot();
  }

  #syncSnapshot(): void {
    if (!this.#provider) return;
    this.#snapshot = this.#provider.getSnapshot();
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

let singleton: BufferProviderController | null = null;

export function getWorkbenchBufferProviderController(): BufferProviderController {
  singleton ??= new BufferProviderController();
  return singleton;
}

export function resetWorkbenchBufferProviderControllerForTesting(): void {
  void singleton?.cleanup();
  singleton = null;
}

function defaultSelectionFactory(): Promise<BufferProviderSelection> {
  return selectBufferEditorProvider({
    ...bufferProviderConfigFromEnv(),
    inlineStore: getWorkbenchBufferStore(),
  });
}
