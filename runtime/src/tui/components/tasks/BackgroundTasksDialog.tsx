// @ts-nocheck
import * as React from "react";

import { isBackgroundTask, type TaskState } from "../../../tasks/types.js";
import { formatNumber } from "../../../utils/format.js";
import { Box, Text, useInput } from "../../ink.js";
import { useAppState } from "../../state/AppState.js";

type Props = {
  onDone?: () => void;
  initialDetailTaskId?: string;
  toolUseContext?: unknown;
};

function taskTitle(task: TaskState): string {
  if ("title" in task && typeof task.title === "string" && task.title.trim()) {
    return task.title;
  }
  if ("command" in task && typeof task.command === "string" && task.command.trim()) {
    return task.command;
  }
  if ("prompt" in task && typeof task.prompt === "string" && task.prompt.trim()) {
    return task.prompt;
  }
  return task.description || task.id;
}

function taskStatusColor(status: string): string | undefined {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "killed":
      return "error";
    case "running":
    case "pending":
      return "cyan_FOR_SUBAGENTS_ONLY";
    default:
      return undefined;
  }
}

function taskDetail(task: TaskState): string | null {
  const progress = task.progress;
  const parts: string[] = [];
  if (progress?.toolUseCount !== undefined) {
    parts.push(`${formatNumber(progress.toolUseCount)} tools`);
  }
  if (progress?.tokenCount !== undefined) {
    parts.push(`${formatNumber(progress.tokenCount)} tokens`);
  }
  if (progress?.lastActivity?.activityDescription) {
    parts.push(progress.lastActivity.activityDescription);
  }
  if ("error" in task && typeof task.error === "string" && task.error.trim()) {
    parts.push(task.error);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function BackgroundTasksDialog({
  onDone,
  initialDetailTaskId,
}: Props): React.ReactNode {
  const tasks = useAppState((state) =>
    Object.values(state.tasks ?? {}).filter(isBackgroundTask),
  );
  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone?.();
    }
  });

  const sorted = [...tasks].sort((left, right) => {
    const leftRunning = left.status === "running" || left.status === "pending";
    const rightRunning = right.status === "running" || right.status === "pending";
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
    return (right.startTime ?? 0) - (left.startTime ?? 0);
  });

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Text bold={true}>Background tasks</Text>
      {sorted.length === 0 ? (
        <Text dimColor={true}>No background tasks</Text>
      ) : (
        sorted.map((task) => {
          const selected = initialDetailTaskId === task.id;
          const detail = taskDetail(task);
          const color = taskStatusColor(task.status);
          return (
            <Box key={task.id} flexDirection="column" marginTop={1}>
              <Text color={color} bold={selected}>
                {selected ? "› " : "  "}
                {task.status} · {task.type} · {taskTitle(task)}
              </Text>
              <Text dimColor={true}>  id: {task.id}</Text>
              {detail ? <Text dimColor={true}>  {detail}</Text> : null}
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor={true}>Esc/q closes</Text>
      </Box>
    </Box>
  );
}

