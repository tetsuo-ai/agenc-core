import React from "react";
import type { ProviderSlug } from "../config/provider-model-authority.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";
import type { ProviderAuthState, ProviderRuntimeState, ProviderMenuRow, ProviderMenuSnapshot, ProviderMenuSelectionResult } from "./provider-menu-snapshot.js";
export { readProviderMenuSnapshot, providerMenuFallback, type ProviderMenuSnapshot, type ProviderMenuSelectionResult } from "./provider-menu-snapshot.js";

type ProviderColor =
  | "success"
  | "agenc"
  | "inactive"
  | "error"
  | "warning"
  | "text2"
  | "subtle";

function statusColor(state: ProviderRuntimeState): ProviderColor {
  switch (state) {
    case "active":
      return "success";
    case "local":
      return "inactive";
    case "available":
      return "agenc";
    case "unverified":
      return "warning";
    case "unauthenticated":
      return "warning";
    case "unavailable":
      return "inactive";
    case "error":
      return "error";
  }
}

function statusGlyph(state: ProviderRuntimeState): string {
  switch (state) {
    case "active":
      return "◆";
    case "local":
      return "○";
    case "available":
      return "●";
    case "unverified":
      return "?";
    case "unauthenticated":
      return "!";
    case "unavailable":
      return "◇";
    case "error":
      return "×";
  }
}

function authColor(state: ProviderAuthState): ProviderColor {
  switch (state) {
    case "managed":
      return "agenc";
    case "ready":
      return "success";
    case "missing":
      return "warning";
    case "optional":
      return "inactive";
  }
}

type DetailRow = {
  readonly key: string;
  readonly value: string;
  readonly color?: ProviderColor;
};

function successMessage(message: string): boolean {
  return (
    message.startsWith("Provider switch") ||
    message.startsWith("Provider switched")
  );
}

