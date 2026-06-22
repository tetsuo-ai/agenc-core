import React from "react";

import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { KeyHint, MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";
import type {
  McpMenuController,
  McpServerStatus,
  McpToolStatus,
} from "./mcp.js";

type McpMode =
  | { readonly name: "list" }
  | { readonly name: "detail"; readonly serverName: string }
  | { readonly name: "tools"; readonly serverName: string }
  | {
      readonly name: "tool";
      readonly serverName: string;
      readonly tool: McpToolStatus;
    }
  | { readonly name: "add" }
  | { readonly name: "create" };

type McpServerRow = McpServerStatus & {
  readonly target: string;
  readonly toolCount: number;
  readonly empty?: boolean;
};

type AddForm = {
  readonly serverName: string;
  readonly commandLine: string;
};

type CreateForm = {
  readonly serverName: string;
  readonly toolName: string;
  readonly description: string;
};

type Field = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly editable: boolean;
  readonly detail: string;
};

const EMPTY_ROW: McpServerRow = {
  name: "none",
  enabled: false,
  required: false,
  state: "disconnected",
  target: "no MCP servers configured",
  toolCount: 0,
  empty: true,
};

function serverRows(
  servers: readonly McpServerStatus[],
  toolsByServer: ReadonlyMap<string, readonly McpToolStatus[]>,
): readonly McpServerRow[] {
  return servers.map(server => ({
    ...server,
    target: server.url ?? server.command ?? "local",
    toolCount: toolsByServer.get(server.name)?.length ?? 0,
  }));
}

function compactText(value: string | undefined, limit = 92): string {
  const normalized = (value ?? "").replace(/\s+/gu, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
}

function stateColor(
  state: McpServerStatus["state"],
): "success" | "error" | "worker" | "inactive" | "agenc" {
  switch (state) {
    case "connected":
      return "success";
    case "failed":
      return "error";
    case "needs-auth":
      return "worker";
    case "pending":
      return "agenc";
    case "disabled":
      return "inactive";
    case "disconnected":
      return "worker";
  }
}

function stateGlyph(state: McpServerStatus["state"]): string {
  switch (state) {
    case "connected":
      return "◆";
    case "failed":
      return "!";
    case "needs-auth":
      return "◇";
    case "pending":
      return "◐";
    case "disabled":
      return "·";
    case "disconnected":
      return "◇";
  }
}

function sameServer(
  rows: readonly McpServerRow[],
  serverName: string,
): McpServerRow | undefined {
  return rows.find(row => row.name === serverName);
}

function addFields(form: AddForm): readonly Field[] {
  return [
    {
      key: "serverName",
      label: "server",
      value: form.serverName,
      editable: true,
      detail: "server id, e.g. github or local-tools",
    },
    {
      key: "commandLine",
      label: "command",
      value: form.commandLine,
      editable: true,
      detail: "stdio command and args, e.g. node ./server.mjs",
    },
    {
      key: "save",
      label: "add",
      value: "connect for this session",
      editable: false,
      detail: "adds/imports a stdio server without editing config.toml",
    },
  ];
}

function createFields(form: CreateForm): readonly Field[] {
  return [
    {
      key: "serverName",
      label: "server",
      value: form.serverName,
      editable: true,
      detail: "new project server id",
    },
    {
      key: "toolName",
      label: "tool",
      value: form.toolName,
      editable: true,
      detail: "first tool name exposed by the scaffold",
    },
    {
      key: "description",
      label: "description",
      value: form.description,
      editable: true,
      detail: "tool description and response text",
    },
    {
      key: "save",
      label: "create",
      value: "scaffold and connect",
      editable: false,
      detail: "writes .agenc/mcp/<server>.mjs and connects it for this session",
    },
  ];
}

function addValidation(form: AddForm): readonly string[] {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9_-]+$/u.test(form.serverName.trim())) {
    errors.push("Server name must use only letters, numbers, hyphens, and underscores.");
  }
  if (form.commandLine.trim().length === 0) {
    errors.push("Command is required.");
  }
  return errors;
}

