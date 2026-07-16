import path from "node:path";
import React, { useEffect, useMemo, useState } from "react";

import { peekLSPDiagnosticsForFile } from "../../../services/lsp/LSPDiagnosticRegistry.js";
import { peekAmbientRuntimeSession } from "../../../session/current-session.js";
import { getCwd } from "../../../utils/cwd.js";
import { logError } from "../../../utils/log.js";
import { readFileInRange } from "../../../utils/readFileInRange.js";
import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState } from "../../state/AppState.js";
import { taskMayReferencePath } from "../agents/activity.js";
import { attachFileRangeCommand, openBufferCommand } from "../commands.js";
import { collectGitStatus } from "../project-tree/gitStatus.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";

const PAGE_SIZE = 80;

export function PreviewSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const [startLine, setStartLine] = useState(() => Math.max(0, (workbench.activeFileLine ?? 1) - 1));
  const [totalLines, setTotalLines] = useState<number | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [gitStateState, setGitStateState] = useState<{
    readonly path: string | null;
    readonly status: string | null;
  }>({ path: null, status: null });
  const tasks = useAppState((state) => state.tasks);
  const activePath = workbench.activeFilePath;
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
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
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
          return (
            <Text key={`${lineNumber}:${line}`} wrap="truncate-end">
              <Text dimColor>{String(lineNumber).padStart(5, " ")} </Text>
              {line}
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
