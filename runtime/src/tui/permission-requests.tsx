import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  parseAskUserQuestionInput,
  recordAskUserQuestionPlanInterviewAction,
  recordAskUserQuestionUpdatedInput,
  type AskUserQuestionInput,
  type AskUserQuestionPlanInterviewAction,
} from "../tools/ask-user-question/tool.js";
import { makeToolUseMessage } from "./synthetic-assistant-message.js";
import type { AgenCBridgeSession } from "./session-types.js";
import { createSessionAppStateBridge } from "./session-app-state.js";
import type { AppState } from "./state/AppState.js";
import { approvalInputText } from "./approval-input-text.js";
import { Box, useInput, type Key } from "./ink.js";
import type { InputEvent } from "./ink/events/input-event.js";
import { useRegisterKeybindingContext } from "./keybindings/KeybindingContext.js";
import { useInputCapture, useKeybindings } from "./keybindings/useKeybinding.js";
import { useRegisterOverlay } from "./context/overlayContext.js";
import { ApprovalCard, type ApprovalDiffPreview } from "./components/v2/primitives.js";
import { buildEditDiffPreview } from "./edit-diff-preview.js";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../tools/ExitPlanModeTool/constants.js";
import { PlanApprovalOverlay } from "./components/PlanApprovalOverlay.js";
import { AskUserQuestionOverlay } from "./components/AskUserQuestionOverlay.js";
import { setPlanApprovalChoice } from "./plan-approval-choice.js";
import {
  classifyApprovalRisk,
  typedConfirmationWordForRisk,
} from "../permissions/risk.js";

export { createSessionAppStateBridge };

export interface PendingRequest {
  readonly id: string;
  readonly ctx: ApprovalCtx;
  readonly input: Record<string, unknown>;
  readonly description: string;
  resolve(decision: ReviewDecision): void;
}

