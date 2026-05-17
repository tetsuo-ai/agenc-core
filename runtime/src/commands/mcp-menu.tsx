import React from "react";

import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import type { SlashCommandContext } from "./types.js";
import type { McpServerStatus, McpToolStatus } from "./mcp.js";

type McpServerRow = McpServerStatus & {
  readonly state: "connected" | "disconnected";
  readonly target: string;
  readonly toolCount: number;
};

function serverRows(
  servers: readonly McpServerStatus[],
  toolsByServer: ReadonlyMap<string, readonly McpToolStatus[]>,
): readonly McpServerRow[] {
  return servers.map(server => ({
    ...server,
    state: server.enabled ? "connected" : "disconnected",
    target: server.url ?? server.command ?? "local",
    toolCount: toolsByServer.get(server.name)?.length ?? 0,
  }));
}

function compactText(value: string, limit = 92): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
}

function stateColor(state: McpServerRow["state"], required: boolean): "success" | "error" | "worker" {
  if (state === "connected") return "success";
  return required ? "error" : "worker";
}

function McpMenuView({
  servers,
  toolsByServer,
  onDone,
}: {
  readonly servers: readonly McpServerStatus[];
  readonly toolsByServer: ReadonlyMap<string, readonly McpToolStatus[]>;
  readonly onDone: () => void;
}): React.ReactNode {
  const rows = React.useMemo(() => serverRows(servers, toolsByServer), [servers, toolsByServer]);
  const displayRows =
    rows.length > 0
      ? rows
      : [{
          name: "none",
          enabled: false,
          required: false,
          state: "disconnected" as const,
          target: "no MCP servers configured",
          toolCount: 0,
        }];
  const [activeIndex, setActiveIndex] = React.useState(0);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone();
      return;
    }
    if (key.upArrow || input === "k") {
      setActiveIndex(index => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex(index => Math.min(displayRows.length - 1, index + 1));
    }
  });

  const selected = displayRows[activeIndex] ?? displayRows[0];
  const selectedTools = selected ? toolsByServer.get(selected.name) ?? [] : [];
  return (
    <MenuModal
      title="mcp"
      count={`${servers.length}`}
      summary={`${rows.filter(row => row.enabled).length} connected`}
      headerRight="session"
      columns={[3, 14, 22, 8, 36, 10]}
      headers={["", "state", "server", "tools", "target", "required"]}
      items={displayRows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => {
        const color = stateColor(row.state, row.required);
        return [
          <ThemedText key="mark" color={color}>
            {row.state === "connected" ? "◆" : row.required ? "!" : "◇"}
          </ThemedText>,
          <ThemedText key="state" color={color} wrap="truncate-end">
            {row.state}
          </ThemedText>,
          <ThemedText key="server" color={active ? "agenc" : "text2"} wrap="truncate-end">
            {row.name}
          </ThemedText>,
          <ThemedText key="tools" color="subtle">
            {String(row.toolCount)}
          </ThemedText>,
          <ThemedText key="target" color="subtle" wrap="truncate-middle">
            {row.target}
          </ThemedText>,
          <ThemedText key="required" color={row.required ? "worker" : "inactive"}>
            {row.required ? "yes" : "no"}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">MCP Servers</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Manage runtime servers with /mcp reconnect, /mcp enable, /mcp disable,
            /mcp add, or /mcp new.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.name ?? "none"}
          </ThemedText>
          {selectedTools.slice(0, 6).map(tool => (
            <ThemedText key={tool.name} color="text2" wrap="truncate-end">
              {tool.name}{tool.description ? ` - ${compactText(tool.description, 62)}` : ""}
            </ThemedText>
          ))}
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "q", label: "close" },
      ]}
      hint="/mcp tools [server]"
    />
  );
}

export function openMcpMenu(
  ctx: SlashCommandContext,
  servers: readonly McpServerStatus[],
  toolsByServer: ReadonlyMap<string, readonly McpToolStatus[]>,
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
    jsx: <McpMenuView servers={servers} toolsByServer={toolsByServer} onDone={close} />,
  });
  return true;
}
