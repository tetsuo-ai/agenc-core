import type { BufferMove } from "../editing.js";
import {
  getWorkbenchBufferStore,
  type BufferVimCommand,
  type BufferVisibleLine,
} from "../BufferStore.js";
import {
  bufferProviderConfigFromEnv,
  bufferProviderConfigFromSources,
  selectBufferEditorProvider,
  type BufferProviderSelection,
} from "./selectBufferEditorProvider.js";
import type { BufferConfig, BufferTabsMode } from "../../../../config/schema.js";
import type {
  EmbeddedNeovimStartupContext,
  EmbeddedNeovimStartupPreparation,
} from "../neovim/NeovimLifecycle.js";
import type {
  BufferEditorProvider,
  BufferCaptureRequest,
  BufferCapturedContext,
  BufferIntegrationIntentListener,
  BufferProviderBuffer,
  BufferProviderCloseOptions,
  BufferProviderInput,
  BufferProviderListener,
  BufferProviderOpenOptions,
  BufferProviderPathMutationResult,
  BufferProviderResize,
  BufferRecoveryAction,
  BufferRecoveryResult,
  BufferProviderSaveOptions,
  BufferProviderSaveAllResult,
  BufferProviderShutdownOptions,
  BufferProviderSnapshot,
} from "./types.js";
import { emptyProviderSnapshot, INLINE_BUFFER_CAPABILITIES } from "./types.js";

type SelectionFactory = () => Promise<BufferProviderSelection>;

export type BufferProviderRuntimeContext = {
  readonly workspaceRoot?: string;
  readonly agencHome?: string;
  readonly beforeOpenFile?: (
    context: EmbeddedNeovimStartupContext,
  ) => Promise<EmbeddedNeovimStartupPreparation | void>;
};

const INITIAL_IDENTITY = {
  kind: "inline" as const,
  label: "basic inline BUFFER fallback",
  fallbackReason: "BUFFER provider has not opened a file yet.",
  capabilities: INLINE_BUFFER_CAPABILITIES,
};

export class BufferProviderController {
  readonly #listeners = new Set<BufferProviderListener>();
  readonly #integrationIntentListeners = new Set<BufferIntegrationIntentListener>();
  #provider: BufferEditorProvider | null = null;
  #providerUnsubscribe: (() => void) | null = null;
  #providerIntegrationUnsubscribe: (() => void) | null = null;
  #selectionFactory: SelectionFactory;
  #snapshot: BufferProviderSnapshot = emptyProviderSnapshot(INITIAL_IDENTITY);
  #lastOpen: BufferProviderOpenOptions | null = null;
  #lastSize: BufferProviderResize | null = null;
  #openGeneration = 0;
  #cleanupPromise: Promise<void> | null = null;
  #replacementPromise: Promise<boolean> | null = null;
  #restartPromise: Promise<boolean> | null = null;
  #deferredOpen: BufferProviderOpenOptions | null = null;
  #configuredBuffer: BufferConfig | undefined;
  #configuredEnv: NodeJS.ProcessEnv | undefined;
  #configuredRuntimeContext: BufferProviderRuntimeContext | undefined;
  #configurationGeneration = 0;
  #providerConfigurationGeneration = -1;
  #automaticInlineFallbackGeneration: number | null = null;
  #usesDefaultSelectionFactory: boolean;

  constructor(selectionFactory?: SelectionFactory) {
    this.#usesDefaultSelectionFactory = selectionFactory === undefined;
    this.#selectionFactory = selectionFactory ??
      (() => defaultSelectionFactory(
        this.#configuredBuffer,
        this.#configuredEnv,
        this.#configuredRuntimeContext,
      ));
  }

  setSelectionFactoryForTesting(selectionFactory: SelectionFactory): void {
    this.#usesDefaultSelectionFactory = false;
    this.#selectionFactory = selectionFactory;
  }

