import React from "react";

import { Box, Text } from "../../ink.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import { useAppState, useSetAppState } from "../../state/AppState.js";
import { formatNumber } from "../../../utils/format.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { stopWorkbenchTask } from "../tasks/stopActions.js";
import { formatTaskElapsed } from "./activity.js";
import { AgentActivityTrack } from "./AgentActivityTrack.js";
import { nonEmptyString as nonBlankString } from "../../../utils/stringUtils.js";
import { formatUsdCost } from "../../../session/cost.js";

export function AgentsRail({
  focused,
  width,
  sessionCostUsd = 0,
}: {
  readonly focused: boolean;
  readonly width: number;
  readonly sessionCostUsd?: number;
}): React.ReactElement {
  const tasks = useAppState((state) => state.tasks);
  const remoteCount = useAppState((state) => state.remoteBackgroundTaskCount);
  const reducedMotion = useAppState(
    (state) => state.settings?.prefersReducedMotion ?? false,
  );
  const setAppState = useSetAppState();
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const taskList = useStableAgentTasks(Object.values(tasks ?? {}).filter((task: any) => task.type !== "local_bash"));
  const activeCount = taskList.filter(
    (task: any) => task.status === "running" || task.status === "pending",
  ).length;
  const statusLabel =
    activeCount > 0
      ? `${activeCount} ACTIVE`
      : remoteCount > 0
        ? `${remoteCount} REMOTE`
        : taskList.length > 0
          ? `${taskList.length} RECENT`
          : "0 ACTIVE";
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
      // Same escape hatch as the explorer: a click on the rail hands it
      // keyboard focus, and esc is the way back to the prompt.
      "agents:backToComposer": () => dispatch({ type: "focus", pane: "composer" }),
    },
    { context: "Agents", isActive: focused },
  );

  return (
    <Box flexDirection="column" width={width} height="100%" borderLeft borderColor="lineSoft" backgroundColor="#000000">
      <Box
        height={2}
        flexShrink={0}
        paddingX={2}
        alignItems="center"
        backgroundColor="#000000"
        borderBottom
        borderBottomColor="lineSoft"
      >
        <Text color={focused ? "text" : "inactive"} wrap="truncate-end">AGENTS</Text>
        <Box flexGrow={1} />
        <Text color="inactive" wrap="truncate-end">{statusLabel}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={2} paddingTop={1}>
        {taskList.length === 0 && remoteCount > 0 ? (
          <Text color="inactive" wrap="wrap">Waiting for agent details…</Text>
        ) : null}
        {taskList.length === 0 && remoteCount === 0 ? (
          <Text color="inactive" wrap="wrap">Delegate work to track progress here.</Text>
        ) : null}
        {taskList.map((task: any) => (
          <AgentRailRow
            key={task.id}
            task={task}
            selected={selectedId === task.id}
            width={Math.max(8, width - 5)}
            reducedMotion={reducedMotion}
          />
        ))}
      </Box>
      <AgentRailSpend sessionCostUsd={sessionCostUsd} />
    </Box>
  );
}

function AgentRailSpend({
  sessionCostUsd,
}: {
  readonly sessionCostUsd: number;
}): React.ReactElement {
  const spend = formatUsdCost(sessionCostUsd);
  return (
    <Box
      height={2}
      flexShrink={0}
      paddingX={2}
      alignItems="center"
      borderTop
      borderTopColor="lineSoft"
      backgroundColor="#000000"
    >
      <Text color="inactive">session spend</Text>
      <Box flexGrow={1} />
      <Text color="text" bold>{spend}</Text>
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
 * MUST follow the stable rendered order or ↓ can select a row other than the
 * one immediately below the cursor. Returns `null` when there is nothing to
 * select or the target row has no stable id.
 */
export function nextAgentSelectionId(
  taskList: readonly any[],
  selectedId: string | null,
  delta: number,
): string | null {
  const renderedOrder = orderAgentTasks(taskList);
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
function AgentRailRow({
  task,
  selected,
  width = 20,
  reducedMotion,
}: {
  readonly task: any;
  readonly selected: boolean;
  readonly width?: number;
  readonly reducedMotion: boolean;
}): React.ReactElement {
  const progress = task.progress ?? {};
  const activity =
    nonBlankString(progress.lastActivity?.activityDescription) ??
    nonBlankString(progress.lastActivity?.toolName) ??
    nonBlankString(task.status) ??
    "unknown";
  const label = agentRowLabel(task);
  const running = task.status === "running";
  const needsApproval = running && task.pendingApproval === true;
  const taskStatus = nonBlankString(task.status) ?? "unknown";
  const statusLabel = needsApproval
    ? "needs you"
    : taskStatus === "pending"
      ? "queued"
      : taskStatus;
  const hasActivityDetail = activity !== statusLabel && activity !== taskStatus;
  const activityDetail = hasActivityDetail ? ` · ${activity}` : "";
  const toolCount = progress.toolUseCount ?? 0;
  const tokenCount = progress.tokenCount ?? 0;
  const stats =
    toolCount > 0 || tokenCount > 0
      ? `${toolCount} tools · ${formatNumber(tokenCount)} tok`
      : "";
  const statsWidth = stringWidth(stats);
  const showStats =
    stats !== "" && width >= 2 + 6 + 1 + statsWidth;
  const trackWidth = Math.max(
    6,
    width - 2 - (showStats ? statsWidth + 1 : 0),
  );
  return (
    <Box flexDirection="column" marginBottom={1} width="100%">
      <Box height={1}>
        <Text color={selected ? "text" : "surfaceBackground"}>{selected ? "› " : "  "}</Text>
        <Text color="text" bold={selected || running} wrap="truncate-end">{label}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="inactive" wrap="truncate-end">
          {statusLabel}
          {running || task.endTime ? ` · ${formatTaskElapsed(task)}` : ""}
          {activityDetail}
        </Text>
      </Box>
      {running && !needsApproval ? (
        <Box paddingLeft={2}>
          <AgentActivityTrack
            width={trackWidth}
            toolCount={toolCount}
            reducedMotion={reducedMotion}
          />
          {showStats ? <Text color="inactive"> {stats}</Text> : null}
        </Box>
      ) : null}
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
