import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Box, Text } from "../agenc/upstream/ink.js";
import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
  McpPrimitiveSchemaDefinition,
  McpRequestId,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../elicitation/types.js";
import { createMcpUrlCompletionResponse } from "../elicitation/url-completion.js";

/**
 * AgenC-owned elicitation bridge for the existing renderer compatibility island.
 * Keep new behavior and exported helper names neutral; only the session adapter
 * import above reaches the upstream-compatible renderer contract.
 */

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

export interface ElicitationBridge {
  readonly prompt: ElicitationPromptState | null;
  submit(value: string): boolean;
}

interface AgenCBridgeSession {
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

export interface ElicitationBridgeController {
  submit(value: string): boolean;
  completeMcpUrl(
    serverName: string,
    requestId: McpRequestId,
    response?: McpElicitationResponse,
  ): boolean;
  cleanup(): void;
}

export function installElicitationResolvers(
  session: Pick<AgenCBridgeSession, "services"> & Partial<Pick<AgenCBridgeSession, "eventLog">>,
  onPendingChange: (pending: PendingElicitation | null) => void,
): ElicitationBridgeController {
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
  session: Partial<Pick<AgenCBridgeSession, "subscribeToEvents">>,
  controller: Pick<ElicitationBridgeController, "completeMcpUrl">,
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

export function useElicitationBridge(session: AgenCBridgeSession): ElicitationBridge {
  const [pending, setPending] = useState<PendingElicitation | null>(null);
  const controllerRef = useRef<ElicitationBridgeController | null>(null);

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
