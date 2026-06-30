import React from "react";

import {
  buildProviderModelCatalog,
  normalizeProviderSlug,
  readProviderConfig,
  type ProviderSlug,
} from "../config/resolve-provider.js";
import {
  configuredModelForProvider,
  defaultModelForProvider,
} from "../config/resolve-model.js";
import type { AgenCConfig, ProviderConfig } from "../config/schema.js";
import { listBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { readCommandConfig } from "./config-context.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import {
  providerHasLiveSubscriptionRoute,
  subscriptionManagedDefaultModel,
  subscriptionManagedModels,
} from "./subscription-managed-models.js";
import type { SlashCommandContext } from "./types.js";

type ProviderRowStatus = "current" | "configured" | "default";
type ProviderAuthState = "managed" | "ready" | "missing" | "optional";
type ProviderRuntimeState =
  | "active"
  | "available"
  | "local"
  | "unauthenticated"
  | "unavailable"
  | "error";
type ProviderColor =
  | "success"
  | "agenc"
  | "inactive"
  | "error"
  | "warning"
  | "text2"
  | "subtle";

type ProviderMenuRow = {
  readonly provider: ProviderSlug;
  readonly name: string;
  readonly model: string;
  readonly models: readonly string[];
  readonly baseURL: string;
  readonly status: ProviderRowStatus;
  readonly runtimeState: ProviderRuntimeState;
  readonly authState: ProviderAuthState;
  readonly auth: string;
  readonly credentialSource: string;
  readonly configured: boolean;
  readonly supportsWebsockets: boolean;
  readonly detail: string;
  readonly error?: string;
};

export type ProviderMenuSnapshot = {
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
  readonly rows: readonly ProviderMenuRow[];
  readonly activeIndex: number;
  readonly diagnostics: readonly string[];
};

export type ProviderMenuSelectionResult = {
  readonly message: string;
  readonly shouldClose: boolean;
};

