import type {
  ActiveSurfaceMode,
  WorkbenchAttachment,
  WorkbenchCommand,
  WorkbenchPane,
  WorkbenchState,
} from "./types.js";
import {
  containsWorkspacePathReference,
  normalizeWorkspacePathForReferences,
  renameWorkspacePathReference,
} from "./pathReferences.js";

export function getDefaultWorkbenchState(): WorkbenchState {
  return {
    focusedPane: "composer",
    explorerVisible: true,
    agentsVisible: true,
    activeSurfaceMode: "transcript",
    activeFilePath: null,
    activeFileLine: null,
    bufferOpenRequestId: 0,
    selectedAgentTaskId: null,
    selectedShellTaskId: null,
    openDiffId: null,
    searchQuery: "",
    selectedSearchMatchId: null,
    composerAttachmentIds: [],
    attachments: [],
    pendingBlockedOverlay: null,
    fileRailPath: null,
  };
}

export function ensureWorkbenchState(state: WorkbenchState | undefined): WorkbenchState {
  return state ?? getDefaultWorkbenchState();
}

export function workbenchReducer(
  inputState: WorkbenchState | undefined,
  command: WorkbenchCommand,
): WorkbenchState {
  const state = ensureWorkbenchState(inputState);
  switch (command.type) {
    case "focus":
      return focusPane(state, command.pane);
    case "focusNext":
      return focusNextPane(state, command.visiblePanes);
    case "openSurface":
      return openSurface(state, command.mode);
    case "openPreview":
      return {
        ...openSurface(state, "preview", command.focus ?? true),
        activeFilePath: command.path,
        activeFileLine: command.line ?? null,
      };
    case "openBuffer":
      return {
        ...openSurface(state, "buffer", command.focus ?? true),
        activeFilePath: command.path,
        activeFileLine: command.line ?? null,
        bufferOpenRequestId: state.bufferOpenRequestId + 1,
      };
    case "openSearch":
      const nextSearchQuery = command.query ?? state.searchQuery;
      const searchQueryChanged =
        command.query !== undefined && command.query !== state.searchQuery;
      let nextSelectedSearchMatchId = state.selectedSearchMatchId;
      if (command.selectedMatchId !== undefined) {
        nextSelectedSearchMatchId = command.selectedMatchId;
      } else if (searchQueryChanged) {
        nextSelectedSearchMatchId = null;
      }
      return {
        ...openSurface(state, "search"),
        searchQuery: nextSearchQuery,
        selectedSearchMatchId: nextSelectedSearchMatchId,
      };
    case "openDiff":
      return {
        ...openSurface(state, "diff", command.focus ?? true),
        openDiffId: command.diffId === undefined ? state.openDiffId : command.diffId,
      };
    case "openShell":
      return {
        ...openSurface(state, "shell", command.focus ?? true),
        selectedShellTaskId: command.taskId,
      };
    case "openAgent":
      return {
        ...openSurface(state, "agent", command.focus ?? true),
        selectedAgentTaskId: command.taskId,
      };
    case "selectAgent":
      return {
        ...state,
        selectedAgentTaskId: command.taskId,
      };
    case "closeSurface":
      return openSurface(state, "transcript");
    case "renamePathReferences": {
      const nextState = renamePathReferences(state, command.fromPath, command.toPath);
      if (
        command.openAffectedBuffer === true &&
        nextState.activeFilePath !== null &&
        nextState.activeFilePath !== state.activeFilePath
      ) {
        return openSurface(nextState, "buffer", false);
      }
      return nextState;
    }
    case "deletePathReferences": {
      const nextState = deletePathReferences(state, command.path);
      if (
        command.closeAffectedSurface === true &&
        state.activeFilePath !== null &&
        nextState.activeFilePath === null
      ) {
        return openSurface(nextState, "transcript");
      }
      return nextState;
    }
    case "toggleExplorer":
      return {
        ...state,
        explorerVisible: command.visible ?? !state.explorerVisible,
        focusedPane:
          command.visible === false && state.focusedPane === "explorer"
            ? "surface"
            : state.focusedPane,
      };
    case "toggleAgents":
      return {
        ...state,
        agentsVisible: command.visible ?? !state.agentsVisible,
        focusedPane:
          command.visible === false && state.focusedPane === "agents"
            ? "surface"
            : state.focusedPane,
      };
    case "attach":
      return attach(state, command.attachment);
    case "removeAttachment":
      return {
        ...state,
        attachments: state.attachments.filter((item) => item.id !== command.id),
        composerAttachmentIds: state.composerAttachmentIds.filter((id) => id !== command.id),
      };
    case "clearAttachments":
      return {
        ...state,
        attachments: [],
        composerAttachmentIds: [],
      };
    case "blockForApproval":
      return {
        ...state,
        pendingBlockedOverlay: {
          kind: "approval",
          requestId: command.requestId,
          attemptedAction: command.attemptedAction,
        },
      };
    case "clearBlockedOverlay":
      return {
        ...state,
        pendingBlockedOverlay: null,
      };
    case "toggleFileRail":
      // Toggling the rail never changes the center surface or steals focus:
      // the transcript/chat stays put, the rail opens beside it.
      if (command.path === undefined) {
        return { ...state, fileRailPath: null };
      }
      return { ...state, fileRailPath: command.path };
  }
}

