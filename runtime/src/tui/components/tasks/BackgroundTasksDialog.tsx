import * as React from "react";

import { killAsyncAgent } from "../../../tasks/LocalAgentTask/LocalAgentTask.js";
import { killTask } from "../../../tasks/LocalShellTask/killShellTasks.js";
import { requestTeammateShutdown } from "../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js";
import {
  isBackgroundTask,
  isStoppableTaskStatus,
  isTaskType,
  type TaskState,
} from "../../../tasks/types.js";
import { formatNumber, truncateToWidth } from "../../../utils/format.js";
import { Box, useInput } from "../../ink.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { useAppState, useSetAppState, type AppState } from "../../state/AppState.js";
import ThemedBox from "../design-system/ThemedBox.js";
import ThemedText from "../design-system/ThemedText.js";
import { KeyHint } from "../v2/primitives.js";

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

function taskStatusColor(status: string): "success" | "error" | "agenc" | "inactive" | "subtle" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "killed":
      return "error";
    case "running":
    case "pending":
      return "agenc";
    default:
      return "subtle";
  }
}

function taskKindIcon(task: TaskState): string {
  switch (task.type) {
    case "remote_agent":
      return "◆";
    case "in_process_teammate":
      return "∙";
    case "local_bash":
      return "$";
    case "local_agent":
      return "◇";
    default:
      return "·";
  }
}

function taskKindLabel(task: TaskState): string {
  switch (task.type) {
    case "remote_agent":
      return "remote";
    case "in_process_teammate":
      return "teammate";
    case "local_bash":
      return "bash";
    case "local_agent":
      return "local";
    default:
      return "task";
  }
}

function taskKindColor(task: TaskState): "worker" | "agenc" | "text2" | "subtle" {
  switch (task.type) {
    case "remote_agent":
      return "worker";
    case "in_process_teammate":
      return "agenc";
    case "local_bash":
      return "text2";
    default:
      return "subtle";
  }
}