function readSessionSelection(ctx: SlashCommandContext): {
  readonly provider?: string;
  readonly model?: string;
} {
  const peekState = (ctx.session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const rawState =
    typeof peekState === "function"
      ? (peekState.call((ctx.session as unknown as { state?: unknown }).state) as {
          sessionConfiguration?: {
            provider?: { slug?: string };
            collaborationMode?: { model?: string };
          };
        })
      : null;
  const directConfig = (ctx.session as unknown as {
    sessionConfiguration?: {
      provider?: { slug?: string };
      collaborationMode?: { model?: string };
    };
  }).sessionConfiguration;
  const sessionConfiguration = rawState?.sessionConfiguration ?? directConfig;
  return {
    ...(sessionConfiguration?.provider?.slug
      ? { provider: sessionConfiguration.provider.slug }
      : {}),
    ...(sessionConfiguration?.collaborationMode?.model
      ? { model: sessionConfiguration.collaborationMode.model }
      : {}),
  };
}

function readAppStateModel(ctx: SlashCommandContext): string | undefined {
  const state = ctx.appState?.getAppState?.();
  if (typeof state !== "object" || state === null) return undefined;
  const model = (state as { mainLoopModel?: unknown }).mainLoopModel;
  return typeof model === "string" && model.trim().length > 0
    ? model.trim()
    : undefined;
}

function providerModel(params: {
  readonly config?: AgenCConfig;
  readonly provider: ProviderSlug;
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
  readonly managedKeysEnabled?: boolean;
}): string {
  if (params.provider === params.currentProvider) return params.currentModel;
  if (params.managedKeysEnabled === true) {
    const managedDefault = subscriptionManagedDefaultModel(params.provider);
    if (managedDefault !== undefined) return managedDefault;
  }
  return (
    (params.config !== undefined
      ? configuredModelForProvider(params.config, params.provider)
      : undefined) ?? defaultModelForProvider(params.provider)
  );
}

function rowStatus(params: {
  readonly config?: AgenCConfig;
  readonly provider: ProviderSlug;
  readonly currentProvider: ProviderSlug;
}): ProviderRowStatus {
  if (params.provider === params.currentProvider) return "current";
  if (
    params.config !== undefined &&
    configuredModelForProvider(params.config, params.provider) !== undefined
  ) {
    return "configured";
  }
  return "default";
}

function rowDetail(status: ProviderRowStatus): string {
  switch (status) {
    case "current":
      return "active provider";
    case "configured":
      return "configured model";
    case "default":
      return "built-in default";
  }
}

function providerBaseURL(
  infoBaseURL: string,
  config: ProviderConfig | undefined,
): string {
  return config?.base_url?.trim() || infoBaseURL;
}

function providerConfigApiKeyEnv(
  config: ProviderConfig | undefined,
): string | undefined {
  return config?.api_key_env?.trim() || undefined;
}

function isLocalProviderEndpoint(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function baseURLError(baseURL: string): string | undefined {
  try {
    new URL(baseURL);
    return undefined;
  } catch {
    return "invalid base URL";
  }
}

function authState(params: {
  readonly provider: ProviderSlug;
  readonly requiresManagedAuth: boolean;
  readonly configuredEnvVar?: string;
  readonly defaultEnvVar?: string;
  readonly baseURL: string;
  readonly config?: AgenCConfig;
}): {
  readonly state: ProviderAuthState;
  readonly label: string;
  readonly source: string;
} {
  const managedKeysEnabled = params.config?.auth?.managedKeys?.enabled === true;
  if (params.requiresManagedAuth) {
    return {
      state: "managed",
      label: managedKeysEnabled ? "managed on" : "managed",
      source: "managed key vending",
    };
  }

  const envVar = params.configuredEnvVar ?? params.defaultEnvVar;
  if (envVar === undefined) {
    return {
      state: "optional",
      label: "local",
      source: "no key required",
    };
  }

  const hasValue = (process.env[envVar]?.trim().length ?? 0) > 0;
  if (hasValue) {
    return {
      state: "ready",
      label: envVar,
      source: `env ${envVar}`,
    };
  }

  const localEndpoint = isLocalProviderEndpoint(params.baseURL);
  if (localEndpoint) {
    return {
      state: "optional",
      label: managedKeysEnabled ? "local only" : `${envVar} optional`,
      source: managedKeysEnabled
        ? `local endpoint; subscription is not used`
        : `env ${envVar} optional for local endpoint`,
    };
  }

  if (managedKeysEnabled && providerHasLiveSubscriptionRoute(params.provider)) {
    return {
      state: "managed",
      label: "subscription",
      source: `AgenC subscription-managed key; ${envVar} optional`,
    };
  }

  return {
    state: "missing",
    label: `${envVar} missing`,
    source: `set env ${envVar}`,
  };
}

function runtimeState(params: {
  readonly status: ProviderRowStatus;
  readonly authState: ProviderAuthState;
  readonly models: readonly string[];
  readonly baseURL: string;
}): { readonly state: ProviderRuntimeState; readonly error?: string } {
  const baseError = baseURLError(params.baseURL);
  if (baseError !== undefined) {
    return { state: "error", error: baseError };
  }
  if (params.models.length === 0) {
    return { state: "unavailable", error: "no models available" };
  }
  if (params.authState === "missing") {
    return { state: "unauthenticated" };
  }
  if (params.status === "current") {
    return { state: "active" };
  }
  if (
    params.authState === "optional" &&
    isLocalProviderEndpoint(params.baseURL)
  ) {
    return { state: "local" };
  }
  return { state: "available" };
}

function runtimeDetail(params: {
  readonly state: ProviderRuntimeState;
  readonly status: ProviderRowStatus;
  readonly error?: string;
}): string {
  if (params.error !== undefined) return params.error;
  switch (params.state) {
    case "active":
      return "active provider";
    case "local":
      return "local endpoint";
    case "available":
      return rowDetail(params.status);
    case "unauthenticated":
      return "credential required";
    case "unavailable":
      return "no models";
    case "error":
      return "configuration error";
  }
}

function statusColor(state: ProviderRuntimeState): ProviderColor {
  switch (state) {
    case "active":
      return "success";
    case "local":
      return "inactive";
    case "available":
      return "agenc";
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

export function readProviderMenuSnapshot(ctx: SlashCommandContext): ProviderMenuSnapshot {
  const config = readCommandConfig(ctx);
  const sessionSelection = readSessionSelection(ctx);
  const diagnostics: string[] = [];
  if (
    sessionSelection.provider !== undefined &&
    normalizeProviderSlug(sessionSelection.provider) === undefined
  ) {
    diagnostics.push(`Unknown session provider: ${sessionSelection.provider}`);
  }
  const currentProvider =
    normalizeProviderSlug(sessionSelection.provider) ??
    normalizeProviderSlug(config?.model_provider) ??
    "grok";
  const currentModel =
    readAppStateModel(ctx) ??
    sessionSelection.model?.trim() ??
    config?.model?.trim() ??
    defaultModelForProvider(currentProvider);
  const modelCatalog = buildProviderModelCatalog(config);
  const managedKeysEnabled = config?.auth?.managedKeys?.enabled === true;

  const rows = listBuiltInProviderInfo().map((info): ProviderMenuRow => {
    const provider = info.id;
    const providerConfig = config ? readProviderConfig(config, provider) : undefined;
    const status = rowStatus({ config, provider, currentProvider });
    const baseURL = providerBaseURL(info.baseURL, providerConfig);
    const configuredEnvVar = providerConfigApiKeyEnv(providerConfig);
    const auth = authState({
      provider,
      requiresManagedAuth: info.requiresManagedAuth,
      ...(configuredEnvVar ? { configuredEnvVar } : {}),
      ...(info.apiKeyEnvVar ? { defaultEnvVar: info.apiKeyEnvVar } : {}),
      baseURL,
      ...(config ? { config } : {}),
    });
    const rawModels = modelCatalog[provider] ?? [];
    const managedModels =
      managedKeysEnabled && providerHasLiveSubscriptionRoute(provider)
        ? subscriptionManagedModels(provider)
        : undefined;
    const models = managedModels !== undefined ? managedModels : rawModels;
    const state = runtimeState({
      status,
      authState: auth.state,
      models,
      baseURL,
    });
    return {
      provider,
      name: info.name,
      model: providerModel({
        config,
        provider,
        currentProvider,
        currentModel,
        managedKeysEnabled,
      }),
      models,
      baseURL,
      status,
      runtimeState: state.state,
      authState: auth.state,
      auth: auth.label,
      credentialSource: auth.source,
      configured:
        providerConfig !== undefined ||
        (config?.model_provider !== undefined &&
          normalizeProviderSlug(config.model_provider) === provider),
      supportsWebsockets: info.supportsWebsockets,
      detail: runtimeDetail({
        state: state.state,
        status,
        ...(state.error ? { error: state.error } : {}),
      }),
      ...(state.error ? { error: state.error } : {}),
    };
  });

  const activeIndex = Math.max(
    0,
    rows.findIndex(row => row.provider === currentProvider),
  );
  return {
    currentProvider,
    currentModel,
    rows,
    activeIndex,
    diagnostics,
  };
}

export function providerMenuFallback(snapshot: ProviderMenuSnapshot): string {
  const lines = [
    "Provider selection",
    `Current: ${snapshot.currentProvider} / ${snapshot.currentModel}`,
    "",
    "Available providers:",
  ];
  for (const row of snapshot.rows) {
    lines.push(
      `  ${row.status === "current" ? "*" : "-"} ${row.provider} -> ${row.model} (${row.detail})`,
    );
  }
  lines.push("", "Run /provider <provider> [model] to switch.");
  return lines.join("\n");
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
    { key: "websocket", value: row.supportsWebsockets ? "yes" : "no" },
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