export function collectPermissionToolNames(
  transcriptToolNames: Iterable<string>,
  requests: readonly PendingRequest[],
): ReadonlySet<string> {
  const names = new Set(transcriptToolNames);
  // Child tools need not appear in the parent's transcript. Every queued
  // request is projected, so include every identity before building cards.
  for (const request of requests) names.add(request.ctx.toolName);
  return names;
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
        typeof record.rawArguments === "string"
          ? record.rawArguments
          : undefined,
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
  const tool = tools.find(
    (candidate) => candidate.name === request.ctx.toolName,
  );
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
    onAllow(updatedInput: unknown, permissionUpdates: readonly unknown[] = []) {
      if (request.ctx.toolName === ASK_USER_QUESTION_TOOL_NAME) {
        recordAskUserQuestionUpdatedInput(request.ctx.callId, updatedInput);
      }
      request.resolve(
        permissionUpdates.length > 0 ? APPROVED_FOR_SESSION : APPROVED,
      );
    },
    onAllowForSession(updatedInput: unknown) {
      if (request.ctx.toolName === ASK_USER_QUESTION_TOOL_NAME) {
        recordAskUserQuestionUpdatedInput(request.ctx.callId, updatedInput);
      }
      request.resolve(APPROVED_FOR_SESSION);
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

type ProjectedToolUseConfirm = NonNullable<
  ReturnType<typeof buildToolUseConfirm>
> & {
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
  onAllowForSession(updatedInput: unknown): void;
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
  getAppState: () => AppState,
) {
  const [requests, setRequests] = useState<readonly PendingRequest[]>([]);

  useEffect(() => {
    const previousResolver = session.services.approvalResolver;
    const previousBridge = session.appStateBridge;
    session.services.approvalResolver = {
      request(ctx) {
        return new Promise<ReviewDecision>((resolve) => {
          if (ctx.signal?.aborted === true) {
            resolve(ABORT);
            return;
          }
          const request: PendingRequest = {
            id: ctx.callId,
            ctx,
            input: deriveInput(ctx),
            description:
              ctx.retryReason ?? `Permission required to use ${ctx.toolName}`,
            resolve,
          };
          const settle = (decision: ReviewDecision): void => {
            setRequests((queue) =>
              queue.filter((item) => item.id !== request.id),
            );
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
      getAppState,
    );
    return () => {
      session.services.approvalResolver = previousResolver;
      session.appStateBridge = previousBridge;
    };
  }, [getAppState, session, setAppState, setExpandedView, setModel]);

  return requests;
}

export function AgenCPermissionOverlay({
  request,
  tools,
  onDismiss,
}: {
  readonly request: PendingRequest | undefined;
  readonly tools: readonly any[];
  readonly mcpClients?: readonly unknown[];
  readonly isNonInteractiveSession?: boolean;
  readonly debug?: boolean;
  readonly onDismiss?: () => void;
}) {
  // Register the whole approval family as a modal overlay: without this the
  // GLOBAL turn-cancel (useCancelRequest) treats esc as "cancel the turn"
  // while an approval is open — the turn aborts but the permission request
  // never resolves, leaving a zombie overlay on screen forever. With the
  // overlay registered, the global cancel defers and esc reaches the
  // approval's own handlers (skip/keep-planning/reject).
  useRegisterOverlay("approval", request !== undefined);

  const isExitPlanMode =
    request !== undefined &&
    request.ctx.toolName === EXIT_PLAN_MODE_TOOL_NAME;

  const toolUseConfirm = useMemo(() => {
    if (!request || isExitPlanMode) return null;
    return buildToolUseConfirm(
      request,
      tools,
    ) as ProjectedToolUseConfirm | null;
  }, [request, tools, isExitPlanMode]);

  // AskUserQuestion gets its interactive picker instead of the generic card:
  // the generic card dumps the questions as raw JSON and approves without
  // recording any answers, so the tool then fails with "User did not provide
  // answers." Parse failures fall through to the generic card unchanged.
  const askUserQuestionInput = useMemo(() => {
    if (
      request === undefined ||
      request.ctx.toolName !== ASK_USER_QUESTION_TOOL_NAME
    ) {
      return null;
    }
    const parsed = parseAskUserQuestionInput(request.input);
    return parsed.ok ? parsed.input : null;
  }, [request]);

  if (request !== undefined && isExitPlanMode) {
    return <PlanApprovalContainer key={request.id} request={request} onDismiss={onDismiss} />;
  }

  if (
    request !== undefined &&
    askUserQuestionInput !== null &&
    toolUseConfirm !== null
  ) {
    return (
      <AskUserQuestionApprovalContainer
        key={request.id}
        input={askUserQuestionInput}
        onSubmit={(updatedInput) => toolUseConfirm.onAllow(updatedInput, [])}
        onSkip={onDismiss ?? (() =>
          // esc is a deliberate skip, not a denial: approve with an empty
          // answer set flagged skipped — the tool then tells the model to
          // proceed with best judgment instead of erroring into a re-ask loop.
          toolUseConfirm.onAllow(
            {
              ...askUserQuestionInput,
              answers: {},
              metadata: {
                ...(askUserQuestionInput.metadata ?? {}),
                skipped: true,
              },
            },
            [],
          )
        )}
      />
    );
  }

  if (request === undefined || toolUseConfirm === null) {
    return null;
  }
  return (
    <AgenCApprovalOverlay
      key={request.id}
      request={request}
      toolUseConfirm={toolUseConfirm}
      onDismiss={onDismiss}
    />
  );
}

function AskUserQuestionApprovalContainer({
  input,
  onSubmit,
  onSkip,
}: {
  readonly input: AskUserQuestionInput;
  onSubmit(updatedInput: unknown): void;
  onSkip(): void;
}): React.ReactElement {
  // Own the Confirmation context like PlanApprovalContainer: without it, esc
  // falls through to the GLOBAL turn-cancel (useCancelRequest) — the turn
  // aborts while the permission request stays pending, leaving a zombie
  // picker on screen forever (observed live: "Turn aborted: interrupted"
  // with the question still open).
  useRegisterKeybindingContext("Confirmation");
  useKeybindings(
    {
      "app:interrupt": () => {
        onSkip();
      },
    },
    { context: "Confirmation" },
  );
  return (
    <AskUserQuestionOverlay
      input={input}
      onSubmit={onSubmit}
      onSkip={onSkip}
    />
  );
}

function PlanApprovalContainer({
  request,
  onDismiss,
}: {
  readonly request: PendingRequest;
  readonly onDismiss?: () => void;
}) {
  useRegisterKeybindingContext("Confirmation");
  const settled = useRef(false);

  const planContent =
    request.ctx.planContent ??
    (typeof request.input.plan === "string" ? request.input.plan : undefined);
  const planFilePath =
    request.ctx.planFilePath ??
    (typeof request.input.planFilePath === "string"
      ? request.input.planFilePath
      : undefined);

  const onApprove = useCallback(
    (mode: "acceptEdits" | "default") => {
      if (settled.current) return;
      settled.current = true;
      setPlanApprovalChoice(request.id, {
        action: "approve",
        mode,
        ...(mode === "acceptEdits" ? { applyAllowedPrompts: true } : {}),
      });
      request.resolve(APPROVED);
    },
    [request],
  );

  const onKeepPlanning = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    setPlanApprovalChoice(request.id, { action: "revise" });
    request.resolve(APPROVED);
  }, [request]);

  useKeybindings(
    {
      "app:interrupt": () => {
        if (settled.current) return;
        settled.current = true;
        request.resolve(ABORT);
      },
    },
    { context: "Confirmation" },
  );

  return (
    <Box flexDirection="column" gap={1}>
      <PlanApprovalOverlay
        {...(planContent !== undefined ? { planContent } : {})}
        {...(planFilePath !== undefined ? { planFilePath } : {})}
        onApprove={onApprove}
        onKeepPlanning={onKeepPlanning}
        onDismiss={onDismiss}
      />
    </Box>
  );
}

function toolLabel(toolUseConfirm: ProjectedToolUseConfirm): string {
  const fromTool = toolUseConfirm.tool.userFacingName?.(toolUseConfirm.input);
  if (fromTool && fromTool.trim().length > 0) return fromTool;
  return toolUseConfirm.tool.name;
}

/** Live shell/command tool names whose approval input IS a runnable command. */
const SHELL_COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.bash",
  "exec_command",
  "Run",
]);

/**
 * Whether the approval `command` string is a real SHELL command (so it earns the
 * `$ ` prompt glyph), vs a non-shell input such as a Write/Edit `file_path` where
 * a `$ ` would misread as runnable and duplicate the diff header's path. Decided
 * from the tool name (the known shell tools) OR — for any other tool — from the
 * input actually carrying a `command`/`cmd` key (the same signal
 * `approvalInputText` uses to render a command rather than a bare path/field).
 */
function approvalCommandIsShell(
  toolUseConfirm: ProjectedToolUseConfirm,
): boolean {
  if (SHELL_COMMAND_TOOL_NAMES.has(toolUseConfirm.tool.name)) return true;
  const input = toolUseConfirm.input;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string" || typeof record.cmd === "string") {
      return true;
    }
  }
  return false;
}

