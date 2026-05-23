// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { peekLSPDiagnosticsForFile } from "../../../services/lsp/LSPDiagnosticRegistry.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { Box, Text } from "../../ink.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useInputCapture, useKeybindings } from "../../keybindings/useKeybinding.js";
import { useAppState } from "../../state/AppState.js";
import { taskMayReferencePath } from "../agents/activity.js";
import {
  getWorkbenchBufferStore,
  type BufferVimCommand,
  type BufferVisibleLine,
} from "../buffer/BufferStore.js";
import { highlightBufferVisibleLines } from "../buffer/highlight.js";
import { BufferLine } from "../buffer/render.js";
import { useBufferStore } from "../buffer/useBufferStore.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";

const EMPTY_HIGHLIGHTS: ReadonlyMap<number, string> = new Map();

export function BufferSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const snapshot = useBufferStore();
  const store = getWorkbenchBufferStore();
  const { rows, columns } = useTerminalSize();
  const tasks = useAppState((state) => state.tasks);
  const activePath = workbench.activeFilePath;
  const inFlightAgent = useMemo(
    () => Object.values(tasks).find((task) =>
      task.type !== "local_bash" &&
      (task.status === "running" || task.status === "pending") &&
      taskMayReferencePath(task, snapshot.filePath ?? activePath)
    ),
    [activePath, snapshot.filePath, tasks],
  );
  const diagnostics = snapshot.absolutePath
    ? peekLSPDiagnosticsForFile(snapshot.absolutePath)
    : [];
  const visibleLines = store.getVisibleLines();
  const highlightedLines = useBufferHighlightedLines(snapshot.filePath ?? activePath, visibleLines);
  const currentLineDiagnostic = diagnostics.find(
    (diagnostic) => (diagnostic.range?.start.line ?? -1) + 1 === snapshot.position.line,
  );

  useEffect(() => {
    if (activePath) {
      void store.open(activePath, workbench.activeFileLine ?? 1);
    }
  }, [activePath, store, workbench.activeFileLine]);

  useEffect(() => {
    store.setViewportRows(Math.max(1, rows - 9));
  }, [rows, store]);

  useRegisterKeybindingContext("Buffer", focused);
  useKeybindings(
    {
      "buffer:save": () => store.save({ hasInFlightAgent: Boolean(inFlightAgent) }),
      "buffer:revert": () => store.revert(),
      "buffer:close": () => {
        if (store.close()) dispatch({ type: "closeSurface" });
      },
      "buffer:closeDiscard": () => {
        if (store.close({ discard: true })) dispatch({ type: "closeSurface" });
      },
      "buffer:externalEditor": () => {
        void store.openExternalEditor();
      },
      "buffer:undo": () => store.undo(),
      "buffer:redo": () => store.redo(),
      "buffer:hover": () => store.requestHover(),
      "buffer:definition": () => store.goToDefinition(),
      "buffer:up": () => store.move("up"),
      "buffer:down": () => store.move("down"),
      "buffer:left": () => store.move("left"),
      "buffer:right": () => store.move("right"),
      "buffer:pageUp": () => store.move("up", { pageSize: Math.max(1, snapshot.viewportRows - 1) }),
      "buffer:pageDown": () => store.move("down", { pageSize: Math.max(1, snapshot.viewportRows - 1) }),
      "buffer:lineStart": () => store.move("lineStart"),
      "buffer:lineEnd": () => store.move("lineEnd"),
      "buffer:top": () => store.move("top"),
      "buffer:bottom": () => store.move("bottom"),
      "buffer:selectUp": () => store.move("up", { extend: true }),
      "buffer:selectDown": () => store.move("down", { extend: true }),
      "buffer:selectLeft": () => store.move("left", { extend: true }),
      "buffer:selectRight": () => store.move("right", { extend: true }),
      "buffer:selectLineStart": () => store.move("lineStart", { extend: true }),
      "buffer:selectLineEnd": () => store.move("lineEnd", { extend: true }),
    },
    { context: "Buffer", isActive: focused },
  );

  const executeVimCommand = useCallback(
    (command: BufferVimCommand): void => {
      switch (command.type) {
        case "save":
          void store.save({ hasInFlightAgent: Boolean(inFlightAgent) });
          break;
        case "quit":
          if (store.close({ discard: command.discard })) dispatch({ type: "closeSurface" });
          break;
        case "saveQuit":
          void (async () => {
            const saved = await store.save({ hasInFlightAgent: Boolean(inFlightAgent) });
            if (saved && store.close()) dispatch({ type: "closeSurface" });
          })();
          break;
      }
    },
    [dispatch, inFlightAgent, store],
  );

  useInputCapture(
    useCallback(
      (input, key) => store.handleVimInput(input, key, Math.max(20, columns - 8), executeVimCommand),
      [columns, executeVimCommand, store],
    ),
    { context: "Buffer", isActive: focused },
  );

  if (!activePath && snapshot.status === "idle") {
    return <EmptySurface title="BUFFER" message="No file selected" />;
  }

  const status = bufferStatusLabel(snapshot, Boolean(inFlightAgent));
  const modeLabel = snapshot.vimCommandLine !== null ? "command" : snapshot.vimMode.toLowerCase();
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader
        title="BUFFER"
        detail={`${snapshot.filePath ?? activePath ?? "loading"} [${modeLabel}, ${status}] ${snapshot.position.line}:${snapshot.position.column}`}
        focused={focused}
      />
      {snapshot.error ? <Text color={snapshot.status === "conflict" ? "warning" : "error"} wrap="truncate-end">{snapshot.error}</Text> : null}
      {diagnostics.length > 0 ? (
        <Text color="warning" wrap="truncate-end">{diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}{currentLineDiagnostic ? ` - ${currentLineDiagnostic.message}` : ""}</Text>
      ) : null}
      {inFlightAgent ? (
        <Text color="warning" wrap="truncate-end">agent edit in flight: {inFlightAgent.description ?? inFlightAgent.id}</Text>
      ) : null}
      {snapshot.hoverText ? <Text dimColor wrap="truncate-end">{oneLine(snapshot.hoverText)}</Text> : null}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {snapshot.status === "loading" ? <Text dimColor>Loading...</Text> : null}
        {visibleLines.map((line) => (
          <BufferLine
            key={line.number}
            line={line}
            snapshot={snapshot}
            width={Math.max(16, columns - 4)}
            focused={focused}
            highlightedText={highlightedLines.get(line.number)}
          />
        ))}
      </Box>
      <Box height={1}>
        <Text dimColor wrap="truncate-end">
          {snapshot.vimCommandLine !== null
            ? `:${snapshot.vimCommandLine}`
            : snapshot.vimMode === "VISUAL"
              ? "VISUAL  h/j/k/l move  y yank  d delete  c change  p paste  esc normal"
              : snapshot.vimMode === "NORMAL"
                ? "NORMAL  enter $EDITOR  v visual  y/p register  : command  i/a/o insert  u undo"
                : "INSERT  esc normal"}
        </Text>
      </Box>
    </Box>
  );
}

