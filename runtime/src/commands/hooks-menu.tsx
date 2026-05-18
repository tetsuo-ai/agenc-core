import React from "react";

import { HOOK_EVENT_NAMES, type HookEventName } from "../config/schema.js";
import type {
  ConfiguredHooksRuntime,
  IndividualHookConfig,
} from "../hooks/configured-hooks.js";
import {
  groupHooksByEvent,
  hookDisplayText,
} from "../hooks/configured-hooks.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

type HookRowStatus = "active" | "empty" | "disabled" | "issue";

type HookEventRow = {
  readonly event: HookEventName;
  readonly count: number;
  readonly status: HookRowStatus;
  readonly matcher: string;
  readonly detail: string;
  readonly hooks: readonly IndividualHookConfig[];
};

function hookEventSummary(event: HookEventName): {
  readonly matcher: string;
  readonly summary: string;
} {
  switch (event) {
    case "PreToolUse":
      return { matcher: "tool_name", summary: "before tool execution" };
    case "PostToolUse":
      return { matcher: "tool_name", summary: "after tool execution" };
    case "PostToolUseFailure":
      return { matcher: "tool_name", summary: "after tool failure" };
    case "PermissionRequest":
      return { matcher: "tool_name", summary: "permission dialog" };
    case "UserPromptSubmit":
      return { matcher: "-", summary: "prompt submission" };
    case "SessionStart":
      return { matcher: "source", summary: "session start" };
    case "Stop":
      return { matcher: "-", summary: "response stop" };
    case "StopFailure":
      return { matcher: "error", summary: "turn API failure" };
    case "PreCompact":
      return { matcher: "trigger", summary: "before compaction" };
    case "PostCompact":
      return { matcher: "trigger", summary: "after compaction" };
  }
}

function statusColor(status: HookRowStatus): "success" | "inactive" | "error" | "agenc" {
  switch (status) {
    case "active":
      return "success";
    case "issue":
      return "error";
    case "disabled":
      return "inactive";
    case "empty":
      return "agenc";
  }
}

function statusGlyph(status: HookRowStatus): string {
  switch (status) {
    case "active":
      return "◆";
    case "issue":
      return "!";
    case "disabled":
      return "◇";
    case "empty":
      return "·";
  }
}

function hookRows(runtime: ConfiguredHooksRuntime): readonly HookEventRow[] {
  const grouped = groupHooksByEvent(runtime.listHooks());
  const hasIssues = runtime.issues().length > 0;
  return HOOK_EVENT_NAMES.map((event) => {
    const hooks = grouped.get(event) ?? [];
    const meta = hookEventSummary(event);
    const firstHook = hooks[0];
    const status: HookRowStatus = runtime.isDisabled()
      ? "disabled"
      : hasIssues
        ? "issue"
        : hooks.length > 0
          ? "active"
          : "empty";
    return {
      event,
      count: hooks.length,
      status,
      matcher: meta.matcher,
      detail: firstHook ? hookDisplayText(firstHook) : meta.summary,
      hooks,
    };
  });
}

function HooksMenuView({
  runtime,
  onDone,
}: {
  readonly runtime: ConfiguredHooksRuntime;
  readonly onDone: () => void;
}): React.ReactNode {
  const rows = React.useMemo(() => hookRows(runtime), [runtime]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const issues = runtime.issues();

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

  const selected = rows[activeIndex] ?? rows[0];
  return (
    <MenuModal
      title="hooks"
      count={`${runtime.listHooks().length}`}
      summary={runtime.isDisabled() ? "disabled" : issues.length === 0 ? "validation ok" : `${issues.length} issue(s)`}
      headerRight="config"
      columns={[3, 13, 22, 8, 14, 40]}
      headers={["", "status", "event", "count", "matcher", "detail"]}
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
          <ThemedText key="event" color={active ? "agenc" : "text2"} wrap="truncate-end">
            {row.event}
          </ThemedText>,
          <ThemedText key="count" color="subtle">
            {String(row.count)}
          </ThemedText>,
          <ThemedText key="matcher" color="inactive" wrap="truncate-end">
            {row.matcher}
          </ThemedText>,
          <ThemedText key="detail" color="subtle" wrap="truncate-end">
            {row.detail}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Hook Configuration</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Source: {runtime.sourcePath()}
          </ThemedText>
          <ThemedText color={issues.length === 0 ? "success" : "error"} wrap="wrap">
            Validation: {issues.length === 0 ? "ok" : `${issues.length} issue(s)`}
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Event: {selected?.event ?? "none"}
          </ThemedText>
          {(selected?.hooks ?? []).slice(0, 6).map(hook => (
            <ThemedText key={`${hook.event}-${hook.index}`} color="text2" wrap="truncate-end">
              #{hook.index} {hook.matcher ? `[${hook.matcher}] ` : ""}{hookDisplayText(hook)}
            </ThemedText>
          ))}
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "q", label: "close" },
      ]}
      hint="/hooks show <event> [index]"
    />
  );
}

export function openHooksMenu(
  ctx: SlashCommandContext,
  runtime: ConfiguredHooksRuntime,
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
    jsx: <HooksMenuView runtime={runtime} onDone={close} />,
  });
  return true;
}
