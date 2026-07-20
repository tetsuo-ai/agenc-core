import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { selectAgenCTuiGlyphs } from "../../glyphs.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { Box, Text } from "../../ink.js";
import type { DOMElement } from "../../ink/dom.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { useInputCapture, useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState } from "../../state/AppState.js";
import TextInput from "../../components/TextInput.js";
import { getGraphemeSegmenter } from "../../../utils/intl.js";
import { logError } from "../../../utils/log.js";
import { inFlightPathsFromTasks } from "../agents/activity.js";
import { attachFileCommand, deletePathReferencesCommand, openBufferCommand, renamePathReferencesCommand } from "../commands.js";
import { composerAttachmentsForState } from "../reducer.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { wheelInputIsInsideNode } from "../surfaces/wheelInput.js";
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
      // A click on the tree hands it keyboard focus; esc is the way back to
      // the prompt. Without this the explorer swallowed focus with no visible
      // escape hatch (users were trapped out of the composer).
      "explorer:backToComposer": () => dispatch({ type: "focus", pane: "composer" }),
    },
    { context: "Explorer", isActive: focused && fileAction === null },
  );

  const viewport = projectTreeViewport(snapshot.rows, maxTreeRows);
  const visibleRows = viewport.rows
    .map((row) => row.selected ? { ...row, focused } : row);
  // Mouse: click a row to select it AND take keyboard focus (a click on the
  // tree means the next arrow keys are meant for the tree). Directory clicks
  // also toggle expansion; file clicks open the buffer surface without moving
  // focus away from the explorer.
  const handleRowClick = useCallback((row: ProjectTreeRow): void => {
    if (row.kind !== "root" && row.kind !== "loading" && row.kind !== "empty" && row.kind !== "error") {
      dispatch({ type: "focus", pane: "explorer" });
    }
    if (row.kind === "directory") {
      store.toggle(row.path);
      return;
    }
    if (row.kind === "file" && row.path) {
      store.reveal(row.path);
      dispatch(openBufferCommand(row.path, undefined, false));
    }
  }, [dispatch, store]);
  // Mouse wheel scrolls the tree (moves the cursor, the viewport window
  // follows it), scoped to the explorer pane's rect.
  const paneRef = useRef<DOMElement | null>(null);
  useInputCapture(
    useCallback(
      (input, key, event) => {
        if (!key.wheelUp && !key.wheelDown) return false;
        if (!wheelInputIsInsideNode(event, paneRef.current)) return false;
        store.move(key.wheelUp ? -3 : 3);
        return true;
      },
      [store],
    ),
    { context: "Explorer", isActive: true },
  );
  // Drive the WORKSPACE count from the project's real file total (carried on the
  // snapshot, collapse-independent) rather than the currently-visible rows — a
  // collapsed directory hides its children from the rows, which would undercount
  // a multi-file project (e.g. an agent-created subpackage showing "WORKSPACE 1").
  const itemCount = snapshot.fileCount;
  const dirtyCount = snapshot.rows.filter((row) => row.gitState && row.gitState !== "clean").length;
  const headerLabel = "WORKSPACE";
  const headerLabelWidth = stringWidth(headerLabel);
  const headerContentWidth = Math.max(0, width - 3);
  const renderedHeaderLabelWidth = Math.min(headerLabelWidth, headerContentWidth);
  const headerMeta = `${itemCount}${dirtyCount > 0 ? ` ${dirtyCount} changed` : ""}${snapshot.loading ? " sync" : ""}`;
  const headerMetaWidth = Math.max(0, headerContentWidth - renderedHeaderLabelWidth - 1);
  const glyphs = selectAgenCTuiGlyphs();

  return (
    <Box ref={paneRef} flexDirection="column" width={width} height="100%" borderRight borderColor={focused ? "suggestion" : "gray"} paddingX={1}>
      <Box height={1} flexShrink={0}>
        {renderedHeaderLabelWidth > 0 ? (
          <Box width={renderedHeaderLabelWidth} flexShrink={0}>
            <Text color={focused ? "suggestion" : "gray"} wrap={renderedHeaderLabelWidth < headerLabelWidth ? "truncate-end" : "wrap"}>{headerLabel}</Text>
          </Box>
        ) : null}
        {headerMetaWidth > 0 ? (
          <Box width={headerMetaWidth} marginLeft={1} flexShrink={1} overflow="hidden">
            <Text dimColor wrap="truncate-end">{headerMeta}</Text>
          </Box>
        ) : null}
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
        {visibleRows.map((row) => <ProjectExplorerRow key={row.id} row={row} width={Math.max(8, width - 3)} onRowClick={handleRowClick} />)}
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
  onRowClick,
}: {
  readonly row: ProjectTreeRow;
  readonly width: number;
  /** Mouse click on the row (selection, directory toggle, file preview). */
  readonly onRowClick?: (row: ProjectTreeRow) => void;
}): React.ReactElement {
  const glyphs = selectAgenCTuiGlyphs();
  const branch = indentPrefix(row);
  const marker = markerForRow(row, glyphs);
  const badges = rowBadges(row, glyphs);
  const prefix = `${branch}${marker} `;
  // Directories carry a trailing slash so they scan differently from files at
  // a glance, without spending a color on the distinction.
  const rawLabel = row.kind === "directory" ? `${row.label}/` : row.label;
  const labelWidth = Math.max(1, width - stringWidth(prefix) - stringWidth(badges) - 1);
  const label = trim(rawLabel, labelWidth);
  const gap = Math.max(0, width - stringWidth(prefix) - stringWidth(label) - stringWidth(badges));
  const color = colorForRow(row);
  return (
    <Box height={1} flexShrink={0} onClick={onRowClick !== undefined ? () => onRowClick(row) : undefined}>
      <Text color={color} inverse={row.focused} wrap="truncate-end">
        {prefix}{label}{" ".repeat(gap)}{badges}
      </Text>
    </Box>
  );
}