function taskDetail(task: TaskState): string | null {
  const progress = "progress" in task ? task.progress : undefined;
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

function taskActionLabel(task: TaskState): string {
  if (!isStoppableTaskStatus(task.status)) {
    return "View output";
  }
  switch (task.type) {
    case "local_bash":
    case "local_agent":
    case "in_process_teammate":
      return "Stop";
    case "remote_agent":
      return "Stop unavailable";
    default:
      return "View output";
  }
}

function isBackgroundDialogTask(task: unknown): task is TaskState {
  if (isBackgroundTask(task)) {
    return true;
  }
  if (typeof task !== "object" || task === null) {
    return false;
  }
  const candidate = task as {
    readonly type?: unknown;
    readonly status?: unknown;
    readonly isBackgrounded?: unknown;
  };
  if (typeof candidate.type !== "string" || !isTaskType(candidate.type)) {
    return false;
  }
  if (candidate.isBackgrounded === false) {
    return false;
  }
  return (
    candidate.status === "completed" ||
    candidate.status === "failed" ||
    candidate.status === "killed"
  );
}

function stopTask(task: TaskState, setAppState: ReturnType<typeof useSetAppState>): void {
  if (!isStoppableTaskStatus(task.status)) {
    return;
  }
  switch (task.type) {
    case "local_bash":
      killTask(task.id, setAppState);
      break;
    case "local_agent":
      killAsyncAgent(task.id, setAppState);
      break;
    case "in_process_teammate":
      requestTeammateShutdown(task.id, setAppState);
      break;
    case "remote_agent":
      break;
  }
}

function setAppStateFromContext(toolUseContext: unknown): ReturnType<typeof useSetAppState> | null {
  if (
    typeof toolUseContext === "object" &&
    toolUseContext !== null &&
    "setAppState" in toolUseContext &&
    typeof toolUseContext.setAppState === "function"
  ) {
    return toolUseContext.setAppState as ReturnType<typeof useSetAppState>;
  }
  return null;
}

export function BackgroundTasksDialog({
  onDone,
  initialDetailTaskId,
  toolUseContext,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const taskTextWidth = Math.max(1, columns - 4);
  const indentedTaskTextWidth = Math.max(1, taskTextWidth - 2);
  const tasks = useAppState((state: AppState) =>
    Object.values(state.tasks ?? {}).filter(isBackgroundDialogTask),
  );
  const appStateSetter = useSetAppState();
  const setAppState = setAppStateFromContext(toolUseContext) ?? appStateSetter;
  const sorted = React.useMemo(() => {
    return [...tasks].sort((left, right) => {
      const leftRunning = left.status === "running" || left.status === "pending";
      const rightRunning = right.status === "running" || right.status === "pending";
      if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
      return (right.startTime ?? 0) - (left.startTime ?? 0);
    });
  }, [tasks]);
  const taskIdsSignature = sorted.map((task) => task.id).join("\0");
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(
    () => initialDetailTaskId ?? sorted[0]?.id ?? null,
  );
  const [showDetail, setShowDetail] = React.useState(
    () => Boolean(initialDetailTaskId),
  );
  React.useEffect(() => {
    if (initialDetailTaskId && sorted.some((task) => task.id === initialDetailTaskId)) {
      setSelectedTaskId(initialDetailTaskId);
      setShowDetail(true);
      return;
    }
    setSelectedTaskId((current) =>
      current && sorted.some((task) => task.id === current)
        ? current
        : sorted[0]?.id ?? null,
    );
  }, [initialDetailTaskId, taskIdsSignature]);

  const selectedIndex = Math.max(
    0,
    sorted.findIndex((task) => task.id === selectedTaskId),
  );
  const selectedTask = sorted[selectedIndex] ?? null;
  const selectedTaskDetail = selectedTask ? taskDetail(selectedTask) : null;
  const selectRelative = React.useCallback(
    (delta: number) => {
      if (sorted.length === 0) {
        return;
      }
      const nextIndex = (selectedIndex + delta + sorted.length) % sorted.length;
      setSelectedTaskId(sorted[nextIndex]!.id);
    },
    [selectedIndex, sorted],
  );
  const stopSelectedTask = React.useCallback(() => {
    if (selectedTask) {
      stopTask(selectedTask, setAppState);
    }
  }, [selectedTask, setAppState]);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone?.();
      return;
    }
    if (sorted.length === 0) {
      return;
    }
    if (key.upArrow || input === "k") {
      selectRelative(-1);
      return;
    }
    if (key.downArrow || input === "j") {
      selectRelative(1);
      return;
    }
    if (key.return || key.rightArrow || input === "l") {
      setShowDetail(true);
      return;
    }
    if (showDetail && (key.leftArrow || input === "b" || input === "h")) {
      setShowDetail(false);
      return;
    }
    if (input === "x") {
      stopSelectedTask();
    }
  });

  const runningCount = sorted.filter(
    task => task.status === "running" || task.status === "pending",
  ).length;
  const finishedCount = sorted.length - runningCount;
  const summary = `${runningCount} running · ${finishedCount} finished`;

  return (
    <ThemedBox
      flexDirection="column"
      width="100%"
      marginTop={1}
      borderStyle="single"
      borderColor="agenc"
      backgroundColor="clawd_background"
      overflow="hidden"
    >
      <ThemedBox flexDirection="row" paddingX={1} borderBottom borderBottomColor="agenc" gap={2}>
        <ThemedText color="agenc">BACKGROUND TASKS</ThemedText>
        <ThemedText color="text2">{summary}</ThemedText>
        <Box flexGrow={1} />
        <ThemedText color="inactive" wrap="truncate-end">↑↓ select · ⏎ open · x stop</ThemedText>
      </ThemedBox>
      {sorted.length === 0 ? (
        <Box paddingX={1} paddingY={1}>
          <ThemedText color="subtle">No background tasks</ThemedText>
        </Box>
      ) : showDetail && selectedTask ? (
        <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          <ThemedText color={taskStatusColor(selectedTask.status)} bold={true}>
            Task details
          </ThemedText>
          <ThemedText color="text2" wrap="truncate-end">
            {truncateToWidth(`${selectedTask.status} · ${selectedTask.type} · ${taskTitle(selectedTask)}`, taskTextWidth)}
          </ThemedText>
          <ThemedText color="inactive">{truncateToWidth(`id: ${selectedTask.id}`, taskTextWidth)}</ThemedText>
          {selectedTaskDetail ? (
            <ThemedText color="subtle" wrap="truncate-end">{truncateToWidth(selectedTaskDetail, taskTextWidth)}</ThemedText>
          ) : null}
          {"command" in selectedTask && selectedTask.command ? (
            <ThemedText color="subtle" wrap="truncate-end">{truncateToWidth(`command: ${selectedTask.command}`, taskTextWidth)}</ThemedText>
          ) : null}
          {"prompt" in selectedTask && selectedTask.prompt ? (
            <ThemedText color="subtle" wrap="truncate-end">{truncateToWidth(`prompt: ${selectedTask.prompt}`, taskTextWidth)}</ThemedText>
          ) : null}
          <ThemedText color="subtle" wrap="truncate-end">{truncateToWidth(`view output: ${selectedTask.outputFile}`, taskTextWidth)}</ThemedText>
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <KeyHint k="←/b" label="back" />
            <KeyHint k="↑↓" label="select" />
            {taskActionLabel(selectedTask) === "Stop" ? <KeyHint k="x" label="stop" /> : null}
            <KeyHint k="esc" label="close" />
          </Box>
          {taskActionLabel(selectedTask) === "Stop unavailable" ? (
            <ThemedText color="inactive">Remote task stop is not available from this session.</ThemedText>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="column">
          {sorted.map((task) => {
            const selected = selectedTaskId === task.id;
            const detail = taskDetail(task);
            const color = taskStatusColor(task.status);
            return (
              <ThemedBox
                key={task.id}
                flexDirection="column"
                backgroundColor={selected ? "agencWash" : undefined}
                paddingX={1}
                paddingY={1}
                borderLeft={selected}
                borderLeftColor={selected ? "agenc" : undefined}
              >
                <Box flexDirection="row" gap={1}>
                  <ThemedText color={taskKindColor(task)}>{taskKindIcon(task)}</ThemedText>
                  <ThemedText color={taskKindColor(task)}>{taskKindLabel(task)}</ThemedText>
                  <ThemedText color={selected ? "agenc" : color} bold={selected} wrap="truncate-end">
                    {truncateToWidth(`${task.status} · ${task.type} · ${taskTitle(task)}`, taskTextWidth)}
                  </ThemedText>
                </Box>
                <Box flexDirection="row" paddingLeft={2} gap={1}>
                  <ThemedText color="muted3">⎿</ThemedText>
                  <ThemedText color="inactive" wrap="truncate-end">{truncateToWidth(`id: ${task.id}`, indentedTaskTextWidth)}</ThemedText>
                </Box>
                {detail ? (
                  <Box flexDirection="row" paddingLeft={2} gap={1}>
                    <ThemedText color="muted3">⎿</ThemedText>
                    <ThemedText color="subtle" wrap="truncate-end">{truncateToWidth(detail, indentedTaskTextWidth)}</ThemedText>
                  </Box>
                ) : null}
              </ThemedBox>
            );
          })}
        </Box>
      )}
      <ThemedBox flexDirection="row" borderTop borderTopColor="lineSoft" paddingX={1} gap={2}>
        <KeyHint k="⏎" label="open" />
        <KeyHint k="x" label="stop" />
        <KeyHint k="esc" label="dismiss" />
        <Box flexGrow={1} />
        <ThemedText color="inactive" wrap="truncate-end">
          {truncateToWidth(sorted.length === 0 ? "Esc/q closes" : "↑/↓ select · Enter opens details · x stops · Esc/q closes", taskTextWidth)}
        </ThemedText>
      </ThemedBox>
    </ThemedBox>
  );
}
