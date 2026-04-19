/**
 * Read-only task-panel formatter for any rendering surface (TUI, web,
 * dashboard, future clients). Pure function — given the open-task list
 * and the recent-completed tail from a
 * {@link ../runtime-contract/types.js#RuntimeContractStatusSnapshot},
 * produce a stable structured view the renderer can lay out.
 *
 * No ANSI, no widths, no column math. Those belong to the renderer so
 * they can adapt to terminal width, theme, or HTML. This module only
 * decides: which tasks appear, in what order, with what label.
 *
 * Ordering contract:
 *   1. in_progress tasks first, most recently updated first
 *   2. pending tasks next, most recently updated first
 *   3. recent-completed tail last (already pre-truncated by the
 *      snapshot builder — this module only renders what it receives)
 *
 * Each entry's display label is:
 *   - activeForm when the task is in_progress and activeForm is set
 *   - subject otherwise
 *   - summary as a last-resort fallback when neither subject nor
 *     activeForm is populated (runtime-only tasks may lack both)
 *
 * @module
 */

import type {
  RuntimeContractStatusSnapshot,
  RuntimeTaskHandle,
} from "../runtime-contract/types.js";

export interface TaskPanelEntry {
  readonly id: string;
  readonly status: string;
  readonly kind: string;
  readonly label: string;
  readonly owner?: string;
  readonly outputReady?: boolean;
  readonly updatedAt?: number;
}

export interface TaskPanelView {
  readonly inProgress: readonly TaskPanelEntry[];
  readonly pending: readonly TaskPanelEntry[];
  readonly recentCompleted: readonly TaskPanelEntry[];
  readonly omittedOpenCount: number;
}

function chooseLabel(handle: RuntimeTaskHandle): string {
  if (handle.status === "in_progress" && handle.activeForm) {
    return handle.activeForm;
  }
  if (handle.subject && handle.subject.length > 0) return handle.subject;
  if (handle.summary && handle.summary.length > 0) return handle.summary;
  return `${handle.kind} task`;
}

function toEntry(handle: RuntimeTaskHandle): TaskPanelEntry {
  return {
    id: handle.id,
    status: handle.status,
    kind: handle.kind,
    label: chooseLabel(handle),
    ...(handle.owner !== undefined ? { owner: handle.owner } : {}),
    ...(handle.outputReady !== undefined
      ? { outputReady: handle.outputReady }
      : {}),
    ...(handle.updatedAt !== undefined ? { updatedAt: handle.updatedAt } : {}),
  };
}

function byUpdatedAtDesc(a: RuntimeTaskHandle, b: RuntimeTaskHandle): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

export interface BuildTaskPanelViewInput {
  readonly openTasks: readonly RuntimeTaskHandle[];
  readonly recentCompletedTasks?: readonly RuntimeTaskHandle[];
  readonly omittedTaskCount?: number;
}

export function buildTaskPanelView(
  input: BuildTaskPanelViewInput,
): TaskPanelView {
  const inProgress = input.openTasks
    .filter((task) => task.status === "in_progress")
    .slice()
    .sort(byUpdatedAtDesc)
    .map(toEntry);
  const pending = input.openTasks
    .filter((task) => task.status === "pending")
    .slice()
    .sort(byUpdatedAtDesc)
    .map(toEntry);
  const recentCompleted = (input.recentCompletedTasks ?? [])
    .slice()
    .sort(byUpdatedAtDesc)
    .map(toEntry);
  return {
    inProgress,
    pending,
    recentCompleted,
    omittedOpenCount: input.omittedTaskCount ?? 0,
  };
}

export function buildTaskPanelViewFromSnapshot(
  snapshot: RuntimeContractStatusSnapshot | undefined,
): TaskPanelView | undefined {
  if (!snapshot) return undefined;
  return buildTaskPanelView({
    openTasks: snapshot.openTasks,
    ...(snapshot.recentCompletedTasks
      ? { recentCompletedTasks: snapshot.recentCompletedTasks }
      : {}),
    omittedTaskCount: snapshot.omittedTaskCount,
  });
}

const STATUS_ICON: Readonly<Record<string, string>> = {
  in_progress: "*",
  pending: "o",
  completed: "x",
  failed: "!",
  cancelled: "-",
  deleted: "-",
};

function iconFor(status: string): string {
  return STATUS_ICON[status] ?? "?";
}

export interface FormatTaskPanelLinesOptions {
  readonly showHeader?: boolean;
  readonly maxLabelLength?: number;
  readonly emptyMessage?: string;
}

function truncate(value: string, max: number): string {
  if (max <= 3) return value.slice(0, max);
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}\u2026`;
}

/**
 * Convenience formatter that emits simple text lines suitable for a
 * minimal panel. Renderers with richer styling primitives should use
 * {@link buildTaskPanelView} directly and style the entries themselves.
 */
export function formatTaskPanelLines(
  view: TaskPanelView,
  options: FormatTaskPanelLinesOptions = {},
): readonly string[] {
  const maxLabel = options.maxLabelLength ?? 72;
  const showHeader = options.showHeader ?? true;
  const lines: string[] = [];
  const isEmpty =
    view.inProgress.length === 0 &&
    view.pending.length === 0 &&
    view.recentCompleted.length === 0;
  if (isEmpty) {
    if (options.emptyMessage) lines.push(options.emptyMessage);
    return lines;
  }
  const renderEntry = (entry: TaskPanelEntry): void => {
    const icon = iconFor(entry.status);
    const owner = entry.owner ? ` (${entry.owner})` : "";
    const ready = entry.outputReady ? " [output ready]" : "";
    lines.push(
      `${icon} #${entry.id} ${truncate(entry.label, maxLabel)}${owner}${ready}`,
    );
  };
  if (showHeader && (view.inProgress.length > 0 || view.pending.length > 0)) {
    lines.push("Tasks");
  }
  for (const entry of view.inProgress) renderEntry(entry);
  for (const entry of view.pending) renderEntry(entry);
  if (view.omittedOpenCount > 0) {
    lines.push(`  (+${view.omittedOpenCount} more not shown)`);
  }
  if (view.recentCompleted.length > 0) {
    if (showHeader) lines.push("Recently completed");
    for (const entry of view.recentCompleted) renderEntry(entry);
  }
  return lines;
}
