import React from "react";

import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { useModalOrTerminalSize } from "../tui/context/modalContext.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

import type { StatusRowState, StatusDashboardSnapshot } from "./status-menu-snapshot.js";
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

function costBlock(snapshot: StatusDashboardSnapshot): {
  readonly cost: string;
  readonly tokens: string;
  readonly percent: string;
} {
  const { rows } = snapshot;
  const cost = snapshot.sessionCost ?? "unavailable";
  const emitted = parseStatusNumber(rows.find(row => row.key.toLowerCase() === "tokens emitted")?.value);
  const remaining = parseStatusNumber(rows.find(row => row.key.toLowerCase() === "tokens remaining")?.value);
  const ratio = emitted !== null && remaining !== null && emitted + remaining > 0
    ? emitted / (emitted + remaining)
    : null;
  return {
    cost,
    tokens: emitted === null ? "tokens n/a" : `${emitted.toLocaleString()} emitted`,
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
  const viewport = useModalOrTerminalSize(useTerminalSize());
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
  const costs = costBlock(snapshot);
  // Keep basic labels whole. Details belong below the list, where they can
  // wrap without squeezing every table cell to make room for a second pane.
  const labelWidth = Math.max(16, ...rows.map(row => row.key.length));
  const valueWidth = Math.max(8, viewport.columns - labelWidth - 24);

  return (
    <MenuModal
      title="status dashboard"
      summary={snapshot.summary}
      headerRight="runtime · session"
      columns={[1, 7, labelWidth, valueWidth]}
      headers={["", "section", "label", "value"]}
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
        ];
      }}
      detail={
        <Box flexDirection="column">
          <ThemedText color="text2" wrap="wrap">
            {selected?.key ?? "Status"}: {selected?.value ?? "unavailable"}
          </ThemedText>
          <ThemedText color="muted3" wrap="wrap">
            {selected?.detail ?? "No status detail available."}
          </ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Cost {costs.cost} · {costs.tokens} · {costs.percent}
          </ThemedText>
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
