/**
 * Results for a shell tool refused because unified exec is paused: the
 * manager could not prove that an earlier command's processes exited
 * (`UnifiedExecUnavailableError`).
 *
 * The refusal ends the turn. Without that, a model tried one shell command
 * after another while every one was refused before it started: in one session
 * that went on for 12 minutes and 2.3M tokens until the task budget prompt.
 * The message becomes the turn's last words, so the user sees what happened
 * and what to do. The turn loop reads the stop from `execUnavailableStop`.
 *
 * @module
 */

import { createToolEffectDispositionEvidence } from "../effect-boundary.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
import type { ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type { UnifiedExecUnavailableError } from "../../unified-exec/types.js";

const NEXT_STEP =
  "Do not call exec_command, write_stdin, Monitor, kill_process or list_processes again in this turn. " +
  "The turn ends after this call. Tell the user what happened.";

/**
 * The refused call never started anything, so it settles as no effect.
 * `evidenceRef` names the tool that refused it.
 */
export function execUnavailableToolResult(
  error: UnifiedExecUnavailableError,
  evidenceRef: string,
): ToolResult {
  return {
    content: safeStringify({
      error: error.message,
      code: error.code,
      retryable: false,
      next_step: NEXT_STEP,
    }),
    isError: true,
    effectDisposition: createToolEffectDispositionEvidence({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
      evidenceRef,
      evidenceMaterial: error.message,
    }),
    metadata: {
      retryable: false,
      // Read by the turn loop (phases/execute-tools.ts) to end the turn.
      execUnavailableStop: {
        explanation: error.message,
        recheckable: error.recheckable,
      },
    },
  };
}

/**
 * The one-time "commands resumed" note: in front of the tool's output for the
 * model, and as its own transcript line for the user, since a successful
 * command's output is usually shown collapsed.
 */
export function withAdmissionResumedNotice(
  content: string,
  notice: string | undefined,
  args?: Record<string, unknown>,
): string {
  if (notice === undefined) return content;
  const session = args === undefined ? undefined : readToolRuntimeContext(args)?.invocation.session;
  session?.emit({
    id: session.nextInternalSubId(),
    msg: { type: "warning", payload: { cause: "exec_resumed", message: notice } },
  });
  return `${notice}\n\n${content}`;
}
