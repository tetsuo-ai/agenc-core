// @ts-nocheck
import React from "react";

import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState, useSetAppState } from "../../state/AppState.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { stopWorkbenchTask, workbenchStopActionForTask } from "../tasks/stopActions.js";
import { formatTaskElapsed } from "./activity.js";

export function AgentsRail({
  focused,
  width,
}: {
  readonly focused: boolean;
  readonly width: number;
}): React.ReactElement {
  const tasks = useAppState((state) => state.tasks);
  const remoteCount = useAppState((state) => state.remoteBackgroundTaskCount);
  const setAppState = useSetAppState();
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const taskList = orderAgentTasks(Object.values(tasks ?? {}).filter((task: any) => task.type !== "local_bash"));
  const { activeTasks, backgroundTasks } = partitionAgentTasks(taskList);
  const { selectedId, selectedIndex, selectedTask } = resolveAgentSelection(taskList, workbench.selectedAgentTaskId);
  const selectByDelta = (delta: number) => {
    if (taskList.length === 0) return;
    const base = selectedIndex < 0 ? 0 : selectedIndex;
    const next = Math.max(0, Math.min(taskList.length - 1, base + delta));
    dispatch({ type: "selectAgent", taskId: taskList[next]?.id ?? null });
  };

  useRegisterKeybindingContext("Agents", focused);
  useKeybindings(
    {
      "workbench:focusSurface": () => dispatch({ type: "focus", pane: "surface" }),
      "agents:up": () => selectByDelta(-1),
      "agents:down": () => selectByDelta(1),
      "agents:open": () => {
        if (selectedTask?.id) dispatch({ type: "openAgent", taskId: selectedTask.id, focus: true });
      },
      "agents:stop": () => {
        if (selectedTask) stopWorkbenchTask(selectedTask, setAppState);
      },
    },
    { context: "Agents", isActive: focused },
  );

  return (
    <Box flexDirection="column" width={width} height="100%" borderLeft borderColor={focused ? "suggestion" : "gray"} paddingX={1}>
      <Box height={1}>
        <Text color={focused ? "suggestion" : "gray"} wrap="truncate-end">Agents</Text>
      </Box>
      {taskList.length === 0 && remoteCount > 0 ? (
        <Text wrap="truncate-end">remote tasks: {remoteCount}</Text>
      ) : null}
      {taskList.length === 0 && remoteCount === 0 ? <Text dimColor>No background agents</Text> : null}
      <AgentRailSection label="active" tasks={activeTasks} selectedId={selectedId} />
      <AgentRailSection label="background" tasks={backgroundTasks} selectedId={selectedId} />
    </Box>
  );
}

export function partitionAgentTasks(tasks: readonly any[]): {
  readonly activeTasks: readonly any[];
  readonly backgroundTasks: readonly any[];
} {
  return {
    activeTasks: tasks.filter((task: any) => task.status === "running" || task.status === "pending"),
    backgroundTasks: tasks.filter((task: any) => task.status !== "running" && task.status !== "pending"),
  };
}

export function orderAgentTasks(tasks: readonly any[]): readonly any[] {
  return [...tasks].sort(compareAgentTasks);
}

export function resolveAgentSelection(tasks: readonly any[], selectedId: string | null | undefined): {
  readonly selectedId: string | null;
  readonly selectedIndex: number;
  readonly selectedTask: any | null;
} {
  const orderedTasks = orderAgentTasks(tasks);
  if (orderedTasks.length === 0) {
    return { selectedId: null, selectedIndex: -1, selectedTask: null };
  }
  const selectedIndex = orderedTasks.findIndex((task: any) => task.id === selectedId);
  const resolvedIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const selectedTask = orderedTasks[resolvedIndex] ?? null;
  return {
    selectedId: selectedTask?.id ?? null,
    selectedIndex: selectedTask ? resolvedIndex : -1,
    selectedTask,
  };
}

function compareAgentTasks(left: any, right: any): number {
  const leftActive = isActiveTaskStatus(left?.status);
  const rightActive = isActiveTaskStatus(right?.status);
  if (leftActive !== rightActive) return leftActive ? -1 : 1;
  return (right?.startTime ?? 0) - (left?.startTime ?? 0);
}

function isActiveTaskStatus(status: unknown): boolean {
  return status === "running" || status === "pending";
}

function AgentRailSection({
  label,
  tasks,
  selectedId,
}: {
  readonly label: string;
  readonly tasks: readonly any[];
  readonly selectedId: string | null;
}): React.ReactElement | null {
  if (tasks.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor wrap="truncate-end">{label}</Text>
      {tasks.map((task: any) => (
        <AgentRailRow
          key={task.id}
          task={task}
          selected={selectedId === task.id}
        />
      ))}
    </Box>
  );
}

function AgentRailRow({
  task,
  selected,
}: {
  readonly task: any;
  readonly selected: boolean;
}): React.ReactElement {
  const progress = task.progress ?? {};
  const activity = progress.lastActivity?.activityDescription ?? progress.lastActivity?.toolName ?? task.status;
  const stopAction = workbenchStopActionForTask(task);
  const diffCount = progress.diffCount ?? task.diffCount;
  const approvalPending = task.approvalPending === true || task.pendingApproval === true;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={selected ? "suggestion" : undefined} wrap="truncate-end">{statusMarker(task.status)} {task.description ?? task.id}</Text>
      <Text dimColor wrap="truncate-end">{activity}</Text>
      <Text dimColor wrap="truncate-end">
        {formatTaskElapsed(task)} · tools {progress.toolUseCount ?? 0} tokens {progress.tokenCount ?? 0}
        {typeof diffCount === "number" && diffCount > 0 ? ` · diffs ${diffCount}` : ""}
        {approvalPending ? " · approval" : ""}
        {stopAction && stopAction !== "remote-unavailable" ? " · x stop" : ""}
      </Text>
    </Box>
  );
}

function statusMarker(status: string): string {
  switch (status) {
    case "running":
      return "*";
    case "failed":
      return "!";
    case "completed":
      return "ok";
    case "killed":
      return "x";
    default:
      return "-";
  }
}
