import type { Key } from "../../../ink.js";
import type {
  BufferVimCommand,
  BufferPosition,
  BufferVisibleLine,
  WorkbenchBufferSnapshot,
} from "../BufferStore.js";
import type { BufferMove } from "../editing.js";
import type { NeovimRenderSnapshot } from "../neovim/NeovimGrid.js";

export type BufferProviderKind = "neovim" | "inline" | "external";

export type BufferProviderStatus =
  | "idle"
  | "loading"
  | "ready"
  | "saving"
  | "error"
  | "conflict"
  | "closed";

export type BufferProviderCapabilities = {
  readonly vimExact: boolean;
  readonly terminalUi: boolean;
  readonly mouse: boolean;
  readonly clipboard: boolean;
  readonly dirtyState: boolean;
  readonly lspPassthrough: boolean;
  readonly multiBuffer: boolean;
};

export type BufferProviderIdentity = {
  readonly kind: BufferProviderKind;
  readonly label: string;
  readonly fallbackReason: string | null;
  readonly capabilities: BufferProviderCapabilities;
};

/**
 * A stable, provider-owned buffer identity. Neovim buffer handles remain valid
 * while a workspace session is alive, including when the buffer is hidden.
 */
export type BufferProviderBuffer = {
  readonly handle: number;
  readonly name: string;
  readonly filePath: string | null;
  readonly absolutePath: string | null;
  readonly listed: boolean;
  readonly loaded: boolean;
  readonly modified: boolean;
  readonly current: boolean;
  readonly bufferType: string;
  readonly modifiable: boolean;
  readonly readOnly: boolean;
  readonly saveable: boolean;
};

export type BufferProviderSnapshot = WorkbenchBufferSnapshot & {
  readonly provider: BufferProviderIdentity;
  readonly providerStatus: BufferProviderStatus;
  readonly providerMessage: string | null;
  readonly terminal: NeovimRenderSnapshot | null;
  /**
   * Authoritative provider manifest. `dirty` is the aggregate of every loaded
   * buffer, not merely the active buffer.
   */
  readonly buffers: readonly BufferProviderBuffer[];
  readonly activeBufferHandle: number | null;
  readonly dirtyBufferCount: number;
  readonly recovery: {
    readonly status: "pending" | "working" | "recovered" | "comparing" | "copy-saved";
    readonly swapFiles: readonly string[];
    readonly copyPath?: string;
    readonly error?: string;
  } | null;
  readonly providerExit?: {
    readonly kind: "intentional" | "crash";
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderrTail: string;
  } | null;
};

export type BufferProviderOpenOptions = {
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
};

export type BufferProviderSaveOptions = {
  readonly force?: boolean;
  readonly hasInFlightAgent?: boolean;
};

export type BufferProviderCloseOptions = {
  readonly discard?: boolean;
};

export type BufferProviderShutdownOptions = {
  readonly mode?: "safe" | "discard";
};

export type BufferRecoveryAction = "recover" | "compare" | "save-copy" | "discard";

export type BufferRecoveryResult =
  | { readonly ok: true; readonly copyPath?: string }
  | { readonly ok: false; readonly reason: string };

export type BufferProviderSaveAllResult =
  | {
      readonly saved: true;
      readonly buffers: readonly BufferProviderBuffer[];
    }
  | {
      readonly saved: false;
      readonly reason: string;
      readonly blockedBuffers: readonly BufferProviderBuffer[];
    };

