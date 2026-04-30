import { useEffect, useMemo, useState } from "react";

import { PermissionRequest } from "../../agenc/upstream/components/permissions/PermissionRequest.js";
import type { ApprovalCtx } from "../../tools/orchestrator.js";
import type { ReviewDecision } from "../../permissions/review-decision.js";
import { ABORT } from "../../permissions/review-decision.js";
import {
  buildToolUseConfirm,
  buildToolUseConfirmQueue,
  type PendingRequest,
} from "../../agenc/adapters/permission-bridge-projection.js";
import type { OpenClaudeBridgeSession } from "./session-types.js";

export { buildToolUseConfirmQueue, type PendingRequest };

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

export function usePermissionBridge(
  session: OpenClaudeBridgeSession,
  setModel: (next: string) => void,
  setExpandedView: (next: "none" | "tasks") => void,
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
    session.appStateBridge = { setModel, setExpandedView };
    return () => {
      session.services.approvalResolver = previousResolver;
      session.appStateBridge = previousBridge;
    };
  }, [session, setExpandedView, setModel]);

  return requests;
}

export function OpenClaudePermissionOverlay({
  request,
  tools,
}: {
  readonly request: PendingRequest | undefined;
  readonly tools: readonly any[];
}) {
  return useMemo(() => {
    if (!request) return null;
    const toolUseConfirm = buildToolUseConfirm(request, tools);
    if (toolUseConfirm === null) return null;
    return (
      <PermissionRequest
        toolUseConfirm={toolUseConfirm as never}
        toolUseContext={{} as any}
        onDone={() => {}}
        onReject={() => {}}
        verbose={true}
        workerBadge={undefined}
      />
    );
  }, [request, tools]);
}
