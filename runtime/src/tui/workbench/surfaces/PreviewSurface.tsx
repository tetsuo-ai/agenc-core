import path from "node:path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { peekLSPDiagnosticsForFile } from "../../../services/lsp/LSPDiagnosticRegistry.js";
import { peekAmbientRuntimeSession } from "../../../session/current-session.js";
import { getCwd } from "../../../utils/cwd.js";
import { logError } from "../../../utils/log.js";
import { readFileInRange } from "../../../utils/readFileInRange.js";
import { Box, Text, Ansi } from "../../ink.js";
import type { DOMElement } from "../../ink/dom.js";
import { useKeybindings, useInputCapture } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState } from "../../state/AppState.js";
import { taskMayReferencePath } from "../agents/activity.js";
import { attachFileRangeCommand, openBufferCommand } from "../commands.js";
import { collectGitStatus } from "../project-tree/gitStatus.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { highlightBufferVisibleLines } from "../buffer/highlight.js";
import { wheelInputIsInsideNode } from "./wheelInput.js";

const PAGE_SIZE = 80;

export function PreviewSurface({
  focused,
  pathOverride = null,
}: {
  readonly focused: boolean;
  /**
   * When set (the right-hand review rail), the surface shows THIS path
   * instead of the workbench's active file. Lets the chat keep the center
   * pane while the file is reviewed beside it (ctrl+r).
   */
  readonly pathOverride?: string | null;
}): React.ReactElement {
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const contentRef = useRef<DOMElement | null>(null);
  const [startLine, setStartLine] = useState(() => Math.max(0, (workbench.activeFileLine ?? 1) - 1));
  const [totalLines, setTotalLines] = useState<number | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [gitStateState, setGitStateState] = useState<{
    readonly path: string | null;
    readonly status: string | null;
  }>({ path: null, status: null });
  const tasks = useAppState((state) => state.tasks);
  const activePath = pathOverride ?? workbench.activeFilePath;
  const gitState = gitStateState.path === activePath ? gitStateState.status : null;
  const inFlightAgent = useMemo(
    () => Object.values(tasks).find((task: any) =>
      task.type !== "local_bash" &&
      (task.status === "running" || task.status === "pending") &&
      taskMayReferencePath(task, activePath)
    ),
    [activePath, tasks],
  );
  const absolutePath = activePath ? path.resolve(getCwd(), activePath) : null;
  const diagnostics = useMemo(
    () => absolutePath
      ? peekLSPDiagnosticsForFile(
          absolutePath,
          peekAmbientRuntimeSession()?.services.sandboxExecutionBroker,
        )
      : [],
    [absolutePath, content],
  );
  const lines = content.length > 0 ? content.split("\n") : [];
  // Syntax colors for the file body (the user asked why the rail "loses the
  // file's colors"): same shiki pipeline the BUFFER uses, mapped per line so
  // the dim line-number gutter stays. Falls back to plain text when the
  // highlighter is unavailable or the language is unknown.
  const [highlightedLines, setHighlightedLines] = useState<ReadonlyMap<number, string>>(new Map());
  useEffect(() => {
    if (!activePath || lines.length === 0) {
      setHighlightedLines(new Map());
      return;
    }
    let cancelled = false;
    const visible = lines.map((text, index) => ({ number: startLine + index + 1, text }));
    void highlightBufferVisibleLines(activePath, visible)
      .then((map) => {
        if (!cancelled) setHighlightedLines(map);
      })
      .catch(() => {
        if (!cancelled) setHighlightedLines(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [activePath, content]);

  useEffect(() => {
    setStartLine(Math.max(0, (workbench.activeFileLine ?? 1) - 1));
    setTotalLines(null);
    setContent("");
    setError(null);
  }, [workbench.activeFileLine, workbench.activeFilePath]);

  useEffect(() => {
    if (!absolutePath) {
      setContent("");
      setError(null);
      setGitStateState({ path: null, status: null });
      setTotalLines(null);
      return;
    }
    const controller = new AbortController();
    readFileInRange(absolutePath, startLine, PAGE_SIZE, undefined, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const nextTotalLines = Math.max(0, result.totalLines ?? result.lineCount ?? 0);
        const maxStartLine = maxPreviewStartLine(nextTotalLines);
        setTotalLines(nextTotalLines);
        if (startLine > maxStartLine) {
          setContent("");
          setError(null);
          setStartLine(maxStartLine);
          return;
        }
        setContent(result.content);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setContent("");
        setTotalLines(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [absolutePath, startLine]);

  useEffect(() => {
    if (!activePath) {
      setGitStateState({ path: null, status: null });
      return;
    }
    const statusPath = activePath;
    setGitStateState({ path: statusPath, status: null });
    let mounted = true;
    collectGitStatus(getCwd())
      .then((status) => {
        if (mounted) setGitStateState({ path: statusPath, status: status.get(statusPath) ?? "clean" });
      })
      .catch((error) => {
        if (!mounted) return;
        logError(error);
        setGitStateState({ path: statusPath, status: null });
      });
    return () => {
      mounted = false;
    };
  }, [activePath]);

  useRegisterKeybindingContext("Surface", focused);
  // Mouse wheel scrolls the file regardless of which pane owns the keyboard —
  // the review rail (ctrl+r) is meant to be scrolled while typing in the
  // composer. Scoped to this surface's own rect so wheel over the transcript
  // or composer never moves the file.
  useInputCapture(
    useCallback(
      (input, key, event) => {
        if (!key.wheelUp && !key.wheelDown) return false;
        if (!wheelInputIsInsideNode(event, contentRef.current)) return false;
        setStartLine((value) => clampPreviewStartLine(value + (key.wheelUp ? -3 : 3), totalLines));
        return true;
      },
      [totalLines],
    ),
    { context: "Surface", isActive: true },
  );
  useKeybindings(
    {
      "surface:up": () => setStartLine((value) => Math.max(0, value - 1)),
      "surface:down": () => setStartLine((value) => clampPreviewStartLine(value + 1, totalLines)),
      "surface:pageUp": () => setStartLine((value) => Math.max(0, value - 20)),
      "surface:pageDown": () => setStartLine((value) => clampPreviewStartLine(value + 20, totalLines)),
      "surface:top": () => setStartLine(0),
      "surface:attach": () => {
        if (activePath) dispatch(attachFileRangeCommand(activePath, startLine + 1, startLine + Math.max(1, lines.length)));
      },
      "surface:edit": () => {
        if (activePath) dispatch(openBufferCommand(activePath, startLine + 1, true));
      },
      "workbench:closeSurface": () => dispatch({ type: "closeSurface" }),
    },
    { context: "Surface", isActive: focused },
  );

  if (!activePath) {
    return <EmptySurface title="PREVIEW" message="No file selected" />;
  }

  return (
    <Box ref={contentRef} flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader title="PREVIEW" detail={`${activePath} [read-only${gitState && gitState !== "clean" ? `, ${gitState}` : ""}]`} focused={focused} />
      {error ? <Text color="error" wrap="truncate-end">{error}</Text> : null}
      {diagnostics.length > 0 ? (
        <Text color="warning" wrap="truncate-end">{diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}</Text>
      ) : null}
      {inFlightAgent ? (
        <Text color="warning" wrap="truncate-end">agent edit in flight: {inFlightAgent.description ?? inFlightAgent.id}</Text>
      ) : null}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {lines.map((line, index) => {
          const lineNumber = startLine + index + 1;
          const highlighted = highlightedLines.get(lineNumber);
          return (
            <Text key={`${lineNumber}:${line}`} wrap="truncate-end">
              <Text dimColor>{String(lineNumber).padStart(5, " ")} </Text>
              {highlighted !== undefined ? <Ansi>{highlighted}</Ansi> : line}
            </Text>
          );
        })}
      </Box>
      <Box height={1}>
        <Text dimColor>q transcript  j/k scroll  e edit  @ attach range</Text>
        <Text dimColor> </Text>
      </Box>
    </Box>
  );
}

function maxPreviewStartLine(totalLines: number): number {
  return Math.max(0, totalLines - 1);
}

function clampPreviewStartLine(startLine: number, totalLines: number | null): number {
  const nextStartLine = Math.max(0, Math.floor(startLine));
  return totalLines === null
    ? nextStartLine
    : Math.min(nextStartLine, maxPreviewStartLine(totalLines));
}

export function SurfaceHeader({
  title,
  detail,
  focused,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly focused?: boolean;
}): React.ReactElement {
  return (
    <Box height={1} flexShrink={0}>
      <Text color={focused ? "suggestion" : "text2"} wrap="truncate-end">{title}</Text>
      {detail ? <Text dimColor wrap="truncate-end"> - {detail}</Text> : null}
    </Box>
  );
}

export function EmptySurface({
  title,
  message,
  detail,
}: {
  readonly title: string;
  readonly message: string;
  readonly detail?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <SurfaceHeader title={title} detail={detail} />
      <Text dimColor>{message}</Text>
    </Box>
  );
}
