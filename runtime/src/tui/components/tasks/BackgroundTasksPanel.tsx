import * as React from "react";

import {
  isBackgroundTask,
  isTaskType,
  type InProcessTeammateTaskState,
  type LocalAgentTaskState,
  type TaskState,
} from "../../../tasks/types.js";
import { tailFile } from "../../../utils/fsOperations.js";
import { formatFileSize, formatNumber, truncateToWidth } from "../../../utils/format.js";
import { getTaskOutputPath } from "../../../utils/task/diskOutput.js";
import type { Theme } from "../../../utils/theme.js";
import { agentRolePresentation } from "../../../agents/role-presentation.js";
import { Box, useInput } from "../../ink.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { useAppState, useSetAppState, type AppState } from "../../state/AppState.js";
import { stopTuiTask, tuiStopActionForTask } from "../../task-stop-actions.js";
import ThemedBox from "../design-system/ThemedBox.js";
import ThemedText from "../design-system/ThemedText.js";
import { KeyHint, MenuModal } from "../v2/primitives.js";

type Props = {
  onDone?: () => void;
  initialDetailTaskId?: string;
  toolUseContext?: unknown;
};

type ThemeColor = keyof Theme;

type TaskDetailRow = {
  readonly section: string;
  readonly label: string;
  readonly value: string;
  readonly color: ThemeColor;
};

type ShellOutputTail = {
  readonly content: string;
  readonly bytesTotal: number;
};

const SHELL_DETAIL_TAIL_BYTES = 8192;

function agentRoleFromDefinition(selectedAgent: unknown): string | undefined {
  if (typeof selectedAgent !== "object" || selectedAgent === null) {
    return undefined;
  }
  const candidate = selectedAgent as { readonly agentType?: unknown };
  return typeof candidate.agentType === "string" ? candidate.agentType : undefined;
}

function formatBackgroundAgentRole(roleName: string | undefined): string {
  return agentRolePresentation(roleName)?.label ?? "Agent";
}

function formatLocalAgentIdentity(
  task: LocalAgentTaskState,
  nameByAgentId: ReadonlyMap<string, string>,
): string {
  const displayName =
    nameByAgentId.get(task.id) ??
    nameByAgentId.get(task.agentId) ??
    task.agentId;
  return `${displayName} · ${formatBackgroundAgentRole(task.agentType)}`;
}

function formatTeammateIdentity(task: InProcessTeammateTaskState): string {
  return `${task.identity.agentName} · ${formatBackgroundAgentRole(agentRoleFromDefinition(task.selectedAgent))}`;
}

function formatBackgroundAgentIdentity(
  task: TaskState,
  nameByAgentId: ReadonlyMap<string, string>,
): string | null {
  if (task.type === "local_agent") {
    return formatLocalAgentIdentity(task, nameByAgentId);
  }
  if (task.type === "in_process_teammate") {
    return formatTeammateIdentity(task);
  }
  return null;
}

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
  const description = task.description.trim();
  return description || task.id;
}

function taskStatusColor(status: TaskState["status"]): "success" | "error" | "agenc" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "killed":
      return "error";
    case "running":
    case "pending":
      return "agenc";
  }
}

function taskKindIcon(task: TaskState): string {
  if (task.status === "running" || task.status === "pending") {
    return "◐";
  }
  switch (task.type) {
    case "in_process_teammate":
      return "∙";
    case "local_bash":
      return "$";
    case "local_agent":
      return "◇";
  }
}

function taskKindLabel(task: TaskState): string {
  switch (task.type) {
    case "in_process_teammate":
      return "teammate";
    case "local_bash":
      return "bash";
    case "local_agent":
      return "local";
  }
}

function taskKindColor(task: TaskState): "worker" | "agenc" | "text2" | "subtle" {
  switch (task.type) {
    case "in_process_teammate":
      return "agenc";
    case "local_bash":
      return "text2";
    case "local_agent":
      return "subtle";
  }
}

function taskStatusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "done";
    case "killed":
      return "cancelled";
    default:
      return status;
  }
}

function taskDetailStatusLabel(task: TaskState): string {
  if (task.status === "running" || task.status === "pending") {
    return `◐ ${task.status}`;
  }
  return task.status === "completed" ? "completed" : taskStatusLabel(task.status);
}

