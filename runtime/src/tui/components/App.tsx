import { c as _c } from "react-compiler-runtime";
import React, { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FpsMetricsProvider, useFpsMetrics } from "../context/fpsMetrics.js";
import { StatsProvider, type StatsStore } from "../context/stats.js";
import { onChangeAppState } from "../state/onChangeAppState.js";
import { syncCollabAgentEventToAppState } from "../state/collabAgentTaskSync.js";
import { selectAgenCTuiGlyphs } from "../glyphs.js";
import { formatTuiBackpressureWarning, getTuiBackpressureSnapshot, subscribeTuiBackpressure } from "../backpressure.js";
import type { FpsMetrics } from "../../utils/fpsTracker.js";
import { Messages } from "./Messages.js";
import { MessageSelector, selectableUserMessagesFilter } from "./MessageSelector.js";
import { ExitFlow } from "./ExitFlow.js";
import PromptInput from "./PromptInput/PromptInput.js";
import { CostThresholdDialog } from "./dialogs/CostThresholdDialog.js";
import { FullscreenLayout } from "./FullscreenLayout.js";
import { WorkbenchLayout } from "../workbench/WorkbenchLayout.js";
import { ApprovalSurfaceBridge } from "../workbench/approvals/ApprovalSurfaceBridge.js";
import { getWorkbenchStateFromAppState, isWorkbenchEnabled } from "../workbench/state.js";
import { shouldEnableTranscriptScrollKeybindings } from "../workbench/transcriptScroll.js";
import { ScrollKeybindingHandler } from "./ScrollKeybindingHandler.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { AlternateScreen } from "../ink/components/AlternateScreen.js";
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from "../../utils/fullscreen.js";
import { SpinnerWithVerb } from "./spinner/Spinner.js";
import { getActiveLocalAgentTasks } from "./spinner/agentActivity.js";
import type { SpinnerMode } from "./spinner/types.js";
import { PromptInputQueuedCommands } from "./PromptInput/PromptInputQueuedCommands.js";
import { useCommandQueue } from "../hooks/useCommandQueue.js";
import { dequeue, enqueue, peek } from "../../utils/messageQueueManager.js";
import { getCronScheduler } from "../../utils/cronScheduler.js";
import { parseSlashCommand, dispatchSlashCommand } from "../../commands/dispatcher.js";
import { buildDefaultRegistry } from "../../commands/registry.js";
import { setGlobalCommandRegistry } from "../../commands/types.js";
import { PromptOverlayProvider } from "../context/promptOverlayContext.js";
import { KeybindingSetup } from "../keybindings/KeybindingProviderSetup.js";
import { CancelRequestHandler } from "../hooks/useCancelRequest.js";
import { useApiKeyVerification } from "../hooks/useApiKeyVerification.js";
import { addToHistory } from "../history/history.js";
import { GlobalKeybindingHandlers } from "../hooks/useGlobalKeybindings.js";
import { type AppState, AppStateProvider, getDefaultAppState, useAppState, useAppStateStore, useSetAppState } from "../state/AppState.js";
import { Box, Text, useApp, useTerminalFocus, useTerminalTitle } from "../ink.js";
import { setPendingResumeSessionId } from "../pending-resume.js";
import type { LLMMessage } from "../../llm/types.js";
import type { McpElicitationRequestEvent, McpElicitationResponse, McpPrimitiveSchemaDefinition, McpRequestId, RequestUserInputEvent, RequestUserInputResponse } from "../../elicitation/types.js";
import { createMcpUrlCompletionResponse } from "../../elicitation/url-completion.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import { defaultConfig } from "../../config/schema.js";
import { createTuiTools } from "../tool-rendering.js";
import { useSessionTranscript } from "../session-transcript.js";
import { useToolJSX } from "../tool-jsx-state.js";
import { executeRealtimeComposerCommand } from "../realtime/commands.js";
import { RealtimePanel } from "../realtime/RealtimePanel.js";
import { useRealtimeState } from "../realtime/useRealtimeState.js";
import { AgenCPermissionOverlay as PermissionOverlay, buildToolUseConfirmQueue, usePermissionRequests } from "../permission-requests.js";
import { submitViaElicitationPrompt } from "../elicitation-submit-routing.js";
import { findCommand, listTuiCommandList } from "../../commands.js";
import { listAgentRoleDefinitions } from "../../agents/role-definitions.js";
import { buildPendingProviderSwitch } from "../model-switch.js";
import { pastedContentsToLLMMessage } from "../../llm/pasted-content.js";
import type { PromptInputContext } from "../input/inputContext.js";
import {
  isDollarSkillCommand,
  loadDollarSkillCommandForTurn,
  parseDollarSkillCommand,
} from "../input/processPromptInput.js";
import type { Command } from "../../commands.js";
import type { QueuedCommand, VimMode } from "../../types/textInputTypes.js";
import { installCompactProgressControls, type AgenCTuiProps } from "../session-types.js";
import { useMcpConnectivityStatus } from "../hooks/notifs/useMcpConnectivityStatus.js";
import { useCostSummary } from "../../cost/hook.js";
import { getTotalCost } from "../../cost/tracker.js";
import { useNotifications } from "../context/notifications.js";
import { hasConsoleBillingAccess } from "../../utils/billing.js";
import { getGlobalConfig, saveGlobalConfig } from "../../utils/config.js";
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from "../../utils/fileStateCache.js";
import { fileHistoryRewind } from "../../utils/fileHistory.js";
import { getCurrentWorktreeSession } from "../../utils/worktree.js";
import { escapeXml, unescapeXml } from "../../utils/xml.js";
import { Onboarding, type FirstRunOnboardingState, useFirstRunOnboardingController } from "../../onboarding/Onboarding.js";
import type { MCPServerConnection } from "../../services/mcp/types.js";
import {
  completionPipelineOwnsPrompt,
  formatCompletionPipelineRows,
  readCompletionPipelineState,
  type CompletionPipelineState,
} from "../completion-pipeline.js";
export { shouldEnableTranscriptScrollKeybindings } from "../workbench/transcriptScroll.js";
export type McpFieldValue = string | number | boolean | readonly string[];
const EMPTY_MCP_CLIENTS: readonly MCPServerConnection[] = [];
const EMPTY_MCP_TOOLS: readonly unknown[] = [];
const EMPTY_ONBOARDING_COMMANDS: Command[] = [];
const BUSY_BLOCKED_SLASH_COMMANDS = new Set(["agents"]);
const mcpSurfaceObjectIds = new WeakMap<object, number>();
let nextMcpSurfaceObjectId = 1;
export type McpFieldParseResult = {
  readonly ok: true;
  readonly value: McpFieldValue;
} | {
  readonly ok: false;
  readonly message: string;
};

type LiveSubmitOptions = {
  readonly fromQueue?: boolean;
  readonly pastedContentsOverride?: Record<number, any>;
};

function isMainThreadRunnableCommand(command: QueuedCommand): boolean {
  return (
    command.agentId === undefined &&
    (command.mode === "prompt" || command.mode === "bash")
  );
}

function dequeueNextMainThreadRunnableCommand(): QueuedCommand | undefined {
  const next = peek(isMainThreadRunnableCommand);
  if (next === undefined) return undefined;
  return dequeue(command => command === next);
}

function queuedCommandInputText(command: QueuedCommand): string {
  if (typeof command.value === "string") return command.value;
  return command.value.map(block => {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
    return "[image]";
  }).filter(Boolean).join("\n");
}

function busySlashCommandMessage(commandName: string): string {
  return `Finish or cancel the current response before opening /${commandName}.`;
}

function isExitSlashCommand(raw: string): boolean {
  const parsed = raw.trim().startsWith("/") ? parseSlashCommand(raw) : null;
  return parsed?.name === "exit" || parsed?.name === "quit";
}

function isOnboardingSlashAlias(raw: string): boolean {
  const parsed = raw.trim().startsWith("/") ? parseSlashCommand(raw) : null;
  return (
    parsed?.name === "next" ||
    parsed?.name === "skip" ||
    parsed?.name === "done" ||
    parsed?.name === "test"
  );
}

function extractUserMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const maybeMessage = message as {
    type?: unknown;
    message?: { content?: unknown };
  };
  if (maybeMessage.type !== "user") return null;
  const content = maybeMessage.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (block): block is { readonly type: "text"; readonly text: string } =>
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map(block => block.text)
      .join("\n");
    return text.length > 0 ? text : null;
  }
  return null;
}

export function enqueueSlashPromptResult(
  content: string,
  scheduleQueueDrain: () => void,
): boolean {
  if (content.trim().length === 0) return false;
  enqueue({
    value: content,
    preExpansionValue: content,
    mode: "prompt",
  });
  scheduleQueueDrain();
  return true;
}

