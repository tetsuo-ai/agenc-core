import React from "react";

import type { PermissionMode } from "../permissions/types.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedBox from "../tui/components/design-system/ThemedBox.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import {
  KeyHint,
  PlanList,
  PlanModeBanner,
} from "../tui/components/v2/primitives.js";
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

export function PlanDashboardView({
  snapshot,
  onDone,
}: {
  readonly snapshot: PlanDashboardSnapshot;
  readonly onDone: () => void;
}): React.ReactNode {
  useInput((input, key) => {
    if (key.escape || input === "q") onDone();
  });

  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor="planMode"
      backgroundColor="clawd_background"
      overflow="hidden"
    >
      {snapshot.mode === "plan" ? (
        <PlanModeBanner body={snapshot.message} />
      ) : null}
      <ThemedBox flexDirection="row" borderBottom borderBottomColor="lineSoft" paddingX={1} gap={2}>
        <ThemedText color="planMode">PLAN</ThemedText>
        <ThemedText color="subtle" wrap="truncate-end">
          mode {snapshot.mode}
        </ThemedText>
        {snapshot.previousMode ? (
          <ThemedText color="inactive" wrap="truncate-end">
            previous {snapshot.previousMode}
          </ThemedText>
        ) : null}
        <Box flexGrow={1} />
        <ThemedText color="inactive" wrap="truncate-middle">
          {snapshot.planPath}
        </ThemedText>
      </ThemedBox>
      <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
        <PlanList title="current plan" items={snapshot.items} />
        {snapshot.planText ? (
          <ThemedText color="subtle" wrap="wrap">
            {compact(snapshot.planText, 260)}
          </ThemedText>
        ) : null}
      </Box>
      <ThemedBox flexDirection="row" borderTop borderTopColor="lineSoft" paddingX={1} gap={2}>
        <KeyHint k="/plan open" label="edit" />
        <KeyHint k="esc" label="dismiss" />
        <Box flexGrow={1} />
        <ThemedText color="inactive" wrap="truncate-end">approve plan from the plan prompt</ThemedText>
      </ThemedBox>
    </ThemedBox>
  );
}

export function openPlanDashboard(
  ctx: SlashCommandContext,
  snapshot: PlanDashboardSnapshot,
): boolean {
  const setToolJSX = ctx.appState?.setToolJSX;
  if (typeof setToolJSX !== "function") return false;
  const close = () => {
    setToolJSX({
      jsx: null,
      shouldHidePromptInput: false,
      clearLocalJSX: true,
    });
  };
  setToolJSX({
    isLocalJSXCommand: true,
    shouldHidePromptInput: true,
    jsx: <PlanDashboardView snapshot={snapshot} onDone={close} />,
  });
  return true;
}
