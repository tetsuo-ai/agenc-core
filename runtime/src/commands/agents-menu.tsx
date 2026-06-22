import React from "react";

import {
  AGENT_SOURCE_GROUPS,
  resolveAgentModelDisplay,
  resolveAgentOverrides,
  type ResolvedAgent,
} from "../tools/AgentTool/agentDisplay.js";
import {
  getActiveAgentsFromList,
  type AgentDefinition,
  type SettingSource,
} from "../tools/AgentTool/loadAgentsDir.js";
import type { Tools } from "../tools/Tool.js";
import { Box, useInput } from "../tui/ink.js";
import { agentRolePresentation } from "../agents/role-presentation.js";
import ThemedBox from "../tui/components/design-system/ThemedBox.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import {
  MenuModal,
  Popup,
} from "../tui/components/v2/primitives.js";
import {
  deleteAgentFromFile,
  getActualRelativeAgentFilePath,
  getNewRelativeAgentFilePath,
  saveAgentToFile,
  updateAgentFile,
} from "../tui/components/agents/agentFileUtils.js";
import { useAppState, useSetAppState } from "../tui/state/AppState.js";
import type { AppState } from "../tui/state/AppStateStore.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { getSourceDisplayName } from "../utils/settings/constants.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

type Done = (
  result?: string,
  options?: { readonly display?: "system" },
) => void;

type AgentRow = ResolvedAgent & {
  readonly empty?: boolean;
};

type AgentMode =
  | { readonly name: "list" }
  | { readonly name: "detail"; readonly agent: AgentDefinition }
  | { readonly name: "create" }
  | { readonly name: "edit"; readonly agent: AgentDefinition }
  | { readonly name: "delete"; readonly agent: AgentDefinition };

type AgentForm = {
  readonly source: SettingSource;
  readonly agentType: string;
  readonly whenToUse: string;
  readonly tools: string;
  readonly model: string;
  readonly systemPrompt: string;
};

type FormFieldKey =
  | "source"
  | "agentType"
  | "whenToUse"
  | "tools"
  | "model"
  | "systemPrompt"
  | "save";

type FormField = {
  readonly key: FormFieldKey;
  readonly label: string;
  readonly value: string;
  readonly editable: boolean;
  readonly detail: string;
};

const CREATE_SOURCES: readonly SettingSource[] = [
  "projectSettings",
  "userSettings",
];

const EMPTY_AGENT_ROW: AgentRow = {
  agentType: "none",
  source: "built-in",
  baseDir: "built-in",
  whenToUse: "No agents are currently registered.",
  getSystemPrompt: () => "",
  empty: true,
};

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

