export const WORKBENCH_ENV_VAR = "AGENC_TUI_WORKBENCH";

export type WorkspaceView = "agent" | "editor";

export type WorkbenchPane =
  "explorer" | "surface" | "agents" | "composer" | "rail";

export type WorkbenchRail =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "transcript" }
  | { readonly kind: "change-review"; readonly changeId: string }
  | { readonly kind: "editor-proposal"; readonly proposalId: string }
  | null;

export type ActiveSurfaceMode =
  | "transcript"
  | "preview"
  | "buffer"
  | "diff"
  | "test"
  | "shell"
  | "search"
  | "task-detail";

export type AgentSurfaceMode = Exclude<ActiveSurfaceMode, "buffer">;

export type WorkbenchAttachmentKind =
  | "file"
  | "file-range"
  | "search-result"
  | "diff-hunk"
  | "task-error"
  | "editor-selection"
  | "editor-diagnostic";

export type WorkbenchAttachment = {
  readonly id: string;
  readonly kind: WorkbenchAttachmentKind;
  readonly label: string;
  readonly path?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly query?: string;
  readonly taskId?: string;
  /** Exact bounded snapshot captured from a live editor buffer. */
  readonly content?: string;
  readonly dirty?: boolean;
  readonly startColumn?: number;
  readonly endColumn?: number;
  readonly selectionMode?: "character" | "line" | "block";
  readonly changedtick?: number;
  readonly diagnostic?: {
    readonly message: string;
    readonly severity?: string;
    readonly source?: string;
    readonly code?: string;
  };
  /** Trusted submit metadata for an explicit embedded-editor interaction. */
  readonly editorInteraction?: {
    readonly kind: "ask" | "explain" | "fix" | "edit" | "refactor";
    readonly bufferHandle: number;
    readonly path: string;
    readonly changedtick: number;
    readonly range: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    };
  };
};

export type WorkbenchSurfaceLeaveCommand =
  | { readonly type: "openSurface"; readonly mode: ActiveSurfaceMode }
  | {
      readonly type: "openPreview";
      readonly path: string;
      readonly line?: number;
      readonly focus?: boolean;
    }
  | {
      readonly type: "openSearch";
      readonly query?: string;
      readonly selectedMatchId?: string | null;
    }
  | {
      readonly type: "openDiff";
      readonly diffId?: string | null;
      readonly focus?: boolean;
    }
  | {
      readonly type: "openShell";
      readonly taskId: string;
      readonly focus?: boolean;
    }
  | {
      readonly type: "openAgent";
      readonly taskId: string;
      readonly focus?: boolean;
    }
  | { readonly type: "closeSurface" }
  /**
   * Atomic ctrl+r handoff: show `path` in the file rail, return the center to
   * the transcript, and focus the composer. Keeping this as one surface-leave
   * command lets the dirty-buffer guard defer or cancel the entire transition.
   */
  | { readonly type: "moveFileToRail"; readonly path: string }
  | {
      readonly type: "requestProjectPathRename";
      readonly fromPath: string;
      readonly toPath: string;
    }
  | { readonly type: "requestProjectPathDelete"; readonly path: string }
  | { readonly type: "requestAppExit"; readonly resumeSessionId?: string }
  | {
      readonly type: "deletePathReferences";
      readonly path: string;
      readonly closeAffectedSurface?: boolean;
    };

export type WorkbenchBlockedOverlay = null | {
  readonly kind: "buffer-dirty";
  readonly requestId: string;
  readonly attemptedAction: string;
  /**
   * The exact navigation command that was stopped. It is replayed only
   * after the user has saved or explicitly discarded every dirty buffer.
   */
  readonly deferredCommand: WorkbenchSurfaceLeaveCommand;
};

