// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import React, { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FpsMetricsProvider } from "../context/fpsMetrics.js";
import { StatsProvider, type StatsStore } from "../context/stats.js";
import { onChangeAppState } from "../state/onChangeAppState.js";
import type { FpsMetrics } from "../../utils/fpsTracker.js";
import { Messages } from "./Messages.js";
import PromptInput from "./PromptInput/PromptInput.js";
import { PromptOverlayProvider } from "../context/promptOverlayContext.js";
import { KeybindingSetup } from "../keybindings/KeybindingProviderSetup.js";
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from "../state/AppState.js";
import {
  Box,
  Text,
  useApp,
  useTerminalFocus,
  useTerminalTitle,
} from "../ink.js";
import type { LLMMessage } from "../../llm/types.js";
import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
  McpPrimitiveSchemaDefinition,
  McpRequestId,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../../elicitation/types.js";
import { createMcpUrlCompletionResponse } from "../../elicitation/url-completion.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import { defaultConfig } from "../../config/schema.js";
import { createTuiTools } from "../tool-rendering.js";
import { useSessionTranscript } from "../session-transcript.js";
import { useToolJSX } from "../tool-jsx-state.js";
import { executeRealtimeComposerCommand } from "../realtime/commands.js";
import { RealtimePanel } from "../realtime/RealtimePanel.js";
import { useRealtimeState } from "../realtime/useRealtimeState.js";
import {
  AgenCPermissionOverlay as PermissionOverlay,
  buildToolUseConfirmQueue,
  usePermissionRequests,
} from "../permission-requests.js";
import { submitViaElicitationPrompt } from "../elicitation-submit-routing.js";
import { listTuiCommandList } from "../../commands.js";
import { listAgentRoleDefinitions } from "../../agents/role-definitions.js";
import { buildPendingProviderSwitch } from "../model-switch.js";
import { pastedContentsToLLMMessage } from "../../llm/pasted-content.js";
import type { Command } from "../../commands.js";
import type { AgentDefinition } from "../../tools/AgentTool/loadAgentsDir.js";
import type { AgenCTuiProps } from "../session-types.js";
import {
  Onboarding,
  type FirstRunOnboardingState,
  useFirstRunOnboardingController,
} from "../../onboarding/Onboarding.js";

export type McpFieldValue = string | number | boolean | readonly string[];

export type McpFieldParseResult =
  | { readonly ok: true; readonly value: McpFieldValue }
  | { readonly ok: false; readonly message: string };

export type UserPending = {
  readonly kind: "user";
  readonly request: RequestUserInputEvent;
  readonly resolve: (response: RequestUserInputResponse | null) => void;
  readonly answers: Record<string, { readonly answers: readonly string[] }>;
  readonly index: number;
};

export type McpFormPending = {
  readonly kind: "mcp-form";
  readonly request: McpElicitationRequestEvent;
  readonly resolve: (response: McpElicitationResponse | null) => void;
  readonly fields: readonly string[];
  readonly content: Record<string, McpFieldValue>;
  readonly index: number;
  readonly error?: string;
};

export type McpUrlPending = {
  readonly kind: "mcp-url";
  readonly request: McpElicitationRequestEvent;
  readonly resolve: (response: McpElicitationResponse | null) => void;
};

export type PendingElicitation = UserPending | McpFormPending | McpUrlPending;

export interface ElicitationQueue {
  current(): PendingElicitation | null;
  enqueue(next: PendingElicitation): PendingElicitation;
  advance(next: PendingElicitation | null): PendingElicitation | null;
  cancel(target: PendingElicitation): {
    readonly handled: boolean;
    readonly current: PendingElicitation | null;
  };
  completeMcpUrl(
    serverName: string,
    requestId: McpRequestId,
    response?: McpElicitationResponse,
  ): { readonly handled: boolean; readonly current: PendingElicitation | null };
  clear(): readonly PendingElicitation[];
}

export interface ElicitationPromptState {
  readonly title: string;
  readonly message: string;
  readonly detailLines: readonly string[];
  readonly placeholder: string;
}

export interface TuiElicitationState {
  readonly prompt: ElicitationPromptState | null;
  submit(value: string): boolean;
}

