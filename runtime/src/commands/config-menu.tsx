import React from "react";

import type { AgenCConfig } from "../config/schema.js";
import type {
  BufferConfig,
  BufferNeovimInitMode,
  BufferProviderMode,
  BufferTabsMode,
} from "../config/schema.js";
import { AgenCConfigEditsBuilder } from "../config/edit.js";
import type { ConfigStore } from "../config/store.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import {
  agencHomeFromCommandContext,
  configFilePathFromCommandContext,
} from "./config-context.js";
import type { SlashCommandContext } from "./types.js";
import { asRecord } from "../utils/record.js";
import { discoverNeovim } from "../tui/workbench/buffer/neovim/NeovimDiscovery.js";
import { bufferProviderConfigFromSources } from "../tui/workbench/buffer/providers/selectBufferEditorProvider.js";

type ConfigRowKind =
  | "runtime"
  | "permissions"
  | "paths"
  | "mcp"
  | "plugins"
  | "profiles"
  | "tools"
  | "agent"
  | "editor"
  | "tui";

type ConfigRowStatus = "active" | "configured" | "default" | "empty";

type ConfigRow = {
  readonly kind: ConfigRowKind;
  readonly key: string;
  readonly value: string;
  readonly status: ConfigRowStatus;
  readonly detail: string;
};

export type ConfigMenuSnapshot = {
  readonly configPath: string;
  readonly warningCount: number;
  readonly rows: readonly ConfigRow[];
  readonly activeIndex: number;
};

type ConfigMenuSnapshotOptions = {
  readonly configPath: string;
  readonly warnings?: readonly string[];
};

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return asRecord(value) ?? undefined;
}

function configured(value: unknown): ConfigRowStatus {
  if (value === undefined || value === null) return "empty";
  if (Array.isArray(value) && value.length === 0) return "empty";
  if (typeof value === "object" && Object.keys(value).length === 0) return "empty";
  return "configured";
}

function scalar(value: unknown, fallback = "not set"): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map(String).join(", ");
  if (typeof value === "object") return `${Object.keys(value).length} entries`;
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

function countRecord(value: unknown): number {
  return Object.keys(optionalRecord(value) ?? {}).length;
}

function listRecordKeys(value: unknown, fallback = "none"): string {
  const keys = Object.keys(optionalRecord(value) ?? {});
  return keys.length > 0 ? keys.join(", ") : fallback;
}

function compact(value: string, limit = 100): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

function toolsDetail(config: AgenCConfig): string {
  const tools = config.tools_config;
  if (tools === undefined) return "No tool overrides configured.";
  const enabled = tools.enabled_tools?.length ?? 0;
  const disabled = tools.disabled_tools?.length ?? 0;
  const web = scalar(tools.web_search, "default");
  return `web search ${web}; ${enabled} enabled tools; ${disabled} disabled tools`;
}

function agentDetail(config: AgenCConfig): string {
  const budget = config.agent?.budget;
  const retention = config.agent?.retention;
  const caps = [
    budget?.token_cap === undefined ? null : `tokens ${budget.token_cap}`,
    budget?.dollar_cap === undefined ? null : `usd ${budget.dollar_cap}`,
    budget?.wall_clock_seconds === undefined ? null : `seconds ${budget.wall_clock_seconds}`,
  ].filter((item): item is string => item !== null);
  const retentionText =
    retention === undefined
      ? "retention defaults"
      : `retention ${retention.completed_days ?? "default"}d completed, ${retention.failed_days ?? "default"}d failed`;
  return `${caps.length > 0 ? caps.join(", ") : "no explicit caps"}; ${retentionText}`;
}

function row(
  kind: ConfigRowKind,
  key: string,
  value: unknown,
  detail: string,
  status: ConfigRowStatus = configured(value),
): ConfigRow {
  return {
    kind,
    key,
    value: compact(scalar(value)),
    status,
    detail: compact(detail, 140),
  };
}