export type UserPending = {
  readonly kind: "user";
  readonly request: RequestUserInputEvent;
  readonly resolve: (response: RequestUserInputResponse | null) => void;
  readonly answers: Record<string, {
    readonly answers: readonly string[];
  }>;
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
const EMPTY_INITIAL_USER_MESSAGES: readonly LLMMessage[] = Object.freeze([]);
export interface ElicitationQueue {
  current(): PendingElicitation | null;
  enqueue(next: PendingElicitation): PendingElicitation;
  advance(next: PendingElicitation | null): PendingElicitation | null;
  cancel(target: PendingElicitation): {
    readonly handled: boolean;
    readonly current: PendingElicitation | null;
  };
  completeMcpUrl(serverName: string, requestId: McpRequestId, response?: McpElicitationResponse): {
    readonly handled: boolean;
    readonly current: PendingElicitation | null;
  };
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
      request(event: RequestUserInputEvent, signal?: AbortSignal): Promise<RequestUserInputResponse | null>;
    };
    mcpElicitationResolver?: {
      request(event: McpElicitationRequestEvent, signal?: AbortSignal): Promise<McpElicitationResponse | null>;
    };
  };
  readonly eventLog?: {
    subscribe(cb: (event: {
      readonly msg: {
        readonly type?: unknown;
        readonly payload?: {
          readonly serverName?: unknown;
          readonly elicitationId?: unknown;
        };
      };
    }) => void): () => void;
  };
  subscribeToEvents?(cb: (event: unknown) => void): () => void;
}
function optionAnswer(raw: string, options: RequestUserInputEvent["questions"][number]["options"]): string {
  const trimmed = raw.trim();
  const first = options?.[0]?.label ?? "";
  if (trimmed.length === 0) return first;
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && options?.[index - 1] !== undefined) {
    return options[index - 1]!.label;
  }
  const byLabel = options?.find(option => option.label.toLowerCase() === trimmed.toLowerCase());
  return byLabel?.label ?? trimmed;
}
function enumMessage(values: readonly string[]): string {
  return `must be one of: ${values.join(", ")}`;
}
function stringEnumValues(schema: McpPrimitiveSchemaDefinition | undefined): readonly string[] | undefined {
  if (schema?.type !== "string") return undefined;
  if (schema.enum !== undefined) return schema.enum;
  if (schema.oneOf !== undefined) return schema.oneOf.map(option => option.const);
  return schema.anyOf?.map(option => option.const);
}
function arrayEnumValues(schema: McpPrimitiveSchemaDefinition | undefined): readonly string[] | undefined {
  if (schema?.type !== "array") return undefined;
  if (schema.items.enum !== undefined) return schema.items.enum;
  return schema.items.anyOf?.map(option => option.const);
}
function enumDetail(schema: McpPrimitiveSchemaDefinition | undefined): string | null {
  if (schema?.type === "string") {
    const titled = schema.oneOf ?? schema.anyOf;
    const values = titled?.map(option => option.title === undefined ? option.const : `${option.const} (${option.title})`) ?? schema.enumNames ?? schema.enum;
    return values === undefined ? null : `Allowed: ${values.join(", ")}`;
  }
  if (schema?.type === "array") {
    const values = schema.items.anyOf?.map(option => option.title === undefined ? option.const : `${option.const} (${option.title})`) ?? schema.items.enumNames ?? schema.items.enum;
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
export function parseMcpField(raw: string, schema: McpPrimitiveSchemaDefinition | undefined): McpFieldParseResult {
  const trimmed = raw.trim();
  switch (schema?.type) {
    case "number":
    case "integer":
      {
        if (trimmed.length === 0) {
          return {
            ok: false,
            message: "must be a number"
          };
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) {
          return {
            ok: false,
            message: "must be a number"
          };
        }
        if (schema.type === "integer" && !Number.isInteger(parsed)) {
          return {
            ok: false,
            message: "must be an integer"
          };
        }
        if (schema.minimum !== undefined && parsed < schema.minimum) {
          return {
            ok: false,
            message: `must be at least ${schema.minimum}`
          };
        }
        if (schema.maximum !== undefined && parsed > schema.maximum) {
          return {
            ok: false,
            message: `must be at most ${schema.maximum}`
          };
        }
        return {
          ok: true,
          value: parsed
        };
      }
    case "boolean":
      {
        if (/^(true|yes|y|1)$/i.test(trimmed)) {
          return {
            ok: true,
            value: true
          };
        }
        if (/^(false|no|n|0)$/i.test(trimmed)) {
          return {
            ok: true,
            value: false
          };
        }
        return {
          ok: false,
          message: "must be true or false"
        };
      }
    case "array":
      {
        const values = trimmed.length === 0 ? [] : trimmed.split(",").map(item => item.trim()).filter(item => item.length > 0);
        if (schema.minItems !== undefined && values.length < schema.minItems) {
          return {
            ok: false,
            message: `must include at least ${schema.minItems} item(s)`
          };
        }
        if (schema.maxItems !== undefined && values.length > schema.maxItems) {
          return {
            ok: false,
            message: `must include at most ${schema.maxItems} item(s)`
          };
        }
        if (schema.uniqueItems === true && new Set(values).size !== values.length) {
          return {
            ok: false,
            message: "must not include duplicate values"
          };
        }
        const allowedValues = arrayEnumValues(schema);
        if (allowedValues !== undefined) {
          const invalid = values.find(value => !allowedValues.includes(value));
          if (invalid !== undefined) {
            return {
              ok: false,
              message: `${invalid} ${enumMessage(allowedValues)}`
            };
          }
        }
        return {
          ok: true,
          value: values
        };
      }
    case "string":
    default:
      {
        const allowedValues = stringEnumValues(schema);
        if (allowedValues !== undefined && !allowedValues.includes(trimmed)) {
          return {
            ok: false,
            message: enumMessage(allowedValues)
          };
        }
        if (schema?.type === "string" && schema.minLength !== undefined && trimmed.length < schema.minLength) {
          return {
            ok: false,
            message: `must be at least ${schema.minLength} characters`
          };
        }
        if (schema?.type === "string" && schema.maxLength !== undefined && trimmed.length > schema.maxLength) {
          return {
            ok: false,
            message: `must be at most ${schema.maxLength} characters`
          };
        }
        return {
          ok: true,
          value: trimmed
        };
      }
  }
}
export function createElicitationQueue(): ElicitationQueue {
  let active: PendingElicitation | null = null;
  const queued: PendingElicitation[] = [];
  const matchesMcpUrl = (pending: PendingElicitation, serverName: string, requestId: McpRequestId): pending is McpUrlPending => pending.kind === "mcp-url" && pending.request.serverName === serverName && String(pending.request.requestId) === String(requestId);
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
        return {
          handled: true,
          current: active
        };
      }
      const queuedIndex = queued.indexOf(target);
      if (queuedIndex === -1) {
        return {
          handled: false,
          current: active
        };
      }
      queued.splice(queuedIndex, 1);
      return {
        handled: true,
        current: active
      };
    },
    completeMcpUrl(serverName, requestId, response) {
      if (active !== null && matchesMcpUrl(active, serverName, requestId)) {
        active.resolve(response ?? {
          action: "accept"
        });
        active = queued.shift() ?? null;
        return {
          handled: true,
          current: active
        };
      }
      const queuedIndex = queued.findIndex(pending => matchesMcpUrl(pending, serverName, requestId));
      if (queuedIndex === -1) {
        return {
          handled: false,
          current: active
        };
      }
      const [pending] = queued.splice(queuedIndex, 1);
      pending?.resolve(response ?? {
        action: "accept"
      });
      return {
        handled: true,
        current: active
      };
    },
    clear() {
      const pending = active === null ? [] : [active];
      pending.push(...queued);
      active = null;
      queued.length = 0;
      return pending;
    }
  };
}
function pendingToPrompt(pending: PendingElicitation): ElicitationPromptState {
  if (pending.kind === "user") {
    const question = pending.request.questions[pending.index];
    const options = question?.options ?? [];
    return {
      title: question?.header ?? "Input requested",
      message: question?.question ?? "Input requested",
      detailLines: options.map((option, index) => `${index + 1}. ${option.label} - ${option.description}`),
      placeholder: options.length > 0 ? "Enter a number, label, or other text" : "Enter a response"
    };
  }
  if (pending.kind === "mcp-url") {
    const request = pending.request.request;
    if (request.mode !== "url") {
      return {
        title: `MCP: ${pending.request.serverName}`,
        message: "MCP elicitation requested",
        detailLines: [],
        placeholder: "Press Enter to continue"
      };
    }
    return {
      title: `MCP: ${pending.request.serverName}`,
      message: request.message,
      detailLines: [request.url, "Type decline or cancel to reject this request."],
      placeholder: "Enter to accept, or type decline/cancel"
    };
  }
  const request = pending.request.request;
  if (request.mode !== "form") {
    return {
      title: `MCP: ${pending.request.serverName}`,
      message: "MCP elicitation requested",
      detailLines: [],
      placeholder: "Press Enter to continue"
    };
  }
  const field = pending.fields[pending.index];
  const schema = field === undefined ? undefined : request.requestedSchema.properties[field];
  const allowedDetail = enumDetail(schema);
  const details = field === undefined ? [] : [schema?.description ?? schema?.title ?? "Requested value", ...(allowedDetail === null ? [] : [allowedDetail]), "Type decline or cancel to reject this request."];
  return {
    title: `MCP: ${pending.request.serverName}`,
    message: field === undefined ? request.message : `${request.message} (${field})`,
    detailLines: pending.error === undefined ? details : [`Invalid input: ${pending.error}`, ...details],
    placeholder: field === undefined ? "Press Enter to accept" : "Enter value"
  };
}
export function settlePendingOnSubmit(pending: PendingElicitation, raw: string): PendingElicitation | null {
  if (pending.kind === "user") {
    const question = pending.request.questions[pending.index];
    if (question === undefined) {
      pending.resolve({
        answers: pending.answers
      });
      return null;
    }
    const answers = {
      ...pending.answers,
      [question.id]: {
        answers: [optionAnswer(raw, question.options)]
      }
    };
    const nextIndex = pending.index + 1;
    if (nextIndex >= pending.request.questions.length) {
      pending.resolve({
        answers
      });
      return null;
    }
    return {
      ...pending,
      answers,
      index: nextIndex
    };
  }
  if (pending.kind === "mcp-url") {
    pending.resolve({
      action: mcpActionFromSubmit(raw) ?? "accept"
    });
    return null;
  }
  const field = pending.fields[pending.index];
  const request = pending.request.request;
  const action = mcpActionFromSubmit(raw);
  if (action !== null) {
    pending.resolve({
      action
    });
    return null;
  }
  if (field === undefined) {
    pending.resolve({
      action: "accept",
      content: pending.content
    });
    return null;
  }
  const schema = request.mode === "form" ? request.requestedSchema.properties[field] : undefined;
  const required = request.mode === "form" && request.requestedSchema.required?.includes(field) === true;
  if (raw.trim().length === 0 && !required) {
    const nextIndex = pending.index + 1;
    if (nextIndex >= pending.fields.length) {
      pending.resolve({
        action: "accept",
        content: pending.content
      });
      return null;
    }
    return {
      ...pending,
      index: nextIndex,
      error: undefined
    };
  }
  const parsed = parseMcpField(raw, schema);
  if (!parsed.ok) {
    return {
      ...pending,
      error: `${field} ${parsed.message}`
    };
  }
  const content = {
    ...pending.content,
    [field]: parsed.value
  };
  const nextIndex = pending.index + 1;
  if (nextIndex >= pending.fields.length) {
    pending.resolve({
      action: "accept",
      content
    });
    return null;
  }
  return {
    ...pending,
    content,
    index: nextIndex,
    error: undefined
  };
}
function resolveOnCleanup(pending: PendingElicitation): void {
  if (pending.kind === "user") {
    pending.resolve(null);
    return;
  }
  pending.resolve({
    action: "cancel"
  });
}
export interface ElicitationResolverController {
  submit(value: string): boolean;
  completeMcpUrl(serverName: string, requestId: McpRequestId, response?: McpElicitationResponse): boolean;
  cleanup(): void;
}
export function installElicitationResolvers(session: Pick<AgenCTuiElicitationSession, "services"> & Partial<Pick<AgenCTuiElicitationSession, "eventLog">>, onPendingChange: (pending: PendingElicitation | null) => void): ElicitationResolverController {
  const queue = createElicitationQueue();
  const publish = (next: PendingElicitation | null): void => {
    onPendingChange(next);
  };
  const completeMcpUrl = (serverName: string, requestId: McpRequestId, response?: McpElicitationResponse): boolean => {
    const result = queue.completeMcpUrl(serverName, requestId, response);
    if (!result.handled) return false;
    publish(result.current);
    return true;
  };
  const attachAbort = (pending: PendingElicitation, signal: AbortSignal | undefined, response: RequestUserInputResponse | McpElicitationResponse | null): (() => void) => {
    if (signal === undefined) return () => {};
    let done = false;
    const abort = (): void => {
      if (done) return;
      done = true;
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
      return () => {};
    }
    signal.addEventListener("abort", abort, {
      once: true
    });
    return () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
    };
  };
  const previousUser = session.services.requestUserInputResolver;
  const previousMcp = session.services.mcpElicitationResolver;
  session.services.requestUserInputResolver = {
    request(event, signal) {
      return new Promise<RequestUserInputResponse | null>(resolve => {
        let detachAbort = () => {};
        const resolveAndDetach = (value: RequestUserInputResponse | null): void => {
          detachAbort();
          resolve(value);
        };
        const pending: UserPending = {
          kind: "user",
          request: event,
          resolve: resolveAndDetach,
          answers: {},
          index: 0
        };
        publish(queue.enqueue(pending));
        detachAbort = attachAbort(pending, signal, null);
      });
    }
  };
  session.services.mcpElicitationResolver = {
    request(event, signal) {
      return new Promise<McpElicitationResponse | null>(resolve => {
        let detachAbort = () => {};
        const resolveAndDetach = (value: McpElicitationResponse | null): void => {
          detachAbort();
          resolve(value);
        };
        if (event.request.mode === "url") {
          const pending: McpUrlPending = {
            kind: "mcp-url",
            request: event,
            resolve: resolveAndDetach
          };
          publish(queue.enqueue(pending));
          detachAbort = attachAbort(pending, signal, null);
          return;
        }
        const pending: McpFormPending = {
          kind: "mcp-form",
          request: event,
          resolve: resolveAndDetach,
          fields: Object.keys(event.request.requestedSchema.properties),
          content: {},
          index: 0
        };
        publish(queue.enqueue(pending));
        detachAbort = attachAbort(pending, signal, null);
      });
    }
  };
  const unsubscribeCompletion = session.eventLog?.subscribe(event => {
    if (event.msg.type !== "mcp_elicitation_complete") return;
    const payload = event.msg.payload;
    if (typeof payload?.serverName !== "string" || (typeof payload.elicitationId !== "string" && typeof payload.elicitationId !== "number")) {
      return;
    }
    completeMcpUrl(payload.serverName, payload.elicitationId, createMcpUrlCompletionResponse());
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
    }
  };
}
export function subscribeToMcpUrlCompletions(session: Partial<Pick<AgenCTuiElicitationSession, "subscribeToEvents">>, controller: Pick<ElicitationResolverController, "completeMcpUrl">): () => void {
  return session.subscribeToEvents?.(event => {
    if (event === null || typeof event !== "object") return;
    const record = event as {
      readonly type?: unknown;
      readonly payload?: {
        readonly serverName?: unknown;
        readonly elicitationId?: unknown;
      };
    };
    if (record.type !== "mcp_elicitation_complete" || typeof record.payload?.serverName !== "string" || (typeof record.payload.elicitationId !== "string" && typeof record.payload.elicitationId !== "number")) {
      return;
    }
    controller.completeMcpUrl(record.payload.serverName, record.payload.elicitationId, createMcpUrlCompletionResponse());
  }) ?? (() => {});
}
export function useTuiElicitation(session) {
  const $ = _c(8);
  const [pending, setPending] = useState(null);
  const controllerRef = useRef(null);
  let t0;
  let t1;
  if ($[0] !== session) {
    t0 = () => {
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
    };
    t1 = [session];
    $[0] = session;
    $[1] = t0;
    $[2] = t1;
  } else {
    t0 = $[1];
    t1 = $[2];
  }
  useEffect(t0, t1);
  let t2;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = value => controllerRef.current?.submit(value) ?? false;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const submit = t2;
  let t3;
  if ($[4] !== pending) {
    t3 = pending === null ? null : pendingToPrompt(pending);
    $[4] = pending;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const prompt = t3;
  let t4;
  if ($[6] !== prompt) {
    t4 = {
      prompt,
      submit
    };
    $[6] = prompt;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  return t4;
}
export function ElicitationOverlay(t0) {
  const $ = _c(13);
  const {
    prompt
  } = t0;
  if (prompt === null) {
    return null;
  }
  let t1;
  if ($[0] !== prompt.title) {
    t1 = <Text bold={true}>{prompt.title}</Text>;
    $[0] = prompt.title;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== prompt.message) {
    t2 = <Text>{prompt.message}</Text>;
    $[2] = prompt.message;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  let t3;
  if ($[4] !== prompt.detailLines) {
    t3 = prompt.detailLines.map(_temp);
    $[4] = prompt.detailLines;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  let t4;
  if ($[6] !== prompt.placeholder) {
    t4 = <Text dimColor={true}>{prompt.placeholder}</Text>;
    $[6] = prompt.placeholder;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  let t5;
  if ($[8] !== t1 || $[9] !== t2 || $[10] !== t3 || $[11] !== t4) {
    t5 = <Box flexDirection="column" width="100%" paddingX={1}>{t1}{t2}{t3}{t4}</Box>;
    $[8] = t1;
    $[9] = t2;
    $[10] = t3;
    $[11] = t4;
    $[12] = t5;
  } else {
    t5 = $[12];
  }
  return t5;
}
function _temp(line) {
  return <Text key={line} dimColor={true}>{line}</Text>;
}
type AppProviderProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
  children: ReactNode;
};

const DEFAULT_FPS_METRICS_GETTER = () => undefined;

export function formatRenderHealthWarning(metrics: FpsMetrics | undefined): string | null {
  if (metrics === undefined) return null;
  const averageFps = Number.isFinite(metrics.averageFps) ? metrics.averageFps : 0;
  const rawLow1PctFps = Number.isFinite(metrics.low1PctFps) ? metrics.low1PctFps : 0;
  const low1PctFps = Math.min(rawLow1PctFps, averageFps);
  if (metrics.sampleCount !== undefined && metrics.sampleCount < 10) return null;
  if (averageFps >= 20 && low1PctFps >= 12) return null;
  return `Render health: average ${averageFps.toFixed(1)} FPS, 1% low ${low1PctFps.toFixed(1)} FPS`;
}

export type KilledAgentSummary = {
  readonly taskId?: string;
  readonly description?: string;
};

export function formatAgentsKilledNotification(
  agents: readonly KilledAgentSummary[],
): string | null {
  if (agents.length === 0) return null;
  const labels = agents
    .map(agent => agent.description?.trim())
    .filter((label): label is string => Boolean(label));
  if (labels.length !== agents.length) {
    return agents.length === 1
      ? "Stopped 1 background agent"
      : `Stopped ${agents.length} background agents`;
  }
  if (labels.length === 1) return `Stopped background agent: ${labels[0]}`;
  if (labels.length > 1) {
    return `Stopped ${labels.length} background agents: ${labels.join(", ")}`;
  }
  return agents.length === 1
    ? "Stopped 1 background agent"
    : `Stopped ${agents.length} background agents`;
}

export function shouldShowPromptInputState(options: {
  readonly isMessageSelectorVisible: boolean;
  readonly permissionRequestCount: number;
  readonly hasElicitationPrompt: boolean;
  readonly completionPipelineOwnsPrompt: boolean;
  readonly toolShouldHidePromptInput?: boolean;
}): boolean {
  return (
    !options.isMessageSelectorVisible &&
    options.permissionRequestCount === 0 &&
    !options.hasElicitationPrompt &&
    !options.completionPipelineOwnsPrompt &&
    options.toolShouldHidePromptInput !== true
  );
}

/**
 * Top-level wrapper for interactive sessions.
 * Provides FPS metrics, stats context, and app state to the component tree.
 */
export function App(t0) {
  const $ = _c(9);
  const {
    getFpsMetrics,
    stats,
    initialState,
    children
  } = t0;
  let t1;
  if ($[0] !== children || $[1] !== initialState) {
    t1 = <AppStateProvider initialState={initialState} onChangeAppState={onChangeAppState}>{children}</AppStateProvider>;
    $[0] = children;
    $[1] = initialState;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  let t2;
  if ($[3] !== stats || $[4] !== t1) {
    t2 = <StatsProvider store={stats}>{t1}</StatsProvider>;
    $[3] = stats;
    $[4] = t1;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  let t3;
  if ($[6] !== getFpsMetrics || $[7] !== t2) {
    t3 = <FpsMetricsProvider getFpsMetrics={getFpsMetrics}>{t2}</FpsMetricsProvider>;
    $[6] = getFpsMetrics;
    $[7] = t2;
    $[8] = t3;
  } else {
    t3 = $[8];
  }
  return t3;
}
function initialPermissionContext(props: AgenCTuiProps): ToolPermissionContext {
  return props.session.services.permissionModeRegistry.current();
}
function startupModel(props: AgenCTuiProps): string | null {
  return props.model ?? props.session.sessionConfiguration?.collaborationMode?.model ?? null;
}
function initialState(props: AgenCTuiProps): any {
  const agentDefinitions = listAgentRoleDefinitions();
  return {
    ...getDefaultAppState(),
    mainLoopModel: startupModel(props),
    mainLoopModelForSession: startupModel(props),
    toolPermissionContext: initialPermissionContext(props),
    agentDefinitions: {
      activeAgents: [...agentDefinitions],
      allAgents: [...agentDefinitions],
    }
  };
}

type SetToolPermissionContext = (next: ToolPermissionContext) => void;

function daemonPermissionModeFn(
  session: AgenCTuiProps["session"],
): ((mode: ToolPermissionContext["mode"]) => Promise<unknown>) | null {
  const fn = session.setDaemonPermissionMode;
  return typeof fn === "function" ? fn.bind(session) : null;
}

function emitPermissionModeSyncWarning(
  session: AgenCTuiProps["session"],
  mode: ToolPermissionContext["mode"],
  err: unknown,
): void {
  if (typeof session.emit !== "function" || typeof session.nextInternalSubId !== "function") {
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause: "permission_mode_sync_failed",
        message: `Failed to change daemon permission mode to ${mode}: ${message}`,
      },
    },
  });
}

function useSyncedPermissionContext(
  session: AgenCTuiProps["session"],
): readonly [ToolPermissionContext, SetToolPermissionContext] {
  const toolPermissionContext = useAppState(_temp2) as ToolPermissionContext;
  const setAppState = useSetAppState();
  useEffect(() => {
    return session.services.permissionModeRegistry.subscribeToModeChange?.(() => {
      const next = session.services.permissionModeRegistry.current();
      setAppState(prev => ({
        ...prev,
        toolPermissionContext: next
      }));
    });
  }, [session, setAppState]);
  const setToolPermissionContext = useCallback((next: ToolPermissionContext) => {
    const registry = session.services.permissionModeRegistry;
    const daemonSetMode = daemonPermissionModeFn(session);
    const applyLocal = async (): Promise<void> => {
      setAppState(prev => ({
        ...prev,
        toolPermissionContext: next
      }));
      await registry.update?.(next);
    };
    if (daemonSetMode === null || next.mode === registry.current().mode) {
      void applyLocal().catch(_temp3);
      return;
    }
    const previous = registry.current();
    void daemonSetMode(next.mode)
      .then(() => applyLocal())
      .catch(err => {
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: previous
        }));
        emitPermissionModeSyncWarning(session, next.mode, err);
      });
  }, [session, setAppState]);
  return [toolPermissionContext, setToolPermissionContext] as const;
}
function _temp3() {}
function _temp2(s) {
  return s.toolPermissionContext;
}
function useInitialSubmit(session, submit, initialPrompt, initialUserMessages) {
  const $ = _c(6);
  const submitted = useRef(false);
  let t0;
  let t1;
  if ($[0] !== initialPrompt || $[1] !== initialUserMessages || $[2] !== session || $[3] !== submit) {
    t0 = () => {
      if (submitted.current) {
        return;
      }
      const hasPrompt = typeof initialPrompt === "string" && initialPrompt.length > 0;
      const startupMessages = initialUserMessages ?? [];
      if (!hasPrompt && startupMessages.length === 0) {
        return;
      }
      submitted.current = true;
      for (const message of startupMessages) {
        session.enqueueIdleInput?.(message);
      }
      if (hasPrompt) {
        submit(initialPrompt).catch(_temp4);
      } else {
        session.submit?.("", {
          displayUserMessage: null
        }).catch(_temp5);
      }
    };
    t1 = [initialPrompt, initialUserMessages, session, submit];
    $[0] = initialPrompt;
    $[1] = initialUserMessages;
    $[2] = session;
    $[3] = submit;
    $[4] = t0;
    $[5] = t1;
  } else {
    t0 = $[4];
    t1 = $[5];
  }
  useEffect(t0, t1);
}
function _temp5() {}
function _temp4() {}
type McpSurfaceSnapshot = {
  readonly clients: readonly MCPServerConnection[];
  readonly tools: readonly unknown[];
};
function readMcpSurfaceSnapshot(session: AgenCTuiProps["session"]): McpSurfaceSnapshot {
  return {
    clients: session.listMcpClients?.() ?? EMPTY_MCP_CLIENTS,
    tools: session.listMcpTools?.() ?? EMPTY_MCP_TOOLS
  };
}
function mcpSurfaceValueSignature(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "function") return "[function]";
      return nested;
    });
  } catch {
    return "[unserializable]";
  }
}
function mcpSurfaceObjectIdentity(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  let id = mcpSurfaceObjectIds.get(value);
  if (id === undefined) {
    id = nextMcpSurfaceObjectId++;
    mcpSurfaceObjectIds.set(value, id);
  }
  return String(id);
}
function mcpSurfaceSignature(snapshot: McpSurfaceSnapshot): string {
  const clients = snapshot.clients.map(client => {
    const maybeError = "error" in client ? mcpSurfaceValueSignature(client.error) : "";
    const connectedIdentity = client.type === "connected" ? mcpSurfaceObjectIdentity(client) : "";
    return [client.name, client.type, maybeError, mcpSurfaceValueSignature(client.config), connectedIdentity].join(":");
  });
  const tools = snapshot.tools.map(tool => {
    if (tool && typeof tool === "object") {
      const typed = tool as {
        readonly name?: unknown;
        readonly description?: unknown;
        readonly inputSchema?: unknown;
      };
      return [typed.name, typed.description, typed.inputSchema, mcpSurfaceObjectIdentity(tool)].map(mcpSurfaceValueSignature).join(":");
    }
    return "";
  });
  return `${clients.join("\u0000")}\u0001${tools.join("\u0000")}`;
}
function useSessionMcpSurface(session) {
  const $ = _c(8);
  let t0;
  if ($[0] !== session) {
    t0 = () => readMcpSurfaceSnapshot(session);
    $[0] = session;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  const [snapshot, setSnapshot] = useState(t0);
  let t1;
  if ($[2] !== session) {
    t1 = () => {
      setSnapshot(previous => {
        const next = readMcpSurfaceSnapshot(session);
        return mcpSurfaceSignature(previous) === mcpSurfaceSignature(next) ? previous : next;
      });
    };
    $[2] = session;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  const refresh = t1;
  let t2;
  let t3;
  if ($[4] !== refresh || $[5] !== session) {
    t2 = () => {
      refresh();
      const unsubscribe = session.subscribeToEvents?.(() => refresh());
      const interval = setInterval(refresh, 1500);
      return () => {
        unsubscribe?.();
        clearInterval(interval);
      };
    };
    t3 = [refresh, session];
    $[4] = refresh;
    $[5] = session;
    $[6] = t2;
    $[7] = t3;
  } else {
    t2 = $[6];
    t3 = $[7];
  }
  useEffect(t2, t3);
  return snapshot;
}
function extractTag(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return null;
  const contentStart = start + open.length;
  const end = text.indexOf(close, contentStart);
  if (end === -1) return null;
  return text.slice(contentStart, end);
}
function restoreComposerText(message: any): {
  text: string;
  mode: "bash" | "prompt";
} | null {
  if (message?.type !== "user") return null;
  const content = message.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const bash = extractTag(trimmed, "bash-input");
  if (bash !== null) return {
    text: unescapeXml(bash),
    mode: "bash"
  };
  const command = extractTag(trimmed, "command-name");
  if (command !== null) {
    const args = extractTag(trimmed, "command-args") ?? "";
    return {
      text: `${unescapeXml(command)} ${unescapeXml(args)}`.trim(),
      mode: "prompt"
    };
  }
  return {
    text: trimmed,
    mode: "prompt"
  };
}
const CONVERSATION_ACTION_BUSY_MESSAGE = "Conversation actions are available after the current turn finishes.";
function hasActiveConversationTurn(session: any): boolean {
  return typeof session?.activeTurn?.unsafePeek === "function" && session.activeTurn.unsafePeek() !== null;
}
function isCompactProgressEvent(event: unknown): event is {
  readonly type: "hooks_start" | "compact_start" | "compact_end";
  readonly hookType?: "pre_compact" | "post_compact" | "session_start";
} {
  if (!event || typeof event !== "object") return false;
  const type = (event as {
    readonly type?: unknown;
  }).type;
  return type === "hooks_start" || type === "compact_start" || type === "compact_end";
}
function compactHookLabel(hookType: unknown): string {
  if (hookType === "pre_compact") return "Running PreCompact hooks";
  if (hookType === "post_compact") return "Running PostCompact hooks";
  return "Running SessionStart hooks";
}
const TITLE_ANIMATION_FRAME_COUNT = 2;
const TITLE_ANIMATION_INTERVAL_MS = 960;

export function animatedTerminalTitlePrefix(
  isAnimating: boolean,
  frame: number,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const glyphs = selectAgenCTuiGlyphs(env);
  return isAnimating
    ? glyphs.titleAnimationFrames[frame] ?? glyphs.titleStaticPrefix
    : glyphs.titleStaticPrefix;
}

export function visibleCancelStreamMode(
  showSpinner: boolean,
  streamMode: SpinnerMode,
): SpinnerMode | undefined {
  return showSpinner ? streamMode : undefined;
}

/**
 * Maintains the terminal-title side effect for the live AgenC TUI shell.
 *
 * Current shape:
 *   - AgenC does not carry session rename or generated-title state in this
 *     bridge, so the title is derived from the active provider/model when
 *     available and otherwise falls back to the product name.
 *
 * Cross-cuts deliberately not carried:
 *   - Generated title extraction and session rename persistence; those need
 *     their own runtime state bridge before they can be live behavior.
 *   - Terminal tab status integration; this path only owns OSC title writes.
 */
function AnimatedTerminalTitle(t0) {
  const $ = _c(6);
  const {
    isAnimating,
    title,
    disabled: t1,
    noPrefix: t2
  } = t0;
  const disabled = t1 === undefined ? false : t1;
  const noPrefix = t2 === undefined ? false : t2;
  const terminalFocused = useTerminalFocus();
  const [frame, setFrame] = useState(0);
  let t3;
  let t4;
  if ($[0] !== disabled || $[1] !== isAnimating || $[2] !== noPrefix || $[3] !== terminalFocused) {
    t3 = () => {
      if (disabled || noPrefix || !isAnimating || !terminalFocused) {
        return;
      }
      const interval = setInterval(() => {
        setFrame(_temp6);
      }, TITLE_ANIMATION_INTERVAL_MS);
      return () => clearInterval(interval);
    };
    t4 = [disabled, isAnimating, noPrefix, terminalFocused];
    $[0] = disabled;
    $[1] = isAnimating;
    $[2] = noPrefix;
    $[3] = terminalFocused;
    $[4] = t3;
    $[5] = t4;
  } else {
    t3 = $[4];
    t4 = $[5];
  }
  useEffect(t3, t4);
  const prefix = animatedTerminalTitlePrefix(isAnimating, frame);
  useTerminalTitle(disabled ? null : noPrefix ? title : `${prefix} ${title}`);
  return null;
}
function _temp6(current) {
  return (current + 1) % TITLE_ANIMATION_FRAME_COUNT;
}
function terminalTitle(props: Parameters<typeof startupModel>[0]): string {
  const provider = props.session.sessionConfiguration?.provider?.slug?.trim();
  const model = startupModel(props)?.trim();
  if (provider && model) return `AgenC ${provider}/${model}`;
  if (model) return `AgenC ${model}`;
  return "AgenC";
}
function AgenCTuiShell(props: AgenCTuiProps): React.ReactElement {
  const {
    exit
  } = useApp();
  const getFpsMetrics = useFpsMetrics();
  useCostSummary(getFpsMetrics);
  const renderHealthWarning = formatRenderHealthWarning(getFpsMetrics?.());
  const backpressureSnapshot = useSyncExternalStore(
    subscribeTuiBackpressure,
    getTuiBackpressureSnapshot,
    getTuiBackpressureSnapshot,
  );
  const backpressureWarning = formatTuiBackpressureWarning(backpressureSnapshot);
  const { addNotification } = useNotifications();
  const {
    status: apiKeyStatus,
    reverify
  } = useApiKeyVerification();
  useEffect(() => {
    void reverify();
  }, [reverify]);
  const [completionPipelineState, setCompletionPipelineState] =
    useState<CompletionPipelineState>(() => readCompletionPipelineState());
  useEffect(() => {
    const refresh = () => setCompletionPipelineState(readCompletionPipelineState());
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, []);
  const completionPipelineRows = formatCompletionPipelineRows(completionPipelineState);
  const completionPipelineActive = completionPipelineOwnsPrompt(completionPipelineState);
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const modalScrollRef = useRef<ScrollBoxHandle | null>(null);
  const fullscreen = isFullscreenEnvEnabled();
  const workbenchEnabled = fullscreen && isWorkbenchEnabled();
  const workbenchState = useAppState(getWorkbenchStateFromAppState);
  // SpinnerWithVerb wall-clock timer state. Refs (not state) so the spinner's
  // 50ms animation tick doesn't re-render AgenCTuiShell — SpinnerAnimationRow
  // owns the per-frame clock and reads these refs directly.
  const loadingStartTimeRef = useRef<number>(0);
  const totalPausedMsRef = useRef<number>(0);
  const pauseStartTimeRef = useRef<number | null>(null);
  const responseLengthRef = useRef<number>(0);
  // Reset timing on isStreaming false→true. Tracks previous via a ref so the
  // reset runs in the same render the spinner first appears. Without the
  // inline reset, the first spinner render after submit sees
  // loadingStartTimeRef=0 and computes a 56-year elapsed time.
  const wasStreamingRef = useRef<boolean>(false);
  const [input, setInput] = useState(props.initialComposerText ?? "");
  const [mode, setMode] = useState<any>("prompt");
  const [stashedPrompt, setStashedPrompt] = useState<any>(undefined);
  const [submitCount, setSubmitCount] = useState(0);
  // Phase 5 #51: bridge the gap between user-pressed-Enter and
  // daemon-emitted turn_started. `transcript.isStreaming` only flips
  // true when the daemon sends `turn_started`, which can take
  // hundreds of ms (network ack, daemon mailbox enqueue, agent
  // wake-up). Without a local "I just submitted" signal, the user
  // stares at a static UI with no spinner and no confirmation that
  // anything is happening. This local state goes true at the start
  // of model-bound `submit()` calls and clears on the next
  // isStreaming=true tick (real turn started) or on submit error
  // (catch wrapper for #61). Local slash commands skip this state so
  // immediate command errors don't flash a model-request spinner.
  const [pendingSubmission, setPendingSubmission] = useState(false);
  const [pastedContents, setPastedContents] = useState<Record<number, any>>({});
  const [vimMode, setVimMode] = useState<VimMode>("INSERT");
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [screen, setScreen] = useState<"prompt" | "transcript">("prompt");
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] = useState(false);
  const [selectorNotice, setSelectorNotice] = useState<string | null>(null);
  const summarizeAbortRef = useRef<AbortController | null>(null);
  const [exitFlow, setExitFlow] = useState<React.ReactNode>(null);
  const [haveShownCostDialog, setHaveShownCostDialog] = useState(() => getGlobalConfig().hasAcknowledgedCostThreshold === true);
  const [showCostDialog, setShowCostDialog] = useState(false);
  const [compactProgress, setCompactProgress] = useState({
    status: "idle",
    label: null as string | null,
    responseLength: 0
  });
  const setAppState = useSetAppState();
  const appStateStore = useAppStateStore();
  const getBridgeAppState = useCallback(() => appStateStore.getState(), [appStateStore]);
  useEffect(() => {
    const subscribe = props.session.subscribeToEvents;
    if (typeof subscribe !== "function") return;
    return subscribe((event: unknown) => {
      syncCollabAgentEventToAppState(event, setAppState);
    });
  }, [props.session, setAppState]);
  const [toolPermissionContext, setToolPermissionContext] = useSyncedPermissionContext(props.session);
  const config = useMemo(() => props.configStore.current?.() ?? defaultConfig(), [props.configStore]);
  const agencHome = props.configStore.agencHome ?? config.agenc_home ?? props.session.home;
  const onboardingContext = useMemo(() => ({
    agencHome,
    config,
    cwd: props.session.cwd ?? props.session.sessionConfiguration?.cwd,
    env: process.env,
    permissionMode: String(toolPermissionContext.mode),
    sandboxMode: config.sandbox_mode ?? config.sandbox?.mode,
    terminalName: process.env.TERM_PROGRAM ?? process.env.TERM
  }), [agencHome, config, props.session.cwd, props.session.sessionConfiguration?.cwd, toolPermissionContext.mode]);
  // Stable reference for the empty fallback. `?? []` would allocate a fresh
  // array on every render, which invalidates useSessionTranscript's useMemo
  // dependency and causes `transcript.messages` to be a fresh array on every
  // keystroke — that fresh identity defeats Messages's React.memo and
  // re-renders the entire message tree per keystroke.
  const transcript = useSessionTranscript(
    props.session,
    props.initialUserMessages ?? EMPTY_INITIAL_USER_MESSAGES,
  );
  // Refs for things the slash-command submit handler needs to read live
  // without re-creating its stable useCallback closure on every render.
  // transcriptMessagesRef gives local command handlers a
  // real conversation history (some command handlers call
  // getMessagesAfterCompactBoundary(context.messages); an empty array
  // would crash them mid-flow).
  const transcriptMessagesRef = useRef<readonly unknown[]>(transcript.messages);
  useEffect(() => {
    transcriptMessagesRef.current = transcript.messages;
  }, [transcript.messages]);
  const realtimeState = useRealtimeState(props.session.realtime);
  const [toolJSX, setToolJSX] = useToolJSX();
  const setModel = useCallback((next: string) => {
    setAppState(prev => ({
      ...prev,
      mainLoopModel: next,
      mainLoopModelForSession: next
    }));
    const switchSpec = buildPendingProviderSwitch(props.session, next);
    if (switchSpec !== null) {
      props.session.setPendingProviderSwitch?.(switchSpec);
    }
  }, [setAppState, props.session]);
  const applyOnboardingSelection = useCallback((next_0: FirstRunOnboardingState) => {
    setModel(next_0.selectedModel);
    props.session.setPendingProviderSwitch?.({
      provider: next_0.selectedProvider,
      model: next_0.selectedModel
    });
  }, [props.session, setModel]);
  const onboarding = useFirstRunOnboardingController({
    ...onboardingContext,
    hasInitialPrompt: (props.initialPrompt?.length ?? 0) > 0 || (props.initialUserMessages?.length ?? 0) > 0,
    isInteractive: props.isInteractive ?? process.stdin.isTTY === true,
    onComplete: applyOnboardingSelection
  });
  const setExpandedView = useCallback((next_1: "none" | "tasks") => {
    setAppState(prev_0 => ({
      ...prev_0,
      expandedView: next_1
    }));
  }, [setAppState]);
  const permissionRequests = usePermissionRequests(props.session, setModel, setExpandedView, setAppState, getBridgeAppState);
  const elicitation = useTuiElicitation(props.session);
  const toolNames = useMemo(() => {
    const names = new Set(transcript.toolNames);
    const firstPermission = permissionRequests[0];
    if (firstPermission) names.add(firstPermission.ctx.toolName);
    return names;
  }, [permissionRequests, transcript.toolNames]);
  const tools = useMemo(() => createTuiTools(toolNames), [toolNames]);
  const mcpSurface = useSessionMcpSurface(props.session);
  const mcpClients = mcpSurface.clients;
  const availableTools = useMemo(() => [...tools, ...mcpSurface.tools], [tools, mcpSurface.tools]);
  const refreshAvailableTools = useCallback(() => [...tools, ...readMcpSurfaceSnapshot(props.session).tools], [props.session, tools]);
  const commandRegistry = useMemo(() => buildDefaultRegistry({
    surface: "daemon-tui"
  }), []);
  useEffect(() => {
    setGlobalCommandRegistry(commandRegistry);
    return () => {
      setGlobalCommandRegistry(null);
    };
  }, [commandRegistry]);
  const commands = useMemo(() => listTuiCommandList(commandRegistry), [commandRegistry]);
  const agents = useMemo(() => listAgentRoleDefinitions(), []);
  const appTasks = useAppState(s => s.tasks);
  const hasActiveLocalAgents = getActiveLocalAgentTasks(appTasks).length > 0;
  const hasActiveSessionTurn = hasActiveConversationTurn(props.session);
  const isLoading = transcript.isStreaming || pendingSubmission || hasActiveSessionTurn;
  const effectiveInputBusy = isLoading || hasActiveLocalAgents || completionPipelineActive;
  const effectiveInputBusyRef = useRef(effectiveInputBusy);
  effectiveInputBusyRef.current = effectiveInputBusy;
  const queuedCommands = useCommandQueue();
  const queueDrainActiveRef = useRef(false);
  const [, setQueueDrainTick] = useState(0);

  // Tool-use context builder. Declared above submit so the slash-command
  // interceptor can read it without TDZ on first render. Also handed to
  // PromptInput further down so non-slash flows keep their existing
  // wiring. The `messages` parameter is passed through so command handlers
  // that read context.messages see real conversation history rather than
  // the empty array the old call site passed.
  const getToolUseContext = useCallback((messages: unknown[], _newMessages: unknown[], abortController: AbortController) => ({
    abortController: props.session.abortController ?? abortController ?? new AbortController(),
    cwd: props.session.cwd ?? props.session.sessionConfiguration?.cwd,
    getAppState: () => appStateStore.getState(),
    getToolPermissionContext: async () => toolPermissionContext,
    messages,
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    options: {
      commands,
      tools: availableTools,
      mcpClients,
      mcpResources: {},
      isNonInteractiveSession: false,
      refreshTools: refreshAvailableTools
    },
    services: props.session.services,
    session: props.session,
    tools: availableTools,
    setToolJSX,
    mcpClients,
    setAppState,
    setMessages: () => {},
    onChangeAPIKey: reverify,
  }) as any, [appStateStore, commands, availableTools, mcpClients, props.session, refreshAvailableTools, toolPermissionContext, setToolJSX, setAppState, reverify]);

  // Transient-message helper for local slash-command results.
  const transientResultTimerRef = useRef<NodeJS.Timeout | null>(null);
  const showTransientResult = useCallback((text: string, opts?: {
    display?: string;
  }) => {
    if (transientResultTimerRef.current !== null) {
      clearTimeout(transientResultTimerRef.current);
      transientResultTimerRef.current = null;
    }
    const isError = (opts?.display ?? "").toLowerCase() === "error";
    setToolJSX({
      jsx: <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={isError ? "error" : "lineSoft"}>
            <Text>{text}</Text>
          </Box>,
      shouldHidePromptInput: false
    });
    transientResultTimerRef.current = setTimeout(() => {
      transientResultTimerRef.current = null;
      setToolJSX(null);
    }, 3000);
  }, [setToolJSX]);
  useEffect(() => {
    return () => {
      if (transientResultTimerRef.current !== null) {
        clearTimeout(transientResultTimerRef.current);
        transientResultTimerRef.current = null;
      }
    };
  }, []);
  const runQueuedBashCommand = useCallback(async (command: string) => {
    const trimmedBash = command.trim();
    if (trimmedBash.length === 0) return;
    const ctx = getToolUseContext(
      transcriptMessagesRef.current as unknown[],
      [],
      new AbortController(),
    ) as PromptInputContext & {
      session?: {
        emit?: (event: unknown) => void;
        nextInternalSubId?: () => string;
      };
      setToolJSX?: (jsx: unknown) => void;
    };
    const session = ctx.session;
    const emit =
      typeof session?.emit === "function" ? session.emit.bind(session) : undefined;
    const nextId =
      typeof session?.nextInternalSubId === "function"
        ? session.nextInternalSubId.bind(session)
        : (() => `bash-${Date.now()}`);
    const emitTranscriptText = (text: string) => {
      emit?.({
        id: nextId(),
        msg: {
          type: "user_message",
          payload: { displayText: text, message: text }
        }
      });
    };

    emitTranscriptText(`<bash-input>${escapeXml(trimmedBash)}</bash-input>`);
    try {
      const { processBashCommand } = await import("../input/processBashCommand.js");
      const result = await processBashCommand(
        trimmedBash,
        [],
        [],
        ctx,
        ctx.setToolJSX ?? (() => {}),
      );
      for (const message_0 of result.messages) {
        const text_1 = extractUserMessageText(message_0);
        if (text_1 === null) continue;
        if (
          !text_1.startsWith("<bash-stdout") &&
          !text_1.startsWith("<bash-stderr")
        ) {
          continue;
        }
        emitTranscriptText(text_1);
      }
    } catch (err_1) {
      const message_1 = err_1 instanceof Error ? err_1.message : String(err_1);
      emitTranscriptText(`<bash-stderr>${escapeXml(message_1)}</bash-stderr>`);
    }
  }, [getToolUseContext]);
  const submit = useCallback(async (value: string, options?: LiveSubmitOptions) => {
    const text_0 = value.trim();
    const activePastedContents = options?.pastedContentsOverride ?? pastedContents;
    const hasAttachments = Object.keys(activePastedContents).length > 0;
    if (text_0.length === 0 && !hasAttachments) return;
    const parsedSlashCommand =
      text_0.startsWith("/") && text_0.length > 1
        ? parseSlashCommand(text_0)
        : null;
    const parsedDollarSkill =
      text_0.startsWith("$") && text_0.length > 1
        ? parseDollarSkillCommand(text_0)
        : null;
    if (
      !options?.fromQueue &&
      parsedSlashCommand !== null &&
      effectiveInputBusyRef.current &&
      BUSY_BLOCKED_SLASH_COMMANDS.has(parsedSlashCommand.name)
    ) {
      showTransientResult(busySlashCommandMessage(parsedSlashCommand.name), {
        display: "error",
      });
      setInput("");
      setPastedContents({});
      return;
    }
    if (!options?.fromQueue && effectiveInputBusyRef.current) {
      enqueue({
        value: text_0,
        preExpansionValue: text_0,
        mode: "prompt",
        ...(hasAttachments ? { pastedContents: activePastedContents } : {}),
      });
      setInput("");
      setPastedContents({});
      if (text_0.length > 0) {
        try {
          addToHistory({
            display: text_0,
            pastedContents: activePastedContents,
          });
        } catch {
        }
      }
      return;
    }
    // Clear any pending transient status overlay (e.g. a slash-command
    // usage error) so the prior status doesn't bleed into the new turn.
    // The 3s auto-clear timer is a safety net; this is the immediate
    // user-input clear path.
    if (transientResultTimerRef.current !== null) {
      clearTimeout(transientResultTimerRef.current);
      transientResultTimerRef.current = null;
      setToolJSX(null);
    }
    const startPendingSubmission = () => {
      setPendingSubmission(true);
      effectiveInputBusyRef.current = true;
    };
    setSubmitCount(count => count + 1);
    if (parsedSlashCommand === null && parsedDollarSkill === null) {
      startPendingSubmission();
    }
    setInput("");
    // Persist the submitted prompt so Up-arrow / Ctrl+R history recall
    // can find it. The daemon-backed AgenCTuiApp dispatch path used to
    // skip this, so the picker said "No history yet" right after a
    // submit and Up-arrow on an empty composer was a no-op (flagged
    // by the power-chainer + returning-user personas). Keep it here for
    // the live mount path.
    if (!options?.fromQueue && text_0.length > 0) {
      try {
        addToHistory({
          display: text_0,
          pastedContents: activePastedContents,
        });
      } catch {
        // best-effort: history persistence must not block submit
      }
    }
    if (hasAttachments) {
      const attachmentsMessage = pastedContentsToLLMMessage(activePastedContents);
      if (attachmentsMessage !== null) {
        props.session.enqueueIdleInput?.(attachmentsMessage);
      }
    }
    setPastedContents({});
    // Slash-command interception. The daemon-backed TUI does not have
    // any server-side slash-command dispatch — every / input would
    // otherwise be forwarded to the model as plain text and the model
    // would respond with generic prose instead of running the command.
    //
    // Slash commands route through the canonical registry. Unrecognized names go
    // through the dispatcher so the TUI matches the daemon/CLI slash path.
    if (parsedSlashCommand !== null) {
      try {
        // Echo the slash-command input to the transcript so the user
        // sees what they typed. Without this the dispatcher
        // intercepts `/foo` silently and only the result overlay
        // appears, leaving no audit trail of what the user invoked.
        // We emit a user_message event directly (instead of routing
        // through props.session.submit) because submit forwards to
        // the model — which we explicitly do not want for a slash
        // command.
        try {
          const internalId = typeof props.session.nextInternalSubId === "function" ? props.session.nextInternalSubId() : `slash-echo-${Date.now()}`;
          props.session.emit?.({
            id: internalId,
            msg: {
              type: "user_message",
              payload: {
                displayText: text_0,
                message: text_0
              }
            }
          });
        } catch {
          // best-effort echo; don't block dispatch on telemetry
        }
        // Build a renderResult helper used by both structured and
        // built-in dispatch paths. Returns true if the result was a
        // "prompt" that needs to be forwarded to the model so the
        // caller can decide whether to keep pendingSubmission set
        // (forwarding) or clear it (handled-locally).
        const renderResult = (result: {
          kind: "text";
          text: string;
        } | {
          kind: "error";
          message: string;
        } | {
          kind: "skip";
        } | {
          kind: "compact";
          text: string;
        } | {
          kind: "prompt";
          content: string;
        } | {
          kind: "exit";
          code?: number;
        }): {
          forwardedToModel: boolean;
        } => {
          if (result.kind === "skip") return {
            forwardedToModel: false
          };
          if (result.kind === "exit") {
            // /exit (and its `/quit` alias) returns kind:"exit" after
            // calling session.shutdown(). The TUI needs to unmount
            // the Ink app and let the parent process exit cleanly.
            // Without this branch, /exit was silently swallowed and
            // the user had to Ctrl-C twice to escape. `exit` here is
            // destructured from `useApp()` at the AgenCTuiShell top
            // level.
            exit();
            return { forwardedToModel: false };
          }
          if (result.kind === "prompt") {
            // Slash command produced a next prompt for the model.
            // Queue it through the same next-turn path used by busy input
            // so `nextInput`/prompt results are visible and never bypass
            // ordering gates.
            enqueueSlashPromptResult(result.content, () => {
              setQueueDrainTick(tick => tick + 1);
            });
            return {
              forwardedToModel: false
            };
          }
          const display = result.kind === "text" || result.kind === "compact" ? result.text : result.kind === "error" ? `Error: ${result.message}` : null;
          if (display === null) return {
            forwardedToModel: false
          };
          // Route through showTransientResult so the overlay auto-clears
          // after ~3s and on the next user input. Prior code called
          // setToolJSX directly without a clear path, so an error like
          // `Usage: /model <model-name>` would persist across every
          // subsequent prompt until another setToolJSX fired.
          showTransientResult(display, {
            display: result.kind === "error" ? "error" : undefined
          });
          return {
            forwardedToModel: false
          };
        };

        const outcome = await dispatchSlashCommand(parsedSlashCommand, {
          session: props.session,
          argsRaw: parsedSlashCommand.argsRaw,
          cwd: props.session.cwd ?? props.session.sessionConfiguration?.cwd ?? process.cwd(),
          home: process.env.HOME ?? "",
          agencHome,
          ...(props.session.services?.configStore ? {
            configStore: props.session.services.configStore
          } : {}),
          appState: {
            getAppState: () => appStateStore.getState(),
            setModel,
            setAppState,
            setToolJSX,
            tools: availableTools,
            // /resume picker: record the chosen session id, then drain Ink.
            // After waitUntilExit() the boot entrypoint relaunches into the
            // proven attach path for this id (see tui/pending-resume.ts). We
            // never touch props.session here — commands must not swap it in
            // place — so the prior session is cleanly detached on exit first.
            requestResumeSession: (sessionId: string) => {
              setPendingResumeSessionId(sessionId);
              exit();
            }
          },
          commandRegistry
        }, commandRegistry);
        if (outcome.result.kind !== "skip" || outcome.command !== undefined) {
          const dispatched_0 = renderResult(outcome.result as never);
          if (!dispatched_0.forwardedToModel) {
            setPendingSubmission(false);
          }
          return;
        }
      } catch (err) {
        // Fall through to the model on dispatch errors so the user
        // doesn't lose their input.
      }
    }
    if (parsedDollarSkill !== null) {
      const command = findCommand(parsedDollarSkill.commandName, commands as unknown as Command[]);
      if (isDollarSkillCommand(command)) {
        try {
          const loaded = await loadDollarSkillCommandForTurn(
            parsedDollarSkill,
            command,
            getToolUseContext(
              transcriptMessagesRef.current as any[],
              [],
              new AbortController(),
            ) as PromptInputContext,
          );
          props.session.enqueueIdleInput?.(loaded.metadata);
          props.session.enqueueIdleInput?.({ content: loaded.blocks });
          startPendingSubmission();
          await props.session.submit?.("", { displayUserMessage: text_0 });
        } catch (err_1) {
          const message_0 = err_1 instanceof Error ? err_1.message : String(err_1);
          showTransientResult(message_0, {
            display: "error"
          });
          setPendingSubmission(false);
        }
        return;
      }
      if (command?.type === "local") {
        showTransientResult(`Use /${parsedDollarSkill.commandName} for commands. Skills use $skill-name.`, {
          display: "error"
        });
        setPendingSubmission(false);
        return;
      }
      showTransientResult(`Unknown skill: $${parsedDollarSkill.commandName}\nUse /skills to list skills or /skills new ${parsedDollarSkill.commandName} to create one.`, {
        display: "error"
      });
      setPendingSubmission(false);
      return;
    }
    if (parsedSlashCommand !== null) {
      startPendingSubmission();
    }
    try {
      // Pass `value` as displayUserMessage so the daemon emits the
      // user-message transcript event with the user's raw typed text,
      // not the model-facing expanded payload. Without this the
      // transcript can show the post-expansion envelope instead of
      // the original input. Pairs with the daemon-hook change in
      // background-agent-runner.installDaemonTurnDriverHooks that
      // suppresses the run-turn duplicate emit.
      await props.session.submit?.(value, { displayUserMessage: value });
    } catch (err_1) {
      // Same defense as submitPromptToModel above: a daemon JSON-RPC
      // error response (e.g. "AgenC daemon agent not running:
      // <agentId>") rejects the pending request, which turns into an
      // unhandledRejection at the React onSubmit boundary if we don't
      // catch here. Surface in the UI so the operator can see what
      // happened — most commonly the agent was evicted after a
      // mid-turn compact failure or daemon restart.
      const message_0 = err_1 instanceof Error ? err_1.message : String(err_1);
      showTransientResult(message_0, {
        display: "error"
      });
      // Submit threw before turn_started arrived — clear the
      // pending-submission spinner so the UI doesn't lie about
      // waiting for a turn that will never start.
      setPendingSubmission(false);
    }
  }, [pastedContents, props.session, setToolJSX, showTransientResult, commandRegistry]);
  // When the daemon shows any sign of activity, drop the optimistic
  // pending-submission flag. We don't gate this only on isStreaming
  // (turn_started) because the daemon sometimes skips that event and
  // goes straight to turn_complete with the message — leaving
  // pendingSubmission stuck true forever and the spinner running long
  // after the response landed. Any of these signals means the daemon
  // saw the submission:
  //   - isStreaming flipped true (turn_started arrived)
  //   - streamingText is flowing
  //   - the assistant message count grew (turn_complete pushed a row)
  const lastAssistantMessageCountRef = useRef(0);
  const assistantMessageCount = useMemo(() => {
    let count_0 = 0;
    for (const m of transcript.messages as readonly {
      type?: string;
    }[]) {
      if (m.type === "assistant") count_0++;
    }
    return count_0;
  }, [transcript.messages]);
  useEffect(() => {
    if (transcript.isStreaming || transcript.streamingText !== null || assistantMessageCount > lastAssistantMessageCountRef.current) {
      lastAssistantMessageCountRef.current = assistantMessageCount;
      setPendingSubmission(false);
    }
  }, [transcript.isStreaming, transcript.streamingText, assistantMessageCount]);
  useInitialSubmit(props.session, submit, props.initialPrompt, props.initialUserMessages);
  useEffect(() => {
    if (queueDrainActiveRef.current) return;
    if (effectiveInputBusy) return;
    if (permissionRequests.length > 0 || elicitation.prompt !== null || isMessageSelectorVisible || onboarding.active) return;
    if (queuedCommands.length === 0) return;
    const command = dequeueNextMainThreadRunnableCommand();
    if (command === undefined) return;
    queueDrainActiveRef.current = true;
    const queuedText = queuedCommandInputText(command);
    const run =
      command.mode === "bash"
        ? runQueuedBashCommand(queuedText)
        : submit(queuedText, {
            fromQueue: true,
            ...(command.pastedContents !== undefined ? { pastedContentsOverride: command.pastedContents } : {}),
          });
    void run.finally(() => {
      queueDrainActiveRef.current = false;
      setQueueDrainTick(tick => tick + 1);
    });
  }, [effectiveInputBusy, permissionRequests.length, elicitation.prompt, isMessageSelectorVisible, onboarding.active, queuedCommands, submit, runQueuedBashCommand]);
  // Start the cron scheduler on session mount so durable scheduled tasks
  // restored from disk actually fire (CronCreate starts it when a task is made
  // in-session, but a fresh session with pre-existing tasks needs this). start()
  // is gated on getScheduledTasksEnabled() (a no-op until a CronCreate enables
  // it) and idempotent; the driver wakes only when a task is genuinely due, so
  // idle costs zero model turns. Stop the process-wide singleton on unmount.
  useEffect(() => {
    const scheduler = getCronScheduler();
    scheduler.start();
    void scheduler.reschedule();
    return () => scheduler.stop();
  }, []);
  const toolUseConfirmQueue = useMemo(() => buildToolUseConfirmQueue(permissionRequests, availableTools), [permissionRequests, availableTools]);

  // Per-turn AbortController. CancelRequestHandler reads
  // `abortSignal !== undefined && !aborted` as "is there a turn to
  // cancel right now," so we must (a) populate it when streaming starts
  // and (b) fire/clear it when ESC fires or the turn naturally ends.
  // We do NOT auto-abort when streaming ends — the user pressing ESC
  // after a turn finished is a no-op, which is correct behavior. The
  // signal is also handed to command contexts so command implementations can
  // cooperatively cancel.
  const [turnAbortController, setTurnAbortController] = useState<AbortController | null>(null);
  useEffect(() => {
    if (transcript.isStreaming) {
      setTurnAbortController(prev_1 => prev_1 === null || prev_1.signal.aborted ? new AbortController() : prev_1);
    } else {
      // Drop the reference once the turn naturally ends; do not abort
      // (the run-turn already finished cleanly).
      setTurnAbortController(null);
    }
  }, [transcript.isStreaming]);
  const handleTurnCancel = useCallback(() => {
    // Fire the local signal first so the CancelRequestHandler observes
    // an aborted signal (gate flips off), then ask the daemon to
    // interrupt the active turn. Errors from the RPC are swallowed
    // inside cancelActiveTurn — pressing ESC must never surface an RPC
    // failure to the user.
    if (turnAbortController !== null && !turnAbortController.signal.aborted) {
      turnAbortController.abort("user_interrupt");
    }
    void props.session.cancelActiveTurn?.("interrupted");
  }, [turnAbortController, props.session]);
  const handleAgentsKilled = useCallback((agents: readonly KilledAgentSummary[]) => {
    const text = formatAgentsKilledNotification(agents);
    if (text === null) return;
    addNotification({
      key: "agents-killed-summary",
      text,
      priority: "immediate",
      timeoutMs: 4000
    });
  }, [addNotification]);
  useMcpConnectivityStatus({
    mcpClients: mcpClients as MCPServerConnection[]
  });
  const title = useMemo(() => terminalTitle(props), [props]);
  const titleIsAnimating = transcript.isStreaming && permissionRequests.length === 0 && elicitation.prompt === null && toolJSX === null && !onboarding.active;
  const isLocalJSXCommandActive = toolJSX?.isLocalJSXCommand === true;
  useEffect(() => {
    if (haveShownCostDialog || showCostDialog) return;
    if (getTotalCost() < 5) return;
    setHaveShownCostDialog(true);
    if (hasConsoleBillingAccess()) {
      setShowCostDialog(true);
    }
  }, [transcript.messages, haveShownCostDialog, showCostDialog]);
  const setCompactStreamMode = useCallback((mode_0: "requesting" | "responding" | null) => {
    if (mode_0 === null) return;
    setCompactProgress(prev_2 => prev_2.status === "idle" ? prev_2 : {
      ...prev_2,
      streamMode: mode_0
    });
  }, []);
  const setCompactResponseLength = useCallback((updater: (length: number) => number) => {
    setCompactProgress(prev_3 => ({
      ...prev_3,
      responseLength: updater(prev_3.responseLength)
    }));
  }, []);
  const handleCompactProgress = useCallback((event: unknown) => {
    if (!isCompactProgressEvent(event)) return;
    if (event.type === "hooks_start") {
      setCompactProgress({
        status: "hooks",
        label: compactHookLabel(event.hookType),
        responseLength: 0
      });
      return;
    }
    if (event.type === "compact_start") {
      setCompactProgress({
        status: "compacting",
        label: "Compacting conversation",
        responseLength: 0
      });
      return;
    }
    setCompactProgress({
      status: "idle",
      label: null,
      responseLength: 0
    });
  }, []);
  const setCompactSDKStatus = useCallback((status: "compacting" | null) => {
    if (status === "compacting") {
      setCompactProgress({
        status: "compacting",
        label: "Compacting conversation",
        responseLength: 0
      });
      return;
    }
    setCompactProgress({
      status: "idle",
      label: null,
      responseLength: 0
    });
  }, []);
  useEffect(() => installCompactProgressControls(props.session, {
    setStreamMode: setCompactStreamMode,
    setResponseLength: setCompactResponseLength,
    onCompactProgress: handleCompactProgress,
    setSDKStatus: setCompactSDKStatus
  }), [props.session, setCompactStreamMode, setCompactResponseLength, handleCompactProgress, setCompactSDKStatus]);
  const handleShowMessageSelector = useCallback(() => {
    if (onboarding.active) return;
    setSelectorNotice(null);
    setIsMessageSelectorVisible(visible => !visible);
  }, [onboarding.active]);
  const handleCloseMessageSelector = useCallback(() => {
    summarizeAbortRef.current?.abort("message-selector-closed");
    summarizeAbortRef.current = null;
    setIsMessageSelectorVisible(false);
  }, []);
  useEffect(() => {
    return () => {
      summarizeAbortRef.current?.abort("app-unmounted");
      summarizeAbortRef.current = null;
    };
  }, []);
  const handleRestoreMessage = useCallback(async (message_1: any) => {
    if (transcript.isStreaming || hasActiveConversationTurn(props.session)) {
      setSelectorNotice(CONVERSATION_ACTION_BUSY_MESSAGE);
      throw new Error(CONVERSATION_ACTION_BUSY_MESSAGE);
    }
    if (props.session.rewindConversationToMessage === undefined) {
      throw new Error("Conversation rewind is not supported by this session.");
    }
    const selectableMessages = (transcript.messages as any[]).filter(selectableUserMessagesFilter as any);
    const messageOrdinal = selectableMessages.indexOf(message_1);
    if (messageOrdinal === -1) {
      throw new Error("The selected message is no longer available.");
    }
    const result_1 = await props.session.rewindConversationToMessage({
      messageOrdinal
    });
    if (!result_1.ok) {
      setSelectorNotice(result_1.message);
      throw new Error(result_1.message);
    }
    if (!result_1.eventAlreadyEmitted && result_1.event !== undefined) {
      props.session.emitPhaseEvent?.(result_1.event as never);
    }
    const restored = restoreComposerText(message_1);
    if (restored !== null) {
      setInput(restored.text);
      setMode(restored.mode);
    }
    setSelectorNotice(result_1.displayText ?? "Conversation rewound");
  }, [props.session, transcript.isStreaming, transcript.messages]);
  const handleRestoreCode = useCallback(async (message_2: any) => {
    await fileHistoryRewind(updater_0 => {
      setAppState(prev_4 => ({
        ...prev_4,
        fileHistory: updater_0(prev_4.fileHistory)
      }));
    }, message_2.uuid);
  }, [setAppState]);
  const handleSummarize = useCallback(async (message_3: any, feedback?: string, direction: "from" | "up_to" = "from") => {
    if (transcript.isStreaming || hasActiveConversationTurn(props.session)) {
      setSelectorNotice(CONVERSATION_ACTION_BUSY_MESSAGE);
      throw new Error(CONVERSATION_ACTION_BUSY_MESSAGE);
    }
    if (props.session.partialCompactFromMessage === undefined) {
      throw new Error("Conversation summarization is not supported by this session.");
    }
    const selectableMessages_0 = (transcript.messages as any[]).filter(selectableUserMessagesFilter as any);
    const messageOrdinal_0 = selectableMessages_0.indexOf(message_3);
    if (messageOrdinal_0 === -1) {
      throw new Error("The selected message is no longer available.");
    }
    summarizeAbortRef.current?.abort("message-selector-replaced");
    const abortController_0 = new AbortController();
    summarizeAbortRef.current = abortController_0;
    let result_2;
    try {
      result_2 = await props.session.partialCompactFromMessage({
        messageOrdinal: messageOrdinal_0,
        direction,
        ...(feedback !== undefined ? {
          feedback
        } : {}),
        signal: abortController_0.signal
      });
    } catch (err_2) {
      if (summarizeAbortRef.current === abortController_0) {
        summarizeAbortRef.current = null;
      }
      throw err_2;
    }
    if (summarizeAbortRef.current === abortController_0) {
      summarizeAbortRef.current = null;
    }
    if (!result_2.ok) {
      setSelectorNotice(result_2.message);
      throw new Error(result_2.message);
    }
    if (!result_2.eventAlreadyEmitted && result_2.event !== undefined) {
      props.session.emitPhaseEvent?.(result_2.event as never);
    }
    if (direction === "from") {
      const restored_0 = restoreComposerText(message_3);
      if (restored_0 !== null) {
        setInput(restored_0.text);
        setMode(restored_0.mode);
      }
    }
    setSelectorNotice(result_2.displayText ?? "Conversation summarized");
  }, [props.session, transcript.isStreaming, transcript.messages]);
  const handleExit = useCallback(() => {
    if (getCurrentWorktreeSession() !== null) {
      setExitFlow(<ExitFlow showWorktree={true} onDone={() => {
        setExitFlow(null);
      }} onCancel={() => {
        setExitFlow(null);
      }} />);
      return;
    }
    exit();
  }, [exit]);
  const handleCostThresholdDone = useCallback(() => {
    setShowCostDialog(false);
    setHaveShownCostDialog(true);
    saveGlobalConfig(current => ({
      ...current,
      hasAcknowledgedCostThreshold: true
    }));
  }, []);

  // Spinner gating + mode derivation.
  //
  // Show the spinner whenever the daemon turn is active or the user just
  // submitted (pendingSubmission bridges the gap to turn_started). The
  // earlier "ghost spinner stays after AI is done" bug was caused by
  // pendingSubmission staying stuck true when the daemon skipped
  // turn_started — that's now fixed by the broader pendingSubmission
  // clearing logic above (which also clears on assistant-message-count
  // growth and streamingText flow).
  //
  // We deliberately key on transcript.isStreaming (not just visible
  // activity), because between tool calls / before the first token the
  // model is still working — the user wants feedback during those
  // gaps, not a blank screen.
  //
  const inProgressToolCount = transcript.inProgressToolUseIDs.size;
  const isStreamingToolInput = transcript.streamingToolUses.length > 0 && inProgressToolCount === 0;
  const hasActiveToolActivity = inProgressToolCount > 0 || isStreamingToolInput;
  const showSpinner =
    (isLoading || hasActiveLocalAgents) &&
    permissionRequests.length === 0 &&
    elicitation.prompt === null &&
    !isMessageSelectorVisible;
  if (isLoading && !wasStreamingRef.current) {
    loadingStartTimeRef.current = Date.now();
    totalPausedMsRef.current = 0;
    pauseStartTimeRef.current = null;
    responseLengthRef.current = 0;
  }
  wasStreamingRef.current = isLoading;
  // Keep responseLengthRef in sync with the streaming buffer so the spinner's
  // token-counter shows current progress.
  responseLengthRef.current = (transcript.streamingText?.length ?? 0) + (transcript.streamingThinking?.thinking?.length ?? 0);
  const streamMode: SpinnerMode =
    inProgressToolCount > 0
      ? "tool-use"
      : isStreamingToolInput
        ? "tool-input"
      : transcript.streamingThinking?.isStreaming
        ? "thinking"
        : transcript.streamingText
          ? "responding"
          : "requesting";
  const cancelStreamMode = visibleCancelStreamMode(showSpinner, streamMode);
  const spinnerElement = showSpinner ? <SpinnerWithVerb mode={streamMode} loadingStartTimeRef={loadingStartTimeRef} totalPausedMsRef={totalPausedMsRef} pauseStartTimeRef={pauseStartTimeRef} responseLengthRef={responseLengthRef} verbose={false} hasActiveTools={hasActiveToolActivity} leaderIsIdle={!transcript.isStreaming} overrideMessage={inProgressToolCount > 0 ? "Running tools" : null} /> : null;

  // Onboarding renders standalone — composer-only flow drives its own input.
  if (onboarding.active) {
    return <Box flexDirection="column" width="100%">
        <AnimatedTerminalTitle isAnimating={titleIsAnimating} title={title} />
        <Onboarding state={onboarding.state} steps={onboarding.steps} currentStep={onboarding.currentStep} context={onboardingContext} />
      {toolJSX !== null ? <Box flexDirection="column" width="100%">
          {toolJSX.jsx}
        </Box> : null}
      <PromptInput debug={false} ideSelection={undefined} toolPermissionContext={toolPermissionContext as any} setToolPermissionContext={setToolPermissionContext as any} apiKeyStatus={apiKeyStatus} agencHome={agencHome} commands={EMPTY_ONBOARDING_COMMANDS} agents={agents as any} isLoading={false} verbose={false} messages={transcript.messages as any[]} onAutoUpdaterResult={() => {}} autoUpdaterResult={null} input={input} onInputChange={setInput} mode={mode} onModeChange={setMode} stashedPrompt={stashedPrompt} setStashedPrompt={setStashedPrompt} submitCount={submitCount} onShowMessageSelector={handleShowMessageSelector} onMessageActionsEnter={handleShowMessageSelector} mcpClients={mcpClients as never} pastedContents={pastedContents} setPastedContents={setPastedContents} vimMode={vimMode} setVimMode={setVimMode} showBashesDialog={showBashesDialog} setShowBashesDialog={setShowBashesDialog} onExit={handleExit} getToolUseContext={getToolUseContext} onSubmit={async (value_0, helpers) => {
        if (isExitSlashCommand(value_0)) {
          setInput("");
          helpers.clearBuffer();
          helpers.resetHistory();
          helpers.setCursorOffset(0);
          handleExit();
          return;
        }
        if (
          value_0.trim().startsWith("/") &&
          !isOnboardingSlashAlias(value_0)
        ) {
          await submitViaElicitationPrompt(elicitation, submit, value_0, helpers);
          return;
        }
        if (await onboarding.submit(value_0)) {
          setInput("");
          helpers.clearBuffer();
          helpers.resetHistory();
          helpers.setCursorOffset(0);
          return;
        }
        await submitViaElicitationPrompt(elicitation, submit, value_0, helpers);
      }} isSearchingHistory={isSearchingHistory} setIsSearchingHistory={setIsSearchingHistory} helpOpen={helpOpen} setHelpOpen={setHelpOpen} />
      </Box>;
  }
  const messagesElement = isLocalJSXCommandActive ? null : <Messages messages={transcript.messages as any[]} tools={tools as any} commands={commands as unknown as Command[]} verbose={screen === "transcript"} toolJSX={toolJSX as any} toolUseConfirmQueue={toolUseConfirmQueue as never[]} inProgressToolUseIDs={new Set(transcript.inProgressToolUseIDs)} isMessageSelectorVisible={isMessageSelectorVisible} conversationId={props.session.conversationId} screen={screen as any} streamingToolUses={transcript.streamingToolUses} showAllInTranscript={showAllInTranscript} isLoading={isLoading} streamingText={transcript.streamingText} streamingThinking={transcript.streamingThinking as never} hidePastThinking={screen === "transcript"} scrollRef={fullscreen ? scrollRef : undefined} trackStickyPrompt={fullscreen ? true : undefined} />;
  const toolOwnsPrompt = toolJSX?.isLocalJSXCommand === true && toolJSX.shouldHidePromptInput === true;
  const inlineToolJSX = toolJSX !== null && !toolOwnsPrompt ? toolJSX.jsx : null;
  const modalToolJSX = toolOwnsPrompt ? toolJSX.jsx : null;
  const scrollableContent = <>
      {messagesElement}
      <RealtimePanel state={realtimeState} />
      {completionPipelineRows.map(row => <Text key={row} color={completionPipelineActive ? "warning" : undefined} wrap="truncate">{row}</Text>)}
      {compactProgress.status !== "idle" ? <Box flexDirection="row" width="100%">
          <Text dimColor>
            {compactProgress.label ?? "Compacting conversation"}
          </Text>
          {compactProgress.responseLength > 0 ? <Text dimColor>{` · ${compactProgress.responseLength} chars`}</Text> : null}
        </Box> : null}
      {renderHealthWarning !== null ? <Text color="warning" wrap="truncate">{renderHealthWarning}</Text> : null}
      {inlineToolJSX !== null ? <Box flexDirection="column" width="100%">
          {inlineToolJSX}
        </Box> : null}
      {/* flexGrow spacer pushes streaming content to the top of the scroll
          viewport in fullscreen mode. */}
      {fullscreen ? <Box flexGrow={1} /> : null}
      {fullscreen ? <PromptInputQueuedCommands /> : null}
    </>;

  // A permission request owns the overlay while it is pending. Elicitation stays
  // queued behind it so Enter/Escape never have two modal owners.
  const overlayContent = permissionRequests.length > 0 ? <>
      {workbenchEnabled ? <ApprovalSurfaceBridge request={permissionRequests[0]} /> : null}
      <PermissionOverlay request={permissionRequests[0]} tools={availableTools as any} mcpClients={mcpClients as any} />
    </> : elicitation.prompt !== null ? <ElicitationOverlay prompt={elicitation.prompt} /> : null;

  // Phase 5 #53: hide PromptInput while a permission overlay or
  // elicitation prompt is active so a single Enter doesn't fire both.
  const showPromptInput = shouldShowPromptInputState({
    isMessageSelectorVisible,
    permissionRequestCount: permissionRequests.length,
    hasElicitationPrompt: elicitation.prompt !== null,
    completionPipelineOwnsPrompt: completionPipelineActive,
    toolShouldHidePromptInput: toolJSX?.shouldHidePromptInput === true
  });
  const promptInputElement = showPromptInput ? <PromptInput debug={false} ideSelection={undefined} toolPermissionContext={toolPermissionContext as any} setToolPermissionContext={setToolPermissionContext as any} apiKeyStatus={apiKeyStatus} agencHome={agencHome} commands={commands as unknown as Command[]} agents={agents as any} isLoading={effectiveInputBusy} verbose={false} messages={transcript.messages as any[]} onAutoUpdaterResult={() => {}} autoUpdaterResult={null} input={input} onInputChange={setInput} mode={mode} onModeChange={setMode} stashedPrompt={stashedPrompt} setStashedPrompt={setStashedPrompt} submitCount={submitCount} onShowMessageSelector={handleShowMessageSelector} onMessageActionsEnter={handleShowMessageSelector} mcpClients={mcpClients as never} pastedContents={pastedContents} setPastedContents={setPastedContents} vimMode={vimMode} setVimMode={setVimMode} showBashesDialog={showBashesDialog} setShowBashesDialog={setShowBashesDialog} onExit={handleExit} getToolUseContext={getToolUseContext} isLocalJSXCommandActive={isLocalJSXCommandActive} onSubmit={async (value_1, helpers_0) => {
    if (isLocalJSXCommandActive) {
      return;
    }
    if (await executeRealtimeComposerCommand(props.session.realtime, value_1)) {
      helpers_0.clearBuffer();
      helpers_0.resetHistory();
      helpers_0.setCursorOffset(0);
      return;
    }
    await submitViaElicitationPrompt(elicitation, submit, value_1, helpers_0);
  }} isSearchingHistory={isSearchingHistory} setIsSearchingHistory={setIsSearchingHistory} helpOpen={helpOpen} setHelpOpen={setHelpOpen} /> : null;
  const bottomContent = <Box flexDirection="column" flexGrow={1}>
      {backpressureWarning !== null ? <Text color="warning" wrap="truncate">{backpressureWarning}</Text> : null}
      {spinnerElement}
      {selectorNotice !== null ? <Text color="warning" wrap="truncate">{selectorNotice}</Text> : null}
      {promptInputElement}
    </Box>;

  // Body MUST be a fragment (not a flex Box) so FullscreenLayout's t14
  // (flexGrow={1} scroll area) and t17 (flexShrink={0} bottom slot) become
  // direct children of AlternateScreen's <Box height={rows} flex column>.
  // Wrapping in another <Box flexDirection="column"> with no height/flexGrow
  // breaks the flex chain — the inner Box collapses to its intrinsic content
  // size and the bottom slot has 0 height. KeybindingSetup must remain a
  // context provider, not a Box.
  const body = <>
      <AnimatedTerminalTitle isAnimating={titleIsAnimating} title={title} />
      <GlobalKeybindingHandlers screen={screen as any} setScreen={setScreen as any} showAllInTranscript={showAllInTranscript} setShowAllInTranscript={setShowAllInTranscript} messageCount={transcript.messages.length} />
      <ScrollKeybindingHandler scrollRef={modalToolJSX !== null ? modalScrollRef : scrollRef} isActive={shouldEnableTranscriptScrollKeybindings({
        fullscreen,
        workbenchEnabled,
        permissionRequestCount: permissionRequests.length,
        modalVisible: modalToolJSX !== null,
        activeSurfaceMode: workbenchState.activeSurfaceMode
      })} isModal={modalToolJSX !== null} />
      <CancelRequestHandler
    // Daemon-mode no-op: permission requests are owned by the daemon
    // and resolved via session.cancelTurn cascade.
    setToolUseConfirmQueue={() => {}} onCancel={handleTurnCancel} onAgentsKilled={handleAgentsKilled} isMessageSelectorVisible={isMessageSelectorVisible} screen={screen as never} {...turnAbortController !== null ? {
      abortSignal: turnAbortController.signal
    } : {}} isSearchingHistory={isSearchingHistory} isHelpOpen={helpOpen} inputMode={mode as never} inputValue={input} streamMode={cancelStreamMode as never} />
      {workbenchEnabled ? <WorkbenchLayout transcript={scrollableContent} composer={bottomContent} overlay={overlayContent ?? undefined} modal={modalToolJSX !== null ? <Box flexDirection="column" width="100%">{modalToolJSX}</Box> : undefined} modalScrollRef={modalScrollRef} pendingApproval={permissionRequests[0] ?? null} scrollRef={scrollRef} atWelcome={transcript.messages.length === 0 && !transcript.streamingText} activityMode={showSpinner ? streamMode : null} /> : <FullscreenLayout scrollRef={scrollRef} scrollable={scrollableContent} bottom={bottomContent} overlay={overlayContent ?? undefined} modal={modalToolJSX !== null ? <Box flexDirection="column" width="100%">{modalToolJSX}</Box> : undefined} modalScrollRef={modalScrollRef} />}
      {showCostDialog ? <CostThresholdDialog onDone={handleCostThresholdDone} /> : null}
      {exitFlow}
      {isMessageSelectorVisible ? <MessageSelector messages={transcript.messages as any[]} onPreRestore={() => {}} onRestoreMessage={handleRestoreMessage} onRestoreCode={handleRestoreCode} onSummarize={handleSummarize} onClose={handleCloseMessageSelector} /> : null}
    </>;
  if (fullscreen) {
    return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
        {body}
      </AlternateScreen>;
  }
  // Non-fullscreen: wrap in a flex column so children stack normally.
  return <Box flexDirection="column" width="100%">{body}</Box>;
}
export function AgenCTuiApp(props: AgenCTuiProps): React.ReactElement {
  const initial = useMemo(() => initialState(props), []);
  return <App initialState={initial} getFpsMetrics={props.getFpsMetrics ?? DEFAULT_FPS_METRICS_GETTER}>
      <PromptOverlayProvider>
        <KeybindingSetup>
          <AgenCTuiShell {...props} />
        </KeybindingSetup>
      </PromptOverlayProvider>
    </App>;
}