function ProviderDetailView({
  row,
  snapshot,
  message,
  busy,
}: {
  readonly row: ProviderMenuRow;
  readonly snapshot: ProviderMenuSnapshot;
  readonly message: string | null;
  readonly busy: boolean;
}): React.ReactNode {
  const models = row.models.length > 0 ? row.models : ["no models available"];
  const items: readonly DetailRow[] = [
    { key: "state", value: row.runtimeState, color: statusColor(row.runtimeState) },
    { key: "provider", value: `${row.name} (${row.provider})`, color: "text2" },
    { key: "active", value: row.status === "current" ? "yes" : "no" },
    { key: "model", value: row.model, color: "agenc" },
    { key: "auth", value: row.credentialSource, color: authColor(row.authState) },
    { key: "base url", value: row.baseURL },
    { key: "configured", value: row.configured ? "yes" : "no" },
    { key: "models", value: `${row.models.length}` },
    ...models.map((model, index) => ({
      key: index === 0 ? "catalog" : "",
      value: model,
      color: (row.models.length > 0 ? "subtle" : "inactive") as ProviderColor,
    })),
  ];

  return (
    <MenuModal
      title="provider detail"
      count={row.provider}
      summary={`${snapshot.currentProvider} / ${snapshot.currentModel}`}
      headerRight={busy ? "switching" : row.runtimeState}
      columns={[14, 64]}
      headers={["field", "value"]}
      items={items}
      activeIndex={0}
      renderRow={(item) => [
        <ThemedText key="field" color="inactive" wrap="truncate-end">
          {item.key}
        </ThemedText>,
        <ThemedText key="value" color={item.color ?? "subtle"} wrap="truncate-middle">
          {item.value}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Provider Detail</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            This is the v2 detail surface for the selected provider. It uses the
            same registry, config, and environment inputs as the runtime switch.
          </ThemedText>
          {row.error ? (
            <ThemedText color="error" wrap="wrap">
              {row.error}
            </ThemedText>
          ) : null}
          {message ? (
            <ThemedText color={successMessage(message) ? "success" : "error"} wrap="wrap">
              {message}
            </ThemedText>
          ) : null}
        </Box>
      }
      footer={[
        { keyName: "l", label: "list" },
        { keyName: "a", label: "auth" },
        { keyName: "q", label: "back" },
      ]}
      hint="provider registry detail"
    />
  );
}

function ProviderAuthView({
  row,
  snapshot,
  message,
}: {
  readonly row: ProviderMenuRow;
  readonly snapshot: ProviderMenuSnapshot;
  readonly message: string | null;
}): React.ReactNode {
  const items: readonly DetailRow[] = [
    { key: "state", value: row.authState, color: authColor(row.authState) },
    { key: "source", value: row.credentialSource, color: "text2" },
    { key: "provider", value: row.provider },
    { key: "model", value: row.model },
    { key: "base url", value: row.baseURL },
    {
      key: "next",
      value:
        row.authState === "missing"
          ? row.credentialSource
          : row.authState === "managed"
            ? "managed auth is selected for this provider; use /subscription to check plan"
            : "credential is available or optional",
      color: row.authState === "missing" ? "warning" : "subtle",
    },
  ];

  return (
    <MenuModal
      title="provider auth"
      count={row.provider}
      summary={`${snapshot.currentProvider} / ${snapshot.currentModel}`}
      headerRight={row.authState}
      columns={[14, 64]}
      headers={["field", "value"]}
      items={items}
      activeIndex={0}
      renderRow={(item) => [
        <ThemedText key="field" color="inactive" wrap="truncate-end">
          {item.key}
        </ThemedText>,
        <ThemedText key="value" color={item.color ?? "subtle"} wrap="truncate-middle">
          {item.value}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Credential State</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Auth stays registry/config driven. Missing credentials are shown here
            before a switch can be submitted.
          </ThemedText>
          {message ? (
            <ThemedText color="warning" wrap="wrap">
              {message}
            </ThemedText>
          ) : null}
        </Box>
      }
      footer={[
        { keyName: "l", label: "list" },
        { keyName: "d", label: "details" },
        { keyName: "q", label: "back" },
      ]}
      hint="credential visibility"
    />
  );
}

function ProviderMenuView({
  snapshot,
  onDone,
  onSelect,
}: {
  readonly snapshot: ProviderMenuSnapshot;
  readonly onDone: () => void;
  readonly onSelect: (provider: ProviderSlug, model: string) => Promise<ProviderMenuSelectionResult>;
}): React.ReactNode {
  const [activeIndex, setActiveIndex] = React.useState(snapshot.activeIndex);
  const [mode, setMode] = React.useState<"list" | "detail" | "auth">("list");
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const rows = snapshot.rows;

  useInput((input, key) => {
    if (busy) return;
    if (key.escape || input === "q") {
      if (mode === "list") {
        onDone();
      } else {
        setMode("list");
      }
      return;
    }
    if (input === "l") {
      setMode("list");
      return;
    }
    if (input === "d" || key.rightArrow) {
      setMode("detail");
      return;
    }
    if (input === "a") {
      setMode("auth");
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
      if (row.runtimeState === "error" || row.runtimeState === "unavailable") {
        setMessage(`${row.provider}: ${row.detail}`);
        return;
      }
      if (row.runtimeState === "unauthenticated") {
        setMode("auth");
        setMessage(`${row.provider}: ${row.credentialSource}`);
        return;
      }
      setBusy(true);
      setMessage("Switching provider...");
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
  if (mode === "detail" && selected !== undefined) {
    return (
      <ProviderDetailView
        row={selected}
        snapshot={snapshot}
        message={message}
        busy={busy}
      />
    );
  }
  if (mode === "auth" && selected !== undefined) {
    return (
      <ProviderAuthView
        row={selected}
        snapshot={snapshot}
        message={message}
      />
    );
  }

  return (
    <MenuModal
      title="provider"
      count={`${rows.length}`}
      summary={`${snapshot.currentProvider} / ${snapshot.currentModel}`}
      headerRight={busy ? "switching" : "live"}
      columns={[3, 16, 18, 28, 20, 9, 22]}
      headers={["", "state", "provider", "model", "auth", "models", "detail"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => {
        const color = statusColor(row.runtimeState);
        return [
          <ThemedText key="mark" color={color}>
            {statusGlyph(row.runtimeState)}
          </ThemedText>,
          <ThemedText key="status" color={color} wrap="truncate-end">
            {row.runtimeState}
          </ThemedText>,
          <ThemedText key="provider" color={active ? "agenc" : "text2"} wrap="truncate-end">
            {row.provider}
          </ThemedText>,
          <ThemedText key="model" color="subtle" wrap="truncate-middle">
            {row.model}
          </ThemedText>,
          <ThemedText key="auth" color={authColor(row.authState)} wrap="truncate-end">
            {row.auth}
          </ThemedText>,
          <ThemedText key="models" color={row.models.length > 0 ? "text2" : "inactive"} wrap="truncate-end">
            {row.models.length}
          </ThemedText>,
          <ThemedText key="detail" color="subtle" wrap="truncate-end">
            {row.detail}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Provider Route</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Empty /provider opens this registry-backed provider catalog. Enter switches to
            the configured or default model when the provider is usable.
          </ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Pro hosted access is routed through OpenRouter. Other provider rows are
            direct BYOK or local routes unless their auth says subscription.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.name ?? snapshot.currentProvider} /{" "}
            {selected?.model ?? snapshot.currentModel}
          </ThemedText>
          {selected ? (
            <>
              <ThemedText color={statusColor(selected.runtimeState)} wrap="wrap">
                {selected.runtimeState}: {selected.detail}
              </ThemedText>
              <ThemedText color={authColor(selected.authState)} wrap="wrap">
                auth: {selected.credentialSource}
              </ThemedText>
              <ThemedText color="inactive" wrap="truncate-middle">
                {selected.baseURL}
              </ThemedText>
              <ThemedText color="subtle" wrap="wrap">
                models:{" "}
                {selected.models.length > 0
                  ? selected.models.slice(0, 4).join(", ")
                  : "none"}
              </ThemedText>
            </>
          ) : null}
          {snapshot.diagnostics.map((diagnostic, index) => (
            <ThemedText key={index} color="warning" wrap="wrap">
              {diagnostic}
            </ThemedText>
          ))}
          {message ? (
            <ThemedText
              color={successMessage(message) ? "success" : "error"}
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
        { keyName: "d", label: "details" },
        { keyName: "a", label: "auth" },
        { keyName: "q", label: "close" },
      ]}
      hint="registry + config defaults"
    />
  );
}

export function openProviderMenu(
  ctx: SlashCommandContext,
  snapshot: ProviderMenuSnapshot,
  onSelect: (provider: ProviderSlug, model: string) => Promise<ProviderMenuSelectionResult>,
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <ProviderMenuView snapshot={snapshot} onDone={close} onSelect={onSelect} />
  ));
}
