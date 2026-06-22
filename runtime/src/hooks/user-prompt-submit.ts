/**
 * UserPromptSubmit hook execution.
 *
 * Ports the prompt-submit hook shape onto AgenC's configured hooks service:
 * the hook receives the original prompt plus the current permission mode,
 * can block prompt processing with a model-facing warning, or can add context
 * that is appended to the next turn.
 */

import type { PermissionMode } from "../permissions/types.js";
import { isRecord } from "../utils/record.js";
import { nonEmptyString as stringValue } from "../utils/stringUtils.js";

export interface UserPromptSubmitBlockingError {
  readonly blockingError: string;
}

export interface UserPromptSubmitHookMessage {
  readonly type?: string;
  readonly attachment: {
    readonly type: string;
    readonly content?: string;
  };
}

export interface UserPromptSubmitHookResult {
  readonly blockingError?: UserPromptSubmitBlockingError;
  readonly preventContinuation?: boolean;
  readonly stopReason?: string;
  readonly additionalContexts?: readonly string[];
  readonly message?: UserPromptSubmitHookMessage;
}

export interface UserPromptSubmitHookInput {
  readonly prompt: string;
  readonly permissionMode?: PermissionMode | string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly transcriptPath?: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export type UserPromptSubmitHook = (
  input: UserPromptSubmitHookInput,
) =>
  | UserPromptSubmitHookResult
  | undefined
  | Promise<UserPromptSubmitHookResult | undefined>
  | Iterable<UserPromptSubmitHookResult | undefined>
  | AsyncIterable<UserPromptSubmitHookResult | undefined>;

export function getUserPromptSubmitHookBlockingMessage(
  blockingError: UserPromptSubmitBlockingError,
): string {
  return `UserPromptSubmit operation blocked by hook:\n${blockingError.blockingError}`;
}

async function* runUserPromptSubmitHooks(
  hooks: readonly UserPromptSubmitHook[],
  input: UserPromptSubmitHookInput,
  onError?: (err: unknown, idx: number) => void,
): AsyncGenerator<UserPromptSubmitHookResult> {
  for (let i = 0; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!hook) continue;
    try {
      const result = hook(input);
      for await (const item of toAsyncIterable(result)) {
        if (!item) continue;
        yield item;
        if (item.blockingError || item.preventContinuation) return;
      }
    } catch (err) {
      onError?.(err, i);
    }
  }
}

export async function* executeUserPromptSubmitHooks(
  prompt: string,
  permissionMode: PermissionMode | string,
  toolUseContext: unknown,
  _requestPrompt?: unknown,
  onError?: (err: unknown, idx: number) => void,
): AsyncGenerator<UserPromptSubmitHookResult> {
  const hooks = readUserPromptSubmitHooks(toolUseContext);
  if (hooks.length === 0) return;
  yield* runUserPromptSubmitHooks(hooks, {
    prompt,
    permissionMode,
    cwd: readCwd(toolUseContext),
    ...readSessionContext(toolUseContext),
    ...readAbortSignal(toolUseContext),
  }, onError);
}

function readUserPromptSubmitHooks(
  toolUseContext: unknown,
): readonly UserPromptSubmitHook[] {
  const direct = readHooksArray(toolUseContext);
  if (direct.length > 0) return direct;

  const contextRecord = isRecord(toolUseContext) ? toolUseContext : undefined;
  const sessionHooks = readHooksArray(
    readNested(contextRecord, ["session", "services", "hooks"]),
  );
  if (sessionHooks.length > 0) return sessionHooks;

  const servicesHooks = readHooksArray(readNested(contextRecord, ["services", "hooks"]));
  if (servicesHooks.length > 0) return servicesHooks;

  const getAppState = contextRecord?.["getAppState"];
  if (typeof getAppState !== "function") return [];
  const appState = getAppState.call(toolUseContext);
  return readHooksArray(readNested(isRecord(appState) ? appState : undefined, [
    "session",
    "services",
    "hooks",
  ]));
}

