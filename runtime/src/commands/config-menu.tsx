import React from "react";

import type { AgenCConfig } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import { configFilePathFromCommandContext } from "./config-context.js";
import type { SlashCommandContext } from "./types.js";
import { asRecord } from "../utils/record.js";

type ConfigRowKind =
  | "runtime"
  | "permissions"
  | "paths"
  | "mcp"
  | "plugins"
  | "profiles"
  | "tools"
  | "agent"
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
      "tui",
      "layout",
      config.tuiLayout?.mode,
      `side pane ${scalar(config.tuiLayout?.sidePane, "default")}; min columns ${scalar(config.tuiLayout?.minColumns, "default")}; editor ${scalar(config.editorMode)}`,
    ),
    row(
      "tui",
      "updates",
      config.autoUpdates,
      `telemetry ${scalar(config.telemetryOptIn, "not set")}; remote control at startup ${scalar(config.remoteControlAtStartup, "not set")}`,
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

function ConfigMenuView({
  snapshot,
  onDone,
}: {
  readonly snapshot: ConfigMenuSnapshot;
  readonly onDone: () => void;
}): React.ReactNode {
  const rows = snapshot.rows;
  const [activeIndex, setActiveIndex] = React.useState(snapshot.activeIndex);

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

  const selected = rows[Math.max(0, Math.min(activeIndex, rows.length - 1))] ?? rows[0];

  return (
    <MenuModal
      title="config"
      count={`${rows.length}`}
      summary={snapshot.warningCount > 0 ? `${snapshot.warningCount} warnings` : "effective settings"}
      headerRight={snapshot.configPath}
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
        { keyName: "q", label: "close" },
      ]}
      hint="/config show · get · reload · edit"
    />
  );
}

export function openConfigMenu(ctx: SlashCommandContext): boolean {
  return openLocalJsxCommand(ctx, close => {
    const snapshot = readConfigMenuSnapshot(ctx);
    return <ConfigMenuView snapshot={snapshot} onDone={close} />;
  });
}
