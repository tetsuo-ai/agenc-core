// @ts-nocheck
import React, { useEffect, useMemo, useState } from "react";

import { getTaskOutputPath } from "../../../utils/task/diskOutput.js";
import { tailFile } from "../../../utils/fsOperations.js";
import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState } from "../../state/AppState.js";
import { attachTaskErrorCommand } from "../commands.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { resolveWorkbenchShellTask } from "../tasks/shellTasks.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";
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
  const [tailState, setTailState] = useState<{ readonly taskId: string | null; readonly content: string }>({
    taskId: null,
    content: "",
  });
  const [selected, setSelected] = useState(0);
  const tail = tailState.taskId === task?.id ? tailState.content : "";
  const failures = useMemo(() => parseVitestFailures(tail), [tail]);
  const selectedIndex = clampSurfaceSelection(selected, failures.length);
  const selectedFailure = failures[selectedIndex] ?? null;

  useEffect(() => {
    if (!task?.id) {
      setTailState({ taskId: null, content: "" });
      return;
    }
    const taskId = task.id;
    setSelected(0);
    setTailState({ taskId, content: "" });
    let mounted = true;
    const readTail = () => {
      tailFile(getTaskOutputPath(taskId), TAIL_BYTES)
        .then((result) => {
          if (mounted) setTailState({ taskId, content: result.content });
        })
        .catch(() => {
          if (mounted) setTailState({ taskId, content: "" });
        });
    };
    readTail();
    const timer = task.status === "running" ? setInterval(readTail, 1_000) : null;
    timer?.unref?.();
    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, [task?.id, task?.status]);

  useRegisterKeybindingContext("Surface", focused);
  const jumpToSelectedFailure = (focus = true) => {
    if (selectedFailure?.location) {
      dispatch({
        type: "openBuffer",
        path: selectedFailure.location.file,
        line: selectedFailure.location.line,
        focus,
      });
    }
  };
  useKeybindings(
    {
      "surface:up": () => setSelected((value) => Math.max(0, value - 1)),
      "surface:down": () => setSelected((value) => Math.min(Math.max(0, failures.length - 1), value + 1)),
      "surface:pageUp": () => setSelected((value) => Math.max(0, value - 10)),
      "surface:pageDown": () => setSelected((value) => Math.min(Math.max(0, failures.length - 1), value + 10)),
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

  return <TestSurfaceView failures={failures} selected={selectedIndex} focused={focused} />;
}

export function TestSurfaceView({
  failures,
  selected,
  focused,
}: {
  readonly failures: readonly ReturnType<typeof parseVitestFailures>[number][];
  readonly selected: number;
  readonly focused: boolean;
}): React.ReactElement {
  const selectedIndex = clampSurfaceSelection(selected, failures.length);
  const selectedFailure = failures[selectedIndex] ?? null;
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader title="TEST" detail={`${failures.length} failure${failures.length === 1 ? "" : "s"} - enter edit - o keep focus - @ attach`} focused={focused} />
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
