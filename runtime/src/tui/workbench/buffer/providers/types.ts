import type { Key } from "../../../ink.js";
import type {
  BufferVimCommand,
  BufferPosition,
  BufferVisibleLine,
  WorkbenchBufferSnapshot,
} from "../BufferStore.js";
import type { BufferMove } from "../editing.js";
import type { NeovimRenderSnapshot } from "../neovim/NeovimGrid.js";
import type { EditorProposalPayload } from "../../../../tools/system/editor-proposal.js";

export type BufferProviderKind = "neovim" | "inline" | "external";

export type BufferProviderStatus =
  "idle" | "loading" | "ready" | "saving" | "error" | "conflict" | "closed";

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
  /** Provider revision identity; null only when the provider cannot expose one. */
  readonly changedtick: number | null;
  /**
   * Whether Neovim will write a final line ending. This is part of the exact
   * byte identity even though changing it does not necessarily advance
   * `changedtick` or set `modified`.
   */
  readonly endOfLine: boolean | null;
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
  /**
   * True while a live, starting, or unproven Neovim process can still own
   * workspace bytes. A cleanup-confirmed startup failure and an intentional
   * close set this false even if the provider surface remains in `error`.
   */
  readonly workspaceAuthorityRequired: boolean;
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
    readonly status:
      "pending" | "working" | "recovered" | "comparing" | "copy-saved";
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

export type BufferProviderCleanupOptions = {
  /**
   * Abnormal terminal/process loss must preserve Neovim recovery state rather
   * than issuing the same destructive force-quit as an explicit discard.
   */
  readonly preserveRecovery?: boolean;
};

export type BufferRecoveryAction =
  "recover" | "compare" | "save-copy" | "discard";

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
   * Opaque identity for one editor-process lifetime. It is used only as salt
   * for attachment identity and is never copied into the attachment payload.
   */
  readonly editorSessionId?: string;
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
  readonly kind:
    "attach" | "ask" | "fix" | "explain" | "edit" | "refactor" | "review";
  readonly prompt?: string;
  readonly context: BufferCapturedContext;
};

export type BufferIntegrationIntentListener = (
  intent: BufferIntegrationIntent,
) => void;

export type BufferEditorProposal = EditorProposalPayload;

export type BufferEditorProposalResolution =
  | {
      readonly ok: true;
      readonly action: "staged" | "accepted" | "rejected";
      readonly proposalId: string;
      readonly changedtick?: number;
    }
  | {
      readonly ok: false;
      readonly proposalId: string;
      readonly reason: string;
      readonly stale?: boolean;
      /**
       * The buffer already contains the accepted edit, but the daemon has
       * not confirmed its idempotent acknowledgement yet. Reject is no
       * longer safe; repeating accept retries only the acknowledgement.
       */
      readonly acknowledgementPending?: boolean;
      readonly acknowledgementAction?: "accept" | "reject";
    };

export type BufferCodePredictionContext = {
  readonly bufferHandle: number;
  readonly path: string;
  readonly changedtick: number;
  readonly fileBytes: number;
  readonly cursor: {
    readonly line: number;
    readonly byteColumn: number;
  };
  readonly prefix: string;
  readonly suffix: string;
  readonly language?: string;
};

export type BufferCodePrediction = {
  readonly requestId: string;
  readonly generation: number;
  readonly bufferHandle: number;
  readonly changedtick: number;
  readonly cursor: {
    readonly line: number;
    readonly byteColumn: number;
  };
  readonly text: string;
  readonly latencyMs: number;
};

export type BufferCodePredictionFeedback = {
  readonly requestId: string;
  readonly kind: "accepted" | "partially_accepted" | "dismissed";
  readonly acceptedCharacters?: number;
  readonly latencyMs?: number;
};

/**
 * One exact, revision-bound view of a loaded file buffer. The caller may hash
 * `content` and omit it for clean buffers before sending a daemon sync.
 */
export type BufferWorkspaceBufferCapture = {
  readonly path: string;
  readonly bufferHandle: number;
  readonly changedtick: number;
  readonly endOfLine: boolean;
  readonly dirty: boolean;
  readonly content: string;
};

/**
 * Exact in-memory workspace state captured synchronously by Neovim before a
 * native write. The target is repeated explicitly so a malformed or stale
 * manifest can never authorize a different buffer's `:write`.
 */