interface AgenCTuiElicitationSession {
  readonly services: {
    requestUserInputResolver?: {
      request(
        event: RequestUserInputEvent,
        signal?: AbortSignal,
      ): Promise<RequestUserInputResponse | null>;
    };
    mcpElicitationResolver?: {
      request(
        event: McpElicitationRequestEvent,
        signal?: AbortSignal,
      ): Promise<McpElicitationResponse | null>;
    };
  };
  readonly eventLog?: {
    subscribe(
      cb: (event: {
        readonly msg: {
          readonly type?: unknown;
          readonly payload?: {
            readonly serverName?: unknown;
            readonly elicitationId?: unknown;
          };
        };
      }) => void,
    ): () => void;
  };
  subscribeToEvents?(cb: (event: unknown) => void): () => void;
}

function optionAnswer(
  raw: string,
  options: RequestUserInputEvent["questions"][number]["options"],
): string {
  const trimmed = raw.trim();
  const first = options?.[0]?.label ?? "";
  if (trimmed.length === 0) return first;
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && options?.[index - 1] !== undefined) {
    return options[index - 1]!.label;
  }
  const byLabel = options?.find(
    (option) => option.label.toLowerCase() === trimmed.toLowerCase(),
  );
  return byLabel?.label ?? trimmed;
}

function enumMessage(values: readonly string[]): string {
  return `must be one of: ${values.join(", ")}`;
}

function stringEnumValues(
  schema: McpPrimitiveSchemaDefinition | undefined,
): readonly string[] | undefined {
  if (schema?.type !== "string") return undefined;
  if (schema.enum !== undefined) return schema.enum;
  if (schema.oneOf !== undefined) return schema.oneOf.map((option) => option.const);
  return schema.anyOf?.map((option) => option.const);
}

function arrayEnumValues(
  schema: McpPrimitiveSchemaDefinition | undefined,
): readonly string[] | undefined {
  if (schema?.type !== "array") return undefined;
  if (schema.items.enum !== undefined) return schema.items.enum;
  return schema.items.anyOf?.map((option) => option.const);
}

function enumDetail(
  schema: McpPrimitiveSchemaDefinition | undefined,
): string | null {
  if (schema?.type === "string") {
    const titled = schema.oneOf ?? schema.anyOf;
    const values = titled?.map((option) =>
      option.title === undefined ? option.const : `${option.const} (${option.title})`
    ) ??
      schema.enumNames ??
      schema.enum;
    return values === undefined ? null : `Allowed: ${values.join(", ")}`;
  }
  if (schema?.type === "array") {
    const values = schema.items.anyOf?.map((option) =>
      option.title === undefined ? option.const : `${option.const} (${option.title})`
    ) ??
      schema.items.enumNames ??
      schema.items.enum;
    return values === undefined ? null : `Allowed: ${values.join(", ")}`;
  }
  return null;
}

function mcpActionFromSubmit(raw: string): "decline" | "cancel" | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "decline" || normalized === "d") return "decline";
  if (normalized === "cancel" || normalized === "c") return "cancel";
  return null;
}

export function parseMcpField(
  raw: string,
  schema: McpPrimitiveSchemaDefinition | undefined,
): McpFieldParseResult {
  const trimmed = raw.trim();
  switch (schema?.type) {
    case "number":
    case "integer": {
      if (trimmed.length === 0) {
        return { ok: false, message: "must be a number" };
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return { ok: false, message: "must be a number" };
      }
      if (schema.type === "integer" && !Number.isInteger(parsed)) {
        return { ok: false, message: "must be an integer" };
      }
      if (schema.minimum !== undefined && parsed < schema.minimum) {
        return { ok: false, message: `must be at least ${schema.minimum}` };
      }
      if (schema.maximum !== undefined && parsed > schema.maximum) {
        return { ok: false, message: `must be at most ${schema.maximum}` };
      }
      return { ok: true, value: parsed };
    }
    case "boolean": {
      if (/^(true|yes|y|1)$/i.test(trimmed)) {
        return { ok: true, value: true };
      }
      if (/^(false|no|n|0)$/i.test(trimmed)) {
        return { ok: true, value: false };
      }
      return { ok: false, message: "must be true or false" };
    }
    case "array": {
      const values = trimmed.length === 0
        ? []
        : trimmed
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (schema.minItems !== undefined && values.length < schema.minItems) {
        return { ok: false, message: `must include at least ${schema.minItems} item(s)` };
      }
      if (schema.maxItems !== undefined && values.length > schema.maxItems) {
        return { ok: false, message: `must include at most ${schema.maxItems} item(s)` };
      }
      if (schema.uniqueItems === true && new Set(values).size !== values.length) {
        return { ok: false, message: "must not include duplicate values" };
      }
      const allowedValues = arrayEnumValues(schema);
      if (allowedValues !== undefined) {
        const invalid = values.find((value) => !allowedValues.includes(value));
        if (invalid !== undefined) {
          return { ok: false, message: `${invalid} ${enumMessage(allowedValues)}` };
        }
      }
      return { ok: true, value: values };
    }
    case "string":
    default: {
      const allowedValues = stringEnumValues(schema);
      if (allowedValues !== undefined && !allowedValues.includes(trimmed)) {
        return { ok: false, message: enumMessage(allowedValues) };
      }
      if (schema?.type === "string" && schema.minLength !== undefined &&
        trimmed.length < schema.minLength) {
        return { ok: false, message: `must be at least ${schema.minLength} characters` };
      }
      if (schema?.type === "string" && schema.maxLength !== undefined &&
        trimmed.length > schema.maxLength) {
        return { ok: false, message: `must be at most ${schema.maxLength} characters` };
      }
      return { ok: true, value: trimmed };
    }
  }
}

