import React from "react";

import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

import type { StatusRowState, StatusDashboardRow, StatusDashboardSnapshot } from "./status-menu-snapshot.js";
export { createStatusDashboardSnapshot, type StatusDashboardSnapshot } from "./status-menu-snapshot.js";

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
