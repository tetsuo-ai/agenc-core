/**
 * Sticky tasks-panel surface for the durable AgenC task board.
 *
 * Mounts when `useAgenCAppState().expandedView === "tasks"` (auto-flipped
 * by `TaskCreate` model-tool, can be toggled programmatically through
 * `setExpandedView`). Reads tasks live via `useTasksList` so concurrent
 * mutations from any agent are reflected immediately through
 * `onTasksUpdated`.
 *
 * Keeps the upstream task-list behavior that matters for parity:
 * recently-completed tasks remain prioritized briefly, blocked pending
 * tasks sort behind unblocked pending tasks, and all-complete lists hide
 * after the hook-level grace period.
 *
 * @module
 */

import React, { useEffect, useRef, useState } from "react";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { stringWidth } from "../ink/stringWidth.js";
import FullWidthRow from "../design-system/FullWidthRow.js";
import { glyphs } from "../design-system/glyphs.js";
import { theme } from "../theme.js";
import type { ListedTask } from "../../bin/task-store.js";
import type { TaskStoreOptions } from "../../bin/task-store.js";
import { useTasksList } from "../hooks/useTasksList.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useLiveAgentStatuses } from "../hooks/useLiveAgentStatuses.js";
import {
  formatAgentRoleLabel,
  formatAgentRolePublicName,
} from "../../agents/role-presentation.js";
import type {
  LiveAgentStatus,
  LiveAgentStatusKind,
} from "../transcript/messages/CoordinatorAgentStatus.js";

const RECENT_COMPLETED_TTL_MS = 30_000;
const OWNER_COLORS: readonly Color[] = [
  theme.colors.primary,
  theme.colors.secondary,
  theme.colors.accent,
  theme.colors.info,
  theme.colors.success,
];
const STATUS_GLYPH: Record<ListedTask["status"], string> = {
  pending: glyphs.circle,
  in_progress: "●",
  completed: glyphs.tick,
};

function statusColor(status: ListedTask["status"]): Color {
  switch (status) {
    case "completed":
      return theme.colors.success;
    case "in_progress":
      return theme.colors.primary;
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
  readonly session?: Parameters<typeof useLiveAgentStatuses>[0];
  readonly onHidden?: () => void;
}

export function TasksPanel({
  storeOptions,
  maxRows,
  session,
  onHidden,
}: TasksPanelProps): React.ReactElement | null {
  const tasks = useTasksList({ opts: storeOptions });
  const agents = useLiveAgentStatuses(session ?? {});
  const { rows, columns } = useTerminalSize();
  const [, forceUpdate] = useState(0);
  const completionTimestampsRef = useRef(new Map<string, number>());
  const previousCompletedIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (tasks !== undefined) return;
    onHidden?.();
  }, [onHidden, tasks]);

  if (previousCompletedIdsRef.current === null) {
    previousCompletedIdsRef.current = new Set(
      (tasks ?? [])
        .filter((task) => task.status === "completed")
        .map((task) => task.id),
    );
  }

  const now = Date.now();
  const currentCompletedIds = new Set(
    (tasks ?? [])
      .filter((task) => task.status === "completed")
      .map((task) => task.id),
  );
  for (const id of currentCompletedIds) {
    if (!previousCompletedIdsRef.current.has(id)) {
      completionTimestampsRef.current.set(id, now);
    }
  }
  for (const id of completionTimestampsRef.current.keys()) {
    if (!currentCompletedIds.has(id)) {
      completionTimestampsRef.current.delete(id);
    }
  }
  previousCompletedIdsRef.current = currentCompletedIds;

  useEffect(() => {
    if (completionTimestampsRef.current.size === 0) return undefined;
    const currentNow = Date.now();
    let earliestExpiry = Infinity;
    for (const timestamp of completionTimestampsRef.current.values()) {
      const expiry = timestamp + RECENT_COMPLETED_TTL_MS;
      if (expiry > currentNow && expiry < earliestExpiry) {
        earliestExpiry = expiry;
      }
    }
    if (earliestExpiry === Infinity) return undefined;
    const timer = setTimeout(
      () => forceUpdate((value) => value + 1),
      earliestExpiry - currentNow,
    );
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [tasks]);

  if (tasks === undefined || tasks.length === 0) return null;

  const maxDisplay =
    maxRows ?? (rows <= 10 ? 0 : Math.min(10, Math.max(3, rows - 14)));
  if (maxDisplay <= 0) return null;

  const unresolvedTaskIds = new Set(
    tasks.filter((task) => task.status !== "completed").map((task) => task.id),
  );
  const { visible, hidden } = selectVisibleTasks({
    tasks,
    maxDisplay,
    now,
    recentCompletedAt: completionTimestampsRef.current,
    unresolvedTaskIds,
  });
  const agentLookup = buildAgentLookup(agents);
  const ownerColors = buildOwnerColors(agents);
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const pendingCount = tasks.filter((task) => task.status === "pending").length;
  const inProgressCount = tasks.filter(
    (task) => task.status === "in_progress",
  ).length;
  const hiddenSummary = formatHiddenSummary(hidden);

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width="100%"
      paddingX={1}
      paddingY={0}
    >
      <Text color={theme.colors.muted}>
        tasks ({completedCount} done
        {inProgressCount > 0 ? `, ${inProgressCount} in progress` : ""},{" "}
        {pendingCount} open)
      </Text>
      {visible.map((task) => {
        const ownerAgent = task.owner ? agentLookup.get(task.owner) : undefined;
        const ownerActive =
          ownerAgent !== undefined && !isTerminalStatus(ownerAgent.status);
        const ownerLabel = task.owner
          ? formatTaskOwnerLabel(task.owner, ownerAgent)
          : undefined;
        return (
          <TaskRow
            key={task.id}
            task={task}
            openBlockers={task.unresolvedBlockers}
            columns={columns}
            ownerColor={task.owner ? ownerColors.get(task.owner) : undefined}
            ownerLabel={ownerLabel}
            ownerActive={ownerActive}
            activity={ownerAgent ? agentActivity(ownerAgent) : undefined}
          />
        );
      })}
      {hiddenSummary !== "" ? (
        <FullWidthRow>
          <Text color={theme.colors.muted}>{hiddenSummary}</Text>
        </FullWidthRow>
      ) : null}
    </Box>
  );
}

