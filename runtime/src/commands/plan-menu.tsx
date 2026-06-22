import React from "react";

import type { PermissionMode } from "../permissions/types.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedBox from "../tui/components/design-system/ThemedBox.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import {
  Popup,
} from "../tui/components/v2/primitives.js";
import { AURA_PLAN_GLYPHS } from "../utils/theme.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext } from "./types.js";

type PlanItemState = "done" | "active" | "pending" | "failed";

export type PlanDashboardSnapshot = {
  readonly mode: PermissionMode;
  readonly previousMode?: PermissionMode;
  readonly planPath: string;
  readonly planText: string | null;
  readonly items: readonly {
    readonly state: PlanItemState;
    readonly text: string;
  }[];
  readonly message: string;
};

function compact(value: string, limit = 100): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

function itemState(line: string): PlanItemState {
  if (/^\s*[-*]\s+\[[xX]\]/u.test(line)) return "done";
  if (/^\s*[-*]\s+\[[!]\]/u.test(line)) return "failed";
  if (/^\s*[-*]\s+\[[\s]\]/u.test(line)) return "pending";
  return "active";
}

function itemText(line: string): string {
  return line
    .replace(/^\s*[-*]\s+\[[xX!\s]\]\s*/u, "")
    .replace(/^\s*[-*]\s*/u, "")
    .replace(/^#+\s*/u, "")
    .trim();
}

function markerForState(state: PlanItemState): string {
  if (state === "done") return "x";
  if (state === "failed") return "!";
  return " ";
}

function formatPlanMarkdown(items: PlanDashboardSnapshot["items"]): string {
  return `${items.map(item => `- [${markerForState(item.state)}] ${item.text}`).join("\n")}\n`;
}

export function planItemsFromText(planText: string | null): PlanDashboardSnapshot["items"] {
  if (!planText || planText.trim().length === 0) {
    return [{
      state: "pending",
      text: "No plan written yet.",
    }];
  }
  const candidateLines = planText
    .split("\n")
    .map(line => line.trim())
    .filter(line =>
      line.length > 0 &&
      !line.startsWith("```") &&
      (/^\s*[-*]\s+/u.test(line) || /^#+\s+/u.test(line)),
    );
  const lines = candidateLines.length > 0
    ? candidateLines
    : planText.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 8);
  return lines.slice(0, 12).map((line, index) => ({
    state: index === 0 && itemState(line) === "active" ? "active" : itemState(line),
    text: compact(itemText(line) || line),
  }));
}

export function createPlanDashboardSnapshot(params: {
  readonly mode: PermissionMode;
  readonly previousMode?: PermissionMode;
  readonly planPath: string;
  readonly planText: string | null;
}): PlanDashboardSnapshot {
  const hasPlan = params.planText !== null && params.planText.trim().length > 0;
  return {
    ...params,
    items: planItemsFromText(params.planText),
    message: hasPlan
      ? "Review the current plan before approving edits or shell actions."
      : "Plan mode is active. Ask AgenC to draft a plan, then approve it before execution.",
  };
}

function PlanDashboardView({
  snapshot,
  onDone,
  onPlanTextChange,
}: {
  readonly snapshot: PlanDashboardSnapshot;
  readonly onDone: () => void;
  readonly onPlanTextChange?: (nextPlanText: string) => void | Promise<void>;
}): React.ReactNode {
  const [items, setItems] = React.useState(() => [...snapshot.items]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [notice, setNotice] = React.useState<string | undefined>();

  const persistItems = React.useCallback((nextItems: PlanDashboardSnapshot["items"]) => {
    setItems([...nextItems]);
    setNotice("plan updated");
    if (onPlanTextChange) void onPlanTextChange(formatPlanMarkdown(nextItems));
  }, [onPlanTextChange]);

  const commitDraft = React.useCallback(() => {
    const text = draft.trim();
    if (text.length === 0) return;
    persistItems(items.map((item, index) => index === activeIndex ? { ...item, text } : item));
    setEditing(false);
  }, [activeIndex, draft, items, persistItems]);

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
        return;
      }
      if (key.return) {
        commitDraft();
        return;
      }
      if (key.backspace || key.delete) {
        setDraft(value => value.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraft(value => `${value}${input}`);
      }
      return;
    }

    if (key.escape || input === "q") {
      onDone();
      return;
    }
    if (key.upArrow || input === "k") {
      setActiveIndex(index => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex(index => Math.min(items.length - 1, index + 1));
      return;
    }
    if (input === "e") {
      setDraft(items[activeIndex]?.text ?? "");
      setEditing(true);
      return;
    }
    if (input === "d" && items.length > 1) {
      const nextItems = items.filter((_item, index) => index !== activeIndex);
      persistItems(nextItems);
      setActiveIndex(index => Math.min(index, nextItems.length - 1));
      return;
    }
    if (input === "a") {
      const nextItems = [
        ...items.slice(0, activeIndex + 1),
        { state: "pending" as const, text: "new plan step" },
        ...items.slice(activeIndex + 1),
      ];
      persistItems(nextItems);
      setActiveIndex(activeIndex + 1);
      setDraft("new plan step");
      setEditing(true);
      return;
    }
    if (key.return) onDone();
  });

  return (
    <Popup
      title="plan mode · full plan"
      status="e edit · d delete · a add · ↵ accept & run"
      accentColor="worker"
      bodyBackgroundColor="planModeWash"
      footer={[
        { keyName: "e", label: "edit step" },
        { keyName: "d", label: "delete" },
        { keyName: "a", label: "add" },
        { keyName: "↵", label: "accept & run" },
        { keyName: "esc", label: "close" },
      ]}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <ThemedText color="worker">mode {snapshot.mode}</ThemedText>
          <ThemedText color="text2" wrap="truncate-end">{snapshot.message}</ThemedText>
        </Box>
        {snapshot.previousMode ? (
          <ThemedText color="muted3" wrap="truncate-end">
            previous {snapshot.previousMode}
          </ThemedText>
        ) : null}
        <ThemedText color="muted3" wrap="truncate-middle">
          {snapshot.planPath}
        </ThemedText>
        <ThemedBox flexDirection="column" borderStyle="single" borderColor="lineSoft">
          <ThemedBox flexDirection="row" borderBottom borderBottomColor="lineSoft" paddingX={1}>
            <ThemedText color="muted3">CURRENT PLAN</ThemedText>
            <Box flexGrow={1} />
            {notice ? <ThemedText color="agenc">{notice}</ThemedText> : null}
          </ThemedBox>
          <Box flexDirection="column" paddingX={1} paddingY={1}>
            {items.map((item, index) => {
              const active = index === activeIndex;
              const glyph = AURA_PLAN_GLYPHS[item.state];
              const text = active && editing ? `${draft}█` : item.text;
              return (
                <ThemedBox
                  key={`${index}-${item.text}`}
                  flexDirection="row"
                  backgroundColor={active ? "agencWash" : undefined}
                >
                  <Box width={1}>
                    <ThemedText color={active ? "agenc" : "lineSoft"}>{active ? "▌" : " "}</ThemedText>
                  </Box>
                  <Box width={4}>
                    <ThemedText color="muted3">{String(index + 1).padStart(2, "0")}</ThemedText>
                  </Box>
                  <Box width={2}>
                    <ThemedText color={item.state === "pending" ? "muted3" : "agenc"}>{glyph}</ThemedText>
                  </Box>
                  <Box flexGrow={1} overflow="hidden">
                    <ThemedText color={active ? "agenc" : "text2"} wrap="truncate-end">
                      {text}
                    </ThemedText>
                  </Box>
                </ThemedBox>
              );
            })}
          </Box>
        </ThemedBox>
      </Box>
    </Popup>
  );
}

export function openPlanDashboard(
  ctx: SlashCommandContext,
  snapshot: PlanDashboardSnapshot,
  options: {
    readonly onPlanTextChange?: (nextPlanText: string) => void | Promise<void>;
  } = {},
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <PlanDashboardView
      snapshot={snapshot}
      onDone={close}
      onPlanTextChange={options.onPlanTextChange}
    />
  ));
}
