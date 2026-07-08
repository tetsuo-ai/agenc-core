import React, { useEffect, useMemo, useState } from "react";

import { logError } from "../../../utils/log.js";
import { getTaskOutputPath } from "../../../utils/task/diskOutput.js";
import { tailFile } from "../../../utils/fsOperations.js";
import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState, useSetAppState } from "../../state/AppState.js";
import { enterTeammateView } from "../../state/teammateViewHelpers.js";
import { formatTaskElapsed, taskPathLabel } from "../agents/activity.js";
import { orderAgentTasks, resolveAgentSelection } from "../agents/AgentsRail.js";
import { useWorkbenchState } from "../state.js";
import { stopWorkbenchTask, workbenchStopActionForTask } from "../tasks/stopActions.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";

export function AgentSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const tasks = useAppState((state) => state.tasks);
  const setAppState = useSetAppState();
  const task = useMemo(() => {
    const taskList = orderAgentTasks(Object.values(tasks).filter((item: any) => item.type !== "local_bash"));
    return resolveAgentSelection(taskList, workbench.selectedAgentTaskId).selectedTask;
  }, [tasks, workbench.selectedAgentTaskId]);
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
    setTailState((current) => current.taskId === taskId ? current : { taskId, content: "" });
    let mounted = true;
    const readTail = () => {
      tailFile(getTaskOutputPath(taskId), 16_000)
        .then((result) => {
          if (mounted) setTailState({ taskId, content: result.content });
        })
        .catch((error) => {
          if (!mounted) return;
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

  useRegisterKeybindingContext("Surface", focused);
  useKeybindings(
    {
      "surface:open": () => {
        if (canEnterAgentTranscript(task)) enterTeammateView(task.id, setAppState);
      },
      "surface:stop": () => {
        if (task) stopWorkbenchTask(task, setAppState);
      },
    },
    { context: "Surface", isActive: focused },
  );

  if (!task) return <EmptySurface title="AGENT" message="No background agent selected" />;

  const progress = task.progress ?? {};
  const stopAction = workbenchStopActionForTask(task);
  const pathLabel = taskPathLabel(task);
  const recentActivities = progress.recentActivities ?? [];
  const currentActivity = progress.lastActivity?.activityDescription ?? progress.lastActivity?.toolName;
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader title="AGENT" detail={`${task.status} - ${task.description}`} focused={focused} />
      <Text wrap="truncate-end">id {task.id}</Text>
      <Text wrap="truncate-end">type {task.type}</Text>
      <Text wrap="truncate-end">elapsed {formatTaskElapsed(task)}</Text>
      {pathLabel ? <Text wrap="truncate-end">path {pathLabel}</Text> : null}
      {progress.toolUseCount !== undefined ? <Text>tools {progress.toolUseCount}</Text> : null}
      {progress.tokenCount !== undefined ? <Text>tokens {progress.tokenCount}</Text> : null}
      {currentActivity ? <Text wrap="truncate-end">now {currentActivity}</Text> : null}
      {recentActivities.length > 0 ? (
        <Box flexDirection="column">
          {recentActivities.slice(-3).map((activity, index) => (
            <Text key={`${index}:${activity.activityDescription ?? activity.toolName ?? ""}`} dimColor wrap="truncate-end">
              recent {activity.activityDescription ?? activity.toolName ?? "activity"}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text dimColor wrap="truncate-end">
        {canEnterAgentTranscript(task) ? "enter transcript · " : ""}
        {stopAction ? "x stop" : "view only"}
        {" · steer unavailable unless agent routing is real"}
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {(tail || "(no output)").split("\n").slice(-60).map((line, index) => (
          <Text key={`${index}:${line}`} wrap="truncate-end">{line}</Text>
        ))}
      </Box>
    </Box>
  );
}

export function canEnterAgentTranscript(task: { readonly id?: string; readonly type?: string } | null | undefined): task is { readonly id: string; readonly type: "local_agent" | "in_process_teammate" } {
  return typeof task?.id === "string" && (task.type === "local_agent" || task.type === "in_process_teammate");
}