  /**
   * Cache persisted BUFFER configuration for the next provider acquisition.
   * A live provider is intentionally not replaced here: replacement must first
   * pass through the Workbench all-buffer Save/Discard/Cancel transaction.
   */
  configure(
    config: BufferConfig | undefined,
    env?: NodeJS.ProcessEnv,
    runtimeContext?: BufferProviderRuntimeContext,
  ): void {
    if (
      this.#configuredBuffer === config &&
      this.#configuredEnv === env &&
      this.#configuredRuntimeContext === runtimeContext
    ) {
      return;
    }
    this.#configuredBuffer = config;
    this.#configuredEnv = env;
    this.#configuredRuntimeContext = runtimeContext;
    this.#configurationGeneration += 1;
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

  getShowTabsMode(): BufferTabsMode {
    return this.#configuredBuffer?.show_tabs ?? "auto";
  }

  async open(filePath: string, line = 1): Promise<void> {
    await this.#open(filePath, line);
  }

  async #open(
    filePath: string,
    line = 1,
    selectionFactory = this.#selectionFactory,
  ): Promise<void> {
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

    // Once auto mode has safely fallen back after a contained startup
    // failure, keep that inline provider for this configuration generation.
    // Project navigation must not relaunch the same broken Neovim startup for
    // every file.
    const automaticInlineProvider =
      this.#automaticInlineFallbackGeneration ===
          this.#configurationGeneration &&
        this.#provider?.identity.kind === "inline"
        ? this.#provider
        : null;
    if (automaticInlineProvider) {
      try {
        await automaticInlineProvider.open({ filePath, line });
      } catch (error) {
        if (
          generation === this.#openGeneration &&
          this.#provider === automaticInlineProvider
        ) {
          this.#recordProviderFailure(
            automaticInlineProvider,
            error,
            "Inline BUFFER fallback open failed",
          );
        }
        return;
      }
      if (
        generation === this.#openGeneration &&
        this.#provider === automaticInlineProvider
      ) {
        this.#deferredOpen = null;
        this.#syncSnapshot();
      }
      return;
    }

