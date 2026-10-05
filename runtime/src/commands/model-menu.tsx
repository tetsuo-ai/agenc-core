import React from "react";
import type { ProviderSlug } from "../config/provider-model-authority.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";
import type { ModelRowStatus, ModelMenuSnapshot, ModelMenuSelectionResult } from "./model-menu-snapshot.js";
export { readModelMenuSnapshot, modelMenuFallback, type ModelMenuSnapshot, type ModelMenuSelectionResult } from "./model-menu-snapshot.js";

function statusColor(
  status: ModelRowStatus,
): "success" | "agenc" | "worker" | "inactive" | "warning" {
  switch (status) {
    case "current":
      return "success";
    case "configured":
      return "agenc";
    case "default":
      return "worker";
    case "available":
      return "inactive";
    case "unavailable":
      return "warning";
  }
}

function statusGlyph(status: ModelRowStatus): string {
  switch (status) {
    case "current":
      return "◆";
    case "configured":
      return "●";
    case "default":
      return "◇";
    case "available":
      return "·";
    case "unavailable":
      return "!";
  }
}

function modelSwitchMessage(message: string): boolean {
  return (
    message.startsWith("Model switch") ||
    message.startsWith("Model switched")
  );
}

function ModelMenuView({
  snapshot,
  onDone,
  onSelect,
}: {
  readonly snapshot: ModelMenuSnapshot;
  readonly onDone: () => void;
  readonly onSelect: (provider: ProviderSlug, model: string) => Promise<ModelMenuSelectionResult>;
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
      if (!row.selectable) {
        setMessage(`${row.provider}: no models configured. Use /provider or config to add a default model.`);
        return;
      }
      setBusy(true);
      setMessage("Switching model...");
      void onSelect(row.provider, row.model).then(
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
  const selectedCount =
    selected === undefined ? 0 : snapshot.providerCounts[selected.provider] ?? 0;
  return (
    <MenuModal
      title="model"
      count={`${rows.length}`}
      summary={`active ${snapshot.provider} / ${snapshot.currentModel} · managed ${snapshot.managedKeysEnabled ? "on" : "off"}`}
      headerRight={busy ? "switching" : "live"}
      columns={[3, 13, 15, 34, 12, 34]}
      headers={["", "status", "provider", "model", "group", "detail"]}
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
          <ThemedText key="provider" color={row.provider === snapshot.provider ? "success" : "subtle"} wrap="truncate-end">
            {row.provider}
          </ThemedText>,
          <ThemedText key="model" color={active ? "agenc" : "text2"} wrap="truncate-middle">
            {row.displayModel}
          </ThemedText>,
          <ThemedText key="group" color="inactive" wrap="truncate-end">
            {row.groupLabel}
          </ThemedText>,
          <ThemedText key="detail" color="subtle" wrap="truncate-end">
            {row.detail}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Model Route</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Empty /model opens this provider-grouped catalog. Use /provider to
            inspect credentials and provider auth state.
          </ThemedText>
          <ThemedText color={snapshot.managedKeysEnabled ? "success" : "warning"} wrap="wrap">
            Managed keys: {snapshot.managedKeysEnabled ? "on" : "off"}. Paid accounts can use
            subscription-managed provider keys when no BYOK key is set.
          </ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Pro hosted models appear under OpenRouter. Other providers are BYOK
            or local routes unless they show hosted subscription detail.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.provider ?? snapshot.provider}:{selected?.displayModel ?? snapshot.currentModel}
          </ThemedText>
          {selected ? (
            <>
              <ThemedText color={statusColor(selected.status)} wrap="wrap">
                {selected.status}: {selected.detail}
              </ThemedText>
              <ThemedText color="inactive" wrap="wrap">
                provider models: {selectedCount > 0 ? selectedCount : "none"}
              </ThemedText>
              {!selected.selectable ? (
                <ThemedText color="warning" wrap="wrap">
                  No models are available for this provider. Configure a default model
                  or switch providers first.
                </ThemedText>
              ) : null}
            </>
          ) : null}
          {message ? (
            <ThemedText
              color={modelSwitchMessage(message) ? "success" : "error"}
              wrap="wrap"
            >
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
      hint="provider:model catalog"
    />
  );
}

export function openModelMenu(
  ctx: SlashCommandContext,
  snapshot: ModelMenuSnapshot,
  onSelect: (provider: ProviderSlug, model: string) => Promise<ModelMenuSelectionResult>,
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <ModelMenuView snapshot={snapshot} onDone={close} onSelect={onSelect} />
  ));
}
