/**
 * Ports the donor runtime's `request_user_input` tool schema,
 * mode-gating, and argument normalization onto AgenC model-facing tools.
 *
 * Why this lives here / shape difference from upstream:
 *   - The donor tool handler calls directly into a session method. AgenC
 *     keeps the same call boundary, but exposes it through the generic
 *     `Tool` interface used by `runtime/src/bin/model-facing-tools.ts`.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Provider-specific tool declaration objects. The registry converts
 *     AgenC `Tool` objects into provider declarations later.
 *
 * @module
 */

import type { Tool, ToolResult } from "../tools/types.js";
import { safeStringify, type ToolExecutionInjectedArgs } from "../tools/types.js";
import type {
  ManagedFeatures,
  SessionConfiguration,
} from "../session/turn-context.js";
import type { PermissionMode } from "../permissions/types.js";
import type { PermissionModeRegistry } from "../permissions/permission-mode.js";
import {
  REQUEST_USER_INPUT_TOOL_NAME,
  type RequestUserInputArgs,
  type RequestUserInputQuestion,
  type RequestUserInputQuestionOption,
  type RequestUserInputResponse,
} from "./types.js";

export interface RequestUserInputToolSession {
  readonly features: ManagedFeatures;
  readonly permissionModeRegistry: PermissionModeRegistry;
  readonly sessionConfiguration: SessionConfiguration;
  requestUserInput(
    callId: string,
    args: RequestUserInputArgs,
    signal?: AbortSignal,
  ): Promise<RequestUserInputResponse | null>;
}

export interface CreateRequestUserInputToolOptions {
  readonly getSession: () => RequestUserInputToolSession | null;
}

const MODE_DISPLAY_NAMES: Readonly<Record<PermissionMode, string>> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  bypassPermissions: "Bypass Permissions",
  dontAsk: "Don't Ask",
  auto: "Auto",
  unattended: "Unattended",
  bubble: "Bubble",
};
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 3;

function json(content: unknown, isError?: boolean): ToolResult {
  return {
    content: safeStringify(content),
    ...(isError ? { isError: true } : {}),
  };
}

function err(message: string): ToolResult {
  return json({ error: message }, true);
}

function displayMode(mode: PermissionMode): string {
  return MODE_DISPLAY_NAMES[mode] ?? mode;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`request_user_input requires ${field} to be a string`);
  }
  return value;
}

function readSecretFlag(value: unknown): false {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(
      "request_user_input requires question.isSecret to be a boolean when provided",
    );
  }
  if (value === true) {
    throw new Error("request_user_input does not support secret questions");
  }
  return false;
}

function readOption(value: unknown): RequestUserInputQuestionOption {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "request_user_input question options require label and description",
    );
  }
  const record = value as Record<string, unknown>;
  return {
    label: stringField(record.label, "option.label"),
    description: stringField(record.description, "option.description"),
  };
}

function readQuestion(value: unknown): RequestUserInputQuestion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request_user_input questions must be objects");
  }
  const record = value as Record<string, unknown>;
  const rawOptions = record.options;
  let options: readonly RequestUserInputQuestionOption[] | undefined;
  if (rawOptions !== undefined) {
    if (!Array.isArray(rawOptions)) {
      throw new Error("request_user_input question options must be an array");
    }
    if (
      rawOptions.length !== 0 &&
      (rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS)
    ) {
      throw new Error(
        "request_user_input requires either fill-text questions or 2-3 options",
      );
    }
    options = rawOptions.map(readOption);
  }
  return {
    id: stringField(record.id, "question.id"),
    header: stringField(record.header, "question.header"),
    question: stringField(record.question, "question.question"),
    isOther: true,
    isSecret: readSecretFlag(record.isSecret),
    ...(options !== undefined ? { options } : {}),
  };
}

export function normalizeRequestUserInputArgs(
  raw: unknown,
): RequestUserInputArgs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("request_user_input requires an object argument");
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.questions)) {
    throw new Error("request_user_input requires a questions array");
  }
  if (
    record.questions.length < MIN_QUESTIONS ||
    record.questions.length > MAX_QUESTIONS
  ) {
    throw new Error("request_user_input requires 1-3 questions");
  }
  return {
    questions: record.questions.map(readQuestion),
  };
}

export function requestUserInputAvailableModes(
  features: ManagedFeatures | undefined,
): readonly PermissionMode[] {
  const modes: PermissionMode[] = ["plan"];
  if (features?.enabled?.("default_mode_request_user_input") === true) {
    modes.unshift("default");
  }
  return modes;
}

function requestUserInputUnavailableMessage(
  mode: PermissionMode,
  availableModes: readonly PermissionMode[],
): string | null {
  if (availableModes.includes(mode)) return null;
  return `request_user_input is unavailable in ${displayMode(mode)} mode`;
}

