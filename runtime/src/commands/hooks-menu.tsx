import React from "react";

import { HOOK_EVENT_NAMES, type HookEventName } from "../config/schema.js";
import type {
  ConfiguredHooksRuntime,
  HookRunDiagnostic,
  IndividualHookConfig,
} from "../hooks/configured-hooks.js";
import {
  groupHooksByEvent,
  hookDisplayText,
} from "../hooks/configured-hooks.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedBox from "../tui/components/design-system/ThemedBox.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { KeyHint, MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

type Done = (
  result?: string,
  options?: { readonly display?: "system" },
) => void;

type HookRowStatus = "active" | "empty" | "disabled" | "issue";

type HooksMode =
  | { readonly name: "events" }
  | { readonly name: "hooks"; readonly event: HookEventName }
  | { readonly name: "detail"; readonly hook: IndividualHookConfig }
  | { readonly name: "edit"; readonly hook: IndividualHookConfig };

type HookEventRow = {
  readonly event: HookEventName;
  readonly count: number;
  readonly status: HookRowStatus;
  readonly matcher: string;
  readonly detail: string;
  readonly hooks: readonly IndividualHookConfig[];
  readonly latest?: HookRunDiagnostic;
};

type HookEditForm = {
  readonly command: string;
  readonly timeoutMs: string;
  readonly enabled: boolean;
};

type HookEditFieldKey = "command" | "timeoutMs" | "enabled" | "test";

type HookEditField = {
  readonly key: HookEditFieldKey;
  readonly label: string;
  readonly value: string;
  readonly editable: boolean;
  readonly detail: string;
};

function hookEventSummary(event: HookEventName): {
  readonly matcher: string;
  readonly summary: string;
} {
  switch (event) {
    case "PreToolUse":
      return { matcher: "tool_name", summary: "before tool execution" };
    case "PostToolUse":
      return { matcher: "tool_name", summary: "after tool execution" };
    case "PostToolUseFailure":
      return { matcher: "tool_name", summary: "after tool failure" };
    case "PermissionRequest":
      return { matcher: "tool_name", summary: "permission dialog" };
    case "UserPromptSubmit":
      return { matcher: "-", summary: "prompt submission" };
    case "SessionStart":
      return { matcher: "source", summary: "session start" };
    case "Stop":
      return { matcher: "-", summary: "response stop" };
    case "StopFailure":
      return { matcher: "error", summary: "turn API failure" };
    case "PreCompact":
      return { matcher: "trigger", summary: "before compaction" };
    case "PostCompact":
      return { matcher: "trigger", summary: "after compaction" };
  }
}

function statusColor(status: HookRowStatus): "success" | "inactive" | "error" | "agenc" {
  switch (status) {
    case "active":
      return "success";
    case "issue":
      return "error";
    case "disabled":
      return "inactive";
    case "empty":
      return "agenc";
  }
}

function statusGlyph(status: HookRowStatus): string {
  switch (status) {
    case "active":
      return "◆";
    case "issue":
      return "!";
    case "disabled":
      return "◇";
    case "empty":
      return "·";
  }
}

function diagColor(
  diag: HookRunDiagnostic | undefined,
): "success" | "error" | "worker" | "inactive" {
  if (!diag) return "inactive";
  if (diag.status === "success") return "success";
  if (diag.status === "blocking") return "worker";
  return "error";
}

function firstLine(value: string | undefined): string {
  return (value ?? "").split(/\r?\n/u, 1)[0]?.trim() ?? "";
}

function compactPath(value: string | undefined): string {
  const source = value ?? ".agenc/hooks";
  const marker = source.includes(".agenc/hooks") ? ".agenc/hooks" : source;
  return marker.length <= 30 ? marker : `…${marker.slice(-29)}`;
}

function EventChips({
  selected,
}: {
  readonly selected: HookEventName;
}): React.ReactNode {
  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {HOOK_EVENT_NAMES.slice(0, 6).map(event => (
        <ThemedBox
          key={event}
          borderStyle="single"
          borderColor={event === selected ? "agenc" : "lineSoft"}
          paddingX={1}
        >
          <ThemedText color={event === selected ? "agenc" : "muted3"}>{event}</ThemedText>
        </ThemedBox>
      ))}
    </Box>
  );
}