function selectVisibleTasks({
  tasks,
  maxDisplay,
  now,
  recentCompletedAt,
  unresolvedTaskIds,
}: {
  readonly tasks: readonly ListedTask[];
  readonly maxDisplay: number;
  readonly now: number;
  readonly recentCompletedAt: ReadonlyMap<string, number>;
  readonly unresolvedTaskIds: ReadonlySet<string>;
}): { readonly visible: readonly ListedTask[]; readonly hidden: readonly ListedTask[] } {
  if (tasks.length <= maxDisplay) {
    return { visible: [...tasks].sort(byIdAsc), hidden: [] };
  }

  const recentCompleted: ListedTask[] = [];
  const olderCompleted: ListedTask[] = [];
  for (const task of tasks.filter((item) => item.status === "completed")) {
    const timestamp = recentCompletedAt.get(task.id);
    if (timestamp !== undefined && now - timestamp < RECENT_COMPLETED_TTL_MS) {
      recentCompleted.push(task);
    } else {
      olderCompleted.push(task);
    }
  }
  recentCompleted.sort(byIdAsc);
  olderCompleted.sort(byIdAsc);
  const inProgress = tasks
    .filter((task) => task.status === "in_progress")
    .sort(byIdAsc);
  const pending = tasks
    .filter((task) => task.status === "pending")
    .sort((left, right) => {
      const leftBlocked = left.unresolvedBlockers.some((id) =>
        unresolvedTaskIds.has(id),
      );
      const rightBlocked = right.unresolvedBlockers.some((id) =>
        unresolvedTaskIds.has(id),
      );
      if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1;
      return byIdAsc(left, right);
    });
  const prioritized = [
    ...recentCompleted,
    ...inProgress,
    ...pending,
    ...olderCompleted,
  ];
  return {
    visible: prioritized.slice(0, maxDisplay),
    hidden: prioritized.slice(maxDisplay),
  };
}

function formatHiddenSummary(tasks: readonly ListedTask[]): string {
  if (tasks.length === 0) return "";
  const pending = tasks.filter((task) => task.status === "pending").length;
  const inProgress = tasks.filter((task) => task.status === "in_progress").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const parts: string[] = [];
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (completed > 0) parts.push(`${completed} completed`);
  return `… +${parts.join(", ")}`;
}

interface TaskRowProps {
  readonly task: ListedTask;
  readonly openBlockers: readonly string[];
  readonly ownerColor?: Color;
  readonly ownerLabel?: string;
  readonly activity?: string;
  readonly ownerActive: boolean;
  readonly columns: number;
}