export function createElicitationQueue(): ElicitationQueue {
  let active: PendingElicitation | null = null;
  const queued: PendingElicitation[] = [];
  const matchesMcpUrl = (
    pending: PendingElicitation,
    serverName: string,
    requestId: McpRequestId,
  ): pending is McpUrlPending =>
    pending.kind === "mcp-url" &&
    pending.request.serverName === serverName &&
    String(pending.request.requestId) === String(requestId);
  return {
    current() {
      return active;
    },
    enqueue(next) {
      if (active === null) {
        active = next;
      } else {
        queued.push(next);
      }
      return active;
    },
    advance(next) {
      active = next ?? queued.shift() ?? null;
      return active;
    },
    cancel(target) {
      if (active === target) {
        active = queued.shift() ?? null;
        return { handled: true, current: active };
      }
      const queuedIndex = queued.indexOf(target);
      if (queuedIndex === -1) {
        return { handled: false, current: active };
      }
      queued.splice(queuedIndex, 1);
      return { handled: true, current: active };
    },
    completeMcpUrl(serverName, requestId, response) {
      if (active !== null && matchesMcpUrl(active, serverName, requestId)) {
        active.resolve(response ?? { action: "accept" });
        active = queued.shift() ?? null;
        return { handled: true, current: active };
      }
      const queuedIndex = queued.findIndex((pending) =>
        matchesMcpUrl(pending, serverName, requestId)
      );
      if (queuedIndex === -1) {
        return { handled: false, current: active };
      }
      const [pending] = queued.splice(queuedIndex, 1);
      pending?.resolve(response ?? { action: "accept" });
      return { handled: true, current: active };
    },
    clear() {
      const pending = active === null ? [] : [active];
      pending.push(...queued);
      active = null;
      queued.length = 0;
      return pending;
    },
  };
}

function pendingToPrompt(pending: PendingElicitation): ElicitationPromptState {
  if (pending.kind === "user") {
    const question = pending.request.questions[pending.index];
    const options = question?.options ?? [];
    return {
      title: question?.header ?? "Input requested",
      message: question?.question ?? "Input requested",
      detailLines: options.map((option, index) =>
        `${index + 1}. ${option.label} - ${option.description}`,
      ),
      placeholder: options.length > 0
        ? "Enter a number, label, or other text"
        : "Enter a response",
    };
  }
  if (pending.kind === "mcp-url") {
    const request = pending.request.request;
    if (request.mode !== "url") {
      return {
        title: `MCP: ${pending.request.serverName}`,
        message: "MCP elicitation requested",
        detailLines: [],
        placeholder: "Press Enter to continue",
      };
    }
    return {
      title: `MCP: ${pending.request.serverName}`,
      message: request.message,
      detailLines: [request.url, "Type decline or cancel to reject this request."],
      placeholder: "Enter to accept, or type decline/cancel",
    };
  }
  const request = pending.request.request;
  if (request.mode !== "form") {
    return {
      title: `MCP: ${pending.request.serverName}`,
      message: "MCP elicitation requested",
      detailLines: [],
      placeholder: "Press Enter to continue",
    };
  }
  const field = pending.fields[pending.index];
  const schema = field === undefined
    ? undefined
    : request.requestedSchema.properties[field];
  const allowedDetail = enumDetail(schema);
  const details = field === undefined
    ? []
    : [
        schema?.description ?? schema?.title ?? "Requested value",
        ...(allowedDetail === null ? [] : [allowedDetail]),
        "Type decline or cancel to reject this request.",
      ];
  return {
    title: `MCP: ${pending.request.serverName}`,
    message: field === undefined
      ? request.message
      : `${request.message} (${field})`,
    detailLines: pending.error === undefined
      ? details
      : [`Invalid input: ${pending.error}`, ...details],
    placeholder: field === undefined
      ? "Press Enter to accept"
      : "Enter value",
  };
}

