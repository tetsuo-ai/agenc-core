import React, { useEffect, useMemo, useState } from "react";

import { logError } from "../../../utils/log.js";
import { getTaskOutputPath } from "../../../utils/task/diskOutput.js";
import { tailFile } from "../../../utils/fsOperations.js";
import { Box, Text } from "../../ink.js";
import { useAppState } from "../../state/AppState.js";
import { useSetAppState } from "../../state/AppState.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { attachTaskErrorCommand, openBufferCommand } from "../commands.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { resolveWorkbenchShellTask } from "../tasks/shellTasks.js";
import { stopWorkbenchTask, workbenchStopActionForTask } from "../tasks/stopActions.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";
import { parseSourceLocations } from "./outputParsers.js";

const TAIL_BYTES = 24_000;

/**
 * The tail state to apply when the shell effect (re-)runs for `taskId`. Preserve
 * the current content when the task is unchanged — the effect also re-runs on a
 * `status` change (e.g. running -> completed), and blanking there flashed the
 * output empty for one cycle. Only blank when switching to a different task.
 * Mirrors AgentSurface's guard.
 */
export function nextShellTailState(
  current: { readonly taskId: string | null; readonly content: string },
  taskId: string,
): { readonly taskId: string | null; readonly content: string } {
  return current.taskId === taskId ? current : { taskId, content: "" };
}

export function ShellSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const tasks = useAppState((state) => state.tasks);
  const dispatch = useWorkbenchDispatch();
  const setAppState = useSetAppState();
  const task = useMemo(() => {
    return resolveWorkbenchShellTask(tasks, workbench.selectedShellTaskId);
  }, [tasks, workbench.selectedShellTaskId]);
  const [tailState, setTailState] = useState<{ readonly taskId: string | null; readonly content: string }>({
    taskId: null,
    content: "",
  });
  const tail = tailState.taskId === task?.id ? tailState.content : "";

  useEffect(() => {
    if (!task?.id) {
      setTailState({ taskId: null, content: "" });
      return;
    }
    const taskId = task.id;
    setTailState((current) => nextShellTailState(current, taskId));
    let mounted = true;
    const readTail = () => {
      tailFile(getTaskOutputPath(taskId), TAIL_BYTES)
        .then((result) => {
          if (mounted) setTailState({ taskId, content: result.content });
        })
        .catch((error) => {
          logError(error);
          // Keep the last successful tail visible across transient read failures.
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

  const locations = useMemo(() => parseSourceLocations(tail), [tail]);

  useRegisterKeybindingContext("Surface", focused);
  const jumpToFirstLocation = () => {
    const location = locations[0];
    if (location) {
      dispatch(openBufferCommand(location.file, location.line, true));
    }
  };
  useKeybindings(
    {
      "surface:open": jumpToFirstLocation,
      "surface:top": jumpToFirstLocation,
      "surface:attach": () => {
        const location = locations[0];
        if (task?.id && location) {
          dispatch(attachTaskErrorCommand({
            taskId: task.id,
            file: location.file,
            line: location.line,
          }));
        }
      },
      "surface:stop": () => {
        if (task) stopWorkbenchTask(task, setAppState);
      },
      "workbench:closeSurface": () => dispatch({ type: "closeSurface" }),
    },
    { context: "Surface", isActive: focused },
  );

  if (!task) return <EmptySurface title="SHELL" message="No shell task selected" />;

  const stopAction = workbenchStopActionForTask(task);
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader title="SHELL" detail={`${task.status} - ${task.description ?? task.id}`} focused={focused} />
      <Text dimColor wrap="truncate-end">
        follow tail on running tasks{stopAction === "local-shell" ? " - x stop" : ""}
      </Text>
      {locations[0] ? (
        <Text dimColor wrap="truncate-end">g/enter edit  @ attach: {locations[0].file}:{locations[0].line}</Text>
      ) : null}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {(tail || "(no output)").split("\n").slice(-80).map((line, index) => (
          <Text key={`${index}:${line}`} wrap="truncate-end">{line}</Text>
        ))}
      </Box>
    </Box>
  );
}
