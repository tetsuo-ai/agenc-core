import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { peekLSPDiagnosticsForFile } from "../../../services/lsp/LSPDiagnosticRegistry.js";
import { peekAmbientRuntimeSession } from "../../../session/current-session.js";
import type { DiagnosticEntry } from "../../../services/lsp/types.js";
import { logError } from "../../../utils/log.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import type { DOMElement } from "../../ink/dom.js";
import type { InputEvent } from "../../ink/events/input-event.js";
import { nodeCache } from "../../ink/node-cache.js";
import { Box, Text } from "../../ink.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useInputCapture, useKeybindings } from "../../keybindings/useKeybinding.js";
import { useAppState } from "../../state/AppState.js";
import { taskMayReferencePath } from "../agents/activity.js";
import {
  type BufferVimCommand,
  type BufferVisibleLine,
} from "../buffer/BufferStore.js";
import { highlightBufferVisibleLines } from "../buffer/highlight.js";
import {
  getWorkbenchBufferProviderController,
} from "../buffer/providers/BufferProviderController.js";
import { BufferLine, NeovimGridView } from "../buffer/render.js";
import { useBufferStore } from "../buffer/useBufferStore.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";
import type { WorkbenchCommand } from "../types.js";

const EMPTY_HIGHLIGHTS: ReadonlyMap<number, string> = new Map();

