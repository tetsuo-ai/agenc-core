import React from "react";

import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState, useSetAppState } from "../../state/AppState.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { stopWorkbenchTask, workbenchStopActionForTask } from "../tasks/stopActions.js";
import { formatTaskElapsed } from "./activity.js";
import { nonEmptyString as nonBlankString } from "../../../utils/stringUtils.js";

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
  const taskList = useStableAgentTasks(Object.values(tasks ?? {}).filter((task: any) => task.type !== "local_bash"));
  const { activeTasks, backgroundTasks } = partitionAgentTasks(taskList);
  const { selectedId, selectedTask } = resolveAgentSelection(taskList, workbench.selectedAgentTaskId);
  const selectByDelta = (delta: number) => {
    const nextId = nextAgentSelectionId(taskList, selectedId, delta);
    if (nextId !== null) dispatch({ type: "selectAgent", taskId: nextId });
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

function useStableAgentTasks(tasks: readonly any[]): readonly any[] {
  const orderRef = React.useRef<readonly string[]>([]);
  const ordered = React.useMemo(() => orderAgentTasks(tasks, orderRef.current), [tasks]);

  React.useEffect(() => {
    orderRef.current = ordered
      .map((task: any) => taskIdOf(task))
      .filter((id: string | null): id is string => id !== null);
  }, [ordered]);

  return ordered;
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

/**
 * The next selection id when arrow-navigating the rail by `delta`. Navigation
 * MUST follow the rendered order — active section then background section —
 * not the flat task list, or ↓ jumps between sections and skips rows the eye
 * expects next. Returns `null` when there is nothing to select or the target
 * row has no stable id (an unkeyed task must not dispatch `taskId: undefined`).
 */
export function nextAgentSelectionId(
  taskList: readonly any[],
  selectedId: string | null,
  delta: number,
): string | null {
  const { activeTasks, backgroundTasks } = partitionAgentTasks(taskList);
  const renderedOrder = [...activeTasks, ...backgroundTasks];
  if (renderedOrder.length === 0) return null;
  const currentIndex = renderedOrder.findIndex((task: any) => taskIdOf(task) === selectedId);
  const base = currentIndex >= 0 ? currentIndex : 0;
  const next = renderedOrder[wrapIndex(base + delta, renderedOrder.length)];
  return taskIdOf(next);
}

export function orderAgentTasks(
  tasks: readonly any[],
  previousOrder: readonly string[] = [],
): readonly any[] {
  const byId = new Map<string, any>();
  const unkeyed: any[] = [];
  for (const task of tasks) {
    const id = taskIdOf(task);
    if (id === null) {
      unkeyed.push(task);
    } else if (!byId.has(id)) {
      byId.set(id, task);
    }
  }

  const ordered: any[] = [];
  const seen = new Set<string>();
  for (const id of previousOrder) {
    const task = byId.get(id);
    if (!task) continue;
    ordered.push(task);
    seen.add(id);
  }
  for (const task of tasks) {
    const id = taskIdOf(task);
    if (id === null || seen.has(id)) continue;
    ordered.push(task);
    seen.add(id);
  }

  return [...ordered, ...unkeyed];
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
  const selectedTask = orderedTasks[resolvedIndex];
  return {
    selectedId: selectedTask.id,
    selectedIndex: resolvedIndex,
    selectedTask,
  };
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function taskIdOf(task: any): string | null {
  return typeof task?.id === "string" ? task.id : null;
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
  const activity =
    nonBlankString(progress.lastActivity?.activityDescription) ??
    nonBlankString(progress.lastActivity?.toolName) ??
    nonBlankString(task.status) ??
    "unknown";
  const label = agentRowLabel(task);
  const stopAction = workbenchStopActionForTask(task);
  const diffCount = progress.diffCount ?? task.diffCount;
  const approvalPending = task.approvalPending === true || task.pendingApproval === true;
  // Semantic state color (working/done/failed/stopped/idle) on the marker so a
  // fan-out reads at a glance instead of as a wall of identical rows. When the
  // agent is waiting on a human decision, the marker shifts to the warning
  // accent regardless of run state so "needs you" stands out.
  const markerColor = approvalPending ? "warning" : statusColor(task.status);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text wrap="truncate-end">
        <Text color={markerColor}>{statusMarker(task.status)}</Text>
        <Text color={selected ? "suggestion" : undefined}> {label}</Text>
      </Text>
      <Text dimColor wrap="truncate-end">{activity}</Text>
      <Text dimColor wrap="truncate-end">
        {formatTaskElapsed(task)} · tools {progress.toolUseCount ?? 0} tokens {progress.tokenCount ?? 0}
        {typeof diffCount === "number" && diffCount > 0 ? ` · diffs ${diffCount}` : ""}
        {approvalPending ? " · approval" : ""}
        {stopAction ? " · x stop" : ""}
      </Text>
    </Box>
  );
}

/**
 * Friendly short label for a rail row. Prefers the friendly task title the
 * sync layer already stores on `description` (the agent nickname / path, e.g.
 * "Nova"), appending the role when one is known so a fan-out of same-named
 * lifecycles is still distinguishable (e.g. "Nova · Scanner"). Falls back to
 * the id, never the raw spawn prompt, which is noisy and truncates badly.
 */
function agentRowLabel(task: any): string {
  const title = nonBlankString(task.description) ?? nonBlankString(task.id) ?? "agent";
  const role = nonBlankString(task.agentType);
  return role && role !== "agent" && role !== title ? `${title} · ${role}` : title;
}

/**
 * Lifecycle glyph for the rail row. Kept ASCII (not the AURA glyph set used by
 * the wider fleet panel in CoordinatorAgentStatus) because the rail is a
 * narrow, dense column where a single-cell ASCII marker stays legible across
 * all terminals; the *semantic state* is now carried by color (statusColor),
 * matching the AURA panel's color intent without a risky cross-surface glyph
 * refactor.
 */
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

/**
 * Theme color token for an agent lifecycle state. Mirrors the fleet panel's
 * intent: working=accent, completed=green, failed=red, stopped=grey,
 * pending/idle=dim. Returns a theme key (resolved by ThemedText), never a raw
 * ANSI value.
 */
function statusColor(status: string): "worker" | "success" | "error" | "muted3" | "inactive" {
  switch (status) {
    case "running":
      return "worker";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "killed":
      return "muted3";
    default:
      // pending / unknown / idle — dim, awaiting work.
      return "inactive";
  }
}