function createValidation(form: CreateForm): readonly string[] {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9_-]+$/u.test(form.serverName.trim())) {
    errors.push("Server name must use only letters, numbers, hyphens, and underscores.");
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(form.toolName.trim())) {
    errors.push("Tool name must start with a letter and contain only letters, numbers, hyphens, and underscores.");
  }
  if (form.description.trim().length === 0) {
    errors.push("Description is required.");
  }
  return errors;
}

function updateAddField(
  form: AddForm,
  key: string,
  updater: (value: string) => string,
): AddForm {
  if (key === "serverName") return { ...form, serverName: updater(form.serverName) };
  if (key === "commandLine") return { ...form, commandLine: updater(form.commandLine) };
  return form;
}

function updateCreateField(
  form: CreateForm,
  key: string,
  updater: (value: string) => string,
): CreateForm {
  if (key === "serverName") return { ...form, serverName: updater(form.serverName) };
  if (key === "toolName") return { ...form, toolName: updater(form.toolName) };
  if (key === "description") return { ...form, description: updater(form.description) };
  return form;
}

function FormModal({
  title,
  count,
  fields,
  activeIndex,
  errors,
  feedback,
}: {
  readonly title: string;
  readonly count: string;
  readonly fields: readonly Field[];
  readonly activeIndex: number;
  readonly errors: readonly string[];
  readonly feedback?: string;
}): React.ReactNode {
  const selected = fields[activeIndex] ?? fields[0];
  return (
    <MenuModal
      title={title}
      count={count}
      summary={errors.length > 0 ? `${errors.length} error(s)` : "ready"}
      headerRight="type · ctrl+s save · esc"
      columns={[3, 14, 82]}
      headers={["", "field", "value"]}
      items={fields}
      activeIndex={activeIndex}
      renderRow={(field, _index, active) => [
        <ThemedText key="mark" color={active ? "agenc" : "muted3"}>
          {active ? "▸" : field.editable ? "·" : " "}
        </ThemedText>,
        <ThemedText key="field" color={active ? "agenc" : "text2"} wrap="truncate-end">
          {field.label}
        </ThemedText>,
        <ThemedText key="value" color={active ? "text" : "subtle"} wrap="truncate-middle">
          {`${field.value || "—"}${active && field.editable ? "█" : ""}`}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">MCP Input</ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            {selected?.detail ?? "Choose a field."}
          </ThemedText>
          {errors.map(error => (
            <ThemedText key={error} color="error" wrap="wrap">! {error}</ThemedText>
          ))}
          {feedback ? <ThemedText color="worker" wrap="wrap">{feedback}</ThemedText> : null}
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "field" },
        { keyName: "type", label: "edit" },
        { keyName: "ctrl+s", label: "save" },
      ]}
      hint="session changes do not persist unless noted"
    />
  );
}