export type WorkbenchState = {
  /**
   * Agent and Editor are two presentations of the same session. The active
   * view is intentionally orthogonal to activeSurfaceMode: task/search/shell
   * surfaces belong to Agent while BUFFER belongs to Editor.
   */
  readonly activeWorkspaceView: WorkspaceView;
  readonly agentFocusedPane: WorkbenchPane;
  readonly editorFocusedPane: WorkbenchPane;
  readonly agentSurfaceMode: AgentSurfaceMode;
  readonly agentRail: WorkbenchRail;
  readonly editorRail: WorkbenchRail;
  readonly agentActiveFilePath: string | null;
  readonly agentActiveFileLine: number | null;
  readonly editorActiveFilePath: string | null;
  readonly editorActiveFileLine: number | null;
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
  /** Attachment ids owned by the currently active workspace composer. */
  readonly composerAttachmentIds: readonly string[];
  readonly agentComposerAttachmentIds: readonly string[];
  readonly editorComposerAttachmentIds: readonly string[];
  readonly attachments: readonly WorkbenchAttachment[];
  readonly pendingBlockedOverlay: WorkbenchBlockedOverlay;
  readonly composerDraftRequest: {
    readonly id: number;
    readonly text: string;
    /**
     * The composer that owns this handoff. Effects may settle after a tab
     * switch, so the request must never be applied to whichever view happens
     * to be active later.
     */
    readonly view: WorkspaceView;
  } | null;
  /** Temporarily gives the center surface the whole workbench viewport. */
  readonly surfaceMaximized: boolean;
  /** Optional sidecar/drawer that remains independent from the center surface. */
  readonly rail: WorkbenchRail;
  /**
   * Monotonic handoff from the pure workbench reducer to the application
   * shell. Exiting is a surface-leave operation so dirty buffers can defer it
   * through the same Save All / Discard All / Cancel transaction.
   */
  readonly appExitRequestId: number;
  readonly appExitResumeSessionId: string | null;
  readonly projectPathMutationRequestId: number;
  readonly projectPathMutationRequest:
    | {
        readonly id: number;
        readonly kind: "rename";
        readonly fromPath: string;
        readonly toPath: string;
      }
    | {
        readonly id: number;
        readonly kind: "delete";
        readonly path: string;
      }
    | null;
};

export type WorkbenchCommand =
  | { readonly type: "switchWorkspaceView"; readonly view: WorkspaceView }
  | {
      readonly type: "cycleWorkspaceView";
      readonly direction?: "next" | "previous";
    }
  | { readonly type: "focus"; readonly pane: WorkbenchPane }
  | {
      readonly type: "focusNext";
      readonly visiblePanes: readonly WorkbenchPane[];
    }
  | WorkbenchSurfaceLeaveCommand
  | {
      readonly type: "openBuffer";
      readonly path: string;
      readonly line?: number;
      readonly focus?: boolean;
    }
  | {
      readonly type: "syncBufferPath";
      readonly path: string;
      readonly line?: number;
    }
  | { readonly type: "selectAgent"; readonly taskId: string | null }
  | {
      readonly type: "renamePathReferences";
      readonly fromPath: string;
      readonly toPath: string;
      readonly openAffectedBuffer?: boolean;
    }
  | { readonly type: "toggleExplorer"; readonly visible?: boolean }
  | { readonly type: "toggleAgents"; readonly visible?: boolean }
  | { readonly type: "toggleSurfaceMaximized"; readonly maximized?: boolean }
  | { readonly type: "attach"; readonly attachment: WorkbenchAttachment }
  | { readonly type: "removeAttachment"; readonly id: string }
  | {
      readonly type: "clearAttachments";
      /**
       * The composer that owned the submitted snapshot. Async submissions
       * must not clear whichever tab happens to be active when they settle.
       */
      readonly workspaceView?: WorkspaceView;
      /**
       * Exact attachment snapshot consumed by the submission. Attachments
       * added while the request is in flight remain available.
       */
      readonly ids?: readonly string[];
    }
  | {
      readonly type: "handoffToComposer";
      readonly attachment: WorkbenchAttachment;
      readonly draftText?: string;
      readonly openTranscriptRail?: boolean;
    }
  | { readonly type: "acknowledgeComposerDraft"; readonly id: number }
  | {
      readonly type: "blockForApproval";
      readonly requestId: string;
      readonly attemptedAction: string;
      readonly deferredCommand: WorkbenchSurfaceLeaveCommand;
    }
  | { readonly type: "clearBlockedOverlay" }
  | { readonly type: "resolveBlockedOverlay"; readonly requestId: string }
  | { readonly type: "completeProjectPathMutation"; readonly requestId: number }
  | { readonly type: "setRail"; readonly rail: WorkbenchRail }
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

export type ProjectTreeRowKind =
  "root" | "directory" | "file" | "loading" | "empty" | "error";

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
  /** Collapse-independent directory count for the explorer footer. */
  readonly directoryCount?: number;
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
