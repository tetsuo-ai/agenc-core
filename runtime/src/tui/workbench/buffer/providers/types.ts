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

export type BufferProviderSnapshot = WorkbenchBufferSnapshot & {
  readonly provider: BufferProviderIdentity;
  readonly providerStatus: BufferProviderStatus;
  readonly providerMessage: string | null;
  readonly terminal: NeovimRenderSnapshot | null;
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

export type BufferProviderInputContext = {
  readonly rows: number;
  readonly columns: number;
};

export type BufferProviderInput = {
  readonly input: string;
  readonly key: Key;
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
  return {
    ...snapshot,
    provider,
    providerStatus: extras.providerStatus ?? snapshot.status,
    providerMessage: extras.providerMessage ?? null,
    terminal: extras.terminal ?? null,
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
  };
}

export function positionFromNeovimCursor(line: number, column: number): BufferPosition {
  return {
    line: Math.max(1, line),
    column: Math.max(0, column),
    offset: 0,
  };
}