function TaskRow({
  task,
  openBlockers,
  ownerColor,
  ownerLabel,
  activity,
  ownerActive,
  columns,
}: TaskRowProps): React.ReactElement {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";
  const isBlocked = openBlockers.length > 0;
  const showOwner = columns >= 60 && ownerLabel !== undefined && ownerActive;
  const ownerWidth = showOwner ? stringWidth(` (@${ownerLabel})`) : 0;
  const displaySubject = truncateToWidth(
    task.subject,
    Math.max(15, columns - 15 - ownerWidth),
  );
  const displayActivity = activity
    ? truncateToWidth(activity, Math.max(15, columns - 15))
    : undefined;
  const showActivity =
    isInProgress && !isBlocked && ownerActive && displayActivity !== undefined;
  const subjectColor =
    isCompleted || isBlocked
      ? theme.colors.muted
      : theme.colors.primary;
  return (
    <Box flexDirection="column" width="100%">
      <FullWidthRow>
        <Text color={statusColor(task.status)}>{STATUS_GLYPH[task.status]}</Text>
        <Text>{" "}</Text>
        <Text color={theme.colors.muted}>#{task.id}</Text>
        <Text>{" "}</Text>
        <Text
          color={subjectColor}
          bold={isInProgress}
          strikethrough={isCompleted}
        >
          {displaySubject}
        </Text>
        {showOwner ? (
          <Text color={theme.colors.muted}>
            {" ("}
            <Text color={ownerColor ?? theme.colors.muted}>@{ownerLabel}</Text>
            {")"}
          </Text>
        ) : null}
        {isBlocked ? (
          <Text color={theme.colors.warning}>
            {" "}
            {glyphs.pointer} blocked by{" "}
            {[...openBlockers].sort(byTaskIdAsc).map((id) => `#${id}`).join(", ")}
          </Text>
        ) : null}
      </FullWidthRow>
      {showActivity ? (
        <FullWidthRow>
          <Text color={theme.colors.muted}>  {displayActivity}…</Text>
        </FullWidthRow>
      ) : null}
    </Box>
  );
}

function byTaskIdAsc(left: string, right: string): number {
  const leftNumber = Number.parseInt(left, 10);
  const rightNumber = Number.parseInt(right, 10);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

function isTerminalStatus(status: LiveAgentStatusKind): boolean {
  return (
    status === "completed" ||
    status === "errored" ||
    status === "shutdown" ||
    status === "interrupted"
  );
}

function buildAgentLookup(
  agents: readonly LiveAgentStatus[],
): ReadonlyMap<string, LiveAgentStatus> {
  const lookup = new Map<string, LiveAgentStatus>();
  for (const agent of agents) {
    lookup.set(agent.threadId, agent);
    lookup.set(agent.role, agent);
    const publicRole = formatAgentRolePublicName(agent.role);
    if (publicRole !== undefined) lookup.set(publicRole, agent);
    lookup.set(formatAgentRoleLabel(agent.role, agent.role), agent);
    if (agent.nickname !== undefined) lookup.set(agent.nickname, agent);
  }
  return lookup;
}

function buildOwnerColors(
  agents: readonly LiveAgentStatus[],
): ReadonlyMap<string, Color> {
  const colors = new Map<string, Color>();
  [...agents]
    .sort((left, right) => left.threadId.localeCompare(right.threadId))
    .forEach((agent, index) => {
      const color = OWNER_COLORS[index % OWNER_COLORS.length]!;
      colors.set(agent.threadId, color);
      colors.set(agent.role, color);
      const publicRole = formatAgentRolePublicName(agent.role);
      if (publicRole !== undefined) colors.set(publicRole, color);
      colors.set(formatAgentRoleLabel(agent.role, agent.role), color);
      if (agent.nickname !== undefined) colors.set(agent.nickname, color);
    });
  return colors;
}

export function formatTaskOwnerLabel(
  owner: string,
  agent?: LiveAgentStatus,
): string {
  if (agent?.nickname !== undefined) return agent.nickname;
  return formatAgentRoleLabel(agent?.role ?? owner, owner);
}

function agentActivity(agent: LiveAgentStatus): string | undefined {
  if (agent.lastToolInfo !== undefined) return agent.lastToolInfo;
  if (agent.taskDescription !== undefined) return agent.taskDescription;
  switch (agent.status) {
    case "pending_init":
      return "starting";
    case "idle":
      return "idle";
    case "running":
      return "running";
    default:
      return undefined;
  }
}

function truncateToWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(value) <= maxWidth) return value;
  if (maxWidth === 1) return "…";
  let out = "";
  for (const char of value) {
    if (stringWidth(`${out}${char}…`) > maxWidth) break;
    out += char;
  }
  return `${out}…`;
}