function latestForHook(
  hook: IndividualHookConfig,
  diagnostics: readonly HookRunDiagnostic[],
): HookRunDiagnostic | undefined {
  return [...diagnostics]
    .reverse()
    .find(diag =>
      diag.event === hook.event &&
      diag.command === hook.command.command &&
      (diag.matcher ?? "") === (hook.matcher ?? ""),
    );
}

function latestForHooks(
  hooks: readonly IndividualHookConfig[],
  diagnostics: readonly HookRunDiagnostic[],
): HookRunDiagnostic | undefined {
  for (const diag of [...diagnostics].reverse()) {
    if (
      hooks.some(hook =>
        diag.event === hook.event &&
        diag.command === hook.command.command &&
        (diag.matcher ?? "") === (hook.matcher ?? ""),
      )
    ) {
      return diag;
    }
  }
  return undefined;
}

function hookRows(
  runtime: ConfiguredHooksRuntime,
  diagnostics: readonly HookRunDiagnostic[],
): readonly HookEventRow[] {
  const grouped = groupHooksByEvent(runtime.listHooks());
  const hasIssues = runtime.issues().length > 0;
  return HOOK_EVENT_NAMES.map((event) => {
    const hooks = grouped.get(event) ?? [];
    const meta = hookEventSummary(event);
    const firstHook = hooks[0];
    const status: HookRowStatus = runtime.isDisabled()
      ? "disabled"
      : hasIssues
        ? "issue"
        : hooks.length > 0
          ? "active"
          : "empty";
    return {
      event,
      count: hooks.length,
      status,
      matcher: meta.matcher,
      detail: firstHook ? hookDisplayText(firstHook) : meta.summary,
      hooks,
      latest: latestForHooks(hooks, diagnostics),
    };
  });
}

function hooksForEvent(
  runtime: ConfiguredHooksRuntime,
  event: HookEventName,
): readonly IndividualHookConfig[] {
  return runtime.listHooks().filter(hook => hook.event === event);
}

function currentHook(
  hook: IndividualHookConfig,
  runtime: ConfiguredHooksRuntime,
): IndividualHookConfig {
  return runtime.listHooks().find(candidate =>
    candidate.event === hook.event &&
    candidate.index === hook.index &&
    candidate.command.command === hook.command.command,
  ) ?? hook;
}

function hookEnabledText(
  runtime: ConfiguredHooksRuntime,
  hook: IndividualHookConfig,
): string {
  if (runtime.isDisabled()) return "session off";
  return hook.enabled ? "on" : "off";
}

function formatDiagnostic(diag: HookRunDiagnostic): string {
  const code = diag.exitCode === undefined ? "" : ` exit=${diag.exitCode}`;
  const output = firstLine(diag.stderr) || firstLine(diag.stdout) || diag.error;
  return `${diag.status}${code} · ${diag.durationMs}ms${output ? ` · ${output}` : ""}`;
}

function createEditForm(hook: IndividualHookConfig): HookEditForm {
  return {
    command: hook.command.command,
    timeoutMs: String(hook.command.timeout_ms ?? 60_000),
    enabled: hook.enabled,
  };
}

function editFields(form: HookEditForm): readonly HookEditField[] {
  return [
    {
      key: "command",
      label: "command",
      value: form.command,
      editable: true,
      detail: "shell command to test with this hook input",
    },
    {
      key: "timeoutMs",
      label: "timeout",
      value: form.timeoutMs,
      editable: true,
      detail: "timeout in milliseconds",
    },
    {
      key: "enabled",
      label: "enabled",
      value: form.enabled ? "true" : "false",
      editable: true,
      detail: "space toggles the test draft enabled flag",
    },
    {
      key: "test",
      label: "test",
      value: "run draft command",
      editable: false,
      detail: "press enter or ctrl+s to run this draft without writing config",
    },
  ];
}

function editValidation(form: HookEditForm): readonly string[] {
  const errors: string[] = [];
  if (form.command.trim().length === 0) {
    errors.push("Command is required.");
  }
  const timeout = Number.parseInt(form.timeoutMs, 10);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    errors.push("Timeout must be a positive integer.");
  }
  return errors;
}