export function settlePendingOnSubmit(
  pending: PendingElicitation,
  raw: string,
): PendingElicitation | null {
  if (pending.kind === "user") {
    const question = pending.request.questions[pending.index];
    if (question === undefined) {
      pending.resolve({ answers: pending.answers });
      return null;
    }
    const answers = {
      ...pending.answers,
      [question.id]: {
        answers: [optionAnswer(raw, question.options)],
      },
    };
    const nextIndex = pending.index + 1;
    if (nextIndex >= pending.request.questions.length) {
      pending.resolve({ answers });
      return null;
    }
    return { ...pending, answers, index: nextIndex };
  }
  if (pending.kind === "mcp-url") {
    pending.resolve({ action: mcpActionFromSubmit(raw) ?? "accept" });
    return null;
  }
  const field = pending.fields[pending.index];
  const request = pending.request.request;
  const action = mcpActionFromSubmit(raw);
  if (action !== null) {
    pending.resolve({ action });
    return null;
  }
  if (field === undefined) {
    pending.resolve({ action: "accept", content: pending.content });
    return null;
  }
  const schema = request.mode === "form"
    ? request.requestedSchema.properties[field]
    : undefined;
  const required = request.mode === "form" &&
    request.requestedSchema.required?.includes(field) === true;
  if (raw.trim().length === 0 && !required) {
    const nextIndex = pending.index + 1;
    if (nextIndex >= pending.fields.length) {
      pending.resolve({ action: "accept", content: pending.content });
      return null;
    }
    return { ...pending, index: nextIndex, error: undefined };
  }
  const parsed = parseMcpField(
    raw,
    schema,
  );
  if (!parsed.ok) {
    return { ...pending, error: `${field} ${parsed.message}` };
  }
  const content = {
    ...pending.content,
    [field]: parsed.value,
  };
  const nextIndex = pending.index + 1;
  if (nextIndex >= pending.fields.length) {
    pending.resolve({ action: "accept", content });
    return null;
  }
  return { ...pending, content, index: nextIndex, error: undefined };
}

function resolveOnCleanup(pending: PendingElicitation): void {
  if (pending.kind === "user") {
    pending.resolve(null);
    return;
  }
  pending.resolve({ action: "cancel" });
}

export interface ElicitationResolverController {
  submit(value: string): boolean;
  completeMcpUrl(
    serverName: string,
    requestId: McpRequestId,
    response?: McpElicitationResponse,
  ): boolean;
  cleanup(): void;
}

