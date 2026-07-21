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
  parseAskUserQuestionInput,
  recordAskUserQuestionPlanInterviewAction,
  recordAskUserQuestionUpdatedInput,
  type AskUserQuestionInput,
  type AskUserQuestionPlanInterviewAction,
} from "../tools/ask-user-question/tool.js";
import { makeToolUseMessage } from "./session-transcript.js";
import type { AgenCBridgeSession } from "./session-types.js";
import { createSessionAppStateBridge } from "./session-app-state.js";
import type { AppState } from "./state/AppState.js";
import { approvalInputText } from "./approval-input-text.js";
import { Box, useInput } from "./ink.js";
import { useRegisterKeybindingContext } from "./keybindings/KeybindingContext.js";
import { useKeybindings } from "./keybindings/useKeybinding.js";
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
}: {
  readonly request: PendingRequest | undefined;
  readonly tools: readonly any[];
  readonly mcpClients?: readonly unknown[];
  readonly isNonInteractiveSession?: boolean;
  readonly debug?: boolean;
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
    return <PlanApprovalContainer key={request.id} request={request} />;
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
        onSkip={() =>
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
        }
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
}: {
  readonly request: PendingRequest;
}) {
  useRegisterKeybindingContext("Confirmation");

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
    setPlanApprovalChoice(request.id, { action: "revise" });
    request.resolve(APPROVED);
  }, [request]);

  useKeybindings(
    {
      "app:interrupt": () => {
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
  "Bash",
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
}: {
  readonly request: PendingRequest;
  readonly toolUseConfirm: ProjectedToolUseConfirm;
}) {
  const command = approvalInputText(toolUseConfirm.input, { prettyJson: true });
  // Build a bounded diff/content preview so a Write/Edit is not approved blind.
  // Reuses the same diff engine + helper the post-approval DIFF card uses; it
  // returns null for non-file-write tools (e.g. Bash), so those show no diff.
  const diffPreview = useMemo<ApprovalDiffPreview | undefined>(() => {
    try {
      const built = buildEditDiffPreview(
        toolUseConfirm.tool.name,
        toolUseConfirm.input,
      );
      if (built === null) return undefined;
      // Label the inline diff the same way the post-approval TRANSCRIPT card
      // does: a Write produces a brand-new file → CREATE; Edit/MultiEdit change
      // an existing one → EDIT. Keeps the approval preview and the transcript in
      // sync instead of showing a neutral DIFF here.
      const op = toolUseConfirm.tool.name === "Write" ? "CREATE" : "EDIT";
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
  }, [toolUseConfirm.tool.name, toolUseConfirm.input]);
  const risk = classifyApprovalRisk({
    request,
    toolName: toolUseConfirm.tool.name,
    description: toolUseConfirm.description,
    command,
  });
  const destructive = risk === "destructive";
  const requiredWord = typedConfirmationWordForRisk({
    risk,
    command,
    description: toolUseConfirm.description,
  });
  const [typed, setTyped] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  useRegisterKeybindingContext("Confirmation");
  const approve = useCallback(() => {
    toolUseConfirm.onAllow(toolUseConfirm.input, []);
  }, [toolUseConfirm]);
  const approveForSession = useCallback(() => {
    if (destructive) return;
    toolUseConfirm.onAllowForSession(toolUseConfirm.input);
  }, [destructive, toolUseConfirm]);
  const reject = useCallback(() => {
    toolUseConfirm.onReject();
  }, [toolUseConfirm]);
  const abort = useCallback(() => {
    toolUseConfirm.onAbort();
  }, [toolUseConfirm]);

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

  useKeybindings(
    {
      "confirm:yes": () => {
        if (destructive) return false;
        approve();
      },
      "confirm:no": reject,
      "app:interrupt": abort,
    },
    { context: "Confirmation" },
  );

  useInput(
    (input, key, event) => {
      if (input === "1") {
        event.stopImmediatePropagation();
        setSelectedIndex(0);
        approve();
        return;
      }
      if (input === "2") {
        event.stopImmediatePropagation();
        setSelectedIndex(1);
        approveForSession();
        return;
      }
      if (input === "3") {
        event.stopImmediatePropagation();
        setSelectedIndex(2);
        reject();
        return;
      }
      if (key.upArrow) {
        event.stopImmediatePropagation();
        setSelectedIndex((index) => (index + 2) % 3);
        return;
      }
      if (key.downArrow) {
        event.stopImmediatePropagation();
        setSelectedIndex((index) => (index + 1) % 3);
        return;
      }
      if (key.return) {
        event.stopImmediatePropagation();
        confirmSelection(selectedIndex);
      }
    },
    { isActive: !destructive },
  );

  useInput(
    (input, key, event) => {
      if (!destructive) return;
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
        setTyped((value) => value.slice(0, -1));
        return;
      }
      if (input.length === 1 && !key.ctrl && !key.meta) {
        setTyped((value) => (value + input).slice(0, requiredWord.length));
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
        note={toolUseConfirm.description}
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