export function requestUserInputToolDescription(
  availableModes: readonly PermissionMode[],
): string {
  return `Request user input for one to three short questions and wait for the response. This tool is only available in ${formatAllowedModes(availableModes)}. Prefer AskUserQuestion for interactive questions — this tool exists for daemon clients that drive the elicitation protocol directly.`;
}

function formatAllowedModes(availableModes: readonly PermissionMode[]): string {
  const names = availableModes.map(displayMode);
  if (names.length === 0) return "no modes";
  if (names.length === 1) return `${names[0]} mode`;
  if (names.length === 2) return `${names[0]} or ${names[1]} mode`;
  return `modes: ${names.join(",")}`;
}

function isSubagentSession(source: SessionConfiguration["sessionSource"]): boolean {
  return source === "cli_subagent" ||
    (typeof source === "object" && source.kind === "subagent");
}

function callIdFromArgs(args: Record<string, unknown>): string {
  return typeof args.__callId === "string" && args.__callId.length > 0
    ? args.__callId
    : `request_user_input-${Date.now().toString(36)}`;
}

function abortSignalFromArgs(args: Record<string, unknown>): AbortSignal | undefined {
  const injected = args as Record<string, unknown> & ToolExecutionInjectedArgs;
  return injected.__abortSignal instanceof AbortSignal
    ? injected.__abortSignal
    : undefined;
}

const REQUEST_USER_INPUT_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "Questions to show the user. Prefer 1 and do not exceed 3",
      minItems: MIN_QUESTIONS,
      maxItems: MAX_QUESTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            description: "Stable identifier for mapping answers (snake_case).",
          },
          header: {
            type: "string",
            description: "Short header label shown in the UI (12 or fewer chars).",
          },
          question: {
            type: "string",
            description: "Single-sentence prompt shown to the user.",
          },
          options: {
            type: "array",
            description:
              "Omit or leave empty for fill-text. Otherwise provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with \"(Recommended)\". Do not include an \"Other\" option in this list; the client will add a free-form \"Other\" option automatically.",
            minItems: 0,
            maxItems: MAX_OPTIONS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: {
                  type: "string",
                  description: "User-facing label (1-5 words).",
                },
                description: {
                  type: "string",
                  description:
                    "One short sentence explaining impact/tradeoff if selected.",
                },
              },
              required: ["label", "description"],
            },
          },
        },
        required: ["id", "header", "question"],
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const);

export function createRequestUserInputTool(
  opts: CreateRequestUserInputToolOptions,
): Tool {
  const session = opts.getSession();
  const availableModes = requestUserInputAvailableModes(session?.features);
  return {
    name: REQUEST_USER_INPUT_TOOL_NAME,
    description: requestUserInputToolDescription(availableModes),
    inputSchema: REQUEST_USER_INPUT_INPUT_SCHEMA,
    metadata: {
      family: "interaction",
      source: "builtin",
      // AskUserQuestion is the canonical visible elicitation tool —
      // two overlapping visible question tools degrade model tool
      // selection. request_user_input stays registered (deferred +
      // hidden) for daemon clients that drive the elicitation.respond
      // protocol explicitly and for tool-search discovery.
      hiddenByDefault: true,
      mutating: true,
      deferred: true,
      keywords: ["interaction", "user-input", "elicitation"],
      preferredProfiles: ["coding", "operator", "general"],
    },
    supportsParallelToolCalls: false,
    requiresUserInteraction: () => true,
    recoveryCategory: "interactive",
    isConcurrencySafe: () => false,
    interruptBehavior: () => "cancel",
    timeoutBehavior: "tool",
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const liveSession = opts.getSession();
      if (liveSession === null) {
        return err("request_user_input requires an active session");
      }
      if (isSubagentSession(liveSession.sessionConfiguration.sessionSource)) {
        return err("request_user_input can only be used by the root thread");
      }
      const modes = requestUserInputAvailableModes(liveSession.features);
      const mode = liveSession.permissionModeRegistry.current().mode;
      const unavailable = requestUserInputUnavailableMessage(mode, modes);
      if (unavailable !== null) {
        return err(unavailable);
      }

      let normalized: RequestUserInputArgs;
      try {
        normalized = normalizeRequestUserInputArgs(args);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }

      const response = await liveSession.requestUserInput(
        callIdFromArgs(args),
        normalized,
        abortSignalFromArgs(args),
      );
      if (response === null) {
        return err("request_user_input was cancelled before receiving a response");
      }
      return {
        content: safeStringify(response),
        codeModeResult: response,
      };
    },
  };
}