export function installElicitationResolvers(
  session: Pick<AgenCTuiElicitationSession, "services"> &
    Partial<Pick<AgenCTuiElicitationSession, "eventLog">>,
  onPendingChange: (pending: PendingElicitation | null) => void,
): ElicitationResolverController {
  const queue = createElicitationQueue();
  const publish = (next: PendingElicitation | null): void => {
    onPendingChange(next);
  };
  const completeMcpUrl = (
    serverName: string,
    requestId: McpRequestId,
    response?: McpElicitationResponse,
  ): boolean => {
    const result = queue.completeMcpUrl(serverName, requestId, response);
    if (!result.handled) return false;
    publish(result.current);
    return true;
  };
  const attachAbort = (
    pending: PendingElicitation,
    signal: AbortSignal | undefined,
    response: RequestUserInputResponse | McpElicitationResponse | null,
  ): void => {
    if (signal === undefined) return;
    const abort = (): void => {
      const result = queue.cancel(pending);
      if (result.handled) {
        publish(result.current);
      }
      if (pending.kind === "user") {
        pending.resolve(response as RequestUserInputResponse | null);
      } else {
        pending.resolve(response as McpElicitationResponse | null);
      }
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  };
  const previousUser = session.services.requestUserInputResolver;
  const previousMcp = session.services.mcpElicitationResolver;
  session.services.requestUserInputResolver = {
    request(event, signal) {
      return new Promise<RequestUserInputResponse | null>((resolve) => {
        const pending: UserPending = {
          kind: "user",
          request: event,
          resolve,
          answers: {},
          index: 0,
        };
        publish(queue.enqueue(pending));
        attachAbort(pending, signal, null);
      });
    },
  };
  session.services.mcpElicitationResolver = {
    request(event, signal) {
      return new Promise<McpElicitationResponse | null>((resolve) => {
        if (event.request.mode === "url") {
          const pending: McpUrlPending = { kind: "mcp-url", request: event, resolve };
          publish(queue.enqueue(pending));
          attachAbort(pending, signal, null);
          return;
        }
        const pending: McpFormPending = {
          kind: "mcp-form",
          request: event,
          resolve,
          fields: Object.keys(event.request.requestedSchema.properties),
          content: {},
          index: 0,
        };
        publish(queue.enqueue(pending));
        attachAbort(pending, signal, null);
      });
    },
  };
  const unsubscribeCompletion = session.eventLog?.subscribe((event) => {
    if (event.msg.type !== "mcp_elicitation_complete") return;
    completeMcpUrl(event.msg.payload.serverName, event.msg.payload.elicitationId);
  });
  return {
    submit(value) {
      const active = queue.current();
      if (active === null) return false;
      publish(queue.advance(settlePendingOnSubmit(active, value)));
      return true;
    },
    completeMcpUrl,
    cleanup() {
      unsubscribeCompletion?.();
      session.services.requestUserInputResolver = previousUser;
      session.services.mcpElicitationResolver = previousMcp;
      for (const pending of queue.clear()) {
        resolveOnCleanup(pending);
      }
      publish(null);
    },
  };
}

export function subscribeToMcpUrlCompletions(
  session: Partial<Pick<AgenCTuiElicitationSession, "subscribeToEvents">>,
  controller: Pick<ElicitationResolverController, "completeMcpUrl">,
): () => void {
  return session.subscribeToEvents?.((event) => {
    if (event === null || typeof event !== "object") return;
    const record = event as {
      readonly type?: unknown;
      readonly payload?: {
        readonly serverName?: unknown;
        readonly elicitationId?: unknown;
      };
    };
    if (
      record.type !== "mcp_elicitation_complete" ||
      typeof record.payload?.serverName !== "string" ||
      typeof record.payload.elicitationId !== "string"
    ) {
      return;
    }
    controller.completeMcpUrl(
      record.payload.serverName,
      record.payload.elicitationId,
      createMcpUrlCompletionResponse(),
    );
  }) ?? (() => {});
}

export function useTuiElicitation(session: AgenCTuiElicitationSession): TuiElicitationState {
  const [pending, setPending] = useState<PendingElicitation | null>(null);
  const controllerRef = useRef<ElicitationResolverController | null>(null);

  useEffect(() => {
    const controller = installElicitationResolvers(session, setPending);
    const unsubscribeCompletions = subscribeToMcpUrlCompletions(session, controller);
    controllerRef.current = controller;
    return () => {
      unsubscribeCompletions();
      controller.cleanup();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [session]);

  const submit = useCallback((value: string): boolean => {
    return controllerRef.current?.submit(value) ?? false;
  }, []);

  const prompt = useMemo(
    () => pending === null ? null : pendingToPrompt(pending),
    [pending],
  );

  return { prompt, submit };
}

export function ElicitationOverlay({
  prompt,
}: {
  readonly prompt: ElicitationPromptState | null;
}): React.ReactElement | null {
  if (prompt === null) return null;
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Text bold>{prompt.title}</Text>
      <Text>{prompt.message}</Text>
      {prompt.detailLines.map((line) => (
        <Text key={line} dimColor>{line}</Text>
      ))}
      <Text dimColor>{prompt.placeholder}</Text>
    </Box>
  );
}

type AppProviderProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
  children: ReactNode;
};

/**
 * Top-level wrapper for interactive sessions.
 * Provides FPS metrics, stats context, and app state to the component tree.
 */
export function App({
  getFpsMetrics,
  stats,
  initialState,
  children,
}: AppProviderProps): React.ReactElement {
  return (
    <FpsMetricsProvider getFpsMetrics={getFpsMetrics}>
      <StatsProvider store={stats}>
        <AppStateProvider initialState={initialState} onChangeAppState={onChangeAppState}>
          {children}
        </AppStateProvider>
      </StatsProvider>
    </FpsMetricsProvider>
  );
}

function initialPermissionContext(
  props: AgenCTuiProps,
): ToolPermissionContext {
  return props.session.services.permissionModeRegistry.current();
}

function startupModel(props: AgenCTuiProps): string | null {
  return (
    props.model ??
    props.session.sessionConfiguration?.collaborationMode?.model ??
    null
  );
}

function initialState(props: AgenCTuiProps): any {
  return {
    ...getDefaultAppState(),
    mainLoopModel: startupModel(props),
    mainLoopModelForSession: startupModel(props),
    toolPermissionContext: initialPermissionContext(props),
  };
}

function useSyncedPermissionContext(session: AgenCTuiProps["session"]) {
  const toolPermissionContext = useAppState((s) => s.toolPermissionContext);
  const setAppState = useSetAppState();
  useEffect(() => {
    return session.services.permissionModeRegistry.subscribeToModeChange?.(() => {
      const next = session.services.permissionModeRegistry.current();
      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: next,
      }));
    });
  }, [session, setAppState]);

  const setToolPermissionContext = useCallback(
    (next: ToolPermissionContext) => {
      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: next,
      }));
      void Promise.resolve(
        session.services.permissionModeRegistry.update?.(next),
      ).catch(() => {});
    },
    [session, setAppState],
  );

  return [toolPermissionContext, setToolPermissionContext] as const;
}