function McpMenuView({
  initialServers,
  initialToolsByServer,
  controller,
  onDone,
}: {
  readonly initialServers: readonly McpServerStatus[];
  readonly initialToolsByServer: ReadonlyMap<string, readonly McpToolStatus[]>;
  readonly controller: McpMenuController;
  readonly onDone: () => void;
}): React.ReactNode {
  const [servers, setServers] = React.useState(initialServers);
  const [toolsByServer, setToolsByServer] = React.useState(initialToolsByServer);
  const rows = React.useMemo(
    () => serverRows(servers, toolsByServer),
    [servers, toolsByServer],
  );
  const displayRows = rows.length > 0 ? rows : [EMPTY_ROW];
  const [mode, setMode] = React.useState<McpMode>({ name: "list" });
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [toolIndex, setToolIndex] = React.useState(0);
  const [formIndex, setFormIndex] = React.useState(0);
  const [addForm, setAddForm] = React.useState<AddForm>({
    serverName: "",
    commandLine: "",
  });
  const [createForm, setCreateForm] = React.useState<CreateForm>({
    serverName: "",
    toolName: "ping",
    description: "Return a simple response.",
  });
  const [feedback, setFeedback] = React.useState<string | undefined>();
  const selected = displayRows[activeIndex] ?? displayRows[0];
  const selectedServer = mode.name === "detail" || mode.name === "tools" || mode.name === "tool"
    ? sameServer(rows, mode.serverName) ?? selected
    : selected;
  const selectedTools = selectedServer && !selectedServer.empty
    ? toolsByServer.get(selectedServer.name) ?? []
    : [];

  const refresh = React.useCallback(async () => {
    const snapshot = await controller.refresh();
    setServers(snapshot.servers);
    setToolsByServer(snapshot.toolsByServer);
  }, [controller]);

  const runMutation = React.useCallback(async (action: () => Promise<string>) => {
    try {
      const message = await action();
      setFeedback(message);
      await refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  }, [refresh]);

  const toggleSelected = React.useCallback(() => {
    if (!selectedServer || selectedServer.empty) {
      setFeedback("No MCP server selected.");
      return;
    }
    void runMutation(() =>
      selectedServer.state === "disabled" || !selectedServer.enabled
        ? controller.enable(selectedServer.name)
        : controller.disable(selectedServer.name),
    );
  }, [controller, runMutation, selectedServer]);

  const reconnectSelected = React.useCallback(() => {
    if (!selectedServer || selectedServer.empty) {
      setFeedback("No MCP server selected.");
      return;
    }
    void runMutation(() => controller.reconnect(selectedServer.name));
  }, [controller, runMutation, selectedServer]);

  const saveAdd = React.useCallback(() => {
    const errors = addValidation(addForm);
    if (errors.length > 0) {
      setFeedback("Fix validation errors before adding.");
      return;
    }
    void runMutation(() =>
      controller.add(addForm.serverName.trim(), addForm.commandLine.trim()),
    );
    setMode({ name: "list" });
  }, [addForm, controller, runMutation]);

  const saveCreate = React.useCallback(() => {
    const errors = createValidation(createForm);
    if (errors.length > 0) {
      setFeedback("Fix validation errors before creating.");
      return;
    }
    void runMutation(() =>
      controller.create(
        createForm.serverName.trim(),
        createForm.toolName.trim(),
        createForm.description.trim(),
      ),
    );
    setMode({ name: "list" });
  }, [controller, createForm, runMutation]);

  useInput((input, key) => {
    if (mode.name === "list") {
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
      if (key.return || input === "l") {
        if (!selected.empty) setMode({ name: "detail", serverName: selected.name });
        return;
      }
      if (input === "t") {
        if (!selected.empty) {
          setToolIndex(0);
          setMode({ name: "tools", serverName: selected.name });
        }
        return;
      }
      if (input === "x") {
        toggleSelected();
        return;
      }
      if (input === "r") {
        reconnectSelected();
        return;
      }
      if (input === "a" || input === "i") {
        setAddForm({ serverName: "", commandLine: "" });
        setFormIndex(0);
        setMode({ name: "add" });
        return;
      }
      if (input === "n") {
        setCreateForm({
          serverName: "",
          toolName: "ping",
          description: "Return a simple response.",
        });
        setFormIndex(0);
        setMode({ name: "create" });
      }
      return;
    }

    if (mode.name === "detail") {
      if (key.escape || input === "h") {
        setMode({ name: "list" });
        return;
      }
      if (input === "q") {
        onDone();
        return;
      }
      if (input === "t") {
        setToolIndex(0);
        setMode({ name: "tools", serverName: mode.serverName });
        return;
      }
      if (input === "x") {
        toggleSelected();
        return;
      }
      if (input === "r") {
        reconnectSelected();
      }
      return;
    }

    if (mode.name === "tools") {
      if (key.escape || input === "h") {
        setMode({ name: "detail", serverName: mode.serverName });
        return;
      }
      if (input === "q") {
        onDone();
        return;
      }
      if (key.upArrow || input === "k") {
        setToolIndex(index => previousMenuIndex(index, Math.max(1, selectedTools.length)));
        return;
      }
      if (key.downArrow || input === "j") {
        setToolIndex(index => nextMenuIndex(index, Math.max(1, selectedTools.length)));
        return;
      }
      if (key.return || input === "l") {
        const tool = selectedTools[toolIndex];
        if (tool) setMode({ name: "tool", serverName: mode.serverName, tool });
      }
      return;
    }

    if (mode.name === "tool") {
      if (key.escape || input === "h") {
        setMode({ name: "tools", serverName: mode.serverName });
        return;
      }
      if (input === "q") onDone();
      return;
    }

    const addMode = mode.name === "add";
    const fields = addMode ? addFields(addForm) : createFields(createForm);
    const field = fields[formIndex] ?? fields[0];
    if (!field) return;
    if (key.escape) {
      setMode({ name: "list" });
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
      if (addMode) saveAdd();
      else saveCreate();
      return;
    }
    if (field.key === "save") {
      if (key.return) {
        if (addMode) saveAdd();
        else saveCreate();
      }
      return;
    }
    if (key.return) {
      setFormIndex(index => nextMenuIndex(index, fields.length));
      return;
    }
    if (key.backspace || key.delete) {
      if (addMode) {
        setAddForm(current =>
          updateAddField(current, field.key, value => value.slice(0, -1)),
        );
      } else {
        setCreateForm(current =>
          updateCreateField(current, field.key, value => value.slice(0, -1)),
        );
      }
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.escape) {
      if (addMode) {
        setAddForm(current =>
          updateAddField(current, field.key, value => `${value}${input}`),
        );
      } else {
        setCreateForm(current =>
          updateCreateField(current, field.key, value => `${value}${input}`),
        );
      }
    }
  });

  if (mode.name === "add") {
    return (
      <FormModal
        title="mcp add/import"
        count={addForm.serverName || "new"}
        fields={addFields(addForm)}
        activeIndex={formIndex}
        errors={addValidation(addForm)}
        feedback={feedback}
      />
    );
  }

  if (mode.name === "create") {
    return (
      <FormModal
        title="mcp new"
        count={createForm.serverName || "new"}
        fields={createFields(createForm)}
        activeIndex={formIndex}
        errors={createValidation(createForm)}
        feedback={feedback}
      />
    );
  }

  if (mode.name === "tool") {
    return (
      <MenuModal
        title="mcp tool"
        count={mode.tool.name}
        summary={mode.serverName}
        headerRight="esc tools"
        columns={[14, 88]}
        headers={["field", "value"]}
        items={[
          ["server", mode.serverName],
          ["name", mode.tool.name],
          ["description", mode.tool.description ?? "—"],
        ] as const}
        activeIndex={0}
        renderRow={row => [
          <ThemedText key="field" color="inactive" wrap="truncate-end">{row[0]}</ThemedText>,
          <ThemedText key="value" color="text2" wrap="wrap">{row[1]}</ThemedText>,
        ]}
        footer={[{ keyName: "esc", label: "tools" }]}
        hint="tool schema is available through the live MCP manager"
      />
    );
  }

  if (mode.name === "tools") {
    const toolRows = selectedTools.length > 0
      ? selectedTools
      : [{ name: "none", description: "No tools available for this server." }];
    return (
      <MenuModal
        title="mcp tools"
        count={selectedServer?.name ?? mode.serverName}
        summary={`${selectedTools.length} tool(s)`}
        headerRight="enter detail · esc server"
        columns={[34, 78]}
        headers={["tool", "description"]}
        items={toolRows}
        activeIndex={toolIndex}
        renderRow={(tool, _index, active) => [
          <ThemedText key="name" color={active ? "agenc" : "text2"} wrap="truncate-end">
            {tool.name}
          </ThemedText>,
          <ThemedText key="description" color="subtle" wrap="truncate-end">
            {compactText(tool.description, 76)}
          </ThemedText>,
        ]}
        preview={
          <Box flexDirection="column" gap={1}>
            <ThemedText color="agenc">{selectedServer?.name ?? mode.serverName}</ThemedText>
            <ThemedText color="subtle" wrap="wrap">
              Tool lists are windowed inside the viewport. Press enter for details.
            </ThemedText>
            {feedback ? <ThemedText color="worker" wrap="wrap">{feedback}</ThemedText> : null}
          </Box>
        }
        footer={[
          { keyName: "up/down", label: "select" },
          { keyName: "enter", label: "detail" },
          { keyName: "esc", label: "server" },
        ]}
        hint="scroll position appears when tools exceed the viewport"
      />
    );
  }

  if (mode.name === "detail") {
    const row = selectedServer ?? EMPTY_ROW;
    const details = [
      ["name", row.name],
      ["state", row.state],
      ["enabled", row.enabled ? "yes" : "no"],
      ["required", row.required ? "yes" : "no"],
      ["target", row.target],
      ["tools", String(row.toolCount)],
      ["error", row.error ?? "—"],
    ] as const;
    return (
      <MenuModal
        title="mcp server"
        count={row.name}
        summary={row.state}
        headerRight="t tools · x toggle · r reconnect"
        columns={[14, 88]}
        headers={["field", "value"]}
        items={details}
        activeIndex={0}
        renderRow={detail => [
          <ThemedText key="field" color="inactive" wrap="truncate-end">{detail[0]}</ThemedText>,
          <ThemedText key="value" color={detail[0] === "state" ? stateColor(row.state) : "text2"} wrap="truncate-middle">
            {detail[1]}
          </ThemedText>,
        ]}
        preview={
          <Box flexDirection="column" gap={1}>
            <ThemedText color={stateColor(row.state)}>{stateGlyph(row.state)} {row.state}</ThemedText>
            <ThemedText color="subtle" wrap="wrap">
              {row.target}
            </ThemedText>
            {row.error ? <ThemedText color="error" wrap="wrap">{row.error}</ThemedText> : null}
            {feedback ? <ThemedText color="worker" wrap="wrap">{feedback}</ThemedText> : null}
            <Box flexDirection="row" gap={2} flexWrap="wrap">
              <KeyHint k="t" label="tools" />
              <KeyHint k="x" label={row.state === "disabled" ? "enable" : "disable"} />
              <KeyHint k="r" label="reconnect" />
            </Box>
          </Box>
        }
        footer={[
          { keyName: "t", label: "tools" },
          { keyName: "x", label: row.state === "disabled" ? "enable" : "disable" },
          { keyName: "r", label: "reconnect" },
          { keyName: "esc", label: "back" },
        ]}
        hint="actions use the live session MCP manager"
      />
    );
  }

  return (
    <MenuModal
      title="mcp"
      count={`${servers.length}`}
      summary={`${rows.filter(row => row.state === "connected").length} connected`}
      headerRight="enter detail · a add · n new"
      columns={[3, 14, 22, 8, 36, 10]}
      headers={["", "state", "server", "tools", "target", "required"]}
      items={displayRows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => {
        const color = stateColor(row.state);
        return [
          <ThemedText key="mark" color={color}>
            {stateGlyph(row.state)}
          </ThemedText>,
          <ThemedText key="state" color={color} wrap="truncate-end">
            {row.empty ? "none" : row.state}
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
            Detail, tools, enable/disable, reconnect, add/import, and scaffold flows use the session MCP manager.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.name ?? "none"}
          </ThemedText>
          {selected && !selected.empty ? (
            <ThemedText color={stateColor(selected.state)} wrap="wrap">
              {selected.state}{selected.error ? ` · ${selected.error}` : ""}
            </ThemedText>
          ) : (
            <ThemedText color="inactive" wrap="wrap">
              No servers configured. Press n to scaffold or a to add/import.
            </ThemedText>
          )}
          {feedback ? <ThemedText color="worker" wrap="wrap">{feedback}</ThemedText> : null}
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <KeyHint k="enter" label="detail" />
            <KeyHint k="t" label="tools" />
            <KeyHint k="a/i" label="add/import" />
            <KeyHint k="n" label="new" />
          </Box>
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "enter", label: "detail" },
        { keyName: "t", label: "tools" },
        { keyName: "x", label: "toggle" },
        { keyName: "r", label: "reconnect" },
        { keyName: "a/i", label: "add/import" },
        { keyName: "n", label: "new" },
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
  controller: McpMenuController,
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <McpMenuView
      initialServers={servers}
      initialToolsByServer={toolsByServer}
      controller={controller}
      onDone={close}
    />
  ));
}
