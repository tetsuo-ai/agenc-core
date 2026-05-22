// @ts-nocheck
import React, { useEffect, useMemo } from "react";

import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState } from "../../state/AppState.js";
import { inFlightPathsFromTasks } from "../agents/activity.js";
import { attachFileCommand, openBufferCommand, openPreviewCommand } from "../commands.js";
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
          dispatch(openPreviewCommand(row.path, undefined, true));
          return;
        }
        if (row?.kind === "directory") store.toggle(row.path);
      },
      "explorer:openKeepFocus": () => {
        const row = store.getCursorRow();
        if (row?.kind === "file" && row.path) dispatch(openPreviewCommand(row.path, undefined, false));
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

  const visibleRows = snapshot.rows
    .slice(0, Math.max(1, 200))
    .map((row) => row.selected ? { ...row, focused } : row);

  return (
    <Box flexDirection="column" width={width} height="100%" borderRight borderColor={focused ? "suggestion" : "gray"} paddingX={1}>
      <Box height={1}>
        <Text color={focused ? "suggestion" : "gray"} wrap="truncate-end">Explorer</Text>
        {snapshot.loading ? <Text dimColor> refresh</Text> : null}
      </Box>
      {snapshot.error ? <Text color="error" wrap="truncate-end">{snapshot.error}</Text> : null}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleRows.map((row) => <ProjectExplorerRow key={row.id} row={row} width={Math.max(8, width - 2)} />)}
      </Box>
    </Box>
  );
}

export function ProjectExplorerRow({
  row,
  width,
}: {
  readonly row: ProjectTreeRow;
  readonly width: number;
}): React.ReactElement {
  const marker = markerForRow(row);
  const git = gitMarker(row.gitState);
  const prefix = "  ".repeat(Math.max(0, row.depth));
  const extras = `${row.active ? " *" : ""}${row.attached ? " @" : ""}${row.searchHit ? " ?" : ""}${row.inFlight ? " ~" : ""}`;
  const labelWidth = Math.max(1, width - prefix.length - marker.length - git.length - extras.length - 2);
  const label = trim(row.label, labelWidth);
  const color = row.selected ? (row.focused ? "suggestion" : "gray") : row.kind === "file" ? undefined : "text2";
  return (
    <Box height={1}>
      <Text color={color} inverse={row.focused} wrap="truncate-end">
        {prefix}{marker} {git}{label}{extras}
      </Text>
    </Box>
  );
}

function markerForRow(row: ProjectTreeRow): string {
  if (row.kind === "root") return row.expanded ? "v" : ">";
  if (row.kind === "directory") return row.expanded ? "v" : ">";
  if (row.kind === "loading") return ".";
  if (row.kind === "error") return "!";
  return "-";
}

function gitMarker(state: ProjectTreeRow["gitState"]): string {
  switch (state) {
    case "modified":
      return "M ";
    case "added":
      return "A ";
    case "deleted":
      return "D ";
    case "renamed":
      return "R ";
    case "unmerged":
      return "U ";
    case "untracked":
      return "? ";
    case "ignored":
      return "! ";
    default:
      return "";
  }
}

function trim(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, Math.max(0, width - 3))}...`;
}