function readHooksArray(value: unknown): readonly UserPromptSubmitHook[] {
  if (!isRecord(value)) return [];
  const hooks = value["userPromptSubmitHooks"];
  if (!Array.isArray(hooks)) return [];
  return hooks.filter((hook): hook is UserPromptSubmitHook =>
    typeof hook === "function",
  );
}

function readCwd(toolUseContext: unknown): string {
  if (isRecord(toolUseContext)) {
    const cwd = toolUseContext["cwd"];
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
    const turnCwd = readNested(toolUseContext, ["turn", "cwd"]);
    if (typeof turnCwd === "string" && turnCwd.length > 0) return turnCwd;
  }
  return process.cwd();
}

function readSessionContext(
  toolUseContext: unknown,
): {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly transcriptPath?: string;
  readonly model?: string;
} {
  if (!isRecord(toolUseContext)) return {};
  const session = readNested(toolUseContext, ["session"]);
  const turn = readNested(toolUseContext, ["turn"]);
  const appState = readAppState(toolUseContext);

  const sessionId =
    stringValue(toolUseContext["sessionId"]) ??
    stringValue(readNested(toolUseContext, ["conversationId"])) ??
    stringValue(readNested(isRecord(session) ? session : undefined, [
      "conversationId",
    ]));
  const turnId =
    stringValue(toolUseContext["turnId"]) ??
    stringValue(readNested(isRecord(turn) ? turn : undefined, ["subId"])) ??
    stringValue(readNested(isRecord(appState) ? appState : undefined, [
      "turn",
      "subId",
    ]));
  const transcriptPath =
    stringValue(toolUseContext["transcriptPath"]) ??
    stringValue(readNested(isRecord(session) ? session : undefined, [
      "transcriptPath",
    ])) ??
    stringValue(readNested(isRecord(session) ? session : undefined, [
      "rolloutStore",
      "rolloutPath",
    ]));
  const model =
    stringValue(toolUseContext["model"]) ??
    stringValue(readNested(isRecord(turn) ? turn : undefined, [
      "modelInfo",
      "slug",
    ])) ??
    stringValue(readNested(isRecord(session) ? session : undefined, [
      "modelInfo",
      "slug",
    ])) ??
    stringValue(readNested(isRecord(session) ? session : undefined, [
      "sessionConfiguration",
      "collaborationMode",
      "model",
    ]));

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function readAppState(toolUseContext: Record<string, unknown>): unknown {
  const getAppState = toolUseContext["getAppState"];
  return typeof getAppState === "function"
    ? getAppState.call(toolUseContext)
    : undefined;
}

function readAbortSignal(
  toolUseContext: unknown,
): { readonly signal?: AbortSignal } {
  if (!isRecord(toolUseContext)) return {};
  const signal = readNested(toolUseContext, ["abortController", "signal"]);
  return signal instanceof AbortSignal ? { signal } : {};
}

function readNested(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

async function* toAsyncIterable(
  value:
    | UserPromptSubmitHookResult
    | undefined
    | Promise<UserPromptSubmitHookResult | undefined>
    | Iterable<UserPromptSubmitHookResult | undefined>
    | AsyncIterable<UserPromptSubmitHookResult | undefined>,
): AsyncGenerator<UserPromptSubmitHookResult | undefined> {
  const awaited = await value;
  if (!awaited) return;
  if (isAsyncIterable(awaited)) {
    for await (const item of awaited) yield item;
    return;
  }
  if (isIterable(awaited)) {
    for (const item of awaited) yield item;
    return;
  }
  yield awaited;
}

function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<UserPromptSubmitHookResult | undefined> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as unknown as AsyncIterable<
    UserPromptSubmitHookResult | undefined
  >;
  return typeof candidate[Symbol.asyncIterator] === "function";
}

function isIterable(
  value: unknown,
): value is Iterable<UserPromptSubmitHookResult | undefined> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as unknown as Iterable<
    UserPromptSubmitHookResult | undefined
  >;
  return typeof candidate[Symbol.iterator] === "function";
}
