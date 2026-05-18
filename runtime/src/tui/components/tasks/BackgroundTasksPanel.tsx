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
import { KeyHint, MenuModal } from "../v2/primitives.js";

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
  if (task.status === "running" || task.status === "pending") {
    return "◐";
  }
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

function taskStatusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "done";
    case "killed":
      return "killed";
    default:
      return status;
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

function taskTarget(task: TaskState): string {
  switch (task.type) {
    case "remote_agent":
      return "worker/remote";
    case "in_process_teammate":
      return "worker/teammate";
    case "local_bash":
      return "local shell";
    case "local_agent":
      return "self";
    default:
      return "background";
  }
}

function taskProgressLabel(task: TaskState): string {
  if (task.status === "running" || task.status === "pending") {
    if ("progress" in task && task.progress?.toolUseCount !== undefined) {
      return `${formatNumber(task.progress.toolUseCount)} tools`;
    }
    return task.status === "running" ? "◐ running" : "queued";
  }
  return task.status === "completed" ? "done" : taskStatusLabel(task.status);
}

function taskElapsedLabel(task: TaskState): string {
  if (typeof task.startTime !== "number" || task.startTime <= 0) return "—";
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - task.startTime) / 1000));
  if (elapsedSeconds >= 3600) return `${Math.floor(elapsedSeconds / 3600)}h`;
  if (elapsedSeconds >= 60) return `${Math.floor(elapsedSeconds / 60)}m`;
  return `${elapsedSeconds}s`;
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

export function BackgroundTasksPanel({
  onDone,
  initialDetailTaskId,
  toolUseContext,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const taskTextWidth = Math.max(1, columns - 4);
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

  if (sorted.length === 0) {
    return (
      <ThemedBox
        flexDirection="column"
        width="100%"
        borderStyle="single"
        borderColor="agenc"
        backgroundColor="clawd_background"
        overflow="hidden"
      >
        <ThemedBox flexDirection="row" paddingX={1} borderBottom borderBottomColor="agenc" gap={2}>
          <ThemedText color="agenc">BACKGROUND TASKS</ThemedText>
          <ThemedText color="text2">{summary}</ThemedText>
          <Box flexGrow={1} />
          <KeyHint k="esc" label="dismiss" />
        </ThemedBox>
        <Box paddingX={1} paddingY={1}>
          <ThemedText color="subtle">No background tasks</ThemedText>
        </Box>
      </ThemedBox>
    );
  }

  return (
    <MenuModal
      title="background tasks"
      count={summary}
      summary="unified background panel"
      headerRight="↑↓ select · ⏎ open · x stop"
      columns={[2, 8, 18, 28, 18, 12, 8, 8]}
      headers={["", "kind", "id · status", "label", "target", "progress", "elapsed", "cost"]}
      items={sorted}
      activeIndex={selectedIndex}
      footer={[
        { keyName: "⏎", label: "open" },
        { keyName: "x", label: "stop" },
        { keyName: "l", label: "logs" },
        { keyName: "r", label: "retry" },
      ]}
      hint={truncateToWidth(
        showDetail ? "detail open · ←/b returns to list" : "kinds · remote · teammate · bash · local",
        taskTextWidth,
      )}
      preview={selectedTask ? (
        <Box flexDirection="column">
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
          {taskActionLabel(selectedTask) === "Stop unavailable" ? (
            <ThemedText color="inactive">Remote task stop is not available from this session.</ThemedText>
          ) : null}
        </Box>
      ) : null}
      renderRow={(task, _index, active) => [
        <ThemedText key="icon" color={taskKindColor(task)}>{taskKindIcon(task)}</ThemedText>,
        <ThemedText key="kind" color={taskKindColor(task)}>{taskKindLabel(task)}</ThemedText>,
        <ThemedText key="status" color={taskStatusColor(task.status)} wrap="truncate-end">
          {`${task.id} · ${taskStatusLabel(task.status)}`}
        </ThemedText>,
        <ThemedText key="label" color={active ? "agenc" : "text2"} wrap="truncate-end">
          {taskTitle(task)}
        </ThemedText>,
        <ThemedText key="target" color="subtle" wrap="truncate-end">{taskTarget(task)}</ThemedText>,
        <ThemedText key="progress" color={taskStatusColor(task.status)} wrap="truncate-end">
          {taskProgressLabel(task)}
        </ThemedText>,
        <ThemedText key="elapsed" color="inactive" wrap="truncate-end">{taskElapsedLabel(task)}</ThemedText>,
        <ThemedText key="cost" color="text2">—</ThemedText>,
      ]}
    />
  );
}
