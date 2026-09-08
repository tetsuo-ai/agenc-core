import React, { useMemo } from "react";

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
import { useTaskTail } from "./useTaskTail.js";
import { parseSourceLocations } from "./outputParsers.js";

const TAIL_BYTES = 24_000;

export function ShellSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const tasks = useAppState((state) => state.tasks);
  const dispatch = useWorkbenchDispatch();
  const setAppState = useSetAppState();
  const task = useMemo(() => {
    return resolveWorkbenchShellTask(tasks, workbench.selectedShellTaskId);
  }, [tasks, workbench.selectedShellTaskId]);
  const { content: tail, error } = useTaskTail({
    taskId: task?.id,
    status: task?.status,
    maxBytes: TAIL_BYTES,
    pollIntervalMs: 1_000,
  });

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
      {error !== null ? <Text color="error" wrap="truncate-end">Output read failed: {error}</Text> : null}
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
