import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  parseExitPlanAllowedPrompts,
  recordExitPlanModeApproval,
  type ExitPlanApprovalMode,
} from "../../planning/exit-plan-approval.js";
import Box from "../ink/components/Box.js";
import StdinContext from "../ink/components/StdinContext.js";
import Text from "../ink/components/Text.js";
import type { InputEvent } from "../ink/events/input-event.js";
import { theme } from "../theme.js";
import { useSetKeybindingContext } from "../keybindings/KeybindingContext.js";
import { Markdown } from "../components/Markdown.js";
import type { ApprovalDecision } from "./ApprovalOverlay.js";

export interface PlanApprovalOverlayProps {
  readonly requestId: string;
  readonly input: unknown;
  readonly workspacePath: string;
  readonly turnId: string;
  readonly onResolve: (decision: ApprovalDecision) => void;
  readonly abortSignal: AbortSignal;
}

const MAX_PLAN_PREVIEW_LINES = 36;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function truncateLines(source: string, maxLines: number): string {
  if (source.length === 0) return "";
  const lines = source.split("\n");
  if (lines.length <= maxLines) return source;
  return `${lines.slice(0, maxLines).join("\n")}\n...`;
}

function openEditor(path: string): Promise<{ readonly ok: true } | { readonly error: string }> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor || editor.trim().length === 0) {
    return Promise.resolve({ error: "no $EDITOR or $VISUAL configured" });
  }
  return new Promise((resolve) => {
    const child = spawn(editor, [path], { stdio: "inherit" });
    child.once("error", (err) => {
      resolve({ error: err.message });
    });
    child.once("exit", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ error: `${editor} exited with code ${code ?? "unknown"}` });
    });
  });
}

