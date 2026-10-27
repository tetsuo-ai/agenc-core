import React from "react";

import type { PermissionMode } from "../permissions/types.js";
import { Box, useInput } from "../tui/ink.js";
import type { Key } from "../tui/ink.js";
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

type PlanSourceItem = {
  readonly state: PlanItemState;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly newline: string;
};

/** Editable source spans, never the compact dashboard preview. */
function planSourceItems(text: string): PlanSourceItem[] {
  const candidates: PlanSourceItem[] = [];
  const fallback: PlanSourceItem[] = [];
  let offset = 0;
  let fence: string | undefined;
  for (const fullLine of text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? []) {
    const newline = fullLine.match(/(?:\r\n|\n|\r)$/u)?.[0] ?? "";
    const line = fullLine.slice(0, fullLine.length - newline.length);
    const lineStart = offset;
    offset += fullLine.length;
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/u)?.[1];
    if (fence !== undefined) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker !== undefined) { fence = marker; continue; }
    if (line.trim().length === 0) continue;
    const prefix = line.match(/^[\t ]*(?:(?:[-*][\t ]+(?:\[[xX!\t ]\][\t ]*)?)|(?:#+[\t ]+))?/u)?.[0] ?? "";
    const entry: PlanSourceItem = {
      state: itemState(line),
      text: line.slice(prefix.length),
      start: lineStart + prefix.length,
      end: lineStart + line.length,
      lineStart,
      lineEnd: offset,
      newline,
    };
    fallback.push(entry);
    if (/^\s*[-*]\s+/u.test(line) || /^\s*#+\s+/u.test(line)) candidates.push(entry);
  }
  return candidates.length > 0 ? candidates : fallback;
}

export function planItemsFromText(planText: string | null): PlanDashboardSnapshot["items"] {
  if (!planText || planText.trim().length === 0) {
    return [{
      state: "pending",
      text: "No plan written yet.",
    }];
  }
  return planSourceItems(planText).slice(0, 12).map(item => ({
    state: item.state,
    text: compact(item.text),
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
      ? "Review or edit the plan here. Ask AgenC to use ExitPlanMode to request execution approval."
      : "Plan mode is active. Ask AgenC to draft a plan and use ExitPlanMode to request execution approval.",
  };
}

type EditorState = {
  readonly planText: string;
  readonly activeIndex: number;
  readonly editing: boolean;
  readonly adding: boolean;
  readonly draft: string;
};

type Press = {
  readonly input: string;
  readonly key: Key;
  readonly pasted: boolean;
};

/**
 * Typed text reaches useInput as one event per run, so "e ADDED" is a single
 * input. Split it into the keys a slow typist would send. Pasted text, control
 * keys and shortcuts stay whole.
 */
function pressesFor(input: string, key: Key, pasted: boolean): Press[] {
  if (input.length < 2 || pasted || key.ctrl || key.meta) return [{ input, key, pasted }];
  return Array.from(input, character => ({ input: character, key, pasted }));
}

function PlanDashboardView({
  snapshot,
  onDone,
  onPlanTextChange,
}: {
  readonly snapshot: PlanDashboardSnapshot;
  readonly onDone: () => void;
  readonly onPlanTextChange?: (nextPlanText: string, previousPlanText: string) => void | Promise<void>;
}): React.ReactNode {
  const [editor, setEditor] = React.useState<EditorState>(() => ({
    planText: snapshot.planText ?? "",
    activeIndex: 0,
    editing: false,
    adding: false,
    draft: "",
  }));
  const { planText, activeIndex, editing, adding, draft } = editor;
  const sourceItems = React.useMemo(() => planSourceItems(planText), [planText]);
  const [notice, setNotice] = React.useState<string | undefined>();
  const saving = React.useRef(false);
  // Keys that share a stdin read all run before React re-renders. Each key
  // reads the state the previous one left here and mirrors it into `editor`
  // for rendering, the way useTextInput keeps its live value.
  const live = React.useRef(editor);
  // Keys that arrive while a save is in flight wait here and run in order
  // once it ends, as they would for a typist who pauses.
  const queued = React.useRef<Press[]>([]);
  const draining = React.useRef(false);
  const finished = React.useRef(false);
  const items: readonly { state: PlanItemState; text: string }[] = sourceItems.length > 0
    ? sourceItems
    : [{ state: "pending", text: "No plan written yet." }];
  const visibleItems = adding
    ? [...items.slice(0, activeIndex), { state: "pending" as const, text: "new plan step" }, ...items.slice(activeIndex)]
    : items;
  const windowStart = Math.max(0, activeIndex - 11);

  React.useLayoutEffect(() => {
    finished.current = false;
    return () => {
      finished.current = true;
      queued.current = [];
    };
  }, []);

  const update = (patch: Partial<EditorState>): void => {
    live.current = { ...live.current, ...patch };
    setEditor(live.current);
  };

  const close = (): void => {
    finished.current = true;
    queued.current = [];
    onDone();
  };

  const persistPlan = async (nextPlanText: string): Promise<void> => {
    if (saving.current) return;
    saving.current = true;
    setNotice("saving plan");
    try {
      await onPlanTextChange?.(nextPlanText, live.current.planText);
      if (finished.current) return;
      update({
        planText: nextPlanText,
        activeIndex: Math.min(live.current.activeIndex, Math.max(0, planSourceItems(nextPlanText).length - 1)),
        editing: false,
        adding: false,
      });
      setNotice("plan updated");
    } catch (error) {
      if (finished.current) return;
      setNotice(`Failed to save plan: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      saving.current = false;
    }
    runQueued();
  };

  const commitDraft = (): void => {
    const state = live.current;
    if (state.draft.trim().length === 0) return;
    const entries = planSourceItems(state.planText);
    const entry = entries[state.activeIndex];
    if (state.adding || entry === undefined) {
      const previous = state.adding ? entries[state.activeIndex - 1] : undefined;
      const at = previous?.lineEnd ?? state.planText.length;
      const newline = previous?.newline || state.planText.match(/\r\n|\n|\r/u)?.[0] || "\n";
      const separator = at > 0 && !/[\r\n]$/u.test(state.planText.slice(0, at)) ? newline : "";
      void persistPlan(`${state.planText.slice(0, at)}${separator}- [ ] ${state.draft}${newline}${state.planText.slice(at)}`);
    } else {
      void persistPlan(`${state.planText.slice(0, entry.start)}${state.draft}${state.planText.slice(entry.end)}`);
    }
  };

  const press = ({ input, key, pasted }: Press): void => {
    const state = live.current;
    // A paste is text, even when it consists of one command character. Keep
    // that distinction while queued so it is interpreted in the right mode.
    if (pasted) {
      if (state.editing) update({ draft: `${state.draft}${input}` });
      return;
    }
    if (state.editing) {
      if (key.escape) {
        update(state.adding
          ? { activeIndex: Math.max(0, state.activeIndex - 1), adding: false, editing: false }
          : { editing: false });
        return;
      }
      if (key.return) {
        commitDraft();
        return;
      }
      if (key.backspace || key.delete) {
        update({ draft: state.draft.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        update({ draft: `${state.draft}${input}` });
      }
      return;
    }

    if (key.escape || input === "q") {
      close();
      return;
    }
    if (key.upArrow || input === "k") {
      update({ activeIndex: Math.max(0, state.activeIndex - 1) });
      return;
    }
    const entries = planSourceItems(state.planText);
    const count = Math.max(1, entries.length);
    if (key.downArrow || input === "j") {
      update({ activeIndex: Math.min(count - 1, state.activeIndex + 1) });
      return;
    }
    if (input === "e") {
      update({ draft: entries[state.activeIndex]?.text ?? "", editing: true });
      return;
    }
    if (input === "d" && count > 1) {
      const entry = entries[state.activeIndex];
      if (entry !== undefined) void persistPlan(`${state.planText.slice(0, entry.lineStart)}${state.planText.slice(entry.lineEnd)}`);
      return;
    }
    if (input === "a") {
      update({ adding: true, activeIndex: state.activeIndex + 1, draft: "new plan step", editing: true });
      return;
    }
    if (key.return) close();
  };

  const runQueued = (): void => {
    // A save callback can throw synchronously and try to resume this drain
    // before it has consumed the triggering key.
    if (draining.current) return;
    draining.current = true;
    const pending = queued.current;
    let done = 0;
    try {
      while (done < pending.length && !saving.current && !finished.current) {
        press(pending[done++]!);
      }
    } finally {
      queued.current = finished.current ? [] : pending.slice(done);
      draining.current = false;
    }
  };

  useInput((input, key, event) => {
    if (finished.current) return;
    for (const next of pressesFor(input, key, event.keypress.isPasted)) queued.current.push(next);
    runQueued();
  });

  return (
    <Popup
      title="plan mode · full plan"
      status="e edit · d delete · a add · ↵ close"
      accentColor="worker"
      bodyBackgroundColor="planModeWash"
      footer={[
        { keyName: "e", label: "edit step" },
        { keyName: "d", label: "delete" },
        { keyName: "a", label: "add" },
        { keyName: "↵", label: "close" },
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
            {visibleItems.slice(windowStart, windowStart + 12).map((item, localIndex) => {
              const index = localIndex + windowStart;
              const active = index === activeIndex;
              const glyph = AURA_PLAN_GLYPHS[item.state];
              const text = active && editing ? `${draft}█` : compact(item.text);
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
                    <ThemedText color={active ? "agenc" : "text2"} wrap={active && editing ? "truncate-start" : "truncate-end"}>
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
    readonly onPlanTextChange?: (nextPlanText: string, previousPlanText: string) => void | Promise<void>;
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