function AgenCApprovalOverlay({
  request,
  toolUseConfirm,
  onDismiss,
}: {
  readonly request: PendingRequest;
  readonly toolUseConfirm: ProjectedToolUseConfirm;
  readonly onDismiss?: () => void;
}) {
  const command = approvalInputText(toolUseConfirm.input, { prettyJson: true });
  const fileWritePreview = request.ctx.fileWritePreview;
  const writePreviewUnavailable = toolUseConfirm.tool.name === "Write" &&
    (fileWritePreview === undefined || fileWritePreview.kind === "unavailable");
  const diffPreview = useMemo<ApprovalDiffPreview | undefined>(() => {
    try {
      if (writePreviewUnavailable) return undefined;
      const writeInput = toolUseConfirm.tool.name === "Write" &&
        fileWritePreview?.kind === "existing" &&
        toolUseConfirm.input !== null && typeof toolUseConfirm.input === "object"
        ? {
            ...toolUseConfirm.input,
            old_string: fileWritePreview.content,
            new_string: (toolUseConfirm.input as Record<string, unknown>).content,
          }
        : undefined;
      const built = buildEditDiffPreview(
        writeInput === undefined ? toolUseConfirm.tool.name : "Edit",
        writeInput ?? toolUseConfirm.input,
      );
      if (built === null) return undefined;
      const op = toolUseConfirm.tool.name === "Write" && fileWritePreview?.kind === "missing"
        ? "CREATE"
        : "EDIT";
      return {
        file: built.file,
        stats: built.stats,
        lines: built.lines,
        remaining: built.remaining,
        op,
      };
    } catch {
      // A malformed input must never break the approval popup — degrade to the
      // command-only card rather than throwing inside render.
      return undefined;
    }
  }, [toolUseConfirm.tool.name, toolUseConfirm.input, fileWritePreview, writePreviewUnavailable]);
  const risk = classifyApprovalRisk({
    request,
    toolName: toolUseConfirm.tool.name,
    description: toolUseConfirm.description,
    command,
    toolInput: toolUseConfirm.input,
  });
  const destructive = risk === "destructive";
  const requiredWord = typedConfirmationWordForRisk({
    risk,
    command,
    description: toolUseConfirm.description,
    toolName: toolUseConfirm.tool.name,
    toolInput: toolUseConfirm.input,
  });
  const [typed, setTyped] = useState("");
  const typedRef = useRef("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const settled = useRef(false);
  useRegisterKeybindingContext("Confirmation");
  const settle = useCallback((decision: () => void) => {
    if (settled.current || request.ctx.signal?.aborted === true) return;
    settled.current = true;
    decision();
  }, [request]);
  const approve = useCallback(() => {
    settle(() => toolUseConfirm.onAllow(toolUseConfirm.input, []));
  }, [settle, toolUseConfirm]);
  const approveForSession = useCallback(() => {
    if (destructive) return;
    settle(() => toolUseConfirm.onAllowForSession(toolUseConfirm.input));
  }, [destructive, settle, toolUseConfirm]);
  const reject = useCallback(() => {
    settle(() => toolUseConfirm.onReject());
  }, [settle, toolUseConfirm]);
  const abort = useCallback(() => {
    settle(() => {
      if (onDismiss !== undefined) onDismiss();
      else toolUseConfirm.onAbort();
    });
  }, [onDismiss, settle, toolUseConfirm]);

  const confirmSelection = useCallback(
    (index: number) => {
      if (index === 0) {
        approve();
        return;
      }
      if (index === 1) {
        approveForSession();
        return;
      }
      reject();
    },
    [approve, approveForSession, reject],
  );

  const handleSelectionInput = useCallback(
    (input: string, key: Key, event: InputEvent): boolean => {
      if (input === "1") {
        event.stopImmediatePropagation();
        selectedIndexRef.current = 0;
        setSelectedIndex(0);
        approve();
        return true;
      }
      if (input === "2") {
        event.stopImmediatePropagation();
        selectedIndexRef.current = 1;
        setSelectedIndex(1);
        approveForSession();
        return true;
      }
      if (input === "3") {
        event.stopImmediatePropagation();
        selectedIndexRef.current = 2;
        setSelectedIndex(2);
        reject();
        return true;
      }
      if (key.upArrow) {
        event.stopImmediatePropagation();
        selectedIndexRef.current = (selectedIndexRef.current + 2) % 3;
        setSelectedIndex(selectedIndexRef.current);
        return true;
      }
      if (key.downArrow) {
        event.stopImmediatePropagation();
        selectedIndexRef.current = (selectedIndexRef.current + 1) % 3;
        setSelectedIndex(selectedIndexRef.current);
        return true;
      }
      if (key.return) {
        event.stopImmediatePropagation();
        confirmSelection(selectedIndexRef.current);
        return true;
      }
      return false;
    },
    [approve, approveForSession, confirmSelection, reject],
  );
  useInputCapture(handleSelectionInput, { context: "Modal", isActive: !destructive });
  useInput(handleSelectionInput, { isActive: !destructive });

  useKeybindings(
    {
      "confirm:yes": () => {
        if (destructive) return false;
        approve();
        return undefined;
      },
      "confirm:no": () => {
        if (destructive) return false;
        reject();
        return undefined;
      },
      "app:interrupt": abort,
    },
    { context: "Confirmation" },
  );

  useInput(
    (input, key, event) => {
      if (!destructive) return;
      event.stopImmediatePropagation();
      if (key.return) {
        if (typedRef.current === requiredWord) approve();
        return;
      }
      if (key.escape) {
        if (onDismiss !== undefined) abort();
        else reject();
        return;
      }
      if (key.backspace || key.delete) {
        typedRef.current = typedRef.current.slice(0, -1);
        setTyped(typedRef.current);
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/u.test(input)) {
        typedRef.current = (typedRef.current + input).slice(0, requiredWord.length + 1);
        setTyped(typedRef.current);
      }
    },
    { isActive: destructive },
  );

  const name = toolLabel(toolUseConfirm);
  const title =
    risk === "destructive"
      ? "destructive high-risk approval"
      : risk === "medium"
        ? "medium-risk approval"
        : "needs approval";
  return (
    <Box flexDirection="column" gap={1}>
      <ApprovalCard
        risk={destructive ? "high" : "low"}
        title={`tool · ${name} · ${title}`}
        command={command.length > 0 ? command : toolUseConfirm.description}
        commandIsShell={approvalCommandIsShell(toolUseConfirm)}
        confirmLabel={destructive ? `type ${requiredWord}` : "enter"}
        facts={[
          { label: "tool", value: name },
          {
            label: "scope",
            value: risk === "low" ? "session" : risk,
            color: destructive
              ? "error"
              : risk === "medium"
                ? "warning"
                : "text2",
          },
          { label: "request", value: request.id },
          {
            label: "confirmation",
            value: destructive ? `type ${requiredWord}` : "enter",
          },
        ]}
        note={writePreviewUnavailable
          ? `Existing content unavailable; this write may overwrite a file. ${fileWritePreview?.kind === "unavailable" ? fileWritePreview.reason : ""}`.trim()
          : toolUseConfirm.description}
        {...(diffPreview !== undefined ? { diffPreview } : {})}
        requestId={request.id}
        requireTypedConfirmation={destructive}
        typedConfirmationValue={typed}
        typedConfirmationTarget={requiredWord}
        selectedIndex={selectedIndex}
      />
    </Box>
  );
}
