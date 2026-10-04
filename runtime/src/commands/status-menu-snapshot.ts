import type { GitStatusSummary, StatusLine } from "./status.js";
import { isRecord } from "../utils/record.js";

export type StatusRowState = "ok" | "warn" | "error" | "info";
type StatusRowGroup = "runtime" | "session";

export type StatusDashboardRow = {
  readonly group: StatusRowGroup;
  readonly section: string;
  readonly key: string;
  readonly value: string;
  readonly state: StatusRowState;
  readonly detail: string;
};

export type StatusDashboardSnapshot = {
  readonly rows: readonly StatusDashboardRow[];
  readonly activeIndex: number;
  readonly summary: string;
};

function scalar(value: unknown, fallback = "not set"): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (Array.isArray(value)) return `${value.length}`;
  if (value instanceof Map) return `${value.size}`;
  if (typeof value === "object") return `${Object.keys(value).length}`;
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

function compact(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

function statusGroup(section: string, key: string): StatusRowGroup {
  const lower = `${section} ${key}`.toLowerCase();
  if (
    lower.includes("git") ||
    lower.includes("mcp") ||
    lower.includes("task") ||
    lower.includes("model") ||
    lower.includes("provider")
  ) {
    return "runtime";
  }
  return "session";
}

function row(
  section: string,
  key: string,
  value: unknown,
  state: StatusRowState,
  detail: string,
): StatusDashboardRow {
  return {
    group: statusGroup(section, key),
    section,
    key,
    value: compact(scalar(value)),
    state,
    detail: compact(detail, 160),
  };
}

function rowFromStatusLine(line: StatusLine): StatusDashboardRow {
  const lower = line.key.toLowerCase();
  const section =
    lower.includes("token") || lower.includes("cost")
      ? "context"
      : lower.includes("permission")
        ? "permissions"
        : lower.includes("model") || lower.includes("provider")
          ? "model"
          : "session";
  return row(section, line.key, line.value, "info", `${line.key}: ${line.value}`);
}

function appStateRows(appState: unknown): StatusDashboardRow[] {
  if (!isRecord(appState)) return [];
  const rows: StatusDashboardRow[] = [];
  const mcp = isRecord(appState.mcp) ? appState.mcp : {};
  rows.push(
    row(
      "mcp",
      "servers",
      Array.isArray(mcp.clients) ? mcp.clients.length : 0,
      "info",
      `${Array.isArray(mcp.tools) ? mcp.tools.length : 0} tools; ${Array.isArray(mcp.commands) ? mcp.commands.length : 0} commands`,
    ),
  );
  const tasks = isRecord(appState.tasks) ? Object.values(appState.tasks) : [];
  const running = tasks.filter(task =>
    isRecord(task) && (task.status === "running" || task.status === "pending"),
  ).length;
  rows.push(
    row(
      "tasks",
      "background tasks",
      tasks.length,
      running > 0 ? "warn" : "ok",
      `${running} running or pending; ${tasks.length - running} completed, failed, or killed`,
    ),
  );
  return rows;
}

function gitRow(git: GitStatusSummary): StatusDashboardRow {
  switch (git.state) {
    case "clean":
      return row("git", "working tree", "clean", "ok", `branch ${git.branch ?? "unknown"}`);
    case "dirty":
      return row(
        "git",
        "working tree",
        "dirty",
        "warn",
        `branch ${git.branch ?? "unknown"}; ${git.changedFiles} changed files`,
      );
    case "not-repo":
      return row("git", "working tree", "not a git repository", "info", git.message);
    case "error":
      return row("git", "working tree", "error", "error", git.message);
  }
}

export function createStatusDashboardSnapshot(params: {
  readonly lines: readonly StatusLine[];
  readonly git: GitStatusSummary;
  readonly appState?: unknown;
}): StatusDashboardSnapshot {
  const rows = [
    gitRow(params.git),
    ...params.lines.map(rowFromStatusLine),
    ...appStateRows(params.appState),
  ];
  const activeIndex = Math.max(0, rows.findIndex(item => item.state === "warn" || item.state === "error"));
  const warnCount = rows.filter(item => item.state === "warn" || item.state === "error").length;
  return {
    rows,
    activeIndex,
    summary: warnCount > 0 ? `${warnCount} attention` : "all nominal",
  };
}