function updateEditField(
  form: HookEditForm,
  key: HookEditFieldKey,
  updater: (value: string) => string,
): HookEditForm {
  switch (key) {
    case "command":
      return { ...form, command: updater(form.command) };
    case "timeoutMs":
      return { ...form, timeoutMs: updater(form.timeoutMs).replace(/[^\d]/gu, "") };
    case "enabled":
    case "test":
      return form;
  }
}

function draftHook(
  hook: IndividualHookConfig,
  form: HookEditForm,
): IndividualHookConfig {
  return {
    ...hook,
    enabled: form.enabled,
    command: {
      ...hook.command,
      command: form.command.trim(),
      timeout_ms: Number.parseInt(form.timeoutMs, 10),
    },
  };
}

function HookDetailModal({
  runtime,
  hook,
  latest,
  feedback,
}: {
  readonly runtime: ConfiguredHooksRuntime;
  readonly hook: IndividualHookConfig;
  readonly latest?: HookRunDiagnostic;
  readonly feedback?: string;
}): React.ReactNode {
  const rows = [
    ["event", hook.event],
    ["matcher", hook.matcher ?? "(all)"],
    ["enabled", hookEnabledText(runtime, hook)],
    ["type", hook.command.type],
    ["timeout", `${hook.command.timeout_ms ?? 60_000}ms`],
    ["source", hook.sourcePath],
    ["command", hook.command.command],
    ["last", latest ? formatDiagnostic(latest) : "no test/run recorded"],
  ] as const;
  return (
    <MenuModal
      title="hook detail"
      count={`${hook.event} #${hook.index}`}
      summary={hookEnabledText(runtime, hook)}
      headerRight="t test · e edit-test · r reload"
      columns={[12, 92]}
      headers={["field", "value"]}
      items={rows}
      activeIndex={0}
      renderRow={row => [
        <ThemedText key="field" color="inactive" wrap="truncate-end">
          {row[0]}
        </ThemedText>,
        <ThemedText key="value" color="text2" wrap="truncate-middle">
          {row[1]}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Hook Command</ThemedText>
          <ThemedText color="text2" wrap="wrap">{hook.command.command}</ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            matcher · {hook.matcher ?? "(all)"}
          </ThemedText>
          {latest ? (
            <ThemedText color={diagColor(latest)} wrap="wrap">
              last · {formatDiagnostic(latest)}
            </ThemedText>
          ) : null}
          {feedback ? <ThemedText color="worker" wrap="wrap">{feedback}</ThemedText> : null}
        </Box>
      }
      footer={[
        { keyName: "t", label: "test" },
        { keyName: "e", label: "edit-test" },
        { keyName: "x", label: "toggle session" },
        { keyName: "r", label: "reload" },
      ]}
      hint="edit-test changes are draft-only; persist in config.toml"
    />
  );
}

function HookEditModal({
  hook,
  form,
  activeIndex,
  errors,
  feedback,
}: {
  readonly hook: IndividualHookConfig;
  readonly form: HookEditForm;
  readonly activeIndex: number;
  readonly errors: readonly string[];
  readonly feedback?: string;
}): React.ReactNode {
  const rows = editFields(form);
  const selected = rows[activeIndex] ?? rows[0];
  return (
    <MenuModal
      title="hook edit-test"
      count={`${hook.event} #${hook.index}`}
      summary={errors.length > 0 ? `${errors.length} error(s)` : "draft valid"}
      headerRight="type · ctrl+s test · esc"
      columns={[3, 12, 88]}
      headers={["", "field", "value"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(field, _index, active) => [
        <ThemedText key="mark" color={active ? "agenc" : "muted3"}>
          {active ? "▸" : field.editable ? "·" : " "}
        </ThemedText>,
        <ThemedText key="field" color={active ? "agenc" : "text2"} wrap="truncate-end">
          {field.label}
        </ThemedText>,
        <ThemedText key="value" color={active ? "text" : "subtle"} wrap="truncate-middle">
          {`${field.value || "—"}${active && field.editable && field.key !== "enabled" ? "█" : ""}`}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Draft Test</ThemedText>
          <EventChips selected={hook.event} />
          <ThemedText color="subtle" wrap="wrap">
            {selected?.detail ?? "Choose a field."}
          </ThemedText>
          <ThemedBox borderStyle="single" borderColor="lineSoft" paddingX={1}>
            <Box flexDirection="column">
              <ThemedText color="muted3">command</ThemedText>
              <ThemedText color="text2" wrap="truncate-middle">{form.command || " "}</ThemedText>
            </Box>
          </ThemedBox>
          <ThemedBox borderStyle="single" borderColor="lineSoft" paddingX={1}>
            <Box flexDirection="row" gap={2}>
              <ThemedText color="muted3">timeout</ThemedText>
              <ThemedText color="text2">{form.timeoutMs}ms</ThemedText>
              <ThemedText color="muted3">enabled</ThemedText>
              <ThemedText color={form.enabled ? "success" : "error"}>{form.enabled ? "true" : "false"}</ThemedText>
            </Box>
          </ThemedBox>
          {errors.map(error => (
            <ThemedText key={error} color="error" wrap="wrap">! {error}</ThemedText>
          ))}
          {feedback ? <ThemedText color="worker" wrap="wrap">{feedback}</ThemedText> : null}
          <ThemedText color="muted3" wrap="wrap">
            variables · $AGENC_SESSION_ID $AGENC_TOOL_NAME $AGENC_CWD $AGENC_HOOK_EVENT
          </ThemedText>
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "field" },
        { keyName: "type", label: "edit" },
        { keyName: "ctrl+s", label: "test" },
      ]}
      hint="space toggles enabled"
    />
  );
}

function HooksMenuView({
  runtime,
  onDone,
  onReload,
}: {
  readonly runtime: ConfiguredHooksRuntime;
  readonly onDone: Done;
  readonly onReload?: () => Promise<string>;
}): React.ReactNode {
  const [mode, setMode] = React.useState<HooksMode>({ name: "events" });
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [hookIndex, setHookIndex] = React.useState(0);
  const [editIndex, setEditIndex] = React.useState(0);
  const [editForm, setEditForm] = React.useState<HookEditForm>(() => ({
    command: "",
    timeoutMs: "60000",
    enabled: true,
  }));
  const [feedback, setFeedback] = React.useState<string | undefined>();
  const [version, setVersion] = React.useState(0);
  const diagnostics = runtime.latestDiagnostics();
  const rows = React.useMemo(
    () => hookRows(runtime, diagnostics),
    [diagnostics, runtime, version],
  );
  const issues = runtime.issues();
  const selectedEvent = rows[activeIndex]?.event ?? rows[0]?.event ?? "PreToolUse";
  const selectedHooks = mode.name === "hooks"
    ? hooksForEvent(runtime, mode.event)
    : mode.name === "detail" || mode.name === "edit"
      ? hooksForEvent(runtime, mode.hook.event)
      : hooksForEvent(runtime, selectedEvent);
  const selectedHook = selectedHooks[hookIndex] ?? selectedHooks[0];
  const modeHook = mode.name === "detail" || mode.name === "edit"
    ? currentHook(mode.hook, runtime)
    : selectedHook;
  const latest = modeHook ? latestForHook(modeHook, diagnostics) : undefined;
  const editErrors = editValidation(editForm);

  const refresh = React.useCallback(() => setVersion(value => value + 1), []);

  const close = React.useCallback(() => {
    onDone(feedback ?? "Hooks dialog dismissed", {
      display: feedback ? undefined : "system",
    });
  }, [feedback, onDone]);

  const runTest = React.useCallback(async (hook: IndividualHookConfig | undefined) => {
    if (!hook) {
      setFeedback("No hook selected to test.");
      return;
    }
    setFeedback(`running ${hook.event} #${hook.index}...`);
    const diag = await runtime.testHook(hook);
    setFeedback(`test ${hook.event} #${hook.index}: ${formatDiagnostic(diag)}`);
    refresh();
  }, [refresh, runtime]);

  const runDraftTest = React.useCallback(async () => {
    if (!modeHook) return;
    const errors = editValidation(editForm);
    if (errors.length > 0) {
      setFeedback("Fix validation errors before testing.");
      return;
    }
    await runTest(draftHook(modeHook, editForm));
  }, [editForm, modeHook, runTest]);

  const toggleDisabled = React.useCallback(() => {
    const nextDisabled = !runtime.isDisabled();
    runtime.setDisabled(nextDisabled);
    setFeedback(`Hooks ${nextDisabled ? "disabled" : "enabled"} for this session.`);
    refresh();
  }, [refresh, runtime]);

  const reload = React.useCallback(async () => {
    if (!onReload) {
      setFeedback("Reload unavailable: no config store is bound to this session.");
      return;
    }
    try {
      const message = await onReload();
      setFeedback(message);
      refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  }, [onReload, refresh]);

  const openHooksForSelectedEvent = React.useCallback((event: HookEventName) => {
    setHookIndex(0);
    setMode({ name: "hooks", event });
  }, []);

  const openDetail = React.useCallback((hook: IndividualHookConfig | undefined) => {
    if (!hook) {
      setFeedback("No hook configured for this event.");
      return;
    }
    setMode({ name: "detail", hook });
  }, []);

  const openEdit = React.useCallback((hook: IndividualHookConfig | undefined) => {
    if (!hook) {
      setFeedback("No hook configured for this event.");
      return;
    }
    setEditForm(createEditForm(hook));
    setEditIndex(0);
    setMode({ name: "edit", hook });
  }, []);

  useInput((input, key) => {
    if (mode.name === "events") {
      if (key.escape || input === "q") {
        close();
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
      if (key.return || input === "l") {
        openHooksForSelectedEvent(selectedEvent);
        return;
      }
      if (input === "t") {
        void runTest(rows[activeIndex]?.hooks[0]);
        return;
      }
      if (input === "x") {
        toggleDisabled();
        return;
      }
      if (input === "r") {
        void reload();
      }
      return;
    }

    if (mode.name === "hooks") {
      if (key.escape || input === "h") {
        setMode({ name: "events" });
        return;
      }
      if (input === "q") {
        close();
        return;
      }
      if (key.upArrow || input === "k") {
        setHookIndex(index => previousMenuIndex(index, selectedHooks.length));
        return;
      }
      if (key.downArrow || input === "j") {
        setHookIndex(index => nextMenuIndex(index, selectedHooks.length));
        return;
      }
      if (key.return || input === "l") {
        openDetail(selectedHook);
        return;
      }
      if (input === "e") {
        openEdit(selectedHook);
        return;
      }
      if (input === "t") {
        void runTest(selectedHook);
        return;
      }
      if (input === "x") {
        toggleDisabled();
        return;
      }
      if (input === "r") {
        void reload();
      }
      return;
    }

    if (mode.name === "detail") {
      if (key.escape || input === "h") {
        setMode({ name: "hooks", event: mode.hook.event });
        return;
      }
      if (input === "q") {
        close();
        return;
      }
      if (input === "t") {
        void runTest(modeHook);
        return;
      }
      if (input === "e") {
        openEdit(modeHook);
        return;
      }
      if (input === "x") {
        toggleDisabled();
        return;
      }
      if (input === "r") {
        void reload();
      }
      return;
    }

    const fields = editFields(editForm);
    const selectedField = fields[editIndex] ?? fields[0];
    if (!selectedField) return;
    if (key.escape) {
      setMode({ name: "detail", hook: mode.hook });
      return;
    }
    if (key.upArrow || input === "k") {
      setEditIndex(index => previousMenuIndex(index, fields.length));
      return;
    }
    if (key.downArrow || input === "j" || key.tab) {
      setEditIndex(index => nextMenuIndex(index, fields.length));
      return;
    }
    if (input === "s" && key.ctrl) {
      void runDraftTest();
      return;
    }
    if (selectedField.key === "enabled") {
      if (input === " " || key.return) {
        setEditForm(current => ({ ...current, enabled: !current.enabled }));
      }
      return;
    }
    if (selectedField.key === "test") {
      if (key.return) void runDraftTest();
      return;
    }
    if (key.return) {
      setEditIndex(index => nextMenuIndex(index, fields.length));
      return;
    }
    if (key.backspace || key.delete) {
      setEditForm(current =>
        updateEditField(current, selectedField.key, value => value.slice(0, -1)),
      );
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.escape) {
      setEditForm(current =>
        updateEditField(current, selectedField.key, value => `${value}${input}`),
      );
    }
  });

  if (mode.name === "edit" && modeHook) {
    return (
      <HookEditModal
        hook={modeHook}
        form={editForm}
        activeIndex={editIndex}
        errors={editErrors}
        feedback={feedback}
      />
    );
  }

  if (mode.name === "detail" && modeHook) {
    return (
      <HookDetailModal
        runtime={runtime}
        hook={modeHook}
        latest={latest}
        feedback={feedback}
      />
    );
  }

  if (mode.name === "hooks") {
    const hookRowsForEvent = selectedHooks.length > 0
      ? selectedHooks
      : [{
          event: mode.event,
          matcher: undefined,
          command: { type: "command" as const, command: "no hooks configured" },
          source: "config" as const,
          sourcePath: runtime.sourcePath(),
          enabled: false,
          index: 0,
        }];
    return (
      <MenuModal
        title="hooks"
        count={mode.event}
        summary={`${selectedHooks.length} configured`}
        headerRight="enter detail · t test · e edit-test"
        columns={[3, 18, 18, 9, 46, 28]}
        headers={["on", "event", "matcher", "enabled", "command", "source"]}
        items={hookRowsForEvent}
        activeIndex={hookIndex}
        renderRow={(hook, _index, active) => {
          const realHook = selectedHooks.length > 0 ? hook : undefined;
          const diag = realHook ? latestForHook(realHook, diagnostics) : undefined;
          return [
            <ThemedText key="mark" color={active ? "agenc" : "muted3"}>
              {active ? "▸" : "·"}
            </ThemedText>,
            <ThemedText key="event" color={active ? "agenc" : "text2"} wrap="truncate-end">
              {hook.event}
            </ThemedText>,
            <ThemedText key="matcher" color="subtle" wrap="truncate-end">
              {hook.matcher ?? "(all)"}
            </ThemedText>,
            <ThemedText key="enabled" color={hook.enabled && !runtime.isDisabled() ? "success" : "inactive"} wrap="truncate-end">
              {realHook ? hookEnabledText(runtime, hook) : "—"}
            </ThemedText>,
            <ThemedText key="command" color="text2" wrap="truncate-middle">
              {hook.command.command}
            </ThemedText>,
            <ThemedText key="source" color={diagColor(diag)} wrap="truncate-end">
              {realHook ? compactPath(hook.sourcePath) : "—"}
            </ThemedText>,
          ];
        }}
        preview={
          <Box flexDirection="column" gap={1}>
            <ThemedText color="agenc">{mode.event}</ThemedText>
            <EventChips selected={mode.event} />
            <ThemedText color="subtle" wrap="wrap">
              {hookEventSummary(mode.event).summary}
            </ThemedText>
            {feedback ? <ThemedText color="worker" wrap="wrap">{feedback}</ThemedText> : null}
            <Box flexDirection="row" gap={2} flexWrap="wrap">
              <KeyHint k="enter" label="detail" />
              <KeyHint k="t" label="test" />
              <KeyHint k="e" label="edit-test" />
              <KeyHint k="h" label="events" />
            </Box>
          </Box>
        }
        footer={[
          { keyName: "up/down", label: "select" },
          { keyName: "enter", label: "detail" },
          { keyName: "t", label: "test" },
          { keyName: "e", label: "edit-test" },
          { keyName: "r", label: "reload" },
        ]}
        hint="test/reload feedback persists until superseded"
      />
    );
  }

  const selected = rows[activeIndex] ?? rows[0];
  return (
    <MenuModal
      title="hooks"
      count={`${runtime.listHooks().length}`}
      summary={runtime.isDisabled() ? "disabled" : issues.length === 0 ? "validation ok" : `${issues.length} issue(s)`}
      headerRight="enter event · x toggle · r reload"
      columns={[3, 22, 18, 46, 30]}
      headers={["on", "event", "matcher", "command", "source"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => {
        const color = statusColor(row.status);
        return [
          <ThemedText key="mark" color={color}>
            {statusGlyph(row.status)}
          </ThemedText>,
          <ThemedText key="event" color={active ? "agenc" : "text2"} wrap="truncate-end">
            {row.event}
          </ThemedText>,
          <ThemedText key="matcher" color="inactive" wrap="truncate-end">
            {row.matcher}
          </ThemedText>,
          <ThemedText key="command" color="text2" wrap="truncate-end">
            {row.detail}
          </ThemedText>,
          <ThemedText key="source" color={diagColor(row.latest)} wrap="truncate-end">
            {compactPath(row.hooks[0]?.sourcePath ?? runtime.sourcePath())}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Hook Editor</ThemedText>
          <EventChips selected={selected?.event ?? "PreToolUse"} />
          <ThemedBox borderStyle="single" borderColor="lineSoft" paddingX={1}>
            <Box flexDirection="column">
              <ThemedText color="muted3">matcher</ThemedText>
              <ThemedText color="text2">{selected?.matcher ?? "-"}</ThemedText>
            </Box>
          </ThemedBox>
          <ThemedBox borderStyle="single" borderColor="lineSoft" paddingX={1}>
            <Box flexDirection="column">
              <ThemedText color="muted3">command</ThemedText>
              <ThemedText color="text2" wrap="truncate-end">{selected?.detail ?? ""}</ThemedText>
            </Box>
          </ThemedBox>
          <ThemedText color={issues.length === 0 ? "success" : "error"} wrap="wrap">
            Validation: {issues.length === 0 ? "ok" : `${issues.length} issue(s)`}
          </ThemedText>
          <ThemedText color="muted3" wrap="wrap">
            variables · $AGENC_SESSION_ID $AGENC_TOOL_NAME $AGENC_CWD $AGENC_HOOK_EVENT
          </ThemedText>
          {(selected?.hooks ?? []).slice(0, 6).map(hook => (
            <ThemedText key={`${hook.event}-${hook.index}`} color="text2" wrap="truncate-end">
              #{hook.index} {hook.matcher ? `[${hook.matcher}] ` : ""}{hookDisplayText(hook)}
            </ThemedText>
          ))}
          {feedback ? <ThemedText color="worker" wrap="wrap">{feedback}</ThemedText> : null}
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "enter", label: "event" },
        { keyName: "x", label: runtime.isDisabled() ? "enable" : "disable" },
        { keyName: "r", label: "reload" },
        { keyName: "q", label: "close" },
      ]}
      hint="/hooks show <event> [index]"
    />
  );
}

export function HooksRuntimeUnavailableModal({
  onDone,
}: {
  readonly onDone: Done;
}): React.ReactNode {
  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone("Hooks runtime is not available in this session.", {
        display: "system",
      });
    }
  });

  return (
    <MenuModal
      title="hooks"
      count="unavailable"
      summary="runtime bridge missing"
      columns={[18, 78]}
      headers={["state", "detail"]}
      items={[["unavailable", "Open /hooks through the runtime slash command to inspect and test hooks."] as const]}
      activeIndex={0}
      renderRow={row => [
        <ThemedText key="state" color="error">{row[0]}</ThemedText>,
        <ThemedText key="detail" color="subtle" wrap="wrap">{row[1]}</ThemedText>,
      ]}
      footer={[{ keyName: "q", label: "close" }]}
      hint="old hook dialogs are disconnected"
    />
  );
}

export function openHooksMenu(
  ctx: SlashCommandContext,
  runtime: ConfiguredHooksRuntime,
): boolean {
  return openLocalJsxCommand(ctx, close => {
    const reload = ctx.configStore
      ? async (): Promise<string> => {
          const config = await ctx.configStore!.reload();
          runtime.load(config.hooks);
          const issues = runtime.issues();
          return issues.length === 0
            ? "Hooks reloaded from config."
            : `Hooks reloaded with ${issues.length} issue(s).`;
        }
      : undefined;
    return (
      <HooksMenuView runtime={runtime} onDone={close as Done} onReload={reload} />
    );
  });
}
