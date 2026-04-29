/**
 * Sticky tasks-panel surface for the durable AgenC task board.
 *
 * Mounts when `useAgenCAppState().expandedView === "tasks"` (auto-flipped
 * by `TaskCreate` model-tool, can be toggled programmatically through
 * `setExpandedView`). Reads tasks live via `useTasksList` so concurrent
 * mutations from any agent are reflected immediately through
 * `onTasksUpdated`.
 *
 * Carve-outs vs openclaude `components/TaskListV2.tsx`:
 *   - No team / teammate / agent-color rendering — AgenC has no team
 *     scoping concept and AgenC agents do not surface as colored
 *     in-process teammates.
 *   - No recent-completed TTL fade — the simpler render is sufficient
 *     for the lean coding profile.
 *
 * @module
 */

import React from "react";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";
import type { ListedTask } from "../../bin/task-store.js";
import type { TaskStoreOptions } from "../../bin/task-store.js";
import { useTasksList } from "../hooks/useTasksList.js";

const STATUS_GLYPH: Record<ListedTask["status"], string> = {
  pending: "·",
  in_progress: "▸",
  completed: "✓",
  deleted: "·",
};

function statusColor(status: ListedTask["status"]): Color {
  switch (status) {
    case "completed":
      return theme.colors.success;
    case "in_progress":
      return theme.colors.primary;
    case "deleted":
      return theme.colors.muted;
    case "pending":
    default:
      return theme.colors.muted;
  }
}

function byIdAsc(a: ListedTask, b: ListedTask): number {
  const an = Number.parseInt(a.id, 10);
  const bn = Number.parseInt(b.id, 10);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a.id.localeCompare(b.id);
}

export interface TasksPanelProps {
  readonly storeOptions: TaskStoreOptions;
  readonly maxRows?: number;
}

export function TasksPanel({
  storeOptions,
  maxRows = 12,
}: TasksPanelProps): React.ReactElement | null {
  const tasks = useTasksList({ opts: storeOptions });
  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort(byIdAsc);
  const visible = sorted.slice(0, maxRows);
  const overflow = sorted.length - visible.length;

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width="100%"
      paddingX={1}
      paddingY={0}
    >
      <Text color={theme.colors.muted}>tasks</Text>
      {visible.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
      {overflow > 0 ? (
        <Text color={theme.colors.muted}>… +{overflow} more</Text>
      ) : null}
    </Box>
  );
}

interface TaskRowProps {
  readonly task: ListedTask;
}

function TaskRow({ task }: TaskRowProps): React.ReactElement {
  const blockedCount = task.unresolvedBlockers.length;
  const subjectColor =
    task.status === "completed" || task.status === "deleted"
      ? theme.colors.muted
      : theme.colors.primary;
  return (
    <Box flexDirection="row">
      <Text color={statusColor(task.status)}>
        {STATUS_GLYPH[task.status]}
      </Text>
      <Text>{" "}</Text>
      <Text color={theme.colors.muted}>#{task.id}</Text>
      <Text>{" "}</Text>
      <Text color={subjectColor}>
        {task.status === "deleted" ? `(deleted) ${task.subject}` : task.subject}
      </Text>
      {task.owner ? (
        <>
          <Text>{"  "}</Text>
          <Text color={theme.colors.muted}>@{task.owner}</Text>
        </>
      ) : null}
      {blockedCount > 0 ? (
        <>
          <Text>{"  "}</Text>
          <Text color={theme.colors.warning}>blocked×{blockedCount}</Text>
        </>
      ) : null}
    </Box>
  );
}
