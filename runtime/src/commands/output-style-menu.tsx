import React from "react";

import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

export type OutputStyleMenuRowStatus = "effective" | "configured" | "available";

export interface OutputStyleMenuRow {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly status: OutputStyleMenuRowStatus;
}

export interface OutputStyleMenuSnapshot {
  readonly configuredStyle: string;
  readonly effectiveStyle: string;
  readonly forcedByPlugin: boolean;
  readonly rows: readonly OutputStyleMenuRow[];
  readonly activeIndex: number;
}

export interface OutputStyleMenuSelectionResult {
  readonly message: string;
  readonly shouldClose: boolean;
}

function statusColor(
  status: OutputStyleMenuRowStatus,
): "success" | "agenc" | "inactive" {
  switch (status) {
    case "effective":
      return "success";
    case "configured":
      return "agenc";
    case "available":
      return "inactive";
  }
}

function statusGlyph(status: OutputStyleMenuRowStatus): string {
  switch (status) {
    case "effective":
      return "◆";
    case "configured":
      return "●";
    case "available":
      return "·";
  }
}

function OutputStyleMenuView({
  snapshot,
  onDone,
  onSelect,
}: {
  readonly snapshot: OutputStyleMenuSnapshot;
  readonly onDone: () => void;
  readonly onSelect: (name: string) => Promise<OutputStyleMenuSelectionResult>;
}): React.ReactNode {
  const [activeIndex, setActiveIndex] = React.useState(snapshot.activeIndex);
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const rows = snapshot.rows;

  useInput((input, key) => {
    if (busy) return;
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
      return;
    }
    if (key.return) {
      const row = rows[activeIndex];
      if (row === undefined) return;
      setBusy(true);
      setMessage("Switching output style...");
      void onSelect(row.name).then(
        result => {
          if (result.shouldClose) {
            onDone();
            return;
          }
          setMessage(result.message);
          setBusy(false);
        },
        error => {
          setMessage(error instanceof Error ? error.message : String(error));
          setBusy(false);
        },
      );
    }
  });

  const selected = rows[activeIndex] ?? rows[0];
  return (
    <MenuModal
      title="output style"
      count={`${rows.length}`}
      summary={`effective ${snapshot.effectiveStyle}`}
      headerRight={busy ? "switching" : "local"}
      columns={[3, 13, 24, 18, 44]}
      headers={["", "status", "style", "source", "description"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => {
        const color = statusColor(row.status);
        return [
          <ThemedText key="mark" color={color}>
            {statusGlyph(row.status)}
          </ThemedText>,
          <ThemedText key="status" color={color} wrap="truncate-end">
            {row.status}
          </ThemedText>,
          <ThemedText key="name" color={active ? "agenc" : "text2"} wrap="truncate-middle">
            {row.name}
          </ThemedText>,
          <ThemedText key="source" color="inactive" wrap="truncate-end">
            {row.source}
          </ThemedText>,
          <ThemedText key="description" color="subtle" wrap="truncate-end">
            {row.description}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Output Style</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Select a response style for subsequent turns. The command writes a
            local settings override for this project.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.name ?? snapshot.effectiveStyle}
          </ThemedText>
          {selected ? (
            <ThemedText color={statusColor(selected.status)} wrap="wrap">
              {selected.status}: {selected.description}
            </ThemedText>
          ) : null}
          {snapshot.forcedByPlugin ? (
            <ThemedText color="warning" wrap="wrap">
              A plugin is forcing the effective style. Manual changes are
              saved but will not take effect until the forced style is removed.
            </ThemedText>
          ) : null}
          {message ? (
            <ThemedText color={message.startsWith("Output style switched") ? "success" : "error"} wrap="wrap">
              {message}
            </ThemedText>
          ) : null}
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "enter", label: "select" },
        { keyName: "q", label: "close" },
      ]}
      hint="/output-style <name>"
    />
  );
}

export function openOutputStyleMenu(
  ctx: SlashCommandContext,
  snapshot: OutputStyleMenuSnapshot,
  onSelect: (name: string) => Promise<OutputStyleMenuSelectionResult>,
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <OutputStyleMenuView
      snapshot={snapshot}
      onDone={close}
      onSelect={onSelect}
    />
  ));
}
