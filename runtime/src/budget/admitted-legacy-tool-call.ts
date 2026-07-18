/** Admission bridge for legacy `Tool.call()` execution surfaces. */

import { randomUUID } from "node:crypto";

import { peekAmbientRuntimeSession } from "../session/current-session.js";
import type { ToolUseContext } from "../tools/Tool.js";
import { readToolRuntimeContext } from "../tools/runtimes/context.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { AdmissionDeniedError } from "./admission-client.js";
import {
  runAdmittedToolCall,
  type AdmittedToolDispatchContext,
} from "./admitted-tool-call.js";

export interface AdmittedLegacyToolCallOptions<T> {
  readonly tool: Tool;
  readonly input: Record<string, unknown>;
  /** Runtime-normalized args used for estimate/reservation accounting. */
  readonly admissionArgs?: Readonly<Record<string, unknown>>;
  readonly context: ToolUseContext;
  readonly invoke: (context: AdmittedToolDispatchContext) => Promise<T>;
  readonly toDispatchResult: (result: T) => ToolResult;
}

export interface AdmittedSessionBoundToolCallOptions<T> {
  readonly tool: Tool;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly invoke: (context: AdmittedToolDispatchContext) => Promise<T>;
  readonly toDispatchResult: (result: T) => ToolResult;
}

/**
 * Admit a non-router tool-shaped boundary against the one unambiguous ambient
 * session. TUI helpers and prompt preprocessing use this for remote effects
 * that are not normal model-visible tool dispatches; normal router calls must
 * keep using their existing admission boundary so they are never admitted
 * twice.
 */
export async function runAdmittedSessionBoundToolCall<T>(
  params: AdmittedSessionBoundToolCallOptions<T>,
): Promise<T> {
  const session = peekAmbientRuntimeSession();
  if (session === null) {
    throw new AdmissionDeniedError("tool_admission_session_unavailable");
  }

  const activeTurn = session.activeTurn?.unsafePeek?.();
  const turnId =
    activeTurn && typeof activeTurn.turnId === "string"
      ? activeTurn.turnId
      : `legacy-direct:${session.conversationId}`;
  const callId = randomUUID();
  let result: T | undefined;
  await runAdmittedToolCall({
    session,
    turnId,
    callId,
    tool: params.tool,
    args: params.args,
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
    invoke: async (context) => {
      result = await params.invoke(context);
      return params.toDispatchResult(result);
    },
  });

  // The admitted invoke either assigned result or threw. This guard is kept
  // fail-closed in case that contract is changed later.
  if (result === undefined) {
    throw new AdmissionDeniedError("tool_admission_result_missing");
  }
  return result;
}

/**
 * Route a direct legacy tool call through the daemon-owned execution kernel.
 *
 * Calls reached through the modern router already carry an authenticated
 * `ToolRuntimeAttemptContext`; the router admitted those immediately before
 * `tool.execute`, so admitting again here would double-reserve the same
 * effect. Direct TUI, prompt, and attachment calls do not carry that marker
 * and must resolve one unambiguous ambient Session or fail closed.
 */
export async function runAdmittedLegacyToolCall<T>(
  params: AdmittedLegacyToolCallOptions<T>,
): Promise<T> {
  if (readToolRuntimeContext(params.input) !== undefined) {
    return params.invoke({
      signal: params.context.abortController.signal,
      abortController: params.context.abortController,
    });
  }

  return runAdmittedSessionBoundToolCall({
    tool: params.tool,
    args: params.admissionArgs ?? params.input,
    signal: params.context.abortController.signal,
    invoke: params.invoke,
    toDispatchResult: params.toDispatchResult,
  });
}