function taskTarget(task: TaskState): string {
  switch (task.type) {
    case "in_process_teammate":
      return "worker/teammate";
    case "local_bash":
      return "local shell";
    case "local_agent":
      return "self";
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

function stringifyUnknown(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatProgressActivity(activity: {
  readonly activityDescription?: string;
  readonly toolName?: string;
  readonly input?: unknown;
}): string {
  return activity.activityDescription ?? [activity.toolName, stringifyUnknown(activity.input)].filter(Boolean).join(" ");
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
  if (progress?.lastActivity) {
    const activity = formatProgressActivity(progress.lastActivity);
    if (activity) {
      parts.push(activity);
    }
  }
  if ("error" in task && typeof task.error === "string" && task.error.trim()) {
    parts.push(task.error);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function addDetailRows(
  rows: TaskDetailRow[],
  section: string,
  label: string,
  value: unknown,
  color: ThemeColor = "text2",
): void {
  const text = stringifyUnknown(value).trim();
  if (!text) {
    return;
  }
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trimEnd();
    if (trimmed) {
      rows.push({ section, label, value: trimmed, color });
    }
  }
}

function addProgressRows(rows: TaskDetailRow[], task: TaskState): void {
  if (!("progress" in task) || !task.progress) {
    return;
  }
  const { toolUseCount, tokenCount, lastActivity, recentActivities } = task.progress;
  if (toolUseCount !== undefined || tokenCount !== undefined) {
    const parts = [
      toolUseCount !== undefined ? `${formatNumber(toolUseCount)} tools` : null,
      tokenCount !== undefined ? `${formatNumber(tokenCount)} tokens` : null,
    ].filter(Boolean);
    addDetailRows(rows, "progress", "usage", parts.join(" · "), "text2");
  }
  if (lastActivity) {
    addDetailRows(rows, "progress", "latest", formatProgressActivity(lastActivity), "subtle");
  }
  if (recentActivities && recentActivities.length > 0) {
    recentActivities.forEach((activity, index) => {
      const description = formatProgressActivity(activity);
      addDetailRows(rows, "progress", `activity ${index + 1}`, description, "subtle");
    });
  }
}

function addMessageRows(
  rows: TaskDetailRow[],
  section: string,
  label: string,
  messages: readonly unknown[] | undefined,
): void {
  if (!messages || messages.length === 0) {
    return;
  }
  messages.forEach((message, index) => {
    addDetailRows(rows, section, `${label} ${index + 1}`, stringifyUnknown(message), "subtle");
  });
}

function buildTaskDetailRows(
  task: TaskState,
  shellOutputTail: ShellOutputTail | undefined,
  nameByAgentId: ReadonlyMap<string, string> = new Map(),
): readonly TaskDetailRow[] {
  const rows: TaskDetailRow[] = [];
  addDetailRows(rows, "task", "status", taskDetailStatusLabel(task), taskStatusColor(task.status));
  addDetailRows(rows, "task", "type", `${taskKindLabel(task)} · ${task.type}`, taskKindColor(task));
  addDetailRows(rows, "task", "title", taskTitle(task), "text2");
  addDetailRows(rows, "task", "id", task.id, "inactive");
  addDetailRows(rows, "task", "target", taskTarget(task), "subtle");
  addDetailRows(rows, "task", "elapsed", taskElapsedLabel(task), "inactive");
  addDetailRows(rows, "output", "uri", task.outputFile, "subtle");

  addProgressRows(rows, task);

  switch (task.type) {
    case "local_bash":
      addDetailRows(rows, "shell", "command", task.command, "text2");
      addDetailRows(rows, "shell", "kind", task.kind, "inactive");
      if (task.result) {
        addDetailRows(rows, "shell", "exit", `code ${task.result.code}`, task.result.code === 0 ? "success" : "error");
        addDetailRows(rows, "shell", "interrupted", task.result.interrupted ? "yes" : "no", task.result.interrupted ? "error" : "inactive");
      }
      if (shellOutputTail) {
        addDetailRows(rows, "output", "size", formatFileSize(shellOutputTail.bytesTotal), "inactive");
        addDetailRows(rows, "output", "tail", shellOutputTail.content || "(no output)", "text2");
      } else {
        addDetailRows(rows, "output", "tail", "loading output tail", "inactive");
      }
      break;
    case "local_agent":
      addDetailRows(rows, "agent", "agent", formatLocalAgentIdentity(task, nameByAgentId), "worker");
      addDetailRows(rows, "agent", "model", task.model, "inactive");
      addDetailRows(rows, "agent", "prompt", task.prompt, "text2");
      addMessageRows(rows, "agent", "pending", task.pendingMessages);
      addMessageRows(rows, "agent", "message", task.messages);
      addDetailRows(rows, "agent", "error", task.error, "error");
      addDetailRows(rows, "agent", "result", task.result, "subtle");
      break;
    case "in_process_teammate":
      addDetailRows(rows, "teammate", "identity", formatTeammateIdentity(task), "worker");
      addDetailRows(rows, "teammate", "id", task.identity.agentId, "inactive");
      addDetailRows(rows, "teammate", "team", task.identity.teamName, "inactive");
      addDetailRows(rows, "teammate", "mode", task.permissionMode, "subtle");
      addDetailRows(rows, "teammate", "state", [
        task.isIdle ? "idle" : "working",
        task.awaitingPlanApproval ? "awaiting plan approval" : "",
        task.shutdownRequested ? "shutdown requested" : "",
      ].filter(Boolean).join(" · "), "text2");
      addDetailRows(rows, "teammate", "model", task.model, "inactive");
      addDetailRows(rows, "teammate", "prompt", task.prompt, "text2");
      addMessageRows(rows, "teammate", "pending", task.pendingUserMessages);
      addMessageRows(rows, "teammate", "message", task.messages);
      addDetailRows(rows, "teammate", "error", task.error, "error");
      addDetailRows(rows, "teammate", "result", task.result, "subtle");
      break;
  }

  return rows;
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
  const agentNameRegistry = useAppState((state: AppState) => state.agentNameRegistry);
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
    () => Boolean(initialDetailTaskId && sorted.some((task) => task.id === initialDetailTaskId)),
  );
  const [detailIndex, setDetailIndex] = React.useState(0);
  const [shellOutputTails, setShellOutputTails] = React.useState<
    Record<string, ShellOutputTail | undefined>
  >({});
  React.useEffect(() => {
    if (initialDetailTaskId && sorted.some((task) => task.id === initialDetailTaskId)) {
      setSelectedTaskId(initialDetailTaskId);
      setShowDetail(true);
      return;
    }
    if (initialDetailTaskId) {
      setShowDetail(false);
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
  const selectedShellOutputTail =
    selectedTask?.type === "local_bash" ? shellOutputTails[selectedTask.id] : undefined;
  const nameByAgentId = React.useMemo(() => {
    const inverted = new Map<string, string>();
    for (const [name, id] of agentNameRegistry ?? []) {
      inverted.set(String(id), name);
    }
    return inverted;
  }, [agentNameRegistry]);
  const detailRows = React.useMemo(
    () => selectedTask ? buildTaskDetailRows(selectedTask, selectedShellOutputTail, nameByAgentId) : [],
    [nameByAgentId, selectedShellOutputTail, selectedTask],
  );
  const selectedTaskStopAction = tuiStopActionForTask(selectedTask);
  const selectedTaskCanStop = selectedTaskStopAction !== null;
  React.useEffect(() => {
    setDetailIndex(0);
  }, [selectedTaskId]);
  React.useEffect(() => {
    setDetailIndex((current) => Math.min(current, Math.max(0, detailRows.length - 1)));
  }, [detailRows.length]);
  React.useEffect(() => {
    if (!showDetail || selectedTask?.type !== "local_bash") {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const readTail = async () => {
      try {
        const result = await tailFile(getTaskOutputPath(selectedTask.id), SHELL_DETAIL_TAIL_BYTES);
        if (cancelled) {
          return;
        }
        setShellOutputTails((current) => ({
          ...current,
          [selectedTask.id]: {
            content: result.content,
            bytesTotal: result.bytesTotal,
          },
        }));
      } catch {
        // Keep the last successful tail visible across transient read failures.
      }
    };
    void readTail();
    if (selectedTask.status === "running" || selectedTask.status === "pending") {
      timer = setInterval(() => {
        void readTail();
      }, 1000);
    }
    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [showDetail, selectedTask?.id, selectedTask?.status, selectedTask?.type]);
  const selectRelative = React.useCallback(
    (delta: number) => {
      const nextIndex = (selectedIndex + delta + sorted.length) % sorted.length;
      setSelectedTaskId(sorted[nextIndex]!.id);
    },
    [selectedIndex, sorted],
  );
  const stopSelectedTask = React.useCallback(() => {
    stopTuiTask(selectedTask!, setAppState);
  }, [selectedTask, setAppState]);
  const selectDetailRelative = React.useCallback(
    (delta: number) => {
      setDetailIndex((current) =>
        Math.min(Math.max(0, current + delta), Math.max(0, detailRows.length - 1)),
      );
    },
    [detailRows.length],
  );

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone?.();
      return;
    }
    if (sorted.length === 0) {
      return;
    }
    if (showDetail) {
      if (key.leftArrow || input === "b" || input === "h") {
        setShowDetail(false);
        return;
      }
      if (key.upArrow || input === "k") {
        selectDetailRelative(-1);
        return;
      }
      if (key.downArrow || input === "j") {
        selectDetailRelative(1);
        return;
      }
      if (input === "x") {
        stopSelectedTask();
      }
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

  if (showDetail && selectedTask) {
    const detailValueWidth = Math.max(12, Math.min(96, columns - 25));
    return (
      <MenuModal
        title="task detail"
        count={taskDetailStatusLabel(selectedTask)}
        summary={truncateToWidth(taskTitle(selectedTask), Math.max(1, columns - 38))}
        headerRight={selectedTaskCanStop ? "↑↓ scroll · ← back · x stop" : "↑↓ scroll · ← back"}
        columns={[8, 12, detailValueWidth]}
        headers={["section", "field", "value"]}
        items={detailRows}
        activeIndex={detailIndex}
        footer={[
          { keyName: "←", label: "back" },
          ...(selectedTaskCanStop ? [{ keyName: "x", label: "stop" }] : []),
        ]}
        hint={truncateToWidth(`${taskKindLabel(selectedTask)} · ${selectedTask.id}`, taskTextWidth)}
        renderRow={(row, _index, active) => [
          <ThemedText key="section" color="inactive" wrap="truncate-end">
            {row.section}
          </ThemedText>,
          <ThemedText key="label" color={active ? "agenc" : "subtle"} wrap="truncate-end">
            {row.label}
          </ThemedText>,
          <ThemedText key="value" color={row.color} wrap="truncate-end">
            {truncateToWidth(row.value, detailValueWidth)}
          </ThemedText>,
        ]}
      />
    );
  }

  const listSelectedTask = selectedTask!;
  const listSelectedTaskDetail = taskDetail(listSelectedTask);
  const listSelectedTaskStopAction = tuiStopActionForTask(listSelectedTask);
  const listSelectedTaskCanStop = listSelectedTaskStopAction !== null;

  return (
    <MenuModal
      title="background tasks"
      count={summary}
      summary="unified background panel"
      headerRight={listSelectedTaskCanStop ? "↑↓ select · ⏎ open · x stop" : "↑↓ select · ⏎ open"}
      columns={[2, 8, 18, 28, 18, 12, 8, 8]}
      headers={["", "kind", "id · status", "label", "target", "progress", "elapsed", "cost"]}
      items={sorted}
      activeIndex={selectedIndex}
      footer={[
        { keyName: "⏎", label: "open" },
        ...(listSelectedTaskCanStop ? [{ keyName: "x", label: "stop" }] : []),
        { keyName: "l", label: "detail" },
      ]}
      hint={truncateToWidth("kinds · teammate · bash · local", taskTextWidth)}
      preview={
        <Box flexDirection="column">
          <ThemedText color={taskStatusColor(listSelectedTask.status)} bold={true}>
            Task details
          </ThemedText>
          <ThemedText color="text2" wrap="truncate-end">
            {truncateToWidth(`${listSelectedTask.status} · ${listSelectedTask.type} · ${formatBackgroundAgentIdentity(listSelectedTask, nameByAgentId) ?? taskTitle(listSelectedTask)}`, taskTextWidth)}
          </ThemedText>
          <ThemedText color="inactive">{truncateToWidth(`id: ${listSelectedTask.id}`, taskTextWidth)}</ThemedText>
          {listSelectedTaskDetail ? (
            <ThemedText color="subtle" wrap="truncate-end">{truncateToWidth(listSelectedTaskDetail, taskTextWidth)}</ThemedText>
          ) : null}
          {"command" in listSelectedTask && listSelectedTask.command ? (
            <ThemedText color="subtle" wrap="truncate-end">{truncateToWidth(`command: ${listSelectedTask.command}`, taskTextWidth)}</ThemedText>
          ) : null}
          {"prompt" in listSelectedTask && listSelectedTask.prompt ? (
            <ThemedText color="subtle" wrap="truncate-end">{truncateToWidth(`prompt: ${listSelectedTask.prompt}`, taskTextWidth)}</ThemedText>
          ) : null}
          <ThemedText color="subtle" wrap="truncate-end">{truncateToWidth(`view output: ${listSelectedTask.outputFile}`, taskTextWidth)}</ThemedText>
        </Box>
      }
      renderRow={(task, _index, active) => [
        <ThemedText key="icon" color={taskKindColor(task)}>{taskKindIcon(task)}</ThemedText>,
        <ThemedText key="kind" color={taskKindColor(task)}>{taskKindLabel(task)}</ThemedText>,
        <ThemedText key="status" color={taskStatusColor(task.status)} wrap="truncate-end">
          {`${task.id} · ${taskStatusLabel(task.status)}`}
        </ThemedText>,
        <ThemedText key="label" color={active ? "agenc" : "text2"} wrap="truncate-end">
          {formatBackgroundAgentIdentity(task, nameByAgentId) ?? taskTitle(task)}
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
