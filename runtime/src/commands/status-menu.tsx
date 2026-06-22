import React from "react";

import type { GitStatusSummary, StatusLine } from "./status.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

type StatusRowState = "ok" | "warn" | "error" | "info";
type StatusRowGroup = "runtime" | "session";

type StatusDashboardRow = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
  const model = appState.mainLoopModel ?? appState.mainLoopModelForSession;
  if (model !== undefined && model !== null) {
    rows.push(row("model", "active model", model, "ok", "Model shown by the live TUI app state."));
  }
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

function stateColor(state: StatusRowState): "success" | "agenc" | "worker" | "error" {
  switch (state) {
    case "ok":
      return "success";
    case "warn":
      return "worker";
    case "error":
      return "error";
    case "info":
      return "agenc";
  }
}

function stateGlyph(state: StatusRowState): string {
  switch (state) {
    case "ok":
      return "●";
    case "warn":
      return "!";
    case "error":
      return "✕";
    case "info":
      return "·";
  }
}

function parseStatusNumber(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/u);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function progressBar(ratio: number | null, width = 24): string {
  if (ratio === null) return "░".repeat(width);
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function costBlock(rows: readonly StatusDashboardRow[]): {
  readonly cost: string;
  readonly tokens: string;
  readonly bar: string;
  readonly percent: string;
} {
  const cost = rows.find(row => row.key.toLowerCase() === "cost")?.value ?? "$0.00";
  const emitted = parseStatusNumber(rows.find(row => row.key.toLowerCase() === "tokens emitted")?.value);
  const remaining = parseStatusNumber(rows.find(row => row.key.toLowerCase() === "tokens remaining")?.value);
  const ratio = emitted !== null && remaining !== null && emitted + remaining > 0
    ? emitted / (emitted + remaining)
    : null;
  return {
    cost,
    tokens: emitted === null ? "tokens n/a" : `${emitted.toLocaleString()} emitted`,
    bar: progressBar(ratio),
    percent: ratio === null ? "budget open" : `${Math.round(ratio * 100)}% used`,
  };
}

function StatusDashboardView({
  snapshot,
  onDone,
}: {
  readonly snapshot: StatusDashboardSnapshot;
  readonly onDone: () => void;
}): React.ReactNode {
  const rows = snapshot.rows;
  const [activeIndex, setActiveIndex] = React.useState(snapshot.activeIndex);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone();
      return;
    }
    if (key.upArrow || input === "k") {
      setActiveIndex(index => previousMenuIndex(index, rows.length));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex(index => nextMenuIndex(index, rows.length));
    }
  });

  const selected = rows[Math.max(0, Math.min(activeIndex, rows.length - 1))] ?? rows[0];
  const costs = costBlock(rows);

  return (
    <MenuModal
      title="status dashboard"
      count={`${rows.length}`}
      summary={snapshot.summary}
      headerRight="runtime · session"
      columns={[3, 12, 22, 28, 46]}
      headers={["", "section", "label", "value", "detail"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(item, _index, active) => {
        const color = stateColor(item.state);
        return [
          <ThemedText key="mark" color={color}>
            {stateGlyph(item.state)}
          </ThemedText>,
          <ThemedText key="group" color={color} wrap="truncate-end">
            {item.group}
          </ThemedText>,
          <ThemedText key="key" color="text2" wrap="truncate-end">
            {item.key}
          </ThemedText>,
          <ThemedText key="value" color={active ? "agenc" : "text2"} wrap="truncate-middle">
            {item.value}
          </ThemedText>,
          <ThemedText key="detail" color="muted3" wrap="truncate-end">
            {item.detail}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Runtime / Session</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            {rows.filter(row => row.group === "runtime").length} runtime rows · {rows.filter(row => row.group === "session").length} session rows
          </ThemedText>
          <ThemedText color="muted3" wrap="wrap">
            Selected: {selected?.group ?? "status"} / {selected?.key ?? "none"}
          </ThemedText>
          <ThemedText color="text2" wrap="wrap">
            {selected?.detail ?? "No status detail available."}
          </ThemedText>
          <Box flexDirection="column">
            <ThemedText color="muted3">COST</ThemedText>
            <ThemedText color="text2" wrap="truncate-end">
              {costs.cost} · {costs.tokens}
            </ThemedText>
            <ThemedText color="agenc" wrap="truncate-end">
              {costs.bar} {costs.percent}
            </ThemedText>
          </Box>
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "q", label: "close" },
      ]}
      hint="/status"
    />
  );
}

export function openStatusDashboard(
  ctx: SlashCommandContext,
  snapshot: StatusDashboardSnapshot,
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <StatusDashboardView snapshot={snapshot} onDone={close} />
  ));
}