function useInitialSubmit(
  session: AgenCTuiProps["session"],
  submit: (input: string) => Promise<void>,
  initialPrompt: string | undefined,
  initialUserMessages: readonly LLMMessage[] | undefined,
): void {
  const submitted = useRef(false);
  useEffect(() => {
    if (submitted.current) return;
    const hasPrompt = typeof initialPrompt === "string" && initialPrompt.length > 0;
    const startupMessages = initialUserMessages ?? [];
    if (!hasPrompt && startupMessages.length === 0) return;
    submitted.current = true;
    for (const message of startupMessages) {
      session.enqueueIdleInput?.(message);
    }
    if (hasPrompt) {
      void submit(initialPrompt).catch(() => {});
    } else {
      void session.submit?.("", { displayUserMessage: null }).catch(() => {});
    }
  }, [initialPrompt, initialUserMessages, session, submit]);
}

const TITLE_ANIMATION_FRAMES = ["⠂", "⠐"];
const TITLE_STATIC_PREFIX = "✳";
const TITLE_ANIMATION_INTERVAL_MS = 960;

/**
 * Ports upstream `src/ink/hooks/use-terminal-title.ts` and the terminal-title
 * leaf from `src/screens/REPL.tsx` onto the live AgenC TUI shell.
 *
 * Shape difference from upstream:
 *   - AgenC does not yet carry upstream session rename or generated-title
 *     state in this bridge, so the title is derived from the active
 *     provider/model when available and otherwise falls back to the product
 *     name.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Generated title extraction and session rename persistence; those need
 *     their own runtime state bridge before they can be live behavior.
 *   - Terminal tab status integration; this port only owns OSC title writes.
 */
function AnimatedTerminalTitle({
  isAnimating,
  title,
  disabled = false,
  noPrefix = false,
}: {
  readonly isAnimating: boolean;
  readonly title: string;
  readonly disabled?: boolean;
  readonly noPrefix?: boolean;
}): null {
  const terminalFocused = useTerminalFocus();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (disabled || noPrefix || !isAnimating || !terminalFocused) return;
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % TITLE_ANIMATION_FRAMES.length);
    }, TITLE_ANIMATION_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [disabled, isAnimating, noPrefix, terminalFocused]);

  const prefix = isAnimating
    ? TITLE_ANIMATION_FRAMES[frame] ?? TITLE_STATIC_PREFIX
    : TITLE_STATIC_PREFIX;
  useTerminalTitle(disabled ? null : noPrefix ? title : `${prefix} ${title}`);
  return null;
}

function terminalTitle(props: Parameters<typeof startupModel>[0]): string {
  const provider = props.session.sessionConfiguration?.provider?.slug?.trim();
  const model = startupModel(props)?.trim();
  if (provider && model) return `AgenC ${provider}/${model}`;
  if (model) return `AgenC ${model}`;
  return "AgenC";
}

