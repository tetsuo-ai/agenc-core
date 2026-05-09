import { useEffect, useMemo, useState } from "react";

import { PermissionRequest } from "./components/permissions/PermissionRequest.js";
import type { ApprovalCtx } from "../tools/orchestrator.js";
import type { ReviewDecision } from "../permissions/review-decision.js";
import {
  ABORT,
  APPROVED,
  APPROVED_FOR_SESSION,
  DENIED,
} from "../permissions/review-decision.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  recordAskUserQuestionPlanInterviewAction,
  recordAskUserQuestionUpdatedInput,
  type AskUserQuestionPlanInterviewAction,
} from "../tools/ask-user-question/tool.js";
import { makeToolUseMessage } from "./session-transcript.js";
import type { AgenCBridgeSession } from "./session-types.js";
import { createSessionAppStateBridge } from "./session-app-state.js";
import type { AppState } from "./state/AppState.js";

export { createSessionAppStateBridge };

export interface PendingRequest {
  readonly id: string;
  readonly ctx: ApprovalCtx;
  readonly input: Record<string, unknown>;
  readonly description: string;
  resolve(decision: ReviewDecision): void;
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { input: raw };
  }
}

function deriveInput(ctx: ApprovalCtx): Record<string, unknown> {
  const payload = ctx.invocation.payload;
  if (!payload || typeof payload !== "object" || !("kind" in payload)) {
    return {};
  }
  const record = payload as {
    readonly kind?: unknown;
    readonly arguments?: unknown;
    readonly rawArguments?: unknown;
    readonly input?: unknown;
    readonly params?: unknown;
  };
  switch (record.kind) {
    case "function":
      return parseJsonObject(
        typeof record.arguments === "string" ? record.arguments : undefined,
      );
    case "mcp":
      return parseJsonObject(
        typeof record.rawArguments === "string" ? record.rawArguments : undefined,
      );
    case "custom":
      return { input: typeof record.input === "string" ? record.input : "" };
    case "local_shell":
      return record.params &&
        typeof record.params === "object" &&
        !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : {};
    default:
      return {};
  }
}

function planInterviewActionFromFeedback(
  feedback: unknown,
): AskUserQuestionPlanInterviewAction | null {
  if (typeof feedback !== "string") return null;
  const normalized = feedback.toLowerCase();
  if (normalized.includes("wants to clarify these questions")) {
    return "chat_about_this";
  }
  if (normalized.includes("provided enough answers for the plan interview")) {
    return "skip_plan_interview";
  }
  return null;
}

export function buildToolUseConfirm(
  request: PendingRequest,
  tools: readonly { readonly name: string }[],
): unknown | null {
  // Phase 5 #52 (security): the prior code was
  //   tools.find(c => c.name === toolName) ?? tools[0]
  // The fallback meant that if the registry didn't expose the
  // requested tool by name (registry race, MCP discovery delay,
  // misconfigured visibility), the overlay rendered the FIRST tool
  // in the list as if it were the requested one — and the user's
  // approve/deny click resolved with that wrong tool's identity.
  // The user could think they were approving `Read` and actually
  // be approving `exec_command`. Fail closed: when the registry
  // can't resolve the tool, auto-deny via DENIED + log the
  // mismatch on the daemon side, then return null so no overlay
  // ever renders.
  const tool = tools.find((candidate) => candidate.name === request.ctx.toolName);
  if (!tool) {
    // Surface the auto-deny via the existing resolve path so the
    // request flows back through the same channel as a manual deny.
    // Daemon logs / observability sinks see the explicit deny with
    // the requested tool name; the user's transcript stays clean
    // (a denied permission isn't usually surfaced unless the user
    // chose it).
    request.resolve(DENIED);
    return null;
  }
  const assistantMessage = makeToolUseMessage(
    request.ctx.callId,
    request.ctx.toolName,
    request.input,
  );
  return {
    assistantMessage,
    tool,
    description: request.description,
    input: request.input,
    toolUseContext: {},
    toolUseID: request.ctx.callId,
    permissionResult: {
      behavior: "ask",
      message: request.description,
    },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction() {},
    onAbort() {
      request.resolve(ABORT);
    },
    onAllow(
      updatedInput: unknown,
      permissionUpdates: readonly unknown[] = [],
    ) {
      if (request.ctx.toolName === ASK_USER_QUESTION_TOOL_NAME) {
        recordAskUserQuestionUpdatedInput(request.ctx.callId, updatedInput);
      }
      request.resolve(
        permissionUpdates.length > 0 ? APPROVED_FOR_SESSION : APPROVED,
      );
    },
    onReject(feedback?: string) {
      if (request.ctx.toolName === ASK_USER_QUESTION_TOOL_NAME) {
        const action = planInterviewActionFromFeedback(feedback);
        if (
          action !== null &&
          recordAskUserQuestionPlanInterviewAction(
            request.ctx.callId,
            request.input,
            action,
          )
        ) {
          request.resolve(APPROVED);
          return;
        }
      }
      request.resolve(DENIED);
    },
    async recheckPermission() {},
  };
}