export function visibleWorkbenchPane(state: WorkbenchState): WorkbenchPane {
  if (state.focusedPane === "explorer" && !state.explorerVisible) return "surface";
  if (state.focusedPane === "agents" && !state.agentsVisible) return "surface";
  if (state.focusedPane === "rail" && state.fileRailPath === null) return "surface";
  return state.focusedPane;
}

export function composerAttachmentsForState(
  state: WorkbenchState,
): readonly WorkbenchAttachment[] {
  const attachmentsById = new Map(state.attachments.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const attachments: WorkbenchAttachment[] = [];
  for (const id of state.composerAttachmentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const attachment = attachmentsById.get(id);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

function openSurface(
  state: WorkbenchState,
  mode: ActiveSurfaceMode,
  focus = true,
): WorkbenchState {
  return {
    ...state,
    activeSurfaceMode: mode,
    focusedPane: focus ? "surface" : state.focusedPane,
  };
}

function focusPane(state: WorkbenchState, pane: WorkbenchPane): WorkbenchState {
  if (pane === "explorer" && !state.explorerVisible) {
    return { ...state, explorerVisible: true, focusedPane: pane };
  }
  if (pane === "agents" && !state.agentsVisible) {
    return { ...state, agentsVisible: true, focusedPane: pane };
  }
  return { ...state, focusedPane: pane };
}

function focusNextPane(
  state: WorkbenchState,
  visiblePanes: readonly WorkbenchPane[],
): WorkbenchState {
  const panes = visiblePanes.length > 0 ? visiblePanes : (["surface", "composer"] as const);
  const current = panes.indexOf(visibleWorkbenchPane(state));
  const next = panes[(current + 1 + panes.length) % panes.length] ?? "surface";
  return { ...state, focusedPane: next };
}

function attach(
  state: WorkbenchState,
  attachment: WorkbenchAttachment,
): WorkbenchState {
  const attachments = [
    ...state.attachments.filter((item) => item.id !== attachment.id),
    attachment,
  ];
  return {
    ...state,
    attachments,
    composerAttachmentIds: attachments.map((item) => item.id),
  };
}

function renamePathReferences(
  state: WorkbenchState,
  fromPath: string,
  toPath: string,
): WorkbenchState {
  const normalizedFromPath = normalizeWorkspacePathForReferences(fromPath);
  const normalizedToPath = normalizeWorkspacePathForReferences(toPath);
  const attachmentIdMap = new Map<string, string>();
  const attachmentsById = new Map<string, WorkbenchAttachment>();
  for (const attachment of state.attachments) {
    const nextAttachment = renameAttachmentPath(
      attachment,
      normalizedFromPath,
      normalizedToPath,
    );
    attachmentIdMap.set(attachment.id, nextAttachment.id);
    attachmentsById.set(nextAttachment.id, nextAttachment);
  }
  const attachments = [...attachmentsById.values()];
  const attachmentIds = new Set(attachments.map((item) => item.id));
  const composerAttachmentIds = unique(
    state.composerAttachmentIds
      .map((id) => attachmentIdMap.get(id) ?? id)
      .filter((id) => attachmentIds.has(id)),
  );
  return {
    ...state,
    activeFilePath:
      renameWorkspacePathReference(
        state.activeFilePath,
        normalizedFromPath,
        normalizedToPath,
      ) ?? state.activeFilePath,
    attachments,
    composerAttachmentIds,
  };
}

function deletePathReferences(
  state: WorkbenchState,
  deletedPath: string,
): WorkbenchState {
  const activeFileDeleted = containsWorkspacePathReference(
    state.activeFilePath,
    deletedPath,
  );
  const attachments = state.attachments.filter((attachment) =>
    !containsWorkspacePathReference(attachment.path ?? null, deletedPath)
  );
  const attachmentIds = new Set(attachments.map((item) => item.id));
  return {
    ...state,
    activeFilePath: activeFileDeleted ? null : state.activeFilePath,
    activeFileLine: activeFileDeleted ? null : state.activeFileLine,
    attachments,
    composerAttachmentIds: state.composerAttachmentIds.filter((id) => attachmentIds.has(id)),
  };
}

function renameAttachmentPath(
  attachment: WorkbenchAttachment,
  fromPath: string,
  toPath: string,
): WorkbenchAttachment {
  const nextPath = renameWorkspacePathReference(
    attachment.path ?? null,
    fromPath,
    toPath,
  );
  if (!nextPath || nextPath === attachment.path) return attachment;
  return {
    ...attachment,
    id: replaceFirst(attachment.id, attachment.path ?? "", nextPath),
    path: nextPath,
    label: replaceFirst(attachment.label, attachment.path ?? "", nextPath),
  };
}

function replaceFirst(value: string, needle: string, replacement: string): string {
  if (!needle) return value;
  const index = value.indexOf(needle);
  if (index < 0) return value;
  return `${value.slice(0, index)}${replacement}${value.slice(index + needle.length)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
