// @ts-nocheck
import React, { useEffect, useMemo, useState } from "react";

import { getTaskOutputPath } from "../../../utils/task/diskOutput.js";
import { tailFile } from "../../../utils/fsOperations.js";
import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState, useSetAppState } from "../../state/AppState.js";
import { enterTeammateView } from "../../state/teammateViewHelpers.js";
import { formatTaskElapsed, taskPathLabel } from "../agents/activity.js";
import { useWorkbenchState } from "../state.js";
import { stopWorkbenchTask, workbenchStopActionForTask } from "../tasks/stopActions.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";

export function AgentSurface({ focused }: { readonly focused: boolean }): React.ReactElement {
  const workbench = useWorkbenchState();
  const tasks = useAppState((state) => state.tasks);
  const setAppState = useSetAppState();
  const task = useMemo(() => {
    if (workbench.selectedAgentTaskId && tasks[workbench.selectedAgentTaskId]) return tasks[workbench.selectedAgentTaskId];
    return Object.values(tasks).find((item: any) => item.type !== "local_bash") ?? null;
  }, [tasks, workbench.selectedAgentTaskId]);
  const [tail, setTail] = useState("");

  useEffect(() => {
    if (!task?.id) {
      setTail("");
      return;
    }
    let mounted = true;
    const readTail = () => {
      tailFile(getTaskOutputPath(task.id), 16_000)
        .then((result) => {
          if (mounted) setTail(result.content);
        })
        .catch(() => {
          if (mounted) setTail("");
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
        if (task?.type === "local_agent") enterTeammateView(task.id, setAppState);
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
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader title="AGENT" detail={`${task.status} - ${task.description}`} focused={focused} />
      <Text wrap="truncate-end">id {task.id}</Text>
      <Text wrap="truncate-end">type {task.type}</Text>
      <Text wrap="truncate-end">elapsed {formatTaskElapsed(task)}</Text>
      {pathLabel ? <Text wrap="truncate-end">path {pathLabel}</Text> : null}
      {progress.toolUseCount !== undefined ? <Text>tools {progress.toolUseCount}</Text> : null}
      {progress.tokenCount !== undefined ? <Text>tokens {progress.tokenCount}</Text> : null}
      {progress.lastActivity?.activityDescription ? <Text wrap="truncate-end">now {progress.lastActivity.activityDescription}</Text> : null}
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
        {task.type === "local_agent" ? "enter transcript · " : ""}
        {stopAction === "remote-unavailable" ? "stop unavailable from this session" : stopAction ? "x stop" : "view only"}
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