function indentPrefix(row: ProjectTreeRow): string {
  // Flat indentation, deliberately WITHOUT connector rails (`│ `, `├─ `): the
  // viewport renders a scrolled window of the tree, and a rail implies a
  // visible parent that may be offscreen — the render contract in
  // tests/tui/workbench/render.test.tsx guards this.
  return "  ".repeat(Math.max(0, row.depth));
}

function markerForRow(row: ProjectTreeRow, glyphs: ReturnType<typeof selectAgenCTuiGlyphs>): string {
  // Folders get a real folder icon (open when expanded) instead of the bare
  // arrow — editor-style affordance (UX request). The root (workspace) is
  // always expanded.
  if (row.kind === "root") return glyphs.folderOpen;
  if (row.kind === "directory") return row.expanded ? glyphs.folderOpen : glyphs.folderClosed;
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
      // Dotfiles are housekeeping noise in most workspaces — keep them visible
      // but visually quiet (a git state, when present, still wins above).
      if (row.kind === "file") {
        if (row.label.startsWith(".")) return "gray";
        return fileTypeColor(row.label);
      }
      return "text2";
  }
}

/**
 * Editor-style file-type colors by extension (UX request): code in the
 * suggestion blue, docs green, config/data yellow, media in the brand tone.
 * Unknown extensions keep the default terminal color. Keyed by lowercase
 * extension without the dot; filenames without one return undefined.
 */
function fileTypeColor(label: string): string | undefined {
  const dot = label.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = label.slice(dot + 1).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return "suggestion";
  if (DOC_EXTENSIONS.has(ext)) return "success";
  if (CONFIG_EXTENSIONS.has(ext)) return "warning";
  if (MEDIA_EXTENSIONS.has(ext)) return "agenc";
  return undefined;
}

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "rb", "java", "kt", "c", "h", "cc", "cpp", "hpp",
  "cs", "swift", "sol", "sh", "bash", "zsh", "fish", "sql", "lua", "zig",
]);
const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "mdx", "txt", "rst", "adoc", "org",
]);
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  "json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "ini", "env",
  "lock", "cfg", "conf", "properties",
]);
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
  "mp4", "webm", "mov", "mp3", "wav", "ogg", "pdf",
]);

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
