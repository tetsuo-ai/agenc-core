import React from "react";

import {
  PERMISSION_BEHAVIORS,
  PERMISSION_RULE_SOURCES,
  type PermissionBehavior,
  type PermissionRuleSource,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

type PermissionRow = {
  readonly behavior: PermissionBehavior | "directory";
  readonly source: PermissionRuleSource | "workspace";
  readonly count: number;
  readonly detail: string;
};

function rulesFor(
  ctx: ToolPermissionContext,
  behavior: PermissionBehavior,
  source: PermissionRuleSource,
): readonly string[] {
  const bucket =
    behavior === "allow"
      ? ctx.alwaysAllowRules
      : behavior === "deny"
        ? ctx.alwaysDenyRules
        : ctx.alwaysAskRules;
  return bucket[source] ?? [];
}

function permissionRows(ctx: ToolPermissionContext): readonly PermissionRow[] {
  const rows: PermissionRow[] = [];
  for (const behavior of PERMISSION_BEHAVIORS) {
    for (const source of PERMISSION_RULE_SOURCES) {
      const rules = rulesFor(ctx, behavior, source);
      if (rules.length === 0) continue;
      rows.push({
        behavior,
        source,
        count: rules.length,
        detail: rules.slice(0, 3).join(", "),
      });
    }
  }
  if (ctx.additionalWorkingDirectories.size > 0) {
    rows.push({
      behavior: "directory",
      source: "workspace",
      count: ctx.additionalWorkingDirectories.size,
      detail: [...ctx.additionalWorkingDirectories.values()]
        .slice(0, 3)
        .map(entry => entry.path)
        .join(", "),
    });
  }
  return rows;
}

function behaviorColor(behavior: PermissionRow["behavior"]): "success" | "error" | "worker" | "agenc" {
  switch (behavior) {
    case "allow":
      return "success";
    case "deny":
      return "error";
    case "ask":
      return "worker";
    case "directory":
      return "agenc";
  }
}

function behaviorGlyph(behavior: PermissionRow["behavior"]): string {
  switch (behavior) {
    case "allow":
      return "◆";
    case "deny":
      return "!";
    case "ask":
      return "?";
    case "directory":
      return "◇";
  }
}

function PermissionsMenuView({
  permissionContext,
  onDone,
}: {
  readonly permissionContext: ToolPermissionContext;
  readonly onDone: () => void;
}): React.ReactNode {
  const rows = React.useMemo(() => permissionRows(permissionContext), [permissionContext]);
  const displayRows =
    rows.length > 0
      ? rows
      : [{
          behavior: "ask" as const,
          source: "session" as const,
          count: 0,
          detail: "No permission rules configured.",
        }];
  const [activeIndex, setActiveIndex] = React.useState(0);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone();
      return;
    }
    if (key.upArrow || input === "k") {
      setActiveIndex(index => previousMenuIndex(index, displayRows.length));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex(index => nextMenuIndex(index, displayRows.length));
    }
  });

  const selected = displayRows[activeIndex] ?? displayRows[0];
  return (
    <MenuModal
      title="permissions"
      count={`${rows.reduce((total, row) => total + row.count, 0)}`}
      summary={`mode ${permissionContext.mode}`}
      headerRight={permissionContext.isBypassPermissionsModeAvailable ? "bypass available" : "guarded"}
      columns={[3, 14, 18, 8, 64]}
      headers={["", "behavior", "source", "count", "rules"]}
      items={displayRows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => {
        const color = behaviorColor(row.behavior);
        return [
          <ThemedText key="mark" color={color}>
            {behaviorGlyph(row.behavior)}
          </ThemedText>,
          <ThemedText key="behavior" color={color} wrap="truncate-end">
            {row.behavior}
          </ThemedText>,
          <ThemedText key="source" color={active ? "agenc" : "text2"} wrap="truncate-end">
            {row.source}
          </ThemedText>,
          <ThemedText key="count" color="subtle">
            {String(row.count)}
          </ThemedText>,
          <ThemedText key="detail" color="subtle" wrap="truncate-end">
            {row.detail}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Permission Rules</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Mode changes use /permissions mode. Rule updates use /permissions add or
            /permissions remove.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.behavior ?? "none"} / {selected?.source ?? "none"}
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Extra directories: {permissionContext.additionalWorkingDirectories.size}
          </ThemedText>
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "q", label: "close" },
      ]}
      hint="/permissions add|remove|mode"
    />
  );
}

export function openPermissionsMenu(
  ctx: SlashCommandContext,
  permissionContext: ToolPermissionContext,
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
    jsx: <PermissionsMenuView permissionContext={permissionContext} onDone={close} />,
  });
  return true;
}