export type BufferWorkspaceWriteRequest = {
  readonly target: {
    /** Actual filesystem destination reported by the write autocmd. */
    readonly path: string;
    /** Named source buffer whose bytes Neovim is about to write. */
    readonly sourcePath: string;
    readonly kind: "buffer" | "file" | "append";
    readonly bufferHandle: number;
    readonly changedtick: number;
    readonly endOfLine: boolean;
    readonly lineStart: number;
    readonly lineEnd: number;
  };
  readonly buffers: readonly BufferWorkspaceBufferCapture[];
};

export type BufferWorkspaceWriteDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export type BufferWorkspaceWriteAuthorityHandler = (
  request: BufferWorkspaceWriteRequest,
) => Promise<BufferWorkspaceWriteDecision>;

export type BufferExternalChangeResolution =
  | {
      readonly ok: true;
      readonly path: string;
      readonly reloaded: boolean;
    }
  | {
      readonly ok: false;
      readonly path: string;
      readonly reason: string;
      readonly dirty?: boolean;
    };

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
  saveBuffer?(
    handle: number,
    options?: BufferProviderSaveOptions,
  ): Promise<boolean>;
  saveAll?(
    options?: BufferProviderSaveOptions,
  ): Promise<BufferProviderSaveAllResult>;
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
  synchronizePathDelete?(
    path: string,
  ): Promise<BufferProviderPathMutationResult>;
  shutdown?(options?: BufferProviderShutdownOptions): Promise<boolean>;
  captureContext?(
    request: BufferCaptureRequest,
  ): Promise<BufferCapturedContext | null>;
  captureWorkspaceBuffers?(): Promise<readonly BufferWorkspaceBufferCapture[]>;
  setWorkspaceWriteAuthorityHandler?(
    handler: BufferWorkspaceWriteAuthorityHandler | null,
  ): void;
  reloadCleanPath?(path: string): Promise<BufferExternalChangeResolution>;
  resolveRecovery?(action: BufferRecoveryAction): Promise<BufferRecoveryResult>;
  subscribeIntegrationIntents?(
    listener: BufferIntegrationIntentListener,
  ): () => void;
  stageProposal?(
    proposal: BufferEditorProposal,
  ): Promise<BufferEditorProposalResolution>;
  acceptProposal?(proposalId: string): Promise<BufferEditorProposalResolution>;
  rejectProposal?(proposalId: string): Promise<BufferEditorProposalResolution>;
  captureCodePredictionContext?(): Promise<BufferCodePredictionContext | null>;
  stageCodePrediction?(prediction: BufferCodePrediction): Promise<boolean>;
  clearCodePrediction?(requestId?: string): Promise<boolean>;
  subscribeCodePredictionFeedback?(
    listener: (feedback: BufferCodePredictionFeedback) => void,
  ): () => void;
  revert(): Promise<void>;
  close(options?: BufferProviderCloseOptions): Promise<boolean>;
  openExternalEditor(): Promise<boolean>;
  undo(): boolean;
  redo(): boolean;
  move(
    move: BufferMove,
    options?: { readonly extend?: boolean; readonly pageSize?: number },
  ): boolean;
  requestHover(): Promise<string | null>;
  goToDefinition(): Promise<boolean>;
  handleInput(event: BufferProviderInput): boolean;
  click(row: number, column: number): boolean;
  resize(size: BufferProviderResize): void;
  focus(focused: boolean): void;
  cleanup(options?: BufferProviderCleanupOptions): Promise<void>;
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
  const buffers = snapshot.absolutePath ? [singleBufferManifest(snapshot)] : [];
  return {
    ...snapshot,
    provider,
    providerStatus: extras.providerStatus ?? snapshot.status,
    workspaceAuthorityRequired: false,
    providerMessage: extras.providerMessage ?? null,
    terminal: extras.terminal ?? null,
    buffers,
    activeBufferHandle: buffers[0]?.handle ?? null,
    dirtyBufferCount: snapshot.dirty ? 1 : 0,
    providerExit: null,
    recovery: null,
  };
}

export function emptyProviderSnapshot(
  provider: BufferProviderIdentity,
): BufferProviderSnapshot {
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
    workspaceAuthorityRequired: false,
    providerMessage: null,
    terminal: null,
    buffers: [],
    activeBufferHandle: null,
    dirtyBufferCount: 0,
    providerExit: null,
    recovery: null,
  };
}

export function positionFromNeovimCursor(
  line: number,
  column: number,
): BufferPosition {
  return {
    line: Math.max(1, line),
    column: Math.max(0, column),
    offset: 0,
  };
}

function singleBufferManifest(
  snapshot: WorkbenchBufferSnapshot,
): BufferProviderBuffer {
  return {
    handle: 0,
    changedtick: null,
    endOfLine: null,
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
