// @ts-nocheck
import React, { useEffect, useMemo } from "react";

import { selectAgenCTuiGlyphs } from "../../glyphs.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { Box, Text } from "../../ink.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState } from "../../state/AppState.js";
import { getGraphemeSegmenter } from "../../../utils/intl.js";
import { inFlightPathsFromTasks } from "../agents/activity.js";
import { attachFileCommand, openBufferCommand } from "../commands.js";
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
  const maxTreeRows = Math.max(1, terminalRows - 8);
  const attachedPaths = useMemo(
    () => workbench.attachments.flatMap((item) => item.path ? [item.path] : []),
    [workbench.attachments],
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
    },
    { context: "Explorer", isActive: focused },
  );

  const viewport = projectTreeViewport(snapshot.rows, maxTreeRows);
  const visibleRows = viewport.rows
    .map((row) => row.selected ? { ...row, focused } : row);
  const itemCount = snapshot.rows.filter((row) => row.kind === "file" || row.kind === "directory").length;
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
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {viewport.above > 0 ? (
          <Box height={1} flexShrink={0}>
            <Text dimColor wrap="truncate-end">{glyphs.arrowUp} {viewport.above} more</Text>
          </Box>
        ) : null}
        {visibleRows.map((row) => <ProjectExplorerRow key={row.id} row={row} width={Math.max(8, width - 2)} />)}
        {viewport.below > 0 ? (
          <Box height={1} flexShrink={0}>
            <Text dimColor wrap="truncate-end">{glyphs.arrowDown} {viewport.below} more</Text>
          </Box>
        ) : null}
      </Box>
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
  const suffix = "...";
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