export type BufferProviderPathMutationResult =
  | {
      readonly ok: true;
      readonly affectedBufferHandles: readonly number[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * True only when the provider can prove that no loaded buffer adopted
       * the destination path. Callers may inverse the disk rename in that
       * state; unknown/false must be quarantined instead.
       */
      readonly diskRollbackSafe?: boolean;
    };

export type BufferCapturedContextKind = "selection" | "buffer" | "diagnostic";

export type BufferCapturedContextPosition = {
  readonly line: number;
  readonly column: number;
};

export type BufferCapturedDiagnostic = {
  readonly message: string;
  readonly severity: number | null;
  readonly source?: string;
  readonly code?: string | number;
};

export type BufferCapturedContext = {
  readonly kind: BufferCapturedContextKind;
  /**
   * Stable provider identity for the source buffer. This is load-session
   * scoped, but unlike a path it also identifies regular unnamed buffers.
   */
  readonly bufferHandle: number;
  readonly path: string;
  readonly range: {
    readonly start: BufferCapturedContextPosition;
    readonly end: BufferCapturedContextPosition;
  };
  readonly content?: string;
  readonly dirty: boolean;
  readonly selectionMode?: "character" | "line" | "block";
  readonly diagnostic?: BufferCapturedDiagnostic;
  readonly changedtick: number;
};

export type BufferCaptureRequest = {
  readonly kind: BufferCapturedContextKind;
  readonly maxBytes?: number;
  readonly maxLines?: number;
};

export type BufferIntegrationIntent = {
  readonly kind: "attach" | "ask" | "fix" | "explain" | "review";
  readonly prompt?: string;
  readonly context: BufferCapturedContext;
};

export type BufferIntegrationIntentListener = (intent: BufferIntegrationIntent) => void;

export type BufferProviderInputContext = {
  readonly rows: number;
  readonly columns: number;
};

export type BufferProviderInput = {
  readonly input: string;
  readonly key: Key;
  readonly isPaste?: boolean;
  readonly context: BufferProviderInputContext;
  readonly onInlineCommand?: (command: BufferVimCommand) => void;
};

export type BufferProviderResize = {
  readonly rows: number;
  readonly columns: number;
};

export type BufferProviderListener = () => void;

export interface BufferEditorProvider {
  readonly identity: BufferProviderIdentity;
  subscribe(listener: BufferProviderListener): () => void;
  getSnapshot(): BufferProviderSnapshot;
  getVisibleLines(): readonly BufferVisibleLine[];
  open(options: BufferProviderOpenOptions): Promise<void>;
  save(options?: BufferProviderSaveOptions): Promise<boolean>;
  inspectDirtyBuffers?(): Promise<readonly BufferProviderBuffer[]>;
  selectBuffer?(handle: number): Promise<boolean>;
  saveBuffer?(handle: number, options?: BufferProviderSaveOptions): Promise<boolean>;
  saveAll?(options?: BufferProviderSaveOptions): Promise<BufferProviderSaveAllResult>;
  /**
   * Freezes the exact provider-owned dirty manifest that a subsequent
   * destructive discard is allowed to affect.
   */
  prepareDiscardAll?(): Promise<string | null>;
  discardAll?(confirmationToken?: string): Promise<boolean>;
  beginProjectPathMutation?(): boolean;
  endProjectPathMutation?(): void;
  synchronizePathRename?(
    fromPath: string,
    toPath: string,
  ): Promise<BufferProviderPathMutationResult>;
  synchronizePathDelete?(path: string): Promise<BufferProviderPathMutationResult>;
  shutdown?(options?: BufferProviderShutdownOptions): Promise<boolean>;
  captureContext?(request: BufferCaptureRequest): Promise<BufferCapturedContext | null>;
  resolveRecovery?(action: BufferRecoveryAction): Promise<BufferRecoveryResult>;
  subscribeIntegrationIntents?(listener: BufferIntegrationIntentListener): () => void;
  revert(): Promise<void>;
  close(options?: BufferProviderCloseOptions): Promise<boolean>;
  openExternalEditor(): Promise<boolean>;
  undo(): boolean;
  redo(): boolean;
  move(move: BufferMove, options?: { readonly extend?: boolean; readonly pageSize?: number }): boolean;
  requestHover(): Promise<string | null>;
  goToDefinition(): Promise<boolean>;
  handleInput(event: BufferProviderInput): boolean;
  click(row: number, column: number): boolean;
  resize(size: BufferProviderResize): void;
  focus(focused: boolean): void;
  cleanup(): Promise<void>;
}

export const INLINE_BUFFER_CAPABILITIES: BufferProviderCapabilities = {
  vimExact: false,
  terminalUi: false,
  mouse: false,
  clipboard: false,
  dirtyState: true,
  lspPassthrough: true,
  multiBuffer: false,
};

export const NEOVIM_BUFFER_CAPABILITIES: BufferProviderCapabilities = {
  vimExact: true,
  terminalUi: true,
  mouse: true,
  clipboard: true,
  dirtyState: true,
  lspPassthrough: false,
  multiBuffer: true,
};

export function withProviderSnapshot(
  snapshot: WorkbenchBufferSnapshot,
  provider: BufferProviderIdentity,
  extras: {
    readonly providerStatus?: BufferProviderStatus;
    readonly providerMessage?: string | null;
    readonly terminal?: NeovimRenderSnapshot | null;
  } = {},
): BufferProviderSnapshot {
  const buffers = snapshot.absolutePath
    ? [singleBufferManifest(snapshot)]
    : [];
  return {
    ...snapshot,
    provider,
    providerStatus: extras.providerStatus ?? snapshot.status,
    providerMessage: extras.providerMessage ?? null,
    terminal: extras.terminal ?? null,
    buffers,
    activeBufferHandle: buffers[0]?.handle ?? null,
    dirtyBufferCount: snapshot.dirty ? 1 : 0,
    providerExit: null,
    recovery: null,
  };
}

export function emptyProviderSnapshot(provider: BufferProviderIdentity): BufferProviderSnapshot {
  return {
    status: "idle",
    filePath: null,
    absolutePath: null,
    dirty: false,
    lineCount: 0,
    position: { line: 1, column: 0, offset: 0 },
    selection: { anchor: 0, head: 0 },
    scrollLine: 0,
    viewportRows: 20,
    canUndo: false,
    canRedo: false,
    error: null,
    conflictKind: null,
    encoding: null,
    lineEndings: null,
    hoverText: null,
    vimMode: "NORMAL",
    vimCommandLine: null,
    provider,
    providerStatus: "idle",
    providerMessage: null,
    terminal: null,
    buffers: [],
    activeBufferHandle: null,
    dirtyBufferCount: 0,
    providerExit: null,
    recovery: null,
  };
}

export function positionFromNeovimCursor(line: number, column: number): BufferPosition {
  return {
    line: Math.max(1, line),
    column: Math.max(0, column),
    offset: 0,
  };
}

function singleBufferManifest(snapshot: WorkbenchBufferSnapshot): BufferProviderBuffer {
  return {
    handle: 0,
    name: snapshot.absolutePath ?? snapshot.filePath ?? "",
    filePath: snapshot.filePath,
    absolutePath: snapshot.absolutePath,
    listed: true,
    loaded: true,
    modified: snapshot.dirty,
    current: true,
    bufferType: "",
    modifiable: true,
    readOnly: false,
    saveable: snapshot.absolutePath !== null,
  };
}