function createConfigMenuSnapshot(
  config: AgenCConfig,
  options: ConfigMenuSnapshotOptions,
): ConfigMenuSnapshot {
  const profiles = countRecord(config.profiles);
  const mcpServers = countRecord(config.mcp_servers);
  const providerCount = countRecord(config.providers);
  const pluginDirs = config.plugins?.dirs?.length ?? 0;
  const pluginAllowlist = config.plugins?.allowlist?.length ?? 0;
  const rows: ConfigRow[] = [
    row(
      "runtime",
      "model",
      config.model,
      `provider ${scalar(config.model_provider)}; ${providerCount} provider override entries`,
      "active",
    ),
    row(
      "runtime",
      "reasoning",
      config.reasoning_effort,
      `summary ${scalar(config.reasoning_summary, "default")}; verbosity ${scalar(config.model_verbosity, "default")}; service tier ${scalar(config.service_tier, "default")}`,
    ),
    row(
      "permissions",
      "approval",
      config.approval_policy,
      `permission default ${scalar(config.permissions?.default_mode ?? config.permissions?.defaultMode, "default")}; reviewer ${scalar(config.approvals_reviewer)}`,
      "active",
    ),
    row(
      "permissions",
      "sandbox",
      config.sandbox_mode ?? config.sandbox?.mode,
      `policy ${scalar(config.sandbox_policy?.mode, "default")}; network ${scalar(config.sandbox_policy?.network_access, "default")}`,
    ),
    row(
      "paths",
      "config.toml",
      options.configPath,
      `workspace ${scalar(config.workspace, "current cwd")}; agenc_home ${scalar(config.agenc_home, "resolved from environment")}`,
      "active",
    ),
    row(
      "paths",
      "project roots",
      config.project_root_markers,
      `project docs max ${scalar(config.project_doc_max_bytes)} bytes; attachments ${scalar(config.attachments?.allowedRoots, "workspace only")}`,
    ),
    row(
      "mcp",
      "mcp server",
      config.mcp?.server?.enabled,
      `transport ${scalar(config.mcp?.server?.transport, "stdio")}; configured servers ${mcpServers}: ${listRecordKeys(config.mcp_servers)}`,
    ),
    row(
      "plugins",
      "plugins",
      config.plugins?.enabled,
      `${pluginDirs} plugin dirs; ${pluginAllowlist} allowlisted; entries ${listRecordKeys(config.plugins?.plugins)}`,
    ),
    row(
      "profiles",
      "profiles",
      profiles,
      profiles > 0 ? listRecordKeys(config.profiles) : "No profiles declared.",
      profiles > 0 ? "configured" : "empty",
    ),
    row("tools", "tools", config.tools_config, toolsDetail(config)),
    row("agent", "agent", config.agent, agentDetail(config)),
    row(
      "editor",
      "buffer",
      config.buffer?.provider ?? "auto",
      `tabs ${scalar(config.buffer?.show_tabs, "auto")}; Neovim init ${scalar(config.buffer?.neovim?.init, "auto")}; executable ${scalar(config.buffer?.neovim?.executable, "auto-detect")}`,
      "active",
    ),
    row(
      "tui",
      "layout",
      config.tuiLayout?.mode,
      `side pane ${scalar(config.tuiLayout?.sidePane, "default")}; min columns ${scalar(config.tuiLayout?.minColumns, "default")}; editor ${scalar(config.editorMode)}`,
    ),
    row(
      "tui",
      "updates",
      config.autoUpdates,
      `remote control at startup ${scalar(config.remoteControlAtStartup, "not set")}`,
    ),
  ];

  if ((options.warnings?.length ?? 0) > 0) {
    rows.unshift(
      row(
        "runtime",
        "warnings",
        options.warnings?.length,
        options.warnings?.join(" | ") ?? "",
        "configured",
      ),
    );
  }

  return {
    configPath: options.configPath,
    warningCount: options.warnings?.length ?? 0,
    rows,
    activeIndex: Math.max(0, rows.findIndex(item => item.status === "active")),
  };
}

export function readConfigMenuSnapshot(ctx: SlashCommandContext): ConfigMenuSnapshot {
  const store = ctx.configStore ??
    (ctx.session.services as { configStore?: ConfigStore | null }).configStore;
  if (!store) {
    throw new Error("ConfigStore not initialised");
  }
  return createConfigMenuSnapshot(store.current(), {
    configPath: configFilePathFromCommandContext(ctx),
    warnings: store.warnings(),
  });
}