function AgenCTuiShell(props: AgenCTuiProps): React.ReactElement {
  const { exit } = useApp();
  const [input, setInput] = useState(props.initialComposerText ?? "");
  const [mode, setMode] = useState<any>("prompt");
  const [stashedPrompt, setStashedPrompt] = useState<any>(undefined);
  const [submitCount, setSubmitCount] = useState(0);
  const [pastedContents, setPastedContents] = useState<Record<number, any>>({});
  const [vimMode, setVimMode] = useState<any>("insert");
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const setAppState = useSetAppState();
  const appStateStore = useAppStateStore();
  const [toolPermissionContext, setToolPermissionContext] =
    useSyncedPermissionContext(props.session);
  const config = useMemo(
    () => props.configStore.current?.() ?? defaultConfig(),
    [props.configStore],
  );
  const agencHome =
    props.configStore.agencHome ?? config.agenc_home ?? props.session.home;
  const onboardingContext = useMemo(
    () => ({
      agencHome,
      config,
      cwd: props.session.cwd ?? props.session.sessionConfiguration?.cwd,
      env: process.env,
      permissionMode: String(toolPermissionContext.mode),
      sandboxMode: config.sandbox_mode ?? config.sandbox?.mode,
      terminalName: process.env.TERM_PROGRAM ?? process.env.TERM,
    }),
    [
      agencHome,
      config,
      props.session.cwd,
      props.session.sessionConfiguration?.cwd,
      toolPermissionContext.mode,
    ],
  );
  const transcript = useSessionTranscript(
    props.session,
    props.initialUserMessages ?? [],
  );
  const realtimeState = useRealtimeState(props.session.realtime);
  const [toolJSX, setToolJSX] = useToolJSX();
  const setModel = useCallback(
    (next: string) => {
      setAppState((prev) => ({
        ...prev,
        mainLoopModel: next,
        mainLoopModelForSession: next,
      }));
      const switchSpec = buildPendingProviderSwitch(props.session, next);
      if (switchSpec !== null) {
        props.session.setPendingProviderSwitch?.(switchSpec);
      }
    },
    [setAppState, props.session],
  );
  const applyOnboardingSelection = useCallback(
    (next: FirstRunOnboardingState) => {
      setModel(next.selectedModel);
      props.session.setPendingProviderSwitch?.({
        provider: next.selectedProvider,
        model: next.selectedModel,
      });
    },
    [props.session, setModel],
  );
  const onboarding = useFirstRunOnboardingController({
    ...onboardingContext,
    hasInitialPrompt:
      (props.initialPrompt?.length ?? 0) > 0 ||
      (props.initialUserMessages?.length ?? 0) > 0,
    isInteractive: props.isInteractive ?? process.stdin.isTTY === true,
    onComplete: applyOnboardingSelection,
  });
  const setExpandedView = useCallback(
    (next: "none" | "tasks") => {
      setAppState((prev) => ({
        ...prev,
        expandedView: next,
      }));
    },
    [setAppState],
  );
  const permissionRequests = usePermissionRequests(
    props.session,
    setModel,
    setExpandedView,
    setAppState,
  );
  const elicitation = useTuiElicitation(props.session);
  const toolNames = useMemo(() => {
    const names = new Set(transcript.toolNames);
    const firstPermission = permissionRequests[0];
    if (firstPermission) names.add(firstPermission.ctx.toolName);
    return names;
  }, [permissionRequests, transcript.toolNames]);
  const tools = useMemo(() => createTuiTools(toolNames), [toolNames]);
  const commands = useMemo(() => listTuiCommandList(), []);
  const agents = useMemo(() => listAgentRoleDefinitions(), []);

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      const hasAttachments = Object.keys(pastedContents).length > 0;
      if (text.length === 0 && !hasAttachments) return;
      setSubmitCount((count) => count + 1);
      setInput("");
      if (hasAttachments) {
        const attachmentsMessage = pastedContentsToLLMMessage(pastedContents);
        if (attachmentsMessage !== null) {
          props.session.enqueueIdleInput?.(attachmentsMessage);
        }
      }
      setPastedContents({});
      await props.session.submit?.(value);
    },
    [pastedContents, props.session],
  );
  useInitialSubmit(
    props.session,
    submit,
    props.initialPrompt,
    props.initialUserMessages,
  );

  const getToolUseContext = useCallback(
    (
      _messages: unknown[],
      _newMessages: unknown[],
      abortController: AbortController,
    ) =>
      ({
        abortController:
          props.session.abortController ?? abortController ?? new AbortController(),
        cwd: props.session.cwd ?? props.session.sessionConfiguration?.cwd,
        getAppState: () => appStateStore.getState(),
        getToolPermissionContext: async () => toolPermissionContext,
        options: {
          commands,
          isNonInteractiveSession: false,
        },
        services: props.session.services,
        session: props.session,
        tools,
        setToolJSX,
      }) as any,
    [
      appStateStore,
      commands,
      props.session,
      toolPermissionContext,
      tools,
      setToolJSX,
    ],
  );

  const mcpClients = useMemo(
    () => props.session.listMcpClients?.() ?? [],
    [props.session],
  );
  const toolUseConfirmQueue = useMemo(
    () => buildToolUseConfirmQueue(permissionRequests, tools),
    [permissionRequests, tools],
  );
  const title = useMemo(() => terminalTitle(props), [props]);
  const titleIsAnimating =
    transcript.isStreaming &&
    permissionRequests.length === 0 &&
    elicitation.prompt === null &&
    toolJSX === null &&
    !onboarding.active;

  return (
    <Box flexDirection="column" width="100%">
      <AnimatedTerminalTitle isAnimating={titleIsAnimating} title={title} />
      {onboarding.active ? (
        <Onboarding
          state={onboarding.state}
          steps={onboarding.steps}
          currentStep={onboarding.currentStep}
          context={onboardingContext}
        />
      ) : (
        <Messages
          messages={transcript.messages as any[]}
          tools={tools as any}
          commands={commands as unknown as Command[]}
          verbose={false}
          toolJSX={toolJSX as any}
          toolUseConfirmQueue={toolUseConfirmQueue as never[]}
          inProgressToolUseIDs={new Set(transcript.inProgressToolUseIDs)}
          isMessageSelectorVisible={false}
          conversationId={props.session.conversationId}
          screen={"prompt" as any}
          streamingToolUses={transcript.streamingToolUses}
          isLoading={transcript.isStreaming}
          streamingText={transcript.streamingText}
          hidePastThinking={false}
        />
      )}
      {!onboarding.active ? (
        <RealtimePanel state={realtimeState} />
      ) : null}
      {!onboarding.active && toolJSX !== null ? (
        <Box flexDirection="column" width="100%">
          {toolJSX.jsx}
        </Box>
      ) : null}
      {!onboarding.active ? (
        <PermissionOverlay
          request={permissionRequests[0]}
          tools={tools}
        />
      ) : null}
      {!onboarding.active ? (
        <ElicitationOverlay prompt={elicitation.prompt} />
      ) : null}
      <PromptInput
        debug={false}
        ideSelection={undefined}
        toolPermissionContext={toolPermissionContext as any}
        setToolPermissionContext={setToolPermissionContext as any}
        apiKeyStatus={"valid" as any}
        commands={commands as unknown as Command[]}
        agents={agents as unknown as AgentDefinition[]}
        isLoading={!onboarding.active && transcript.isStreaming}
        verbose={false}
        messages={transcript.messages as any[]}
        onAutoUpdaterResult={() => {}}
        autoUpdaterResult={null}
        input={input}
        onInputChange={setInput}
        mode={mode}
        onModeChange={setMode}
        stashedPrompt={stashedPrompt}
        setStashedPrompt={setStashedPrompt}
        submitCount={submitCount}
        onShowMessageSelector={() => {}}
        mcpClients={mcpClients as never}
        pastedContents={pastedContents}
        setPastedContents={setPastedContents}
        vimMode={vimMode}
        setVimMode={setVimMode}
        showBashesDialog={showBashesDialog}
        setShowBashesDialog={setShowBashesDialog}
        onExit={exit}
        getToolUseContext={getToolUseContext}
        onSubmit={async (value, helpers) => {
          if (await onboarding.submit(value)) {
            helpers.clearBuffer();
            helpers.resetHistory();
            helpers.setCursorOffset(0);
            return;
          }
          if (
            await executeRealtimeComposerCommand(props.session.realtime, value)
          ) {
            helpers.clearBuffer();
            helpers.resetHistory();
            helpers.setCursorOffset(0);
            return;
          }
          await submitViaElicitationPrompt(elicitation, submit, value, helpers);
        }}
        isSearchingHistory={isSearchingHistory}
        setIsSearchingHistory={setIsSearchingHistory}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
      />
    </Box>
  );
}

export function AgenCTuiApp(
  props: AgenCTuiProps,
): React.ReactElement {
  const initial = useMemo(() => initialState(props), []);
  return (
    <App
      initialState={initial}
      getFpsMetrics={() => undefined}
    >
      <PromptOverlayProvider>
        <KeybindingSetup>
          <AgenCTuiShell {...props} />
        </KeybindingSetup>
      </PromptOverlayProvider>
    </App>
  );
}
