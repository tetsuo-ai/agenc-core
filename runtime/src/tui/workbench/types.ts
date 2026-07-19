export const WORKBENCH_ENV_VAR = "AGENC_TUI_WORKBENCH";

export type WorkbenchPane = "explorer" | "surface" | "agents" | "composer" | "rail";

export type ActiveSurfaceMode =
  | "transcript"
  | "preview"
  | "buffer"
  | "diff"
  | "test"
  | "shell"
  | "search"
  | "agent";

export type WorkbenchAttachmentKind =
  | "file"
  | "file-range"
  | "search-result"
  | "diff-hunk"
  | "task-error";

export type WorkbenchAttachment = {
  readonly id: string;
  readonly kind: WorkbenchAttachmentKind;
  readonly label: string;
  readonly path?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly query?: string;
  readonly taskId?: string;
};

export type WorkbenchBlockedOverlay =
  | null
  | { readonly kind: "approval"; readonly requestId: string; readonly attemptedAction: string };

export type WorkbenchState = {
  readonly focusedPane: WorkbenchPane;
  readonly explorerVisible: boolean;
  readonly agentsVisible: boolean;
  readonly activeSurfaceMode: ActiveSurfaceMode;
  readonly activeFilePath: string | null;
  readonly activeFileLine: number | null;
  readonly bufferOpenRequestId: number;
  readonly selectedAgentTaskId: string | null;
  readonly selectedShellTaskId: string | null;
  readonly openDiffId: string | null;
  readonly searchQuery: string;
  readonly selectedSearchMatchId: string | null;
  readonly composerAttachmentIds: readonly string[];
  readonly attachments: readonly WorkbenchAttachment[];
  readonly pendingBlockedOverlay: WorkbenchBlockedOverlay;
  /**
   * File shown in the right-hand review rail (ctrl+r): the chat stays in the
   * center pane while the user scrolls/reviews the file beside it. Null when
   * the rail is closed. Independent from the center surface, so toggling the
   * rail never navigates away from the transcript.
   */
  readonly fileRailPath: string | null;
};

export type WorkbenchCommand =
  | { readonly type: "focus"; readonly pane: WorkbenchPane }
  | { readonly type: "focusNext"; readonly visiblePanes: readonly WorkbenchPane[] }
  | { readonly type: "openSurface"; readonly mode: ActiveSurfaceMode }
  | { readonly type: "openPreview"; readonly path: string; readonly line?: number; readonly focus?: boolean }
  | { readonly type: "openBuffer"; readonly path: string; readonly line?: number; readonly focus?: boolean }
  | { readonly type: "openSearch"; readonly query?: string; readonly selectedMatchId?: string | null }
  | { readonly type: "openDiff"; readonly diffId?: string | null; readonly focus?: boolean }
  | { readonly type: "openShell"; readonly taskId: string; readonly focus?: boolean }
  | { readonly type: "openAgent"; readonly taskId: string; readonly focus?: boolean }
  | { readonly type: "selectAgent"; readonly taskId: string | null }
  | { readonly type: "closeSurface" }
  | {
      readonly type: "renamePathReferences";
      readonly fromPath: string;
      readonly toPath: string;
      readonly openAffectedBuffer?: boolean;
    }
  | {
      readonly type: "deletePathReferences";
      readonly path: string;
      readonly closeAffectedSurface?: boolean;
    }
  | { readonly type: "toggleExplorer"; readonly visible?: boolean }
  | { readonly type: "toggleAgents"; readonly visible?: boolean }
  | { readonly type: "attach"; readonly attachment: WorkbenchAttachment }
  | { readonly type: "removeAttachment"; readonly id: string }
  | { readonly type: "clearAttachments" }
  | { readonly type: "blockForApproval"; readonly requestId: string; readonly attemptedAction: string }
  | { readonly type: "clearBlockedOverlay" }
  /**
   * Toggle the right-hand review rail (ctrl+r). `path` opens the rail with
   * that file; omitted `path` closes it. Opening never moves focus away from
   * the composer's current context by itself — the chat stays in the center.
   */
  | { readonly type: "toggleFileRail"; readonly path?: string };

export type WorkbenchLayoutSize = "wide" | "medium" | "narrow";

export type ProjectTreeGitState =
  | "clean"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "unmerged"
  | "untracked"
  | "ignored";

export type ProjectTreeRowKind = "root" | "directory" | "file" | "loading" | "empty" | "error";

export type ProjectTreeRow = {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly kind: ProjectTreeRowKind;
  readonly depth: number;
  readonly expanded: boolean;
  readonly hasChildren?: boolean;
  readonly isLast?: boolean;
  readonly ancestorLast?: readonly boolean[];
  readonly selected: boolean;
  readonly focused: boolean;
  readonly active: boolean;
  readonly attached: boolean;
  readonly searchHit: boolean;
  readonly inFlight: boolean;
  readonly gitState?: ProjectTreeGitState;
  readonly error?: string;
};

export type ProjectTreeSnapshot = {
  readonly cwd: string;
  readonly rows: readonly ProjectTreeRow[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly cursorPath: string | null;
  readonly activePath: string | null;
  readonly expandedPaths: readonly string[];
  /**
   * Total number of FILES the project tree knows about, independent of which
   * directories are currently expanded. The WORKSPACE header count is driven by
   * this — counting only the currently-visible rows undercounts a project whose
   * files live inside a collapsed directory (e.g. an agent-created subpackage),
   * which is the "what exists" anchor the header is meant to convey.
   */
  readonly fileCount: number;
};

export type SearchMatch = {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

export type SearchGroup = {
  readonly file: string;
  readonly matches: readonly SearchMatch[];
};