function promptText(agent: AgentDefinition): string {
  try {
    return agent.getSystemPrompt();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function providerSummary(agent: AgentDefinition): string {
  const provider = (agent as { readonly provider?: unknown }).provider;
  return typeof provider === "string" && provider.length > 0 ? provider : "inherit";
}

function agentRoleLabel(agent: AgentDefinition): string {
  return agentRolePresentation(agent.agentType)?.label ?? "Agent";
}

function agentIdentityLabel(agent: AgentDefinition): string {
  return `${agent.agentType} · ${agentRoleLabel(agent)}`;
}

function agentScopeLabel(agent: AgentDefinition): string {
  if (agent.memory) return agent.memory;
  if (agent.source === "built-in") return "runtime";
  if (agent.source === "plugin") return "plugin";
  if (agent.source === "projectSettings") return "project";
  if (agent.source === "userSettings") return "user";
  return sourceLabel(agent.source).toLowerCase();
}

function agentBudgetLabel(agent: AgentDefinition): string {
  if (agent.maxTurns !== undefined) return `${agent.maxTurns} turns`;
  if (agent.effort) return `effort ${agent.effort}`;
  return "inherit";
}

function agentWorktreeLabel(agent: AgentDefinition): string {
  if (agent.isolation === "worktree") return "isolated worktree";
  if (agent.isolation === "remote") return "remote";
  return "current checkout";
}

function editableAgent(agent: AgentDefinition): boolean {
  return (
    agent.source !== "built-in" &&
    agent.source !== "plugin" &&
    agent.source !== "flagSettings"
  );
}

function statusFor(agent: ResolvedAgent, activeAgents: readonly AgentDefinition[]): {
  readonly glyph: string;
  readonly label: string;
  readonly color: "agenc" | "worker" | "muted3";
} {
  if (agent.overriddenBy) {
    return { glyph: "◇", label: `overridden by ${agent.overriddenBy}`, color: "muted3" };
  }
  const active = activeAgents.some(
    candidate =>
      candidate.agentType === agent.agentType &&
      candidate.source === agent.source,
  );
  if (active) return { glyph: "◆", label: "active", color: "agenc" };
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

function sameAgent(left: AgentDefinition, right: AgentDefinition): boolean {
  return left.agentType === right.agentType && left.source === right.source;
}

function currentAgent(
  agent: AgentDefinition,
  allAgents: readonly AgentDefinition[],
): AgentDefinition {
  return allAgents.find(candidate => sameAgent(candidate, agent)) ?? agent;
}

function toolsText(agent: AgentDefinition): string {
  if (agent.tools === undefined) return "*";
  if (agent.tools.length === 0) return "";
  return agent.tools.join(", ");
}

function parseTools(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "*") return undefined;
  return trimmed
    .split(",")
    .map(tool => tool.trim())
    .filter(tool => tool.length > 0);
}

function modelValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateAgentTypeValue(agentType: string): string | null {
  if (!agentType) return "Agent type is required";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/u.test(agentType)) {
    return "Agent type must start and end with alphanumeric characters and contain only letters, numbers, and hyphens";
  }
  if (agentType.length < 3) return "Agent type must be at least 3 characters long";
  if (agentType.length > 50) return "Agent type must be less than 50 characters";
  return null;
}

function createInitialForm(): AgentForm {
  return {
    source: "projectSettings",
    agentType: "",
    whenToUse: "",
    tools: "*",
    model: "",
    systemPrompt: "",
  };
}

function editInitialForm(agent: AgentDefinition): AgentForm {
  return {
    source: agent.source === "plugin" || agent.source === "built-in"
      ? "projectSettings"
      : agent.source,
    agentType: agent.agentType,
    whenToUse: agent.whenToUse,
    tools: toolsText(agent),
    model: agent.model ?? "",
    systemPrompt: promptText(agent),
  };
}

function updateFormField(
  form: AgentForm,
  key: FormFieldKey,
  updater: (value: string) => string,
): AgentForm {
  switch (key) {
    case "agentType":
      return { ...form, agentType: updater(form.agentType) };
    case "whenToUse":
      return { ...form, whenToUse: updater(form.whenToUse) };
    case "tools":
      return { ...form, tools: updater(form.tools) };
    case "model":
      return { ...form, model: updater(form.model) };
    case "systemPrompt":
      return { ...form, systemPrompt: updater(form.systemPrompt) };
    case "source":
    case "save":
      return form;
  }
}

function cycleSource(source: SettingSource, direction: 1 | -1): SettingSource {
  const index = CREATE_SOURCES.indexOf(source);
  const nextIndex = index === -1
    ? 0
    : (index + direction + CREATE_SOURCES.length) % CREATE_SOURCES.length;
  return CREATE_SOURCES[nextIndex] ?? "projectSettings";
}

function formFields(form: AgentForm, mode: "create" | "edit"): readonly FormField[] {
  const rows: FormField[] = [];
  rows.push({
    key: "source",
    label: "source",
    value: getSourceDisplayName(form.source),
    editable: mode === "create",
    detail: mode === "create"
      ? "space or ←/→ cycles where the agent file will be written"
      : "source is fixed for existing agents",
  });
  rows.push({
    key: "agentType",
    label: "name",
    value: form.agentType,
    editable: mode === "create",
    detail: mode === "create"
      ? "lowercase role id, e.g. test-runner"
      : "agent names are fixed; create a new agent to rename",
  });
  rows.push({
    key: "whenToUse",
    label: "description",
    value: form.whenToUse,
    editable: true,
    detail: "short routing hint shown to the model and menus",
  });
  rows.push({
    key: "tools",
    label: "tools",
    value: form.tools,
    editable: true,
    detail: "comma-separated tool names, or * for default/all tools",
  });
  rows.push({
    key: "model",
    label: "model",
    value: form.model,
    editable: true,
    detail: "blank inherits the session model",
  });
  rows.push({
    key: "systemPrompt",
    label: "prompt",
    value: form.systemPrompt,
    editable: true,
    detail: "system prompt body; edit long prompts in the file after save",
  });
  rows.push({
    key: "save",
    label: "save",
    value: mode === "create" ? "create agent" : "save changes",
    editable: false,
    detail: "press enter or ctrl+s to validate and persist",
  });
  return rows;
}

function validationFor(
  form: AgentForm,
  allAgents: readonly AgentDefinition[],
  tools: Tools,
  mode: "create" | "edit",
): { readonly errors: readonly string[]; readonly warnings: readonly string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const trimmedName = form.agentType.trim();
  const typeError = validateAgentTypeValue(trimmedName);
  if (typeError) errors.push(typeError);
  if (
    mode === "create" &&
    allAgents.some(agent => agent.agentType === trimmedName)
  ) {
    errors.push(`Agent type "${trimmedName}" already exists`);
  }

  const description = form.whenToUse.trim();
  if (!description) {
    errors.push("Description (description) is required");
  } else if (description.length < 10) {
    warnings.push("Description should be more descriptive (at least 10 characters)");
  } else if (description.length > 5000) {
    warnings.push("Description is very long (over 5000 characters)");
  }

  const parsedTools = parseTools(form.tools);
  if (parsedTools === undefined) {
    warnings.push("Agent has access to all tools");
  } else if (parsedTools.length === 0) {
    warnings.push("No tools selected - agent will have very limited capabilities");
  }

  const availableToolNames = new Set(
    (tools as readonly { readonly name?: unknown }[])
      .map(tool => tool.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
  if (availableToolNames.size > 0 && parsedTools !== undefined) {
    const invalidTools = parsedTools.filter(tool => !availableToolNames.has(tool));
    if (invalidTools.length > 0) {
      errors.push(`Invalid tools: ${invalidTools.join(", ")}`);
    }
  }

  const systemPrompt = form.systemPrompt.trim();
  if (!systemPrompt) {
    errors.push("System prompt is required");
  } else if (systemPrompt.length < 20) {
    errors.push("System prompt is too short (minimum 20 characters)");
  } else if (systemPrompt.length > 10000) {
    warnings.push("System prompt is very long (over 10,000 characters)");
  }

  return {
    errors,
    warnings,
  };
}

function FieldValue({
  field,
  active,
}: {
  readonly field: FormField;
  readonly active: boolean;
}): React.ReactNode {
  const shown = field.value.length > 0 ? field.value : "—";
  const suffix = active && field.editable ? "█" : "";
  return (
    <ThemedText color={active ? "text" : "subtle"} wrap="truncate-middle">
      {`${shown}${suffix}`}
    </ThemedText>
  );
}

function DetailMeta({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.ReactNode {
  return (
    <Box flexDirection="row">
      <Box width={14}>
        <ThemedText color="muted3" wrap="truncate-end">{label}</ThemedText>
      </Box>
      <Box flexGrow={1} overflow="hidden">
        <ThemedText color="text2" wrap="wrap">{value}</ThemedText>
      </Box>
    </Box>
  );
}

function AgentDefinitionDetailBlock({
  agent,
  notice,
}: {
  readonly agent: AgentDefinition;
  readonly notice?: string;
}): React.ReactNode {
  return (
    <ThemedBox flexDirection="column" borderStyle="single" borderColor="lineSoft" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <ThemedText color="agenc" wrap="truncate-end">{agentIdentityLabel(agent)}</ThemedText>
        <ThemedText color="muted3" wrap="truncate-end">
          {editableAgent(agent) ? "editable" : "read-only"}
        </ThemedText>
      </Box>
      <DetailMeta label="when-to-use" value={compactText(agent.whenToUse, "No description.", 360)} />
      <DetailMeta label="tools" value={`${toolSummary(agent)} · skills ${skillSummary(agent)}`} />
      <DetailMeta label="model" value={`${resolveAgentModelDisplay(agent) ?? "inherit"} · provider ${providerSummary(agent)}`} />
      <DetailMeta label="budget" value={agentBudgetLabel(agent)} />
      <DetailMeta label="worktree" value={agentWorktreeLabel(agent)} />
      <ThemedText color="muted3">system prompt</ThemedText>
      <ThemedBox borderStyle="single" borderColor="lineSoft" paddingX={1}>
        <ThemedText color="text2" wrap="wrap">
          {compactText(promptText(agent), "No system prompt.", 720)}
        </ThemedText>
      </ThemedBox>
      {notice ? (
        <ThemedText color="agenc" wrap="wrap">{notice}</ThemedText>
      ) : null}
    </ThemedBox>
  );
}

function AgentsDefinitionsEditor({
  activeAgents,
  activeIndex,
  activeCount,
  displayRows,
  notice,
  registeredCount,
}: {
  readonly activeAgents: readonly AgentDefinition[];
  readonly activeIndex: number;
  readonly activeCount: number;
  readonly displayRows: readonly AgentRow[];
  readonly notice?: string;
  readonly registeredCount: number;
}): React.ReactNode {
  const { columns, rows } = useTerminalSize();
  const selected = displayRows[activeIndex] ?? displayRows[0];
  const viewportRows = Number.isFinite(rows) ? Math.max(12, Math.trunc(rows)) : 24;
  const maxVisibleRows = Math.max(1, Math.min(displayRows.length, viewportRows - 13));
  const windowStart = Math.min(
    Math.max(0, activeIndex - Math.floor(maxVisibleRows / 2)),
    Math.max(0, displayRows.length - maxVisibleRows),
  );
  const visibleRows = displayRows.slice(windowStart, windowStart + maxVisibleRows);
  const windowEnd = windowStart + visibleRows.length;
  const scrollStatus = displayRows.length > visibleRows.length
    ? ` · scroll ${windowStart + 1}-${windowEnd}/${displayRows.length}`
    : "";
  const nameWidth = columns >= 110 ? 30 : 24;
  const scopeWidth = columns >= 110 ? 16 : 12;
  const sourceWidth = columns >= 110 ? 20 : 16;

  return (
    <Popup
      title="agents"
      status={`${activeCount} delegate-capable · ${registeredCount} registered${scrollStatus}`}
      footer={[
        { keyName: "up/down", label: "select" },
        { keyName: "enter", label: "detail" },
        { keyName: "n", label: "new" },
        { keyName: "e", label: "edit" },
        { keyName: "d", label: "delete" },
        { keyName: "q", label: "close" },
      ]}
    >
      <Box flexDirection="column">
        <ThemedText color="muted3" wrap="truncate-end">
          {activeCount} delegate-capable · {registeredCount} registered · q/esc close
        </ThemedText>
        <Box flexDirection="row">
          <Box width={2} />
          <Box width={nameWidth}>
            <ThemedText color="muted3" wrap="truncate-end">name · Role</ThemedText>
          </Box>
          <Box width={scopeWidth}>
            <ThemedText color="muted3" wrap="truncate-end">scope</ThemedText>
          </Box>
          <Box width={sourceWidth}>
            <ThemedText color="muted3" wrap="truncate-end">source</ThemedText>
          </Box>
        </Box>
        {visibleRows.map((agent, visibleIndex) => {
          const index = windowStart + visibleIndex;
          const active = index === activeIndex;
          const status = statusFor(agent as ResolvedAgent, activeAgents);
          return (
            <ThemedBox
              key={`${agent.source}-${agent.agentType}-${index}`}
              flexDirection="row"
              backgroundColor={active ? "agencWash" : undefined}
            >
              <Box width={1}>
                <ThemedText color={active ? "agenc" : "lineSoft"}>{active ? "▌" : " "}</ThemedText>
              </Box>
              <Box width={1}>
                <ThemedText color={status.color}>{status.glyph}</ThemedText>
              </Box>
              <Box width={nameWidth}>
                <ThemedText color={active ? "agenc" : "text2"} wrap="truncate-end">
                  {agentIdentityLabel(agent)}
                </ThemedText>
              </Box>
              <Box width={scopeWidth}>
                <ThemedText color="text2" wrap="truncate-end">{agentScopeLabel(agent)}</ThemedText>
              </Box>
              <Box width={sourceWidth}>
                <ThemedText color="muted3" wrap="truncate-end">{sourceLabel(agent.source)}</ThemedText>
              </Box>
            </ThemedBox>
          );
        })}
        {selected && !selected.empty ? (
          <AgentDefinitionDetailBlock agent={selected} notice={notice} />
        ) : (
          <ThemedBox flexDirection="column" borderStyle="single" borderColor="lineSoft" paddingX={1} marginTop={1}>
            <ThemedText color="muted3">No agent definitions are registered.</ThemedText>
          </ThemedBox>
        )}
      </Box>
    </Popup>
  );
}

function AgentDetailModal({
  agent,
  notice,
}: {
  readonly agent: AgentDefinition;
  readonly notice?: string;
}): React.ReactNode {
  return (
    <Popup
      title={`agent detail · ${agentIdentityLabel(agent)}`}
      status="e edit · d delete · q close · esc back"
      footer={[
        { keyName: "e", label: "edit" },
        { keyName: "d", label: "delete" },
        { keyName: "q", label: "close" },
        { keyName: "esc", label: "back" },
      ]}
    >
      <AgentDefinitionDetailBlock agent={agent} notice={notice} />
    </Popup>
  );
}

function AgentDeleteModal({
  agent,
  activeIndex,
  error,
}: {
  readonly agent: AgentDefinition;
  readonly activeIndex: number;
  readonly error?: string;
}): React.ReactNode {
  const rows = [
    { label: "no", detail: "cancel and return to detail" },
    { label: "yes", detail: `delete ${getActualRelativeAgentFilePath(agent)}` },
  ] as const;
  return (
    <MenuModal
      title="delete agent"
      count={agent.agentType}
      summary={editableAgent(agent) ? "confirmation required" : "read-only"}
      headerRight="y/n · q close · enter"
      columns={[5, 80]}
      headers={["pick", "effect"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => [
        <ThemedText key="pick" color={active ? "error" : "text2"}>
          {row.label}
        </ThemedText>,
        <ThemedText key="detail" color="subtle" wrap="truncate-middle">
          {row.detail}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="error">Delete {agent.agentType}?</ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            This removes the agent markdown file and refreshes the active agent list.
          </ThemedText>
          {error ? <ThemedText color="error" wrap="wrap">{error}</ThemedText> : null}
        </Box>
      }
      footer={[
        { keyName: "y", label: "delete" },
        { keyName: "n", label: "cancel" },
        { keyName: "q", label: "close" },
        { keyName: "esc", label: "back" },
      ]}
      hint="built-in, plugin, and flag agents are read-only"
    />
  );
}

function AgentFormModal({
  mode,
  form,
  activeIndex,
  validation,
  notice,
}: {
  readonly mode: "create" | "edit";
  readonly form: AgentForm;
  readonly activeIndex: number;
  readonly validation: {
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  };
  readonly notice?: string;
}): React.ReactNode {
  const rows = formFields(form, mode);
  const selected = rows[activeIndex] ?? rows[0];
  const target = mode === "create"
    ? getNewRelativeAgentFilePath({
        source: form.source,
        agentType: form.agentType.trim() || "new-agent",
      })
    : "existing file";
  return (
    <MenuModal
      title={mode === "create" ? "create agent" : "edit agent"}
      count={form.agentType.trim() || "new"}
      summary={
        validation.errors.length > 0
          ? `${validation.errors.length} error(s)`
          : validation.warnings.length > 0
            ? `${validation.warnings.length} warning(s)`
            : "valid"
      }
      headerRight="type · ctrl+s save · ctrl+c close · esc"
      columns={[3, 15, 78]}
      headers={["", "field", "value"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(field, _index, active) => [
        <ThemedText key="mark" color={active ? "agenc" : "muted3"}>
          {active ? "▸" : field.editable ? "·" : " "}
        </ThemedText>,
        <ThemedText key="label" color={active ? "agenc" : "text2"} wrap="truncate-end">
          {field.label}
        </ThemedText>,
        <FieldValue key="value" field={field} active={active} />,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Validation</ThemedText>
          <ThemedText color="inactive" wrap="truncate-middle">
            file · {target}
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            {selected?.detail ?? "Choose a field."}
          </ThemedText>
          {validation.errors.map(error => (
            <ThemedText key={`error-${error}`} color="error" wrap="wrap">
              ! {error}
            </ThemedText>
          ))}
          {validation.warnings.map(warning => (
            <ThemedText key={`warning-${warning}`} color="worker" wrap="wrap">
              ! {warning}
            </ThemedText>
          ))}
          {notice ? (
            <ThemedText color={validation.errors.length > 0 ? "error" : "success"} wrap="wrap">
              {notice}
            </ThemedText>
          ) : null}
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "field" },
        { keyName: "type", label: "edit" },
        { keyName: "ctrl+s", label: "save" },
        { keyName: "ctrl+c", label: "close" },
        { keyName: "esc", label: "back" },
      ]}
      hint="space cycles source · backspace deletes"
    />
  );
}

function AgentsMenuModal({
  onDone,
  initialTools = [],
}: {
  readonly onDone: Done;
  readonly initialTools?: readonly unknown[];
}): React.ReactNode {
  const agentDefinitions = useAppState((state: AppState) => state.agentDefinitions);
  const setAppState = useSetAppState();
  const activeAgents = agentDefinitions.activeAgents;
  const rows = React.useMemo(
    () => sortAgents(resolveAgentOverrides(
      agentDefinitions.allAgents,
      agentDefinitions.activeAgents,
    )) as readonly AgentRow[],
    [agentDefinitions.activeAgents, agentDefinitions.allAgents],
  );
  const displayRows =
    rows.length > 0
      ? rows
      : [EMPTY_AGENT_ROW];
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [mode, setMode] = React.useState<AgentMode>({ name: "list" });
  const [formIndex, setFormIndex] = React.useState(0);
  const [deleteIndex, setDeleteIndex] = React.useState(0);
  const [form, setForm] = React.useState<AgentForm>(() => createInitialForm());
  const [notice, setNotice] = React.useState<string | undefined>();
  const [deleteError, setDeleteError] = React.useState<string | undefined>();
  const availableTools = initialTools as Tools;

  const selected = displayRows[activeIndex] ?? displayRows[0];
  const activeCount = rows.filter(row => !row.overriddenBy).length;
  const modeAgent = "agent" in mode
    ? currentAgent(mode.agent, agentDefinitions.allAgents)
    : undefined;
  const formMode = mode.name === "create" ? "create" : "edit";
  const validation = validationFor(
    form,
    agentDefinitions.allAgents,
    availableTools,
    formMode,
  );

  const enterDetail = React.useCallback((agent: AgentDefinition | undefined) => {
    if (!agent || (agent as AgentRow).empty) return;
    setNotice(undefined);
    setMode({ name: "detail", agent });
  }, []);

  const startCreate = React.useCallback(() => {
    setNotice(undefined);
    setForm(createInitialForm());
    setFormIndex(0);
    setMode({ name: "create" });
  }, []);

  const startEdit = React.useCallback((agent: AgentDefinition | undefined) => {
    if (!agent || !editableAgent(agent)) {
      setNotice("This agent source is read-only.");
      return;
    }
    setNotice(undefined);
    setForm(editInitialForm(agent));
    setFormIndex(2);
    setMode({ name: "edit", agent });
  }, []);

  const startDelete = React.useCallback((agent: AgentDefinition | undefined) => {
    if (!agent || !editableAgent(agent)) {
      setNotice("This agent source is read-only.");
      return;
    }
    setDeleteError(undefined);
    setDeleteIndex(0);
    setMode({ name: "delete", agent });
  }, []);

  const closeWithMessage = React.useCallback(() => {
    onDone(notice ?? "Agents dialog dismissed", {
      display: notice ? undefined : "system",
    });
  }, [notice, onDone]);

  const saveForm = React.useCallback(async () => {
    const currentValidation = validationFor(
      form,
      agentDefinitions.allAgents,
      availableTools,
      formMode,
    );
    if (currentValidation.errors.length > 0) {
      setNotice("Fix validation errors before saving.");
      return;
    }

    const trimmedName = form.agentType.trim();
    const trimmedDescription = form.whenToUse.trim();
    const trimmedPrompt = form.systemPrompt.trim();
    const parsedTools = parseTools(form.tools);
    const parsedModel = modelValue(form.model);

    try {
      if (mode.name === "create") {
        await saveAgentToFile(
          form.source,
          trimmedName,
          trimmedDescription,
          parsedTools,
          trimmedPrompt,
          true,
          undefined,
          parsedModel,
        );
        const created: AgentDefinition = {
          agentType: trimmedName,
          source: form.source,
          filename: trimmedName,
          whenToUse: trimmedDescription,
          tools: parsedTools,
          ...(parsedModel ? { model: parsedModel } : {}),
          getSystemPrompt: () => trimmedPrompt,
        };
        setAppState((state: unknown) => {
          const appState = state as AppState;
          const allAgents = [
            ...appState.agentDefinitions.allAgents.filter(agent => !sameAgent(agent, created)),
            created,
          ];
          return {
            ...appState,
            agentDefinitions: {
              ...appState.agentDefinitions,
              allAgents,
              activeAgents: getActiveAgentsFromList(allAgents),
            },
          };
        });
        setNotice(`Created agent: ${trimmedName}`);
        setMode({ name: "list" });
        return;
      }

      if (!modeAgent || !editableAgent(modeAgent)) {
        setNotice("This agent source is read-only.");
        return;
      }
      await updateAgentFile(
        modeAgent,
        trimmedDescription,
        parsedTools,
        trimmedPrompt,
        modeAgent.color,
        parsedModel,
        modeAgent.memory,
        modeAgent.effort as never,
      );
      const updated: AgentDefinition = {
        ...modeAgent,
        whenToUse: trimmedDescription,
        tools: parsedTools,
        model: parsedModel,
        getSystemPrompt: () => trimmedPrompt,
      };
      setAppState((state: unknown) => {
        const appState = state as AppState;
        const allAgents = appState.agentDefinitions.allAgents.map(agent =>
          sameAgent(agent, modeAgent) ? updated : agent,
        );
        return {
          ...appState,
          agentDefinitions: {
            ...appState.agentDefinitions,
            allAgents,
            activeAgents: getActiveAgentsFromList(allAgents),
          },
        };
      });
      setNotice(`Updated agent: ${modeAgent.agentType}`);
      setMode({ name: "detail", agent: updated });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [
    agentDefinitions.allAgents,
    availableTools,
    form,
    formMode,
    mode.name,
    modeAgent,
    setAppState,
  ]);

  const confirmDelete = React.useCallback(async () => {
    if (!modeAgent || !editableAgent(modeAgent)) {
      setDeleteError("This agent source is read-only.");
      return;
    }
    try {
      await deleteAgentFromFile(modeAgent);
      setAppState((state: unknown) => {
        const appState = state as AppState;
        const allAgents = appState.agentDefinitions.allAgents.filter(
          agent => !sameAgent(agent, modeAgent),
        );
        return {
          ...appState,
          agentDefinitions: {
            ...appState.agentDefinitions,
            allAgents,
            activeAgents: getActiveAgentsFromList(allAgents),
          },
        };
      });
      setNotice(`Deleted agent: ${modeAgent.agentType}`);
      setMode({ name: "list" });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    }
  }, [modeAgent, setAppState]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      closeWithMessage();
      return;
    }

    if (mode.name === "list") {
      if (key.escape || input === "q") {
        closeWithMessage();
        return;
      }
      if (input === "n") {
        startCreate();
        return;
      }
      if (key.return) {
        enterDetail(selected);
        return;
      }
      if (input === "e") {
        startEdit(selected);
        return;
      }
      if (input === "d") {
        startDelete(selected);
        return;
      }
      if (key.upArrow || input === "k") {
        setActiveIndex(index => previousMenuIndex(index, displayRows.length));
        return;
      }
      if (key.downArrow || input === "j") {
        setActiveIndex(index => nextMenuIndex(index, displayRows.length));
      }
      return;
    }

    if (mode.name === "detail") {
      if (input === "q") {
        closeWithMessage();
        return;
      }
      if (key.escape) {
        setMode({ name: "list" });
        return;
      }
      if (input === "e") {
        startEdit(modeAgent);
        return;
      }
      if (input === "d") {
        startDelete(modeAgent);
      }
      return;
    }

    if (mode.name === "delete") {
      if (input === "q") {
        closeWithMessage();
        return;
      }
      if (key.escape || input === "n") {
        setMode({ name: "detail", agent: mode.agent });
        return;
      }
      if (input === "y") {
        void confirmDelete();
        return;
      }
      if (key.upArrow || key.downArrow || input === "j" || input === "k") {
        setDeleteIndex(index => index === 0 ? 1 : 0);
        return;
      }
      if (key.return) {
        if (deleteIndex === 1) void confirmDelete();
        else setMode({ name: "detail", agent: mode.agent });
      }
      return;
    }

    const fields = formFields(form, mode.name);
    const selectedField = fields[formIndex] ?? fields[0];
    if (!selectedField) return;

    if (key.escape) {
      if (mode.name === "edit" && modeAgent) {
        setMode({ name: "detail", agent: modeAgent });
      } else {
        setMode({ name: "list" });
      }
      return;
    }
    if (key.upArrow || input === "k") {
      setFormIndex(index => previousMenuIndex(index, fields.length));
      return;
    }
    if (key.downArrow || input === "j" || key.tab) {
      setFormIndex(index => nextMenuIndex(index, fields.length));
      return;
    }
    if (input === "s" && key.ctrl) {
      void saveForm();
      return;
    }
    if (selectedField.key === "source" && selectedField.editable) {
      if (input === " " || key.rightArrow || key.leftArrow) {
        setForm(current => ({
          ...current,
          source: cycleSource(current.source, key.leftArrow ? -1 : 1),
        }));
      }
      return;
    }
    if (selectedField.key === "save") {
      if (key.return) void saveForm();
      return;
    }
    if (!selectedField.editable) return;
    if (key.return) {
      setFormIndex(index => nextMenuIndex(index, fields.length));
      return;
    }
    if (key.backspace || key.delete) {
      setForm(current =>
        updateFormField(current, selectedField.key, value => value.slice(0, -1)),
      );
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.escape) {
      setForm(current =>
        updateFormField(current, selectedField.key, value => `${value}${input}`),
      );
    }
  });

  if (mode.name === "detail" && modeAgent) {
    return <AgentDetailModal agent={modeAgent} notice={notice} />;
  }

  if (mode.name === "delete" && modeAgent) {
    return (
      <AgentDeleteModal
        agent={modeAgent}
        activeIndex={deleteIndex}
        error={deleteError}
      />
    );
  }

  if (mode.name === "create" || mode.name === "edit") {
    return (
      <AgentFormModal
        mode={mode.name}
        form={form}
        activeIndex={formIndex}
        validation={validation}
        notice={notice}
      />
    );
  }

  return (
    <AgentsDefinitionsEditor
      activeAgents={activeAgents}
      activeCount={activeCount}
      activeIndex={activeIndex}
      displayRows={displayRows}
      notice={notice}
      registeredCount={rows.length}
    />
  );
}

export function openAgentsMenu(ctx: SlashCommandContext): boolean {
  return openLocalJsxCommand(ctx, close => (
    <AgentsMenuModal onDone={close} initialTools={ctx.appState?.tools ?? []} />
  ));
}
