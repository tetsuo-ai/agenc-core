/**
 * `/tasks` — summarize live background tasks and spawned agents.
 *
 * The richer task manager lives in the TUI footer. This command gives
 * users a discoverable slash-command entry point when they expect agent
 * work to be inspectable by name.
 *
 * @module
 */

import React from "react";
import {
  isStoppableTaskStatus,
  isTaskType,
  type AgentProgress,
  type TaskState,
  type TaskStatus,
  type TaskType,
} from "../tasks/types.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import { openAsyncLocalJsxCommand } from "./local-jsx-command.js";

export interface TaskSummaryRow {
  readonly id: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly title: string;
  readonly detail?: string;
  readonly startTime: number;
}

const SUMMARY_LINE_WIDTH = 76;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function compactTaskId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...` : id;
}

function formatTaskSubject(row: TaskSummaryRow, prefixLength: number): string {
  const compactId = compactTaskId(row.id);
  if (row.title === row.id || row.title === compactId) {
    return truncate(compactId, Math.max(8, SUMMARY_LINE_WIDTH - prefixLength));
  }
  const suffix = ` (${compactId})`;
  const titleWidth = Math.max(8, SUMMARY_LINE_WIDTH - prefixLength - suffix.length);
  return `${truncate(row.title, titleWidth)}${suffix}`;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u)[0]?.trim() ?? "";
}

function taskTypeLabel(type: TaskType): string {
  switch (type) {
    case "local_agent":
      return "agent";
    case "in_process_teammate":
      return "teammate";
    case "local_bash":
      return "shell";
    case "remote_agent":
      return "remote";
  }
}

function readProgress(task: Record<string, unknown>): AgentProgress | undefined {
  return isRecord(task.progress) ? (task.progress as AgentProgress) : undefined;
}

function formatProgress(progress: AgentProgress | undefined): string | undefined {
  if (!progress) return undefined;
  const parts: string[] = [];
  if (typeof progress.toolUseCount === "number" && progress.toolUseCount > 0) {
    parts.push(`${progress.toolUseCount} ${progress.toolUseCount === 1 ? "tool" : "tools"}`);
  }
  if (typeof progress.tokenCount === "number" && progress.tokenCount > 0) {
    parts.push(`${progress.tokenCount.toLocaleString()} tokens`);
  }
  const activity = progress.lastActivity?.activityDescription?.trim();
  if (activity) {
    parts.push(truncate(activity, 56));
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function taskTitle(task: TaskState): string {
  const record = task as unknown as Record<string, unknown>;
  const identity = isRecord(record.identity) ? record.identity : undefined;
  const selectedAgent = isRecord(record.selectedAgent) ? record.selectedAgent : undefined;
  const candidates = [
    stringField(identity ?? {}, "agentName"),
    stringField(selectedAgent ?? {}, "name"),
    stringField(record, "title"),
    stringField(record, "command"),
    stringField(record, "prompt"),
    stringField(record, "description"),
    task.id,
  ];
  for (const candidate of candidates) {
    if (candidate) return truncate(firstLine(candidate), 72);
  }
  return task.id;
}

function taskDetail(task: TaskState): string | undefined {
  const record = task as unknown as Record<string, unknown>;
  const parts: string[] = [];
  const progress = formatProgress(readProgress(record));
  if (progress) parts.push(progress);
  const error = stringField(record, "error");
  if (error) parts.push(`error: ${truncate(firstLine(error), 56)}`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function isTaskState(value: unknown): value is TaskState {
  if (!isRecord(value)) return false;
  const type = value.type;
  const status = value.status;
  return (
    typeof type === "string" &&
    isTaskType(type) &&
    (
      status === "pending" ||
      status === "running" ||
      status === "completed" ||
      status === "failed" ||
      status === "killed"
    ) &&
    typeof value.id === "string"
  );
}

export function collectTaskSummaryRows(appState: unknown): TaskSummaryRow[] {
  if (!isRecord(appState) || !isRecord(appState.tasks)) return [];
  return Object.values(appState.tasks)
    .filter(isTaskState)
    .map((task) => {
      const detail = taskDetail(task);
      const startTime =
        numberField(task as unknown as Record<string, unknown>, "startTime") ?? 0;
      return {
        id: task.id,
        type: task.type,
        status: task.status,
        title: taskTitle(task),
        ...(detail ? { detail } : {}),
        startTime,
      };
    })
    .sort((a, b) => {
      const aActive = isStoppableTaskStatus(a.status) ? 0 : 1;
      const bActive = isStoppableTaskStatus(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return b.startTime - a.startTime;
    });
}

export function formatTaskSummary(rows: readonly TaskSummaryRow[]): string {
  if (rows.length === 0) {
    return [
      "Tasks:",
      "  active: none",
      "  agents and long-running shell commands appear here while they run.",
      "  manage: Down selects the task pill; Enter opens details.",
      "          x stops a running task.",
    ].join("\n");
  }

  const activeCount = rows.filter((row) => isStoppableTaskStatus(row.status)).length;
  const lines = [
    "Tasks:",
    `  active: ${activeCount}`,
    `  total: ${rows.length}`,
  ];
  for (const row of rows) {
    const prefix = `  ${row.status} ${taskTypeLabel(row.type)} `;
    const subject = formatTaskSubject(row, prefix.length);
    lines.push(`${prefix}${subject}`);
    if (row.detail) {
      lines.push(`    ${truncate(row.detail, SUMMARY_LINE_WIDTH - 4)}`);
    }
  }
  lines.push("  manage: Down selects the task pill; Enter opens details.");
  lines.push("          x stops a running task.");
  return lines.join("\n");
}

export const tasksCommand: SlashCommand = {
  name: "tasks",
  aliases: ["jobs", "bashes"],
  description: "Show live background tasks and spawned agents",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      if (
        await openAsyncLocalJsxCommand(ctx, async close => {
          const { BackgroundTasksPanel } = await import(
            "../tui/components/tasks/BackgroundTasksPanel.js"
          );
          return React.createElement(BackgroundTasksPanel, { onDone: close });
        })
      ) {
        return { kind: "skip" };
      }
      const getAppState = ctx.appState?.getAppState;
      if (typeof getAppState !== "function") {
        return {
          kind: "text",
          text: [
            "Tasks:",
            "  live task state is only available inside the interactive TUI.",
            "  in the TUI, Down selects the task pill; Enter opens details.",
            "  x stops a running task.",
          ].join("\n"),
        };
      }
      return {
        kind: "text",
        text: formatTaskSummary(collectTaskSummaryRows(getAppState())),
      };
    }),
};