function statusColor(status: ConfigRowStatus): "success" | "agenc" | "worker" | "inactive" {
  switch (status) {
    case "active":
      return "success";
    case "configured":
      return "agenc";
    case "default":
      return "worker";
    case "empty":
      return "inactive";
  }
}

function statusGlyph(status: ConfigRowStatus): string {
  switch (status) {
    case "active":
      return "◆";
    case "configured":
      return "●";
    case "default":
      return "◇";
    case "empty":
      return "·";
  }
}

export function ConfigMenuView({
  snapshot,
  store,
  agencHome,
  onDone,
}: {
  readonly snapshot: ConfigMenuSnapshot;
  readonly store: ConfigStore;
  readonly agencHome: string;
  readonly onDone: () => void;
}): React.ReactNode {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) =>
      store.subscribe(() => onStoreChange()),
    [store],
  );
  const getSnapshot = React.useCallback(() => store.current(), [store]);
  const config = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const liveSnapshot = React.useMemo(
    () => createConfigMenuSnapshot(config, {
      configPath: snapshot.configPath,
      warnings: store.warnings(),
    }),
    [config, snapshot.configPath, store],
  );
  const rows = liveSnapshot.rows;
  const [activeIndex, setActiveIndex] = React.useState(snapshot.activeIndex);
  const [editorOpen, setEditorOpen] = React.useState(false);

  useInput((input, key) => {
    if (editorOpen) return;
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
    if (key.return && rows[activeIndex]?.kind === "editor") {
      setEditorOpen(true);
    }
  });

  if (editorOpen) {
    return (
      <EditorConfigView
        config={config}
        store={store}
        agencHome={agencHome}
        env={process.env}
        onDone={() => setEditorOpen(false)}
      />
    );
  }

  const selected = rows[Math.max(0, Math.min(activeIndex, rows.length - 1))] ?? rows[0];

  return (
    <MenuModal
      title="config"
      count={`${rows.length}`}
      summary={liveSnapshot.warningCount > 0 ? `${liveSnapshot.warningCount} warnings` : "effective settings"}
      headerRight={liveSnapshot.configPath}
      columns={[3, 13, 18, 24, 54]}
      headers={["", "status", "section", "key", "value"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(item, _index, active) => {
        const color = statusColor(item.status);
        return [
          <ThemedText key="mark" color={color}>
            {statusGlyph(item.status)}
          </ThemedText>,
          <ThemedText key="status" color={color} wrap="truncate-end">
            {item.status}
          </ThemedText>,
          <ThemedText key="section" color={active ? "agenc" : "text2"} wrap="truncate-end">
            {item.kind}
          </ThemedText>,
          <ThemedText key="key" color="text2" wrap="truncate-end">
            {item.key}
          </ThemedText>,
          <ThemedText key="value" color="subtle" wrap="truncate-middle">
            {item.value}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Config Store</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Effective settings are read from the live ConfigStore. Use explicit subcommands for scripted output.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.key ?? "none"}
          </ThemedText>
          <ThemedText color="inactive" wrap="wrap">
            {selected?.detail ?? "No config rows available."}
          </ThemedText>
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        ...(rows[activeIndex]?.kind === "editor"
          ? [{ keyName: "enter", label: "open editor settings" }]
          : []),
        { keyName: "q", label: "close" },
      ]}
      hint="/config show · get · reload · edit"
    />
  );
}

const BUFFER_PROVIDER_MODES: readonly BufferProviderMode[] = [
  "auto",
  "neovim",
  "inline",
  "external",
];
const BUFFER_INIT_MODES: readonly BufferNeovimInitMode[] = [
  "auto",
  "user",
  "clean",
];
const BUFFER_TAB_MODES: readonly BufferTabsMode[] = [
  "auto",
  "always",
  "never",
];

const BUFFER_EDITOR_ENV_KEYS = [
  "AGENC_BUFFER_PROVIDER",
  "AGENC_BUFFER_NVIM",
  "AGENC_BUFFER_NVIM_USE_INIT",
  "AGENC_BUFFER_NVIM_TIMEOUT_MS",
  "AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS",
  "AGENC_BUFFER_NVIM_OPERATION_TIMEOUT_MS",
  "AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS",
  "AGENC_BUFFER_NVIM_SESSION",
] as const;

