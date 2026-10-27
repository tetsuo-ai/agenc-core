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

/** What each effort level means for the user, shown under the list. */
const EFFORT_DESCRIPTIONS: Record<string, string> = {
  default: "uses this model's own default.",
  none: "no extra thinking. Fastest and cheapest.",
  minimal: "almost no thinking. Very fast.",
  low: "light thinking. Fast and cheap; good for simple edits and questions.",
  medium: "balanced thinking for everyday coding.",
  high: "thinks harder. Better on tricky bugs; slower and uses more tokens.",
  xhigh: "even more thinking for hard problems.",
  max: "the most thinking. Best for the hardest tasks; slowest and most expensive.",
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
      detail={
        <Box flexDirection="column" gap={1}>
          {rows[activeIndex] !== undefined ? (
            <ThemedText color="text" wrap="wrap">
              {rows[activeIndex]!.label}: {EFFORT_DESCRIPTIONS[String(rows[activeIndex]!.choice)] ?? EFFORT_DESCRIPTIONS[rows[activeIndex]!.label] ?? "a reasoning level this model supports."}
            </ThemedText>
          ) : null}
          <ThemedText color="text2" wrap="wrap">
            Effort sets how much the model thinks before it answers. More effort is slower and costs more.
          </ThemedText>
          {message ? (
            <ThemedText color="error" wrap="wrap">
              {message}
            </ThemedText>
          ) : null}
        </Box>
      }
      footer={[
        { keyName: "↑↓", label: "choose" },
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