function bufferStatusLabel(snapshot: ReturnType<typeof useBufferStore>, hasInFlightAgent: boolean): string {
  const parts = [snapshot.status];
  if (snapshot.dirty) parts.push("dirty");
  if (hasInFlightAgent) parts.push("agent");
  if (snapshot.encoding) parts.push(snapshot.encoding);
  if (snapshot.lineEndings) parts.push(snapshot.lineEndings);
  return parts.join(", ");
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function useBufferHighlightedLines(
  filePath: string | null,
  visibleLines: readonly BufferVisibleLine[],
): ReadonlyMap<number, string> {
  const [highlightedLines, setHighlightedLines] = useState<ReadonlyMap<number, string>>(EMPTY_HIGHLIGHTS);
  const highlightKey = useMemo(
    () => `${filePath ?? ""}\u0000${visibleLines.map((line) => `${line.number}:${line.text}`).join("\u0000")}`,
    [filePath, visibleLines],
  );
  const linesForHighlight = useMemo(
    () => visibleLines.map((line) => ({ ...line })),
    [highlightKey],
  );

  useEffect(() => {
    let active = true;
    setHighlightedLines(EMPTY_HIGHLIGHTS);
    void highlightBufferVisibleLines(filePath, linesForHighlight).then((result) => {
      if (active) setHighlightedLines(result);
    });
    return () => {
      active = false;
    };
  }, [filePath, highlightKey, linesForHighlight]);

  return highlightedLines;
}
