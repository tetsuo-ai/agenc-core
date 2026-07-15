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
  #replacementPromise: Promise<boolean> | null = null;

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
      try {
        await cleanupPromise;
      } catch (error) {
        if (generation === this.#openGeneration) {
          this.#recordProviderFailure(this.#provider, error, "BUFFER provider cleanup failed");
        }
        return;
      }
      if (generation !== this.#openGeneration) {
        return;
      }
    }
    const replacementPromise = this.#replacementPromise;
    if (replacementPromise) {
      try {
        await replacementPromise;
      } catch (error) {
        if (generation === this.#openGeneration) {
          this.#recordProviderFailure(this.#provider, error, "BUFFER provider replacement failed");
        }
        return;
      }
      if (generation !== this.#openGeneration) return;
    }
    let selection: BufferProviderSelection;
    try {
      selection = await this.#selectionFactory();
    } catch (error) {
      if (generation === this.#openGeneration) {
        this.#recordProviderFailure(this.#provider, error, "BUFFER provider open failed");
      }
      return;
    }
    if (generation !== this.#openGeneration) {
      return;
    }
    const selectedProvider = selection.provider;
    const provider = this.#provider?.identity.kind === selectedProvider.identity.kind
      ? this.#provider
      : selectedProvider;
    try {
      if (!await this.#replaceProvider(provider, generation)) return;
    } catch {
      return;
    }
    if (generation !== this.#openGeneration || this.#provider !== provider) return;
    try {
      await provider.open({ filePath, line });
    } catch (error) {
      if (generation === this.#openGeneration) {
        this.#recordProviderFailure(this.#provider ?? provider, error, "BUFFER provider open failed");
      }
      return;
    }
    if (generation !== this.#openGeneration || this.#provider !== provider) return;
    this.#syncSnapshot();
  }

  async save(options: BufferProviderSaveOptions = {}): Promise<boolean> {
    return this.#provider?.save(options) ?? false;
  }

  async revert(): Promise<void> {
    await this.#provider?.revert();
  }

  async close(options: BufferProviderCloseOptions = {}): Promise<boolean> {
    const generation = this.#openGeneration + 1;
    this.#openGeneration = generation;
    const replacementPromise = this.#replacementPromise;
    if (replacementPromise) {
      try {
        await replacementPromise;
      } catch (error) {
        if (generation === this.#openGeneration) {
          this.#recordProviderFailure(this.#provider, error, "BUFFER provider replacement failed");
        }
        return false;
      }
      if (generation !== this.#openGeneration) return false;
    }
    const cleanupPromise = this.#cleanupPromise;
    if (cleanupPromise) {
      try {
        await cleanupPromise;
      } catch (error) {
        if (generation === this.#openGeneration) {
          this.#recordProviderFailure(this.#provider, error, "BUFFER provider cleanup failed");
        }
        return false;
      }
      if (generation !== this.#openGeneration) return false;
    }
    const provider = this.#provider;
    const closed = await provider?.close(options) ?? true;
    if (generation !== this.#openGeneration || provider !== this.#provider) return false;
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
    isPaste = false,
  ): boolean {
    return this.#provider?.handleInput({ input, key, isPaste, context, onInlineCommand }) ?? false;
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
    const generation = this.#openGeneration + 1;
    this.#openGeneration = generation;
    const replacementPromise = this.#replacementPromise;
    if (replacementPromise) {
      // A replacement owns teardown until it settles. This cleanup generation
      // makes installation stale; then cleanup can retry any retained provider.
      await replacementPromise.catch(() => false);
      if (generation !== this.#openGeneration) return;
    }
    if (this.#cleanupPromise) {
      await this.#cleanupPromise;
      if (generation === this.#openGeneration) this.#lastOpen = null;
      return;
    }
    const provider = this.#provider;
    const unsubscribe = this.#providerUnsubscribe;
    this.#cleanupPromise = (async () => {
      try {
        await provider?.cleanup();
      } catch (error) {
        this.#recordProviderFailure(provider, error, "BUFFER provider cleanup failed");
        throw error;
      }
      if (this.#provider !== provider) return;
      if (generation === this.#openGeneration) this.#lastOpen = null;
      unsubscribe?.();
      this.#provider = null;
      this.#providerUnsubscribe = null;
      this.#snapshot = emptyProviderSnapshot(INITIAL_IDENTITY);
      this.#emit();
    })().finally(() => {
      this.#cleanupPromise = null;
    });
    return this.#cleanupPromise;
  }

  async reopen(): Promise<void> {
    const lastOpen = this.#lastOpen;
    if (lastOpen) await this.open(lastOpen.filePath, lastOpen.line);
  }

  async #replaceProvider(provider: BufferEditorProvider, generation: number): Promise<boolean> {
    if (this.#provider === provider) return true;
    if (this.#replacementPromise) {
      await this.#replacementPromise;
      if (generation !== this.#openGeneration) return false;
      return this.#replaceProvider(provider, generation);
    }
    const replacement = this.#replaceProviderOnce(provider, generation);
    this.#replacementPromise = replacement;
    try {
      return await replacement;
    } finally {
      if (this.#replacementPromise === replacement) this.#replacementPromise = null;
    }
  }

  async #replaceProviderOnce(
    provider: BufferEditorProvider,
    generation: number,
  ): Promise<boolean> {
    const previousProvider = this.#provider;
    const previousUnsubscribe = this.#providerUnsubscribe;
    if (previousProvider) {
      try {
        const closed = await previousProvider.close({ discard: false });
        if (!closed) {
          this.#recordProviderCloseRefusal(previousProvider);
          return false;
        }
      } catch (error) {
        this.#recordProviderFailure(previousProvider, error, "BUFFER provider close failed");
        throw error;
      }
      try {
        await previousProvider.cleanup();
      } catch (error) {
        this.#recordProviderFailure(previousProvider, error, "BUFFER provider cleanup failed");
        throw error;
      }
    }
    if (this.#provider !== previousProvider) return false;
    previousUnsubscribe?.();
    this.#provider = null;
    this.#providerUnsubscribe = null;
    if (generation !== this.#openGeneration) {
      this.#snapshot = emptyProviderSnapshot(INITIAL_IDENTITY);
      this.#emit();
      return false;
    }
    this.#provider = provider;
    this.#providerUnsubscribe = provider.subscribe(() => this.#syncSnapshot());
    if (this.#lastSize) provider.resize(this.#lastSize);
    this.#syncSnapshot();
    return true;
  }

  #syncSnapshot(): void {
    if (!this.#provider) return;
    this.#snapshot = this.#provider.getSnapshot();
    this.#emit();
  }

  #publishDirtyOpenConflict(providerSnapshot: BufferProviderSnapshot): void {
    const message = "Unsaved edits. Save, revert, or close-discard before opening another file.";
    this.#snapshot = {
      ...providerSnapshot,
      status: "conflict",
      providerStatus: "conflict",
      providerMessage: message,
      error: message,
      conflictKind: "disk",
    };
    this.#emit();
  }

  #recordProviderCloseRefusal(provider: BufferEditorProvider): void {
    const snapshot = provider.getSnapshot();
    if (
      (snapshot.providerStatus === "conflict" || snapshot.providerStatus === "error") &&
      snapshot.error
    ) {
      this.#snapshot = snapshot;
      this.#emit();
      return;
    }
    if (snapshot.dirty) {
      this.#publishDirtyOpenConflict(snapshot);
      return;
    }
    this.#recordProviderFailure(
      provider,
      new Error("active provider refused a non-discarding close"),
      "BUFFER provider replacement blocked",
    );
  }

  #recordProviderFailure(
    provider: BufferEditorProvider | null,
    error: unknown,
    context: string,
  ): void {
    const providerSnapshot = provider?.getSnapshot();
    if (providerSnapshot?.providerStatus === "error" && providerSnapshot.error) {
      this.#snapshot = providerSnapshot;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      this.#snapshot = {
        ...this.#snapshot,
        status: "error",
        providerStatus: "error",
        providerMessage: `${context}: ${message}`,
        error: `${context}: ${message}`,
        conflictKind: null,
      };
    }
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

export async function resetWorkbenchBufferProviderControllerForTesting(): Promise<void> {
  const controller = singleton;
  singleton = null;
  await controller?.cleanup();
}

function defaultSelectionFactory(): Promise<BufferProviderSelection> {
  return selectBufferEditorProvider({
    ...bufferProviderConfigFromEnv(),
    inlineStore: getWorkbenchBufferStore(),
  });
}