    // An explicitly configured inline provider owns the singleton inline
    // store. Reuse it directly for navigation. Selecting another same-kind
    // candidate and then cleaning that unused candidate can close the shared
    // store underneath the live provider, silently discarding dirty edits
    // before the live provider gets a chance to reject the open.
    const configuredInlineProvider =
      this.#usesDefaultSelectionFactory &&
        this.#providerConfigurationGeneration === this.#configurationGeneration &&
        this.#provider?.identity.kind === "inline"
        ? this.#provider
        : null;
    if (configuredInlineProvider) {
      try {
        await configuredInlineProvider.open({ filePath, line });
      } catch (error) {
        if (
          generation === this.#openGeneration &&
          this.#provider === configuredInlineProvider
        ) {
          this.#recordProviderFailure(
            configuredInlineProvider,
            error,
            "Inline BUFFER open failed",
          );
        }
        return;
      }
      if (
        generation === this.#openGeneration &&
        this.#provider === configuredInlineProvider
      ) {
        this.#deferredOpen = null;
        this.#syncSnapshot();
      }
      return;
    }

    // A multi-buffer provider owns a workspace session. Reuse it directly so
    // navigation cannot rerun discovery or replace the live Neovim process.
    const workspaceProvider = this.#provider?.identity.capabilities.multiBuffer &&
        this.#provider.inspectDirtyBuffers &&
        this.#provider.saveAll &&
        (
          this.#providerConfigurationGeneration === this.#configurationGeneration ||
          this.#snapshot.providerStatus !== "closed"
        )
      ? this.#provider
      : null;
    if (workspaceProvider) {
      try {
        await workspaceProvider.open({ filePath, line });
      } catch (error) {
        if (generation === this.#openGeneration && this.#provider === workspaceProvider) {
          this.#recordProviderFailure(workspaceProvider, error, "BUFFER provider open failed");
        }
        return;
      }
      if (generation === this.#openGeneration && this.#provider === workspaceProvider) {
        this.#deferredOpen = null;
        this.#syncSnapshot();
      }
      return;
    }

    const selectionConfigurationGeneration = this.#configurationGeneration;
    let selection: BufferProviderSelection;
    try {
      selection = await selectionFactory();
    } catch (error) {
      if (generation === this.#openGeneration) {
        this.#recordProviderFailure(this.#provider, error, "BUFFER provider open failed");
      }
      return;
    }
    if (generation !== this.#openGeneration) {
      return;
    }
    if (selectionConfigurationGeneration !== this.#configurationGeneration) {
      await selection.provider.cleanup().catch(() => {});
      await this.#open(filePath, line, selectionFactory);
      return;
    }
    const selectedProvider = selection.provider;
    const provider =
      this.#providerConfigurationGeneration === this.#configurationGeneration &&
        this.#provider?.identity.kind === selectedProvider.identity.kind
      ? this.#provider
      : selectedProvider;
    if (provider !== selectedProvider) {
      // Selection factories return controller-owned provider candidates. When
      // the installed same-kind provider is reused, release the unopened
      // candidate immediately instead of leaking any resources it acquired
      // during selection.
      try {
        await selectedProvider.cleanup();
      } catch (error) {
        if (generation === this.#openGeneration) {
          this.#recordProviderFailure(
            this.#provider,
            error,
            "Unused BUFFER provider cleanup failed",
          );
        }
        return;
      }
      if (generation !== this.#openGeneration) return;
      if (
        selectionConfigurationGeneration !== this.#configurationGeneration
      ) {
        await this.#open(filePath, line, selectionFactory);
        return;
      }
    }
    try {
      if (
        !await this.#replaceProvider(
          provider,
          generation,
          selectionConfigurationGeneration,
        )
      ) {
        if (
          generation === this.#openGeneration &&
          selectionConfigurationGeneration !== this.#configurationGeneration
        ) {
          await this.#open(filePath, line, selectionFactory);
        } else if (generation === this.#openGeneration) {
          this.#deferredOpen = { filePath, line };
        }
        return;
      }
    } catch {
      return;
    }
    if (generation !== this.#openGeneration || this.#provider !== provider) return;
    this.#automaticInlineFallbackGeneration = null;
    let providerOpenFailed = false;
    let providerOpenError: unknown;
    try {
      await provider.open({ filePath, line });
    } catch (error) {
      providerOpenFailed = true;
      providerOpenError = error;
    }
    if (generation !== this.#openGeneration || this.#provider !== provider) return;

    const startupFallback =
      selection.kind === "neovim"
        ? selection.startupFailureFallback
        : undefined;
    const startupFailureReason = startupFallback?.failureReason() ?? null;
    // A provider may both reject open() and retain the stronger verified-safe
    // startup marker. That marker takes precedence and permits auto fallback;
    // an arbitrary rejection without it remains a provider error.
    if (startupFallback && startupFailureReason !== null) {
      let inlineProvider: BufferEditorProvider;
      try {
        inlineProvider = startupFallback.createProvider(startupFailureReason);
      } catch (error) {
        this.#recordProviderFailure(
          provider,
          error,
          "Inline BUFFER startup fallback creation failed",
        );
        return;
      }
      try {
        if (
          !await this.#replaceProvider(
            inlineProvider,
            generation,
            selectionConfigurationGeneration,
          )
        ) {
          return;
        }
      } catch {
        return;
      }
      if (
        generation !== this.#openGeneration ||
        this.#provider !== inlineProvider
      ) {
        return;
      }
      this.#automaticInlineFallbackGeneration =
        selectionConfigurationGeneration;
      try {
        await inlineProvider.open({ filePath, line });
      } catch (error) {
        if (
          generation === this.#openGeneration &&
          this.#provider === inlineProvider
        ) {
          this.#recordProviderFailure(
            inlineProvider,
            error,
            "Inline BUFFER startup fallback open failed",
          );
        }
        return;
      }
      if (
        generation !== this.#openGeneration ||
        this.#provider !== inlineProvider
      ) {
        return;
      }
      this.#deferredOpen = null;
      this.#syncSnapshot();
      return;
    }
    if (providerOpenFailed) {
      this.#recordProviderFailure(
        this.#provider ?? provider,
        providerOpenError,
        "BUFFER provider open failed",
      );
      return;
    }
    this.#deferredOpen = null;
    this.#syncSnapshot();
  }

  async save(options: BufferProviderSaveOptions = {}): Promise<boolean> {
    return this.#provider?.save(options) ?? false;
  }

  async inspectDirtyBuffers(): Promise<readonly BufferProviderBuffer[]> {
    const provider = this.#provider;
    if (!provider) return [];
    if (provider.inspectDirtyBuffers) return provider.inspectDirtyBuffers();
    return provider.getSnapshot().buffers.filter((buffer) => buffer.modified);
  }

  async selectBuffer(handle: number): Promise<boolean> {
    const provider = this.#provider;
    if (!provider) return false;
    if (provider.selectBuffer) return provider.selectBuffer(handle);
    return provider.getSnapshot().activeBufferHandle === handle;
  }

  async saveBuffer(
    handle: number,
    options: BufferProviderSaveOptions = {},
  ): Promise<boolean> {
    const provider = this.#provider;
    if (!provider) return false;
    if (provider.saveBuffer) return provider.saveBuffer(handle, options);
    const snapshot = provider.getSnapshot();
    return snapshot.activeBufferHandle === handle
      ? provider.save(options)
      : false;
  }

  async saveAll(
    options: BufferProviderSaveOptions = {},
  ): Promise<BufferProviderSaveAllResult> {
    const provider = this.#provider;
    if (!provider) return { saved: true, buffers: [] };
    if (provider.saveAll) return provider.saveAll(options);
    const dirtyBuffers = provider.getSnapshot().buffers.filter((buffer) => buffer.modified);
    if (dirtyBuffers.length === 0) return { saved: true, buffers: [] };
    const saved = await provider.save(options);
    return saved
      ? {
          saved: true,
          buffers: dirtyBuffers.map((buffer) => ({ ...buffer, modified: false })),
        }
      : {
          saved: false,
          reason: provider.getSnapshot().error ?? "The active BUFFER could not be saved.",
          blockedBuffers: dirtyBuffers,
        };
  }

  async prepareDiscardAll(): Promise<string | null> {
    const provider = this.#provider;
    if (!provider) return "no-provider";
    return provider.prepareDiscardAll?.() ?? null;
  }

  async discardAll(confirmationToken?: string): Promise<boolean> {
    const provider = this.#provider;
    if (!provider) return true;
    if (provider.discardAll) return provider.discardAll(confirmationToken);
    return false;
  }

  beginProjectPathMutation(): boolean {
    return this.#provider?.beginProjectPathMutation?.() ?? true;
  }

  endProjectPathMutation(): void {
    this.#provider?.endProjectPathMutation?.();
  }

  async synchronizePathRename(
    fromPath: string,
    toPath: string,
  ): Promise<BufferProviderPathMutationResult> {
    const provider = this.#provider;
    if (!provider?.synchronizePathRename) {
      return { ok: true, affectedBufferHandles: [] };
    }
    const result = await provider.synchronizePathRename(fromPath, toPath);
    if (provider === this.#provider) this.#syncSnapshot();
    return result;
  }

  async synchronizePathDelete(
    path: string,
  ): Promise<BufferProviderPathMutationResult> {
    const provider = this.#provider;
    if (!provider?.synchronizePathDelete) {
      return { ok: true, affectedBufferHandles: [] };
    }
    const result = await provider.synchronizePathDelete(path);
    if (provider === this.#provider) this.#syncSnapshot();
    return result;
  }

  async shutdown(options: BufferProviderShutdownOptions = {}): Promise<boolean> {
    const provider = this.#provider;
    if (!provider) return true;
    if (provider.shutdown) return provider.shutdown(options);
    return provider.close({ discard: options.mode === "discard" });
  }

  captureContext(request: BufferCaptureRequest): Promise<BufferCapturedContext | null> {
    return this.#provider?.captureContext?.(request) ?? Promise.resolve(null);
  }

  resolveRecovery(action: BufferRecoveryAction): Promise<BufferRecoveryResult> {
    return this.#provider?.resolveRecovery?.(action) ??
      Promise.resolve({ ok: false, reason: "No BUFFER recovery is pending." });
  }

  subscribeIntegrationIntents(listener: BufferIntegrationIntentListener): () => void {
    this.#integrationIntentListeners.add(listener);
    return () => {
      this.#integrationIntentListeners.delete(listener);
    };
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
    const unsubscribeIntegration = this.#providerIntegrationUnsubscribe;
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
      unsubscribeIntegration?.();
      this.#provider = null;
      this.#automaticInlineFallbackGeneration = null;
      this.#providerUnsubscribe = null;
      this.#providerIntegrationUnsubscribe = null;
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

  async restartAfterCrash(
    mode: "configured" | "clean" | "inline",
  ): Promise<boolean> {
    if (this.#restartPromise) return this.#restartPromise;
    const restart = this.#restartAfterCrashOnce(mode);
    this.#restartPromise = restart;
    try {
      return await restart;
    } finally {
      if (this.#restartPromise === restart) this.#restartPromise = null;
    }
  }

  async #restartAfterCrashOnce(
    mode: "configured" | "clean" | "inline",
  ): Promise<boolean> {
    const lastOpen = this.#lastOpen;
    if (!lastOpen) return false;
    if (mode === "configured") {
      await this.cleanup();
      await this.open(lastOpen.filePath, lastOpen.line);
      return this.#snapshot.providerStatus === "ready";
    }

    await this.cleanup();
    const base = this.#configuredBuffer
      ? bufferProviderConfigFromSources(this.#configuredBuffer, this.#configuredEnv)
      : bufferProviderConfigFromEnv(this.#configuredEnv);
    const selectionFactory = async (): Promise<BufferProviderSelection> =>
      selectBufferEditorProvider({
        ...base,
        ...this.#configuredRuntimeContext,
        mode: mode === "inline" ? "inline" : "neovim",
        ...(mode === "clean" ? { useUserInit: false } : {}),
        inlineStore: getWorkbenchBufferStore(),
      });
    await this.#open(lastOpen.filePath, lastOpen.line, selectionFactory);
    return this.#snapshot.providerStatus === "ready";
  }

  async #replaceProvider(
    provider: BufferEditorProvider,
    generation: number,
    configurationGeneration: number,
  ): Promise<boolean> {
    if (this.#provider === provider) return true;
    if (this.#replacementPromise) {
      await this.#replacementPromise;
      if (generation !== this.#openGeneration) return false;
      return this.#replaceProvider(
        provider,
        generation,
        configurationGeneration,
      );
    }
    const replacement = this.#replaceProviderOnce(
      provider,
      generation,
      configurationGeneration,
    );
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
    configurationGeneration: number,
  ): Promise<boolean> {
    const previousProvider = this.#provider;
    const previousUnsubscribe = this.#providerUnsubscribe;
    const previousIntegrationUnsubscribe = this.#providerIntegrationUnsubscribe;
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
    previousIntegrationUnsubscribe?.();
    this.#provider = null;
    this.#providerUnsubscribe = null;
    this.#providerIntegrationUnsubscribe = null;
    if (
      generation !== this.#openGeneration ||
      configurationGeneration !== this.#configurationGeneration
    ) {
      await provider.cleanup().catch(() => {});
      this.#snapshot = emptyProviderSnapshot(INITIAL_IDENTITY);
      this.#emit();
      return false;
    }
    this.#provider = provider;
    this.#providerConfigurationGeneration = configurationGeneration;
    this.#providerUnsubscribe = provider.subscribe(() => this.#syncSnapshot());
    this.#providerIntegrationUnsubscribe = provider.subscribeIntegrationIntents?.(
      (intent) => {
        for (const listener of this.#integrationIntentListeners) listener(intent);
      },
    ) ?? null;
    if (this.#lastSize) provider.resize(this.#lastSize);
    this.#syncSnapshot();
    return true;
  }

  #syncSnapshot(): void {
    if (!this.#provider) return;
    this.#snapshot = this.#provider.getSnapshot();
    if (
      this.#snapshot.providerStatus === "ready" &&
      this.#snapshot.filePath !== null &&
      this.#deferredOpen === null
    ) {
      this.#lastOpen = {
        filePath: this.#snapshot.filePath,
        line: this.#snapshot.position.line,
      };
    }
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

function defaultSelectionFactory(
  config?: BufferConfig,
  env?: NodeJS.ProcessEnv,
  runtimeContext?: BufferProviderRuntimeContext,
): Promise<BufferProviderSelection> {
  return selectBufferEditorProvider({
    ...(config
      ? bufferProviderConfigFromSources(config, env)
      : bufferProviderConfigFromEnv(env)),
    ...runtimeContext,
    inlineStore: getWorkbenchBufferStore(),
  });
}
