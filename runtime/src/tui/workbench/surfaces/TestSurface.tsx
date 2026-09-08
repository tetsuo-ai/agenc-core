import React, { useEffect, useMemo, useState } from "react";

import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState } from "../../state/AppState.js";
import { attachTaskErrorCommand, openBufferCommand } from "../commands.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { resolveWorkbenchShellTask } from "../tasks/shellTasks.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";
import { useTaskTail } from "./useTaskTail.js";
import { parseVitestFailures } from "./outputParsers.js";
import { clampSurfaceSelection } from "./selection.js";

const TAIL_BYTES = 48_000;

export function TestSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const tasks = useAppState((state) => state.tasks);
  const dispatch = useWorkbenchDispatch();
  const task = useMemo(() => {
    return resolveWorkbenchShellTask(tasks, workbench.selectedShellTaskId);
  }, [tasks, workbench.selectedShellTaskId]);
  const { content: tail, error } = useTaskTail({
    taskId: task?.id,
    status: task?.status,
    maxBytes: TAIL_BYTES,
    pollIntervalMs: 1_000,
  });
  const [selected, setSelected] = useState(0);
  const failures = useMemo(() => parseVitestFailures(tail), [tail]);
  const selectedIndex = clampSurfaceSelection(selected, failures.length);
  const selectedFailure = failures[selectedIndex] ?? null;

  useEffect(() => {
    setSelected(0);
  }, [task?.id]);

  useRegisterKeybindingContext("Surface", focused);
  const jumpToSelectedFailure = (focus = true) => {
    if (selectedFailure?.location) {
      dispatch(openBufferCommand(
        selectedFailure.location.file,
        selectedFailure.location.line,
        focus,
      ));
    }
  };
  useKeybindings(
    {
      "surface:up": () => setSelected((value) => Math.max(0, clampSurfaceSelection(value, failures.length) - 1)),
      "surface:down": () => setSelected((value) => Math.min(Math.max(0, failures.length - 1), clampSurfaceSelection(value, failures.length) + 1)),
      "surface:pageUp": () => setSelected((value) => Math.max(0, clampSurfaceSelection(value, failures.length) - 10)),
      "surface:pageDown": () => setSelected((value) => Math.min(Math.max(0, failures.length - 1), clampSurfaceSelection(value, failures.length) + 10)),
      "surface:top": () => setSelected(0),
      "surface:bottom": () => setSelected(Math.max(0, failures.length - 1)),
      "surface:open": () => jumpToSelectedFailure(true),
      "surface:openKeepFocus": () => jumpToSelectedFailure(false),
      "surface:attach": () => {
        if (task?.id && selectedFailure?.location) {
          dispatch(attachTaskErrorCommand({
            taskId: task.id,
            file: selectedFailure.location.file,
            line: selectedFailure.location.line,
            label: selectedFailure.name,
          }));
        }
      },
      "workbench:closeSurface": () => dispatch({ type: "closeSurface" }),
    },
    { context: "Surface", isActive: focused },
  );

  if (!task) return <EmptySurface title="TEST" message="No test task selected" />;

  return <TestSurfaceView failures={failures} selected={selectedIndex} focused={focused} outputError={error} />;
}

export function TestSurfaceView({
  failures,
  selected,
  focused,
  outputError,
}: {
  readonly failures: readonly ReturnType<typeof parseVitestFailures>[number][];
  readonly selected: number;
  readonly focused: boolean;
  readonly outputError?: string | null;
}): React.ReactElement {
  const selectedIndex = clampSurfaceSelection(selected, failures.length);
  const selectedFailure = failures[selectedIndex] ?? null;
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader title="TEST" detail={`${failures.length} failure${failures.length === 1 ? "" : "s"} - enter edit - o keep focus - @ attach`} focused={focused} />
      {outputError != null ? <Text color="error" wrap="truncate-end">Output read failed: {outputError}</Text> : null}
      {failures.length === 0 ? (
        <Text dimColor wrap="truncate-end">No parsed test failures in the selected task output.</Text>
      ) : null}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {failures.map((failure, index) => (
          <Text key={failure.id} color={index === selectedIndex ? "suggestion" : undefined} wrap="truncate-end">
            {failure.location ? `${failure.location.file}:${failure.location.line} ` : ""}
            {failure.name}
          </Text>
        ))}
      </Box>
      {selectedFailure ? <Text dimColor wrap="truncate-end">{selectedFailure.message}</Text> : null}
    </Box>
  );
}