export function BufferSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const snapshot = useBufferStore();
  const store = getWorkbenchBufferProviderController();
  const { rows, columns } = useTerminalSize();
  const tasks = useAppState((state) => state.tasks);
  const activePath = workbench.activeFilePath;
  const activeLine = workbench.activeFileLine ?? 1;
  const activeOpenRequestId = workbench.bufferOpenRequestId;
  const lastOpenRequest = useRef<string | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const inFlightAgent = useMemo(
    () => Object.values(tasks).find((task) =>
      task.type !== "local_bash" &&
      (task.status === "running" || task.status === "pending") &&
      taskMayReferencePath(task, snapshot.filePath ?? activePath)
    ),
    [activePath, snapshot.filePath, tasks],
  );
  const diagnostics = snapshot.absolutePath
    ? peekLSPDiagnosticsForFile(
        snapshot.absolutePath,
        peekAmbientRuntimeSession()?.services.sandboxExecutionBroker,
      )
    : [];
  const visibleLines = store.getVisibleLines();
  const highlightedLines = useBufferHighlightedLines(snapshot.filePath ?? activePath, visibleLines);
  const currentLineDiagnostic = diagnostics.find(
    (diagnostic) => diagnosticCoversLine(diagnostic, snapshot.position.line),
  );

  useEffect(() => {
    if (!activePath) return;
    const requestKey = `${activePath}\u0000${activeLine}\u0000${activeOpenRequestId}`;
    const isNewRequest = lastOpenRequest.current !== requestKey;
    const shouldRetryCleanBlockedPath =
      snapshot.status !== "loading" &&
      snapshot.filePath !== null &&
      snapshot.filePath !== activePath &&
      !snapshot.dirty;
    if (!isNewRequest && !shouldRetryCleanBlockedPath) return;
    lastOpenRequest.current = requestKey;
    void store.open(activePath, activeLine).catch(logError);
  }, [activeLine, activeOpenRequestId, activePath, snapshot.dirty, snapshot.filePath, snapshot.status, store]);

  useEffect(() => {
    store.resize({
      rows: Math.max(1, rows - 9),
      columns: Math.max(20, columns - 4),
    });
  }, [columns, rows, store]);

  useEffect(() => {
    store.focus(focused);
    return () => {
      if (focused) store.focus(false);
    };
  }, [focused, store]);

  useEffect(() => {
    if (!focused) return;
    if (workbench.activeSurfaceMode !== "buffer") return;
    if (snapshot.provider.kind !== "neovim") return;
    if (snapshot.providerStatus !== "closed") return;
    dispatch({ type: "closeSurface" });
  }, [dispatch, focused, snapshot.provider.kind, snapshot.providerStatus, workbench.activeSurfaceMode]);

  useEffect(() => () => {
    void store.cleanup().catch(logError);
  }, [store]);

  useRegisterKeybindingContext("Buffer", focused);
  const hasInFlightAgent = Boolean(inFlightAgent);
  const keyHandlers = useMemo(
    () => createBufferSurfaceKeyHandlers({
      store,
      snapshot,
      hasInFlightAgent,
      dispatch,
    }),
    [dispatch, hasInFlightAgent, snapshot, store],
  );
  useKeybindings(keyHandlers, { context: "Buffer", isActive: focused });

  const executeVimCommand = useCallback(
    (command: BufferVimCommand): void => {
      executeBufferVimCommand(command, {
        store,
        dispatch,
        hasInFlightAgent,
      });
    },
    [dispatch, hasInFlightAgent, store],
  );

  useInputCapture(
    useCallback(
      (input, key, event) => {
        if ((key.wheelUp || key.wheelDown) && !wheelInputIsInsideNode(event, contentRef.current)) {
          return false;
        }
        return store.handleInput(
          input,
          key,
          {
            columns: Math.max(20, columns - 8),
            rows: Math.max(1, rows - 9),
          },
          executeVimCommand,
          event.keypress.isPasted,
        );
      },
      [columns, executeVimCommand, rows, store],
    ),
    { context: "Buffer", isActive: focused },
  );

  if (!activePath && snapshot.status === "idle") {
    return <EmptySurface title="BUFFER" message="No file selected" />;
  }

  const status = bufferStatusLabel(snapshot, Boolean(inFlightAgent));
  const modeLabel = snapshot.vimCommandLine !== null ? "command" : snapshot.vimMode.toLowerCase();
  const terminal = snapshot.terminal;
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader
        title="BUFFER"
        detail={`${snapshot.filePath ?? activePath ?? "loading"} [${snapshot.provider.label}, ${modeLabel}, ${status}] ${snapshot.position.line}:${snapshot.position.column}`}
        focused={focused}
      />
      {snapshot.provider.fallbackReason ? (
        <Text color="warning" wrap="truncate-end">{snapshot.provider.fallbackReason}</Text>
      ) : null}
      {snapshot.providerMessage ? (
        <Text dimColor wrap="truncate-end">{snapshot.providerMessage}</Text>
      ) : null}
      {snapshot.error ? <Text color={snapshot.status === "conflict" ? "warning" : "error"} wrap="truncate-end">{snapshot.error}</Text> : null}
      {diagnostics.length > 0 ? (
        <Text color="warning" wrap="truncate-end">{diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}{currentLineDiagnostic ? ` - ${currentLineDiagnostic.message}` : ""}</Text>
      ) : null}
      {inFlightAgent ? (
        <Text color="warning" wrap="truncate-end">agent edit in flight: {inFlightAgent.description ?? inFlightAgent.id}</Text>
      ) : null}
      {snapshot.hoverText ? <Text dimColor wrap="truncate-end">{oneLine(snapshot.hoverText)}</Text> : null}
      <Box
        ref={contentRef}
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        onClick={(event) => {
          event.stopImmediatePropagation();
          if (focused) store.click(event.localRow, event.localCol);
        }}
      >
        {snapshot.status === "loading" ? <Text dimColor>Loading...</Text> : null}
        {terminal
          ? <NeovimGridView terminal={terminal} focused={focused} width={Math.max(16, columns - 4)} />
          : visibleLines.map((line) => (
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
          {terminal
            ? terminal.commandLine !== null
              ? `${terminal.mode.toUpperCase()}  :${terminal.commandLine}`
              : `${terminal.mode.toUpperCase()}  shift+tab composer  ctrl+x h explorer  ctrl+x ctrl+e external`
            : snapshot.vimCommandLine !== null
            ? `:${snapshot.vimCommandLine}`
            : snapshot.vimMode === "VISUAL"
              ? "VISUAL  h/j/k/l move  y yank  d delete  c change  p paste  esc normal"
              : snapshot.vimMode === "NORMAL"
                ? "BASIC FALLBACK  ctrl+x ctrl+e external  v visual  y/p register  : command  i/a/o insert"
                : "INSERT  esc normal"}
        </Text>
      </Box>
    </Box>
  );
}

export function wheelInputIsInsideNode(event: InputEvent, node: DOMElement | null): boolean {
  if (!event.key.wheelUp && !event.key.wheelDown) return true;
  const point = wheelPointFromInputEvent(event);
  if (!point) return false;
  if (!node) return false;
  const rect = nodeCache.get(node);
  if (!rect) return false;
  return point.column >= rect.x &&
    point.column < rect.x + rect.width &&
    point.row >= rect.y &&
    point.row < rect.y + rect.height;
}

function wheelPointFromInputEvent(event: InputEvent): { readonly column: number; readonly row: number } | null {
  const raw = event.keypress.raw ?? event.keypress.sequence ?? "";
  const sgr = /\x1B\[<\d+;(\d+);(\d+)[Mm]/.exec(raw);
  if (sgr) {
    return { column: Number(sgr[1]) - 1, row: Number(sgr[2]) - 1 };
  }
  if (raw.length === 6 && raw.startsWith("\x1B[M")) {
    return {
      column: raw.charCodeAt(4) - 33,
      row: raw.charCodeAt(5) - 33,
    };
  }
  return null;
}

type BufferSurfaceStore = Pick<ReturnType<typeof getWorkbenchBufferProviderController>,
  | "save"
  | "revert"
  | "close"
  | "openExternalEditor"
  | "undo"
  | "redo"
  | "move"
  | "requestHover"
  | "goToDefinition"
>;

export type BufferSurfaceActionOptions = {
  readonly store: BufferSurfaceStore;
  readonly snapshot: ReturnType<typeof useBufferStore>;
  readonly hasInFlightAgent: boolean;
  readonly dispatch: (command: WorkbenchCommand) => void;
};

export function createBufferSurfaceKeyHandlers({
  store,
  snapshot,
  hasInFlightAgent,
  dispatch,
}: BufferSurfaceActionOptions): Record<string, () => void | false | Promise<void>> {
  return {
    "buffer:save": () => {
      void store.save({ hasInFlightAgent }).catch(logError);
    },
    "workbench:focusExplorer": () => {
      dispatch({ type: "focus", pane: "explorer" });
    },
    "workbench:focusAgents": () => {
      dispatch({ type: "focus", pane: "agents" });
    },
    "workbench:focusComposer": () => {
      dispatch({ type: "focus", pane: "composer" });
    },
    "buffer:revert": () => {
      if (snapshot.provider.capabilities.terminalUi) return false;
      void store.revert().catch(logError);
    },
    "buffer:close": async () => {
      try {
        if (await store.close()) dispatch({ type: "closeSurface" });
      } catch (error) {
        logError(error);
      }
    },
    "buffer:closeDiscard": async () => {
      try {
        if (await store.close({ discard: true })) dispatch({ type: "closeSurface" });
      } catch (error) {
        logError(error);
      }
    },
    "buffer:externalEditor": () => {
      void store.openExternalEditor().catch(logError);
    },
    "buffer:undo": () => snapshot.provider.capabilities.terminalUi ? false : store.undo(),
    "buffer:redo": () => snapshot.provider.capabilities.terminalUi ? false : store.redo(),
    "buffer:hover": () => {
      if (snapshot.provider.capabilities.terminalUi) return false;
      void store.requestHover().catch(logError);
    },
    "buffer:definition": () => {
      if (snapshot.provider.capabilities.terminalUi) return false;
      void store.goToDefinition().catch(logError);
    },
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
  };
}

export function executeBufferVimCommand(
  command: BufferVimCommand,
  { store, dispatch, hasInFlightAgent }: Pick<BufferSurfaceActionOptions, "store" | "dispatch" | "hasInFlightAgent">,
): void {
  switch (command.type) {
    case "save":
      void store.save({ hasInFlightAgent, force: command.force }).catch(logError);
      break;
    case "quit":
      void (async () => {
        if (await store.close({ discard: command.discard })) dispatch({ type: "closeSurface" });
      })().catch(logError);
      break;
    case "saveQuit":
      void (async () => {
        const saved = await store.save({ hasInFlightAgent, force: command.force });
        if (saved && await store.close()) dispatch({ type: "closeSurface" });
      })().catch(logError);
      break;
  }
}

export function bufferStatusLabel(snapshot: ReturnType<typeof useBufferStore>, hasInFlightAgent: boolean): string {
  const parts = [snapshot.status];
  if (snapshot.dirty) parts.push("dirty");
  if (hasInFlightAgent) parts.push("agent");
  if (snapshot.encoding) parts.push(snapshot.encoding);
  if (snapshot.lineEndings) parts.push(snapshot.lineEndings);
  return parts.join(", ");
}

export function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function diagnosticCoversLine(diagnostic: DiagnosticEntry, line: number): boolean {
  const range = diagnostic.range;
  if (!range) return false;
  const targetLine = line - 1;
  const startLine = range.start.line;
  const endLine =
    range.end.line > startLine && range.end.character === 0
      ? range.end.line - 1
      : range.end.line;
  return targetLine >= startLine && targetLine <= endLine;
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
