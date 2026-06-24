import React, { useCallback, useEffect, useMemo, useState } from "react";

import { selectAgenCTuiGlyphs } from "../../glyphs.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { Box, Text } from "../../ink.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState } from "../../state/AppState.js";
import TextInput from "../../components/TextInput.js";
import { getGraphemeSegmenter } from "../../../utils/intl.js";
import { logError } from "../../../utils/log.js";
import { inFlightPathsFromTasks } from "../agents/activity.js";
import { attachFileCommand, deletePathReferencesCommand, openBufferCommand, renamePathReferencesCommand } from "../commands.js";
import { composerAttachmentsForState } from "../reducer.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import type { ProjectTreeRow } from "../types.js";
import { getProjectTreeStore } from "./ProjectTreeStore.js";
import { useProjectTree } from "./useProjectTree.js";

type Props = {
  readonly focused: boolean;
  readonly width: number;
};

export function ProjectExplorer({ focused, width }: Props): React.ReactElement {
  const snapshot = useProjectTree();
  const workbench = useWorkbenchState();
  const tasks = useAppState((state) => state.tasks);
  const dispatch = useWorkbenchDispatch();
  const store = getProjectTreeStore();
  const { rows: terminalRows } = useTerminalSize();
  const [fileAction, setFileAction] = useState(null);
  const maxTreeRows = Math.max(1, terminalRows - 8);
  const attachedPaths = useMemo(
    () => composerAttachmentsForState(workbench).flatMap((item) => item.path ? [item.path] : []),
    [workbench.attachments, workbench.composerAttachmentIds],
  );

  useEffect(() => {
    store.setActivePath(workbench.activeFilePath);
  }, [store, workbench.activeFilePath]);

  useEffect(() => {
    store.setAttachedPaths(attachedPaths);
  }, [store, attachedPaths]);

  useEffect(() => {
    store.setViewportRows(maxTreeRows);
  }, [store, maxTreeRows]);

  useEffect(() => {
    const filePaths = snapshot.rows
      .filter((row) => row.kind === "file")
      .map((row) => row.path);
    store.setInFlightPaths(inFlightPathsFromTasks(Object.values(tasks), filePaths));
  }, [store, tasks, snapshot.rows]);

  const closeFileAction = useCallback(() => setFileAction(null), []);

  const beginCreateFile = useCallback(() => {
    const row = store.getCursorRow();
    setFileAction({
      kind: "create",
      value: defaultCreateFilePath(row),
      busy: false,
      error: null,
    });
  }, [store]);

  const beginRename = useCallback(() => {
    const row = store.getCursorRow();
    if (!isMutableTreeRow(row)) return;
    setFileAction({
      kind: "rename",
      path: row.path,
      value: row.path,
      busy: false,
      error: null,
    });
  }, [store]);

  const beginDelete = useCallback(() => {
    const row = store.getCursorRow();
    if (!isMutableTreeRow(row)) return;
    setFileAction({
      kind: "delete",
      path: row.path,
      label: row.label,
      rowKind: row.kind,
      busy: false,
      error: null,
    });
  }, [store]);

  const submitFileAction = useCallback(async (value) => {
    const action = fileAction;
    if (!action || action.kind === "delete" || action.busy) return;
    setFileAction({ ...action, value, busy: true, error: null });
    let result;
    try {
      result = action.kind === "create"
        ? await store.createFile(value)
        : await store.renamePath(action.path, value);
    } catch (error) {
      logError(error);
      setFileAction({ ...action, value, busy: false, error: fileActionFailureMessage(action, value, error) });
      return;
    }
    if (!result.ok) {
      setFileAction({ ...action, value, busy: false, error: result.error });
      return;
    }
    setFileAction(null);
    if (action.kind === "create") {
      dispatch(openBufferCommand(result.path, undefined, true));
      return;
    }
    dispatch(renamePathReferencesCommand(action.path, result.path, { openAffectedBuffer: true }));
  }, [dispatch, fileAction, store]);

  const confirmDelete = useCallback(async () => {
    const action = fileAction;
    if (!action || action.kind !== "delete" || action.busy) return;
    setFileAction({ ...action, busy: true, error: null });
    let result;
    try {
      result = await store.deletePath(action.path);
    } catch (error) {
      logError(error);
      setFileAction({ ...action, busy: false, error: fileActionFailureMessage(action, action.path, error) });
      return;
    }
    if (!result.ok) {
      setFileAction({ ...action, busy: false, error: result.error });
      return;
    }
    setFileAction(null);
    dispatch(deletePathReferencesCommand(action.path, { closeAffectedSurface: true }));
  }, [dispatch, fileAction, store]);

  useRegisterKeybindingContext("Explorer", focused);
  useKeybindings(
    {
      "explorer:up": () => store.move(-1),
      "explorer:down": () => store.move(1),
      "explorer:pageUp": () => store.movePage(-1),
      "explorer:pageDown": () => store.movePage(1),
      "explorer:top": () => store.moveToStart(),
      "explorer:bottom": () => store.moveToEnd(),
      "explorer:expand": () => store.expand(),
      "explorer:collapse": () => store.collapse(),
      "explorer:revealActive": () => store.reveal(workbench.activeFilePath),
      "explorer:open": () => {
        const row = store.getCursorRow();
        if (row?.kind === "file" && row.path) {
          dispatch(openBufferCommand(row.path, undefined, true));
          return;
        }
        if (row?.kind === "directory") store.toggle(row.path);
      },
      "explorer:openKeepFocus": () => {
        const row = store.getCursorRow();
        if (row?.kind === "file" && row.path) dispatch(openBufferCommand(row.path, undefined, false));
      },
      "explorer:edit": () => {
        const row = store.getCursorRow();
        if (row?.kind === "file" && row.path) dispatch(openBufferCommand(row.path, undefined, true));
      },
      "explorer:editKeepFocus": () => {
        const row = store.getCursorRow();
        if (row?.kind === "file" && row.path) dispatch(openBufferCommand(row.path, undefined, false));
      },
      "explorer:attach": () => {
        const row = store.getCursorRow();
        if (row?.kind === "file" && row.path) dispatch(attachFileCommand(row.path));
      },
      "explorer:addFile": beginCreateFile,
      "explorer:rename": beginRename,
      "explorer:delete": beginDelete,
    },
    { context: "Explorer", isActive: focused && fileAction === null },
  );

  const viewport = projectTreeViewport(snapshot.rows, maxTreeRows);
  const visibleRows = viewport.rows
    .map((row) => row.selected ? { ...row, focused } : row);
  // Drive the WORKSPACE count from the project's real file total (carried on the
  // snapshot, collapse-independent) rather than the currently-visible rows — a
  // collapsed directory hides its children from the rows, which would undercount
  // a multi-file project (e.g. an agent-created subpackage showing "WORKSPACE 1").
  const itemCount = snapshot.fileCount;
  const dirtyCount = snapshot.rows.filter((row) => row.gitState && row.gitState !== "clean").length;
  const glyphs = selectAgenCTuiGlyphs();

  return (
    <Box flexDirection="column" width={width} height="100%" borderRight borderColor={focused ? "suggestion" : "gray"} paddingX={1}>
      <Box height={1} flexShrink={0}>
        <Text color={focused ? "suggestion" : "gray"} wrap="truncate-end">WORKSPACE</Text>
        <Text dimColor wrap="truncate-end"> {itemCount}{dirtyCount > 0 ? ` ${dirtyCount} changed` : ""}{snapshot.loading ? " sync" : ""}</Text>
      </Box>
      {snapshot.error ? (
        <Box height={1} flexShrink={0}>
          <Text color="error" wrap="truncate-end">{snapshot.error}</Text>
        </Box>
      ) : null}
      {fileAction ? (
        <ProjectFileActionPrompt
          focused={focused}
          action={fileAction}
          width={Math.max(8, width - 2)}
          onChange={(value) => setFileAction((current) => current ? { ...current, value } : current)}
          onSubmit={submitFileAction}
          onConfirmDelete={confirmDelete}
          onCancel={closeFileAction}
        />
      ) : null}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {viewport.above > 0 ? (
          <Box height={1} flexShrink={0}>
            {/* "N above" / "N below" reads as a position (how far the window
                sits from each end) instead of an ambiguous "N more". The
                `inactive` tone is brighter than the prior dimColor so the
                indicator is legible against the rows. */}
            <Text color="inactive" wrap="truncate-end">{glyphs.arrowUp} {viewport.above} above</Text>
          </Box>
        ) : null}
        {visibleRows.map((row) => <ProjectExplorerRow key={row.id} row={row} width={Math.max(8, width - 3)} />)}
        {viewport.below > 0 ? (
          <Box height={1} flexShrink={0}>
            <Text color="inactive" wrap="truncate-end">{glyphs.arrowDown} {viewport.below} below</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export function ProjectFileActionPrompt({
  focused = true,
  action,
  width,
  onChange,
  onSubmit,
  onConfirmDelete,
  onCancel,
}) {
  const actionKey = action.kind === "create" ? action.kind : `${action.kind}:${action.path}`;
  const [cursorOffset, setCursorOffset] = useState(action.value?.length ?? 0);

  useEffect(() => {
    setCursorOffset(action.value?.length ?? 0);
  }, [actionKey]);

  useRegisterKeybindingContext("Confirmation", focused && action.kind === "delete");
  useKeybindings(
    {
      "confirm:yes": () => {
        void onConfirmDelete();
      },
      "confirm:no": onCancel,
    },
    { context: "Confirmation", isActive: focused && action.kind === "delete" },
  );

  if (action.kind === "delete") {
    return (
      <Box flexDirection="column" borderTop borderBottom borderColor="error" paddingY={0} flexShrink={0}>
        <Text color="error" wrap="truncate-end">
          Delete {action.rowKind === "directory" ? "directory" : "file"} {action.path}?
        </Text>
        <Text dimColor wrap="truncate-end">{action.busy ? "deleting..." : "y/enter confirm  n/esc cancel"}</Text>
        {action.error ? <Text color="error" wrap="truncate-end">{action.error}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderTop borderBottom borderColor="suggestion" paddingY={0} flexShrink={0}>
      <Text color="suggestion" wrap="truncate-end">
        {action.kind === "create" ? "Add file" : "Rename"}
      </Text>
      <TextInput
        value={action.value}
        onChange={onChange}
        onSubmit={(value) => {
          void onSubmit(value);
        }}
        onExit={onCancel}
        inputFilter={(input, key) => {
          if (key.escape) {
            onCancel();
            return "";
          }
          return input;
        }}
        disableEscapeDoublePress
        focus={focused && !action.busy}
        showCursor
        multiline={false}
        maxVisibleLines={1}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        columns={Math.max(8, width - 2)}
        placeholder="path/to/file"
      />
      <Text dimColor wrap="truncate-end">{action.busy ? "working..." : "enter confirm  esc cancel"}</Text>
      {action.error ? <Text color="error" wrap="truncate-end">{action.error}</Text> : null}
    </Box>
  );
}

export function projectTreeViewport(
  rows: readonly ProjectTreeRow[],
  maxRows: number,
): { readonly rows: readonly ProjectTreeRow[]; readonly above: number; readonly below: number } {
  const limit = Math.max(1, Math.floor(maxRows));
  if (rows.length <= limit) return { rows, above: 0, below: 0 };

  const selectedIndex = rows.findIndex((row) => row.selected);
  const targetIndex = selectedIndex < 0 ? 0 : selectedIndex;
  const halfWindow = Math.floor(limit / 2);
  const start = targetIndex < limit
    ? 0
    : Math.min(Math.max(0, targetIndex - halfWindow), rows.length - limit);
  const end = Math.min(rows.length, start + limit);

  return {
    rows: rows.slice(start, end),
    above: start,
    below: Math.max(0, rows.length - end),
  };
}

export function ProjectExplorerRow({
  row,
  width,
}: {
  readonly row: ProjectTreeRow;
  readonly width: number;
}): React.ReactElement {
  const glyphs = selectAgenCTuiGlyphs();
  const branch = indentPrefix(row);
  const marker = markerForRow(row, glyphs);
  const badges = rowBadges(row, glyphs);
  const prefix = `${branch}${marker} `;
  const labelWidth = Math.max(1, width - stringWidth(prefix) - stringWidth(badges) - 1);
  const label = trim(row.label, labelWidth);
  const gap = Math.max(0, width - stringWidth(prefix) - stringWidth(label) - stringWidth(badges));
  const color = colorForRow(row);
  return (
    <Box height={1} flexShrink={0}>
      <Text color={color} inverse={row.focused} wrap="truncate-end">
        {prefix}{label}{" ".repeat(gap)}{badges}
      </Text>
    </Box>
  );
}

function indentPrefix(row: ProjectTreeRow): string {
  return "  ".repeat(Math.max(0, row.depth));
}

function markerForRow(row: ProjectTreeRow, glyphs: ReturnType<typeof selectAgenCTuiGlyphs>): string {
  if (row.kind === "root") return row.expanded ? glyphs.arrowDown : glyphs.arrowRight;
  if (row.kind === "directory") return row.expanded ? glyphs.arrowDown : glyphs.arrowRight;
  if (row.kind === "loading") return glyphs.ellipsis;
  // An empty workspace is a normal cold-start state, so its marker is a neutral
  // space — the "!" below is reserved for genuine error rows.
  if (row.kind === "empty") return " ";
  if (row.kind === "error") return "!";
  return " ";
}

function rowBadges(row: ProjectTreeRow, glyphs: ReturnType<typeof selectAgenCTuiGlyphs>): string {
  return [
    gitMarker(row.gitState),
    row.active ? glyphs.statusDot : "",
    row.attached ? "@" : "",
    row.searchHit ? "?" : "",
    row.inFlight ? "~" : "",
  ].filter(Boolean).join(" ");
}

function gitMarker(state: ProjectTreeRow["gitState"]): string {
  switch (state) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "unmerged":
      return "U";
    case "untracked":
      return "?";
    case "ignored":
      return "!";
    default:
      return "";
  }
}

function colorForRow(row: ProjectTreeRow): string | undefined {
  if (row.selected) return row.focused ? "suggestion" : "gray";
  if (row.active) return "success";
  switch (row.gitState) {
    case "modified":
    case "renamed":
      return "warning";
    case "added":
      return "success";
    case "deleted":
    case "unmerged":
      return "error";
    case "untracked":
    case "ignored":
      return "gray";
    default:
      return row.kind === "file" ? undefined : "text2";
  }
}

function trim(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  if (width <= 1) return value.slice(0, width);
  const suffix = selectAgenCTuiGlyphs().ellipsis;
  const maxWidth = Math.max(0, width - stringWidth(suffix));
  let output = "";
  let used = 0;
  for (const segment of getGraphemeSegmenter().segment(value)) {
    const nextWidth = used + stringWidth(segment.segment);
    if (nextWidth > maxWidth) break;
    output += segment.segment;
    used = nextWidth;
  }
  return `${output}${suffix}`;
}

function isMutableTreeRow(row: ProjectTreeRow | null): boolean {
  return row?.kind === "file" || row?.kind === "directory";
}

function defaultCreateFilePath(row: ProjectTreeRow | null): string {
  if (row?.kind === "directory") return `${row.path}/`;
  if (row?.kind === "file") {
    const slash = row.path.lastIndexOf("/");
    return slash >= 0 ? `${row.path.slice(0, slash)}/` : "";
  }
  return "";
}

function fileActionFailureMessage(action, value: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (action.kind === "create") return `Cannot create ${value}: ${detail}`;
  if (action.kind === "rename") return `Cannot rename ${action.path}: ${detail}`;
  return `Cannot delete ${action.path}: ${detail}`;
}
