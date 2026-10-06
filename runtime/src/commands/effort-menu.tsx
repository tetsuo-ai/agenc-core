import React from "react";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

export type EffortChoice = string | "default";

export type EffortMenuRow = {
  readonly choice: EffortChoice;
  readonly label: string;
  readonly detail: string;
  readonly current: boolean;
};

export type EffortMenuSnapshot = {
  readonly model: string;
  readonly rows: readonly EffortMenuRow[];
  readonly activeIndex: number;
};

export type EffortMenuSelectionResult = {
  readonly message: string;
  readonly shouldClose: boolean;
};

function EffortMenuView({
  snapshot,
  onDone,
  onSelect,
}: {
  readonly snapshot: EffortMenuSnapshot;
  readonly onDone: () => void;
  readonly onSelect: (choice: EffortChoice) => Promise<EffortMenuSelectionResult>;
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
      void onSelect(row.choice).then(
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

  return (
    <MenuModal
      title="effort"
      count={`${rows.length}`}
      summary={snapshot.model}
      headerRight={busy ? "applying" : undefined}
      columns={[3, 16, 40]}
      headers={["", "level", ""]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => [
        <ThemedText key="mark" color={row.current ? "text" : "subtle"}>
          {row.current ? "●" : " "}
        </ThemedText>,
        <ThemedText key="level" color={active ? "text" : "text2"} bold={active}>
          {row.label}
        </ThemedText>,
        <ThemedText key="detail" color="inactive" wrap="truncate-end">
          {row.detail}
        </ThemedText>,
      ]}
      preview={
        message ? (
          <Box flexDirection="column">
            <ThemedText color="error" wrap="wrap">
              {message}
            </ThemedText>
          </Box>
        ) : undefined
      }
      footer={[
        { keyName: "up/down", label: "move" },
        { keyName: "enter", label: "apply" },
        { keyName: "esc", label: "close" },
      ]}
    />
  );
}

export function openEffortMenu(
  ctx: SlashCommandContext,
  snapshot: EffortMenuSnapshot,
  onSelect: (choice: EffortChoice) => Promise<EffortMenuSelectionResult>,
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <EffortMenuView snapshot={snapshot} onDone={close} onSelect={onSelect} />
  ));
}