export function buildToolUseConfirmQueue(
  requests: readonly PendingRequest[],
  tools: readonly { readonly name: string }[],
): readonly unknown[] {
  const queue: unknown[] = [];
  for (const request of requests) {
    const projected = buildToolUseConfirm(request, tools);
    if (projected !== null) queue.push(projected);
  }
  return queue;
}

export function usePermissionRequests(
  session: AgenCBridgeSession,
  setModel: (next: string) => void,
  setExpandedView: (next: "none" | "tasks") => void,
  setAppState: (updater: (prev: AppState) => AppState) => void,
) {
  const [requests, setRequests] = useState<readonly PendingRequest[]>([]);

  useEffect(() => {
    const previousResolver = session.services.approvalResolver;
    const previousBridge = session.appStateBridge;
    session.services.approvalResolver = {
      request(ctx) {
        return new Promise<ReviewDecision>((resolve) => {
          const request: PendingRequest = {
            id: ctx.callId,
            ctx,
            input: deriveInput(ctx),
            description: ctx.retryReason ?? `Permission required to use ${ctx.toolName}`,
            resolve,
          };
          const settle = (decision: ReviewDecision): void => {
            setRequests((queue) => queue.filter((item) => item.id !== request.id));
            resolve(decision);
          };
          const onAbort = (): void => settle(ABORT);
          ctx.signal?.addEventListener("abort", onAbort, { once: true });
          setRequests((queue) => [
            ...queue,
            {
              ...request,
              resolve(decision) {
                ctx.signal?.removeEventListener("abort", onAbort);
                settle(decision);
              },
            },
          ]);
        });
      },
    };
    session.appStateBridge = createSessionAppStateBridge(
      setModel,
      setExpandedView,
      setAppState,
    );
    return () => {
      session.services.approvalResolver = previousResolver;
      session.appStateBridge = previousBridge;
    };
  }, [session, setAppState, setExpandedView, setModel]);

  return requests;
}

export function AgenCPermissionOverlay({
  request,
  tools,
  mcpClients = [],
  isNonInteractiveSession = false,
  debug = false,
}: {
  readonly request: PendingRequest | undefined;
  readonly tools: readonly any[];
  readonly mcpClients?: readonly unknown[];
  readonly isNonInteractiveSession?: boolean;
  readonly debug?: boolean;
}) {
  return useMemo(() => {
    if (!request) return null;
    const toolUseConfirm = buildToolUseConfirm(request, tools);
    if (toolUseConfirm === null) return null;
    // The legacy stub `toolUseContext={{} as any}` crashed every
    // PermissionRequest component that read `toolUseContext.options.*`
    // — most visibly FilePermissionDialog/useDiffInIDE on
    // `options.mcpClients`. Populate the minimum shape consumers
    // expect; the App.tsx render path doesn't run a real model loop
    // here, so empty `tools`/`mcpClients` and quiet `debug` are
    // semantically correct (the overlay just renders + sends
    // approve/deny back to the daemon). See GAP-TUI-WRITE-MCP-CLIENTS-CRASH.
    const toolUseContext = {
      options: {
        tools,
        mcpClients,
        isNonInteractiveSession,
        debug,
        commands: [],
        verbose: true,
      },
    };
    return (
      <PermissionRequest
        toolUseConfirm={toolUseConfirm as never}
        toolUseContext={toolUseContext as any}
        onDone={() => {}}
        onReject={() => {}}
        verbose={true}
        workerBadge={undefined}
      />
    );
  }, [request, tools, mcpClients, isNonInteractiveSession, debug]);
}
