import React from "react";

import {
  AGENT_SOURCE_GROUPS,
  resolveAgentModelDisplay,
  resolveAgentOverrides,
  type ResolvedAgent,
} from "../tools/AgentTool/agentDisplay.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { useAppState } from "../tui/state/AppState.js";
import type { AppState } from "../tui/state/AppStateStore.js";
import type { AgentDefinition } from "../tools/AgentTool/loadAgentsDir.js";
import type { SlashCommandContext } from "./types.js";

function sourceLabel(source: AgentDefinition["source"]): string {
  return AGENT_SOURCE_GROUPS.find(group => group.source === source)?.label ?? source;
}

function compactText(value: string | undefined, fallback = "—", limit = 92): string {
  const normalized = (value ?? "").replace(/\s+/gu, " ").trim();
  const text = normalized.length > 0 ? normalized : fallback;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}...`;
}

function toolSummary(agent: AgentDefinition): string {
  if (agent.tools?.length) return `${agent.tools.length} tools`;
  if (agent.disallowedTools?.length) return `default - ${agent.disallowedTools.length}`;
  return "default";
}

function skillSummary(agent: AgentDefinition): string {
  if (agent.skills?.length) return `${agent.skills.length} skills`;
  return "—";
}

function statusFor(agent: ResolvedAgent, activeAgents: readonly AgentDefinition[]): {
  readonly glyph: string;
  readonly label: string;
  readonly color: "success" | "worker" | "inactive" | "agenc";
} {
  if (agent.overriddenBy) {
    return { glyph: "◇", label: `overridden by ${agent.overriddenBy}`, color: "inactive" };
  }
  const active = activeAgents.some(
    candidate =>
      candidate.agentType === agent.agentType &&
      candidate.source === agent.source,
  );
  if (active) return { glyph: "◆", label: "active", color: "success" };
  if (agent.source === "plugin") return { glyph: "●", label: "plugin", color: "worker" };
  return { glyph: "·", label: "available", color: "agenc" };
}

function sortAgents(agents: readonly ResolvedAgent[]): readonly ResolvedAgent[] {
  const sourceOrder = new Map(
    AGENT_SOURCE_GROUPS.map((group, index) => [group.source, index]),
  );
  return [...agents].sort((left, right) => {
    const bySource =
      (sourceOrder.get(left.source) ?? 99) - (sourceOrder.get(right.source) ?? 99);
    if (bySource !== 0) return bySource;
    return left.agentType.localeCompare(right.agentType, undefined, {
      sensitivity: "base",
    });
  });
}

export function AgentsMenuModal({
  onDone,
}: {
  readonly onDone: () => void;
}): React.ReactNode {
  const agentDefinitions = useAppState((state: AppState) => state.agentDefinitions);
  const activeAgents = agentDefinitions.activeAgents;
  const rows = React.useMemo(
    () => sortAgents(resolveAgentOverrides(
      agentDefinitions.allAgents,
      agentDefinitions.activeAgents,
    )),
    [agentDefinitions.activeAgents, agentDefinitions.allAgents],
  );
  const displayRows =
    rows.length > 0
      ? rows
      : [{
          agentType: "none",
          source: "built-in" as const,
          baseDir: "built-in" as const,
          whenToUse: "No agents are currently registered.",
          getSystemPrompt: () => "",
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
  const activeCount = rows.filter(row => !row.overriddenBy).length;

  return (
    <MenuModal
      title="agents"
      count={`${activeCount} active · ${rows.length} registered`}
      summary="delegate-capable role definitions"
      headerRight="↑↓ select · q dismiss"
      columns={[3, 18, 18, 12, 10, 10, 48]}
      headers={["", "name", "source", "status", "model", "tools", "when to use"]}
      items={displayRows}
      activeIndex={activeIndex}
      renderRow={(agent, _index, active) => {
        const status = statusFor(agent as ResolvedAgent, activeAgents);
        return [
          <ThemedText key="mark" color={status.color}>{status.glyph}</ThemedText>,
          <ThemedText key="name" color={active ? "agenc" : "text2"} wrap="truncate-end">
            {agent.agentType}
          </ThemedText>,
          <ThemedText key="source" color="subtle" wrap="truncate-end">
            {sourceLabel(agent.source)}
          </ThemedText>,
          <ThemedText key="status" color={status.color} wrap="truncate-end">
            {status.label}
          </ThemedText>,
          <ThemedText key="model" color="subtle" wrap="truncate-end">
            {resolveAgentModelDisplay(agent) ?? "inherit"}
          </ThemedText>,
          <ThemedText key="tools" color="subtle" wrap="truncate-end">
            {toolSummary(agent)}
          </ThemedText>,
          <ThemedText key="use" color="subtle" wrap="truncate-end">
            {compactText(agent.whenToUse)}
          </ThemedText>,
        ];
      }}
      preview={
        selected ? (
          <Box flexDirection="column" gap={1}>
            <ThemedText color="agenc">{selected.agentType}</ThemedText>
            <ThemedText color="subtle" wrap="wrap">
              {compactText(selected.whenToUse, "No description.", 320)}
            </ThemedText>
            <ThemedText color="inactive">
              source · {sourceLabel(selected.source)}
            </ThemedText>
            <ThemedText color="inactive">
              model · {resolveAgentModelDisplay(selected) ?? "inherit"}
            </ThemedText>
            <ThemedText color="inactive">
              tools · {toolSummary(selected)} · skills · {skillSummary(selected)}
            </ThemedText>
            {"filename" in selected && selected.filename ? (
              <ThemedText color="inactive" wrap="truncate-middle">
                file · {selected.filename}
              </ThemedText>
            ) : null}
          </Box>
        ) : undefined
      }
      footer={[
        { keyName: "↑↓", label: "select" },
        { keyName: "q", label: "close" },
      ]}
      hint="agent creation/editing remains available through project agent files"
    />
  );
}

export function openAgentsMenu(ctx: SlashCommandContext): boolean {
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
    jsx: <AgentsMenuModal onDone={close} />,
  });
  return true;
}