export type EffectiveBufferEditorConfig = {
  readonly provider: BufferProviderMode;
  readonly init: BufferNeovimInitMode;
  readonly executable: string | undefined;
  readonly discoveryTimeoutMs: number | undefined;
  readonly environmentOverrides: readonly string[];
};

export function effectiveBufferEditorConfig(
  config: BufferConfig | undefined,
  env: NodeJS.ProcessEnv,
): EffectiveBufferEditorConfig {
  const effective = bufferProviderConfigFromSources(config, env);
  return {
    provider: effective.mode ?? "auto",
    init: effective.useUserInit === true
      ? "user"
      : effective.useUserInit === false
        ? "clean"
        : "auto",
    executable:
      effective.executable?.trim().length
        ? effective.executable
        : undefined,
    discoveryTimeoutMs: effective.timeoutMs,
    environmentOverrides: BUFFER_EDITOR_ENV_KEYS.filter(
      (key) => env[key] !== undefined,
    ),
  };
}

function EditorConfigView({
  config,
  store,
  agencHome,
  env,
  onDone,
}: {
  readonly config: AgenCConfig;
  readonly store: ConfigStore;
  readonly agencHome: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onDone: () => void;
}): React.ReactNode {
  const [provider, setProvider] = React.useState<BufferProviderMode>(
    config.buffer?.provider ?? "auto",
  );
  const [init, setInit] = React.useState<BufferNeovimInitMode>(
    config.buffer?.neovim?.init ?? "auto",
  );
  const [tabs, setTabs] = React.useState<BufferTabsMode>(
    config.buffer?.show_tabs ?? "auto",
  );
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [healthGeneration, setHealthGeneration] = React.useState(0);
  const [health, setHealth] = React.useState("checking Neovim…");
  const [saveStatus, setSaveStatus] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [draftDirty, setDraftDirty] = React.useState(false);
  const savingRef = React.useRef(false);
  React.useEffect(() => {
    if (draftDirty) return;
    setProvider(config.buffer?.provider ?? "auto");
    setInit(config.buffer?.neovim?.init ?? "auto");
    setTabs(config.buffer?.show_tabs ?? "auto");
  }, [config.buffer, draftDirty]);
  const draftConfig = React.useMemo<BufferConfig>(() => ({
    ...config.buffer,
    provider,
    show_tabs: tabs,
    neovim: {
      ...config.buffer?.neovim,
      init,
    },
  }), [config.buffer, init, provider, tabs]);
  const effective = React.useMemo(
    () => effectiveBufferEditorConfig(draftConfig, env),
    [draftConfig, env],
  );

  React.useEffect(() => {
    let cancelled = false;
    setHealth("checking Neovim…");
    void discoverNeovim({
      executable: effective.executable,
      useUserInit:
        effective.init === "auto" ? undefined : effective.init === "user",
      timeoutMs: effective.discoveryTimeoutMs,
    }).then((result) => {
      if (cancelled) return;
      setHealth(
        result.usable
          ? `${result.version.raw} · ${result.executable} · ${
            effective.init === "auto"
              ? "auto init (user, then clean fallback)"
              : `${effective.init} init`
          }`
          : result.reason,
      );
    }).catch((error) => {
      if (!cancelled) {
        setHealth(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    effective.discoveryTimeoutMs,
    effective.executable,
    effective.init,
    healthGeneration,
  ]);

  const cycle = React.useCallback((direction: -1 | 1) => {
    if (activeIndex === 0) {
      setProvider(current => cycleValue(BUFFER_PROVIDER_MODES, current, direction));
    } else if (activeIndex === 1) {
      setInit(current => cycleValue(BUFFER_INIT_MODES, current, direction));
    } else {
      setTabs(current => cycleValue(BUFFER_TAB_MODES, current, direction));
    }
    setDraftDirty(true);
    setSaveStatus(null);
  }, [activeIndex]);

  const save = React.useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveStatus("saving…");
    try {
      await new AgenCConfigEditsBuilder(agencHome)
        .setBufferEditorConfig({
          provider,
          show_tabs: tabs,
          neovim: draftConfig.neovim,
        })
        .apply();
      await store.reload();
      setDraftDirty(false);
      setSaveStatus(
        effective.environmentOverrides.length > 0
          ? `saved to config.toml · process env still overrides: ${
            effective.environmentOverrides.join(", ")
          }`
          : "saved · applies to the next safe editor start",
      );
    } catch (error) {
      setSaveStatus(`save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [
    agencHome,
    draftConfig.neovim,
    effective.environmentOverrides,
    provider,
    store,
    tabs,
  ]);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone();
      return;
    }
    if (key.upArrow || input === "k") {
      setActiveIndex(index => previousMenuIndex(index, 3));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex(index => nextMenuIndex(index, 3));
      return;
    }
    if (key.leftArrow || input === "h") {
      cycle(-1);
      return;
    }
    if (key.rightArrow || input === "l" || key.return) {
      cycle(1);
      return;
    }
    if (input === "s") {
      void save();
      return;
    }
    if (input === "r") {
      setHealthGeneration(value => value + 1);
    }
  });

  const rows = [
    {
      key: "provider",
      value: provider,
      detail: "auto prefers embedded Neovim and falls back inline",
    },
    {
      key: "init",
      value: init,
      detail: "auto tries user init, then one clean-start fallback",
    },
    {
      key: "buffer tabs",
      value: tabs,
      detail: "host buffer strip visibility",
    },
  ] as const;

  return (
    <MenuModal
      title="editor settings"
      count="3"
      summary={saveStatus ?? "effective BUFFER configuration"}
      headerRight={effective.executable ?? "auto-detect"}
      columns={[3, 22, 18, 64]}
      headers={["", "setting", "value", "behavior"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(item, _index, active) => [
        <ThemedText key="mark" color={active ? "success" : "inactive"}>
          {active ? "◆" : "·"}
        </ThemedText>,
        <ThemedText key="key" color={active ? "agenc" : "text2"}>
          {item.key}
        </ThemedText>,
        <ThemedText key="value" color="text2">
          {item.value}
        </ThemedText>,
        <ThemedText key="detail" color="subtle" wrap="truncate-end">
          {item.detail}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Neovim health</ThemedText>
          <ThemedText color="text2" wrap="wrap">{health}</ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Effective next start: provider {effective.provider}; init {effective.init};
            executable {effective.executable ?? "auto-detect"}.
          </ThemedText>
          <ThemedText
            color={effective.environmentOverrides.length > 0 ? "warning" : "subtle"}
            wrap="wrap"
          >
            {effective.environmentOverrides.length > 0
              ? `Process environment overrides config.toml: ${effective.environmentOverrides.join(", ")}`
              : "No AGENC_BUFFER_* process overrides are active."}
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Recovery is private under AGENC_HOME.
          </ThemedText>
          {saveStatus ? <ThemedText color={saveStatus.startsWith("save failed") ? "error" : "success"} wrap="wrap">{saveStatus}</ThemedText> : null}
        </Box>
      }
      footer={[
        { keyName: "h/l", label: "change" },
        { keyName: "s", label: saving ? "saving" : "save" },
        { keyName: "r", label: "health check" },
        { keyName: "q", label: "back" },
      ]}
      hint="[buffer] and [buffer.neovim] in config.toml"
    />
  );
}

function cycleValue<T>(
  values: readonly T[],
  current: T,
  direction: -1 | 1,
): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + direction + values.length) % values.length] ?? current;
}

export function openConfigMenu(ctx: SlashCommandContext): boolean {
  return openLocalJsxCommand(ctx, close => {
    const store = ctx.configStore ??
      (ctx.session.services as { configStore?: ConfigStore | null }).configStore;
    if (!store) return <ThemedText color="error">ConfigStore not initialised</ThemedText>;
    const snapshot = readConfigMenuSnapshot(ctx);
    return (
      <ConfigMenuView
        snapshot={snapshot}
        store={store}
        agencHome={agencHomeFromCommandContext(ctx)}
        onDone={close}
      />
    );
  });
}
