// @ts-nocheck
import React, { useEffect, useMemo } from "react";

import { peekLSPDiagnosticsForFile } from "../../../services/lsp/LSPDiagnosticRegistry.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { Box, Text, useInput } from "../../ink.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useAppState } from "../../state/AppState.js";
import { taskMayReferencePath } from "../agents/activity.js";
import { getWorkbenchBufferStore } from "../buffer/BufferStore.js";
import { BufferLine } from "../buffer/render.js";
import { useBufferStore } from "../buffer/useBufferStore.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";

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

  useInput((input, key, event) => {
    if (key.ctrl || key.meta || key.super || key.escape) return;
    if (key.return) {
      store.newline();
      event.stopImmediatePropagation();
      return;
    }
    if (key.tab) {
      store.insert("\t");
      event.stopImmediatePropagation();
      return;
    }
    if (key.backspace) {
      store.backspace();
      event.stopImmediatePropagation();
      return;
    }
    if (key.delete) {
      store.deleteForward();
      event.stopImmediatePropagation();
      return;
    }
    if (input.length > 0) {
      store.insert(input);
      event.stopImmediatePropagation();
    }
  }, { isActive: focused });

  if (!activePath && snapshot.status === "idle") {
    return <EmptySurface title="BUFFER" message="No file selected" />;
  }

  const status = bufferStatusLabel(snapshot, Boolean(inFlightAgent));
  const visibleLines = store.getVisibleLines();
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader
        title="BUFFER"
        detail={`${snapshot.filePath ?? activePath ?? "loading"} [${status}] ${snapshot.position.line}:${snapshot.position.column}`}
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
          />
        ))}
      </Box>
      <Box height={1}>
        <Text dimColor wrap="truncate-end">
          ctrl+s save  ctrl+z undo  ctrl+y redo  ctrl+w q close  ctrl+w x discard
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