function readPlan(path: string, fallback: string): string {
  if (path.length === 0) return fallback;
  try {
    const content = readFileSync(path, "utf8");
    return content.length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
}

function ensurePlanFile(path: string, content: string): void {
  if (path.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export const PlanApprovalOverlay: React.FC<PlanApprovalOverlayProps> = ({
  requestId,
  input,
  workspacePath,
  turnId,
  onResolve,
  abortSignal,
}) => {
  const stdin = useContext(StdinContext);
  const record = useMemo(() => asRecord(input), [input]);
  const planFilePath = stringValue(record.planFilePath);
  const initialPlan = stringValue(record.plan);
  const allowedPrompts = useMemo(
    () => parseExitPlanAllowedPrompts(record.allowedPrompts),
    [record.allowedPrompts],
  );
  const [plan, setPlan] = useState(() => readPlan(planFilePath, initialPlan));
  const [feedback, setFeedback] = useState("");
  const [capturingFeedback, setCapturingFeedback] = useState(false);
  const [status, setStatus] = useState("");
  const resolvedRef = useRef(false);
  const setActiveContext = useSetKeybindingContext();

  const resolveOnce = useCallback(
    (decision: ApprovalDecision) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolve(decision);
    },
    [onResolve],
  );

  const approve = useCallback(
    (opts: {
      readonly mode?: ExitPlanApprovalMode;
      readonly applyAllowedPrompts?: boolean;
      readonly clearContext?: boolean;
    } = {}) => {
      recordExitPlanModeApproval(requestId, {
        action: "approve",
        plan,
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        ...(opts.applyAllowedPrompts !== undefined
          ? { applyAllowedPrompts: opts.applyAllowedPrompts }
          : {}),
        ...(opts.clearContext !== undefined
          ? { clearContext: opts.clearContext }
          : {}),
        allowedPrompts,
      });
      resolveOnce({ behavior: "allow" });
    },
    [allowedPrompts, plan, requestId, resolveOnce],
  );

  const revise = useCallback(() => {
    recordExitPlanModeApproval(requestId, {
      action: "revise",
      plan,
      ...(feedback.trim().length > 0 ? { feedback: feedback.trim() } : {}),
    });
    resolveOnce({ behavior: "allow" });
  }, [feedback, plan, requestId, resolveOnce]);

  const editPlan = useCallback(async () => {
    if (planFilePath.length === 0) {
      setStatus("No plan file path is available.");
      return;
    }
    try {
      ensurePlanFile(planFilePath, plan);
      setStatus("Editor opened. Return here after saving.");
      const result = await openEditor(planFilePath);
      if ("error" in result) {
        setStatus(`Editor failed: ${result.error}`);
        return;
      }
      const next = readPlanFileSafe(planFilePath, plan);
      setPlan(next);
      setStatus("Plan reloaded from editor.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, [plan, planFilePath]);

  useEffect(() => {
    setActiveContext("modal");
    return () => {
      setActiveContext("chat");
    };
  }, [setActiveContext]);

  useEffect(() => {
    if (abortSignal.aborted) {
      queueMicrotask(() => resolveOnce({ behavior: "abort" }));
      return;
    }
    const handler = (): void => {
      resolveOnce({ behavior: "abort" });
    };
    abortSignal.addEventListener("abort", handler);
    return () => {
      abortSignal.removeEventListener("abort", handler);
    };
  }, [abortSignal, resolveOnce]);

  useEffect(() => {
    const emitter = stdin.internal_eventEmitter;
    if (!emitter) return;
    const listener = (event: InputEvent): void => {
      if (resolvedRef.current) return;
      const key = event.key;
      if (capturingFeedback) {
        if (key.escape) {
          setCapturingFeedback(false);
          return;
        }
        if (key.return) {
          revise();
          return;
        }
        if (key.backspace || key.delete) {
          setFeedback((current) => current.slice(0, -1));
          return;
        }
        if (event.input.length === 1 && !key.ctrl && !key.meta && !key.tab) {
          setFeedback((current) => `${current}${event.input}`);
        }
        return;
      }
      if (!key.ctrl && !key.meta && event.input === "c") {
        resolveOnce({ behavior: "abort" });
        return;
      }
      if (key.ctrl && !key.meta && event.input === "g") {
        void editPlan();
        return;
      }
      if (key.return || (!key.ctrl && !key.meta && event.input === "y")) {
        approve();
        return;
      }
      if (!key.ctrl && !key.meta && event.input === "a") {
        approve({ mode: "acceptEdits", applyAllowedPrompts: true });
        return;
      }
      if (!key.ctrl && !key.meta && event.input === "m") {
        approve({ mode: "auto", applyAllowedPrompts: true });
        return;
      }
      if (!key.ctrl && !key.meta && event.input === "b") {
        approve({ mode: "bypassPermissions", applyAllowedPrompts: true });
        return;
      }
      if (!key.ctrl && !key.meta && event.input === "x") {
        approve({ applyAllowedPrompts: true, clearContext: true });
        return;
      }
      if (!key.ctrl && !key.meta && event.input === "f") {
        setCapturingFeedback(true);
        return;
      }
      if (key.escape || (!key.ctrl && !key.meta && event.input === "d")) {
        revise();
      }
    };
    emitter.on("input", listener);
    return () => {
      emitter.removeListener("input", listener);
    };
  }, [approve, capturingFeedback, editPlan, revise, resolveOnce, stdin]);

  const preview = truncateLines(
    plan.trim().length > 0
      ? plan
      : "No plan content was supplied. The model should write the AgenC plan file before calling ExitPlanMode.",
    MAX_PLAN_PREVIEW_LINES,
  );

  return (
    <Box
      borderStyle="double"
      borderColor={theme.colors.primary as never}
      padding={1}
      flexDirection="column"
    >
      <Text color={theme.colors.warning as never}>Plan approval needed</Text>
      <Text dim>{`turn · ${turnId}`}</Text>
      <Text dim>{`workspace · ${workspacePath}`}</Text>
      <Text dim>{`plan file · ${planFilePath || "(unknown)"}`}</Text>
      <Text dim>{`plan · ${countLines(plan)} lines`}</Text>
      {allowedPrompts.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Requested prompt permissions</Text>
          {allowedPrompts.map((entry, index) => (
            <Text key={`${entry.tool}-${index}`} dim>
              {`  - ${entry.tool}(${entry.prompt})`}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
        <Markdown>{preview}</Markdown>
      </Box>
      {status ? <Text color={theme.colors.secondary as never}>{status}</Text> : null}
      {capturingFeedback ? (
        <Box marginTop={1} borderStyle="round" paddingX={1}>
          <Text color={theme.colors.accent as never}>
            {`Feedback: ${feedback}_`}
          </Text>
        </Box>
      ) : feedback ? (
        <Text dim>{`feedback · ${feedback}`}</Text>
      ) : null}
      <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
        <Text>[Y/Enter] Approve plan</Text>
        <Text>
          {allowedPrompts.length > 0
            ? "[A] Approve + allow requested prompts"
            : "[A] Approve in accept-edits mode"}
        </Text>
        <Text>[M] Approve and resume auto mode</Text>
        <Text>[B] Approve and bypass permissions</Text>
        <Text>[X] Approve and clear context</Text>
        <Text>[F] Add feedback, then keep planning</Text>
        <Text>[D/Esc] Keep planning</Text>
        <Text>[Ctrl+G] Edit plan file</Text>
        <Text>[C] Abort without approving</Text>
      </Box>
    </Box>
  );
};

function readPlanFileSafe(path: string, fallback: string): string {
  try {
    const content = readFileSync(path, "utf8");
    return content.length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
}

export default PlanApprovalOverlay;
