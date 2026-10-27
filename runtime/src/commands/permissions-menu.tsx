import React from "react";

import {
  PERMISSION_RULE_SOURCES,
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionRuleSource,
  type ToolPermissionContext,
} from "../permissions/types.js";
import {
  permissionModePlainDescription,
  permissionModePlainLabel,
} from "../permissions/mode-display.js";
import { canonicalizeBypassPermissionsCwd } from "../permissions/bypass-consent-state.js";
import { useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

type PermissionMenuActionResult = {
  readonly ok: boolean;
  readonly message: string;
  readonly nextMode?: PermissionMode;
};

export type PermissionsMenuController = {
  readonly setMode: (mode: PermissionMode) => Promise<PermissionMenuActionResult>;
  readonly acceptBypass: () => Promise<PermissionMenuActionResult>;
};

type PermissionRow =
  | {
      readonly kind: "mode";
      readonly mode: PermissionMode;
      readonly behavior: "mode";
      readonly source: "runtime";
      readonly count: number;
      readonly detail: string;
    }
  | {
      readonly kind: "rule";
      readonly behavior: PermissionBehavior;
      readonly source: PermissionRuleSource;
      readonly count: number;
      readonly detail: string;
    }
  | {
      readonly kind: "directory";
      readonly behavior: "directory";
      readonly source: "workspace";
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

/** Everyday modes first; the two advanced ones follow. */
const MODE_ORDER: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
];

function permissionRows(ctx: ToolPermissionContext): readonly PermissionRow[] {
  const addressable = new Set<PermissionMode>(USER_ADDRESSABLE_PERMISSION_MODES);
  return MODE_ORDER.filter(mode => addressable.has(mode)).map(mode => ({
    kind: "mode" as const,
    mode,
    behavior: "mode" as const,
    source: "runtime" as const,
    count: mode === ctx.mode ? 1 : 0,
    detail: permissionModePlainDescription(mode),
  }));
}

function ruleCounts(ctx: ToolPermissionContext): { allow: number; deny: number; ask: number } {
  const count = (behavior: PermissionBehavior): number =>
    PERMISSION_RULE_SOURCES.reduce((total, source) => total + rulesFor(ctx, behavior, source).length, 0);
  return { allow: count("allow"), deny: count("deny"), ask: count("ask") };
}

function bypassAccepted(ctx: ToolPermissionContext, workspacePath: string): boolean {
  try {
    return ctx.bypassPermissionsAcceptedIn?.includes(
      canonicalizeBypassPermissionsCwd(workspacePath),
    ) === true;
  } catch {
    return false;
  }
}

function PermissionsMenuView({
  permissionContext,
  workspacePath,
  controller,
  onDone,
}: {
  readonly permissionContext: ToolPermissionContext;
  readonly workspacePath: string;
  readonly controller?: PermissionsMenuController;
  readonly onDone: () => void;
}): React.ReactNode {
  const rows = React.useMemo(() => permissionRows(permissionContext), [permissionContext]);
  const displayRows =
    rows.length > 0
      ? rows
      : [{
          kind: "rule" as const,
          behavior: "ask" as const,
          source: "session" as const,
          count: 0,
          detail: "No permission rules configured.",
        }];
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [mode, setMode] = React.useState<PermissionMode>(permissionContext.mode);
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const applyMode = React.useCallback((target: PermissionMode) => {
    if (!controller) {
      setMessage("Mode changes require a live permission controller.");
      return;
    }
    setBusy(true);
    setMessage(`Switching to ${permissionModePlainLabel(target)}...`);
    void controller.setMode(target).then(
      result => {
        setBusy(false);
        setMessage(result.message);
        if (result.ok && result.nextMode !== undefined) setMode(result.nextMode);
      },
      error => {
        setBusy(false);
        setMessage(error instanceof Error ? error.message : String(error));
      },
    );
  }, [controller]);

  const acceptAndApplyRiskyMode = React.useCallback((target: PermissionMode) => {
    if (!controller) {
      setMessage("Bypass confirmation requires a live permission controller.");
      return;
    }
    setBusy(true);
    setMessage("Recording workspace consent...");
    void controller.acceptBypass().then(
      accept => {
        if (!accept.ok) {
          setBusy(false);
          setMessage(accept.message);
          return;
        }
        void controller.setMode(target).then(
          result => {
            setBusy(false);
            setMessage(`${accept.message}\n${result.message}`);
            if (result.ok && result.nextMode !== undefined) setMode(result.nextMode);
          },
          error => {
            setBusy(false);
            setMessage(error instanceof Error ? error.message : String(error));
          },
        );
      },
      error => {
        setBusy(false);
        setMessage(error instanceof Error ? error.message : String(error));
      },
    );
  }, [controller]);

  useInput((input, key) => {
    if (busy) return;
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
      return;
    }
    if (key.return) {
      const selectedRow = displayRows[activeIndex];
      if (selectedRow?.kind !== "mode") return;
      if (
        (selectedRow.mode === "bypassPermissions" || selectedRow.mode === "dontAsk") &&
        !bypassAccepted(permissionContext, workspacePath)
      ) {
        acceptAndApplyRiskyMode(selectedRow.mode);
        return;
      }
      applyMode(selectedRow.mode);
    }
  });


  const rules = ruleCounts(permissionContext);
  const ruleParts = [
    rules.allow > 0 ? `${rules.allow} allow` : null,
    rules.deny > 0 ? `${rules.deny} deny` : null,
    rules.ask > 0 ? `${rules.ask} ask` : null,
  ].filter((part): part is string => part !== null);
  const extraFolders = permissionContext.additionalWorkingDirectories.size;
  return (
    <MenuModal
      title="permissions"
      summary={permissionModePlainLabel(mode)}
      columns={[2, 14, 56]}
      headers={["", "mode", "how much can the agent do without asking?"]}
      items={displayRows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => {
        const current = row.kind === "mode" && row.mode === mode;
        const risky = row.kind === "mode" && (row.mode === "bypassPermissions" || row.mode === "dontAsk");
        const advanced = row.kind === "mode" && (row.mode === "dontAsk" || row.mode === "auto");
        const nameColor = current ? "success" : risky ? "error" : advanced ? "subtle" : "text";
        return [
          <ThemedText key="mark" color={current ? "success" : "subtle"}>
            {current ? "●" : " "}
          </ThemedText>,
          <ThemedText key="name" color={nameColor} bold={active} wrap="truncate-end">
            {row.kind === "mode" ? permissionModePlainLabel(row.mode) : row.behavior}
          </ThemedText>,
          <ThemedText key="detail" color={risky && active ? "error" : active ? "text" : "subtle"} wrap="truncate-end">
            {row.detail}
          </ThemedText>,
        ];
      }}
      footer={[
        { keyName: "↑↓", label: "choose" },
        { keyName: "enter", label: "apply" },
        { keyName: "esc", label: "close" },
      ]}
      hint={message ?? `${ruleParts.length > 0 ? `rules: ${ruleParts.join(", ")}` : "no custom rules"}${extraFolders > 0 ? ` · extra folders: ${extraFolders}` : ""} · /permissions add|remove`}
    />
  );
}

export function openPermissionsMenu(
  ctx: SlashCommandContext,
  permissionContext: ToolPermissionContext,
  controller?: PermissionsMenuController,
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <PermissionsMenuView
      permissionContext={permissionContext}
      workspacePath={ctx.cwd}
      controller={controller}
      onDone={close}
    />
  ));
}
