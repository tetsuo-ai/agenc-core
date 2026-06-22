import React from "react";

import {
  PERMISSION_BEHAVIORS,
  PERMISSION_RULE_SOURCES,
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionRuleSource,
  type ToolPermissionContext,
} from "../permissions/types.js";
import {
  permissionModeShortTitle,
  permissionModeTitle,
} from "../permissions/mode-display.js";
import { Box, useInput } from "../tui/ink.js";
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

function modeDescription(mode: PermissionMode): string {
  switch (mode) {
    case "default":
      return "ask for ambiguous tools";
    case "acceptEdits":
      return "auto-accept file edits";
    case "plan":
      return "read-only planning";
    case "bypassPermissions":
      return "DANGER: bypass approvals";
    case "dontAsk":
      return "suppress prompts";
    case "auto":
      return "auto-approve allowlisted tools";
    case "unattended":
      return "background-agent mode";
    case "bubble":
      return "nested permission bubbling";
  }
}

function permissionRows(ctx: ToolPermissionContext): readonly PermissionRow[] {
  const rows: PermissionRow[] = [];
  for (const mode of USER_ADDRESSABLE_PERMISSION_MODES) {
    rows.push({
      kind: "mode",
      mode,
      behavior: "mode",
      source: "runtime",
      count: mode === ctx.mode ? 1 : 0,
      detail: modeDescription(mode),
    });
  }
  for (const behavior of PERMISSION_BEHAVIORS) {
    for (const source of PERMISSION_RULE_SOURCES) {
      const rules = rulesFor(ctx, behavior, source);
      if (rules.length === 0) continue;
      rows.push({
        kind: "rule",
        behavior,
        source,
        count: rules.length,
        detail: rules.slice(0, 3).join(", "),
      });
    }
  }
  if (ctx.additionalWorkingDirectories.size > 0) {
    rows.push({
      kind: "directory",
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

function behaviorColor(
  row: PermissionRow,
  currentMode: PermissionMode,
): "success" | "error" | "worker" | "agenc" | "planMode" | "inactive" | "warning" {
  if (row.kind === "mode") {
    if (row.mode === currentMode) return "success";
    if (row.mode === "bypassPermissions" || row.mode === "dontAsk") return "error";
    if (row.mode === "plan") return "planMode";
    if (row.mode === "auto" || row.mode === "acceptEdits") return "warning";
    return "inactive";
  }
  switch (row.behavior) {
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

function behaviorGlyph(row: PermissionRow, currentMode: PermissionMode): string {
  if (row.kind === "mode") {
    if (row.mode === currentMode) return "◆";
    if (row.mode === "bypassPermissions") return "!";
    return "◇";
  }
  switch (row.behavior) {
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

function bypassAccepted(ctx: ToolPermissionContext, workspacePath: string): boolean {
  return ctx.bypassPermissionsAcceptedIn?.includes(workspacePath) === true;
}

function ConfirmBypassView({
  buffer,
  message,
}: {
  readonly buffer: string;
  readonly message: string | null;
}): React.ReactNode {
  return (
    <MenuModal
      title="permissions"
      count="bypass"
      summary="explicit confirmation required"
      headerRight="danger"
      columns={[18, 60]}
      headers={["field", "value"]}
      items={[
        { field: "target", value: "bypassPermissions" },
        { field: "required", value: "type bypass" },
        { field: "typed", value: buffer.length > 0 ? buffer : "(empty)" },
      ]}
      activeIndex={1}
      renderRow={(row) => [
        <ThemedText key="field" color="inactive" wrap="truncate-end">
          {row.field}
        </ThemedText>,
        <ThemedText key="value" color={row.field === "target" ? "error" : "text2"} wrap="truncate-end">
          {row.value}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="error">Bypass Permissions</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            This mode bypasses approval prompts for this workspace. It must be
            confirmed before the mode switch is applied.
          </ThemedText>
          {message ? (
            <ThemedText color="warning" wrap="wrap">
              {message}
            </ThemedText>
          ) : null}
        </Box>
      }
      footer={[
        { keyName: "type", label: "bypass" },
        { keyName: "enter", label: "confirm" },
        { keyName: "esc", label: "cancel" },
      ]}
      hint="risky mode confirmation"
    />
  );
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
  const [confirmBypass, setConfirmBypass] = React.useState(false);
  const [confirmBuffer, setConfirmBuffer] = React.useState("");

  const applyMode = React.useCallback((target: PermissionMode) => {
    if (!controller) {
      setMessage("Mode changes require a live permission controller.");
      return;
    }
    setBusy(true);
    setMessage(`Switching mode to ${target}...`);
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

  const confirmAndApplyBypass = React.useCallback(() => {
    if (!controller) {
      setMessage("Bypass confirmation requires a live permission controller.");
      setConfirmBypass(false);
      return;
    }
    setBusy(true);
    setMessage("Recording bypass confirmation...");
    void controller.acceptBypass().then(
      accept => {
        if (!accept.ok) {
          setBusy(false);
          setMessage(accept.message);
          return;
        }
        void controller.setMode("bypassPermissions").then(
          result => {
            setBusy(false);
            setConfirmBypass(false);
            setConfirmBuffer("");
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
    if (confirmBypass) {
      if (key.escape) {
        setConfirmBypass(false);
        setConfirmBuffer("");
        return;
      }
      if (key.backspace || key.delete) {
        setConfirmBuffer(value => value.slice(0, -1));
        return;
      }
      if (key.return) {
        if (confirmBuffer === "bypass") {
          confirmAndApplyBypass();
        } else {
          setMessage('Type "bypass" exactly to confirm bypassPermissions.');
        }
        return;
      }
      if (input.length > 0) {
        setConfirmBuffer(value => `${value}${input}`.slice(0, 16));
      }
      return;
    }

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
    if (input === "b") {
      setConfirmBypass(true);
      setConfirmBuffer("");
      setMessage("Type bypass to confirm bypassPermissions.");
      return;
    }
    if (key.return) {
      const selectedRow = displayRows[activeIndex];
      if (selectedRow?.kind !== "mode") return;
      if (
        selectedRow.mode === "bypassPermissions" &&
        !bypassAccepted(permissionContext, workspacePath)
      ) {
        setConfirmBypass(true);
        setConfirmBuffer("");
        setMessage("Type bypass to confirm bypassPermissions.");
        return;
      }
      applyMode(selectedRow.mode);
    }
  });

  if (confirmBypass) {
    return <ConfirmBypassView buffer={confirmBuffer} message={message} />;
  }

  const selected = displayRows[activeIndex] ?? displayRows[0];
  const totalRules = rows
    .filter(row => row.kind !== "mode")
    .reduce((total, row) => total + row.count, 0);
  return (
    <MenuModal
      title="permissions"
      count={`${totalRules}`}
      summary={`mode ${mode}`}
      headerRight={permissionContext.isBypassPermissionsModeAvailable ? "bypass available" : "guarded"}
      columns={[3, 16, 18, 8, 64]}
      headers={["", "behavior", "source", "count", "rules"]}
      items={displayRows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => {
        const color = behaviorColor(row, mode);
        return [
          <ThemedText key="mark" color={color}>
            {behaviorGlyph(row, mode)}
          </ThemedText>,
          <ThemedText key="behavior" color={color} wrap="truncate-end">
            {row.kind === "mode" ? row.mode : row.behavior}
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
            Mode changes, rules, workspace trust, and bypass confirmation stay
            on this v2 surface. Rule edits use /permissions add or remove.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Current mode: {permissionModeTitle(mode)} ({permissionModeShortTitle(mode)})
          </ThemedText>
          <ThemedText color={selected?.kind === "mode" ? behaviorColor(selected, mode) : "subtle"} wrap="wrap">
            Selected: {selected?.kind === "mode" ? selected.mode : selected?.behavior ?? "none"} / {selected?.source ?? "none"}
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Extra directories: {permissionContext.additionalWorkingDirectories.size}
          </ThemedText>
          {mode === "bypassPermissions" ? (
            <ThemedText color="error" wrap="wrap">
              bypassPermissions is active. Risky actions are no longer prompted.
            </ThemedText>
          ) : null}
          {message ? (
            <ThemedText color={message.startsWith("Mode:") || message.includes("accepted") ? "success" : "warning"} wrap="wrap">
              {message}
            </ThemedText>
          ) : null}
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "enter", label: "set mode" },
        { keyName: "b", label: "confirm bypass" },
        { keyName: "q", label: "close" },
      ]}
      hint="/permissions add|remove|mode"
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
