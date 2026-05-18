import { useCallback, useEffect, useMemo, useState } from "react";

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
import { Box, Text, useInput } from "./ink.js";
import { useKeybindings } from "./keybindings/useKeybinding.js";
import { ApprovalCard, KeyHint } from "./components/v2/primitives.js";

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

type ProjectedToolUseConfirm = NonNullable<ReturnType<typeof buildToolUseConfirm>> & {
  readonly tool: {
    readonly name: string;
    userFacingName?(input: unknown): string;
  };
  readonly description: string;
  readonly input: unknown;
  onAllow(
    updatedInput: unknown,
    permissionUpdates?: readonly unknown[],
    feedback?: string,
  ): void;
  onReject(feedback?: string): void;
  onAbort(): void;
};

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
}: {
  readonly request: PendingRequest | undefined;
  readonly tools: readonly any[];
  readonly mcpClients?: readonly unknown[];
  readonly isNonInteractiveSession?: boolean;
  readonly debug?: boolean;
}) {
  const toolUseConfirm = useMemo(() => {
    if (!request) return null;
    return buildToolUseConfirm(request, tools) as ProjectedToolUseConfirm | null;
  }, [request, tools]);

  if (request === undefined || toolUseConfirm === null) {
    return null;
  }
  return <AgenCApprovalOverlay request={request} toolUseConfirm={toolUseConfirm} />;
}

function inputValue(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "input", "query", "path", "file_path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  try {
    return JSON.stringify(record, null, 2);
  } catch {
    return String(input);
  }
}

function toolLabel(toolUseConfirm: ProjectedToolUseConfirm): string {
  const fromTool = toolUseConfirm.tool.userFacingName?.(toolUseConfirm.input);
  if (fromTool && fromTool.trim().length > 0) return fromTool;
  return toolUseConfirm.tool.name;
}

function isHighRisk(request: PendingRequest, toolUseConfirm: ProjectedToolUseConfirm): boolean {
  const haystack = [
    request.ctx.toolName,
    toolUseConfirm.tool.name,
    toolUseConfirm.description,
    inputValue(toolUseConfirm.input),
  ].join(" ").toLowerCase();
  return /\b(mainnet|settle|stake|transfer|slash|escrow|solana\s+transfer)\b/u.test(haystack);
}

function typedConfirmationWord(toolUseConfirm: ProjectedToolUseConfirm): string {
  const haystack = [
    toolUseConfirm.tool.name,
    toolUseConfirm.description,
    inputValue(toolUseConfirm.input),
  ].join(" ").toLowerCase();
  if (/\bsettle\b/u.test(haystack)) return "settle";
  if (/\bstake\b/u.test(haystack)) return "stake";
  if (/\btransfer\b/u.test(haystack)) return "transfer";
  return "yes";
}

function AgenCApprovalOverlay({
  request,
  toolUseConfirm,
}: {
  readonly request: PendingRequest;
  readonly toolUseConfirm: ProjectedToolUseConfirm;
}) {
  const highRisk = isHighRisk(request, toolUseConfirm);
  const requiredWord = typedConfirmationWord(toolUseConfirm);
  const [typed, setTyped] = useState("");
  const approve = useCallback(() => {
    toolUseConfirm.onAllow(toolUseConfirm.input, []);
  }, [toolUseConfirm]);
  const reject = useCallback(() => {
    toolUseConfirm.onReject();
  }, [toolUseConfirm]);
  const abort = useCallback(() => {
    toolUseConfirm.onAbort();
  }, [toolUseConfirm]);

  useKeybindings(
    {
      "confirm:yes": () => {
        if (highRisk) return false;
        approve();
      },
      "confirm:no": reject,
      "app:interrupt": abort,
    },
    { context: "Confirmation" },
  );

  useInput(
    (input, key, event) => {
      if (!highRisk) return;
      event.stopImmediatePropagation();
      if (key.return) {
        if (typed === requiredWord) approve();
        return;
      }
      if (key.escape) {
        reject();
        return;
      }
      if (key.backspace || key.delete) {
        setTyped(value => value.slice(0, -1));
        return;
      }
      if (input.length === 1 && !key.ctrl && !key.meta) {
        setTyped(value => (value + input).slice(0, requiredWord.length));
      }
    },
    { isActive: highRisk },
  );

  const name = toolLabel(toolUseConfirm);
  const command = inputValue(toolUseConfirm.input);
  const typedReady = typed === requiredWord;

  return (
    <Box flexDirection="column" gap={1}>
      <ApprovalCard
        risk={highRisk ? "high" : "low"}
        title={`tool · ${name} · ${highRisk ? "high-risk approval" : "needs approval"}`}
        command={command.length > 0 ? command : toolUseConfirm.description}
        facts={[
          { label: "tool", value: name },
          {
            label: "scope",
            value: highRisk ? "mainnet / protocol" : "session",
            color: highRisk ? "error" : "text2",
          },
          { label: "request", value: request.id },
          { label: "confirmation", value: highRisk ? `type ${requiredWord}` : "enter" },
        ]}
        note={toolUseConfirm.description}
        confirmLabel={highRisk ? `type '${requiredWord}' to approve` : "⏎ approve"}
        requireTypedConfirmation={highRisk}
      />
      {highRisk ? (
        <Box flexDirection="row" gap={1}>
          <Text color={typedReady ? "success" : "error"}>
            {typed.length > 0 ? typed : " "}
          </Text>
          <Text dimColor={true}>/ {requiredWord}</Text>
          <Box flexGrow={1} />
          <KeyHint k="esc" label="cancel" />
        </Box>
      ) : null}
    </Box>
  );
}
