import { stripVTControlCharacters } from "node:util";
import type { ExecCommandToolOutput } from "../../unified-exec/types.js";

/**
 * Shown after the footer when processes outlived the command and cleanup
 * is complete. Without it the model saw exit 0 for `nginx` or
 * `nohup server &`, then found nothing listening, and could not learn why:
 * the containment that stops a command's residue never said so.
 *
 * The usual residue is a server a command started to smoke-test it. Models
 * then waited for it with a fixed `sleep 1`, ran the check again after an
 * edit, and searched the process table for leftovers (where `pkill -f` can
 * match the command's own shell), each step another model call. The note
 * says that nothing is left to stop and how to wait for a server: a bounded
 * loop on its port or log line, requests and `kill $!` in one command.
 */
export const RESIDUAL_PROCESSES_NOTE =
  "[note: this command left processes running after it exited. Cleanup is complete; those processes are no longer running. Nothing is left to stop or look for. To check a server, start it in the background, wait for its port or log line in a bounded loop instead of a fixed sleep (for example up to 50 tries of `curl -sf <url>` with `sleep 0.1`), then make the requests and `kill $!` in the same command. To start a service that must keep running after the command returns and after this session ends, use detach: true only outside the sandbox (an approved require_escalated launch, if permitted). Otherwise keep the process in the foreground with yield_time_ms; managed sessions stop at session end.]";

/** The same fact on a later command of a session that already got {@link RESIDUAL_PROCESSES_NOTE}. */
export const RESIDUAL_PROCESSES_REPEAT_NOTE =
  "[note: this command left processes running after it exited. Cleanup is complete; those processes are no longer running.]";

/** Sessions that got the full residue note, oldest first; bounded for long-lived daemons. */
const sessionsWithResidualNote = new Set<string>();
const RESIDUAL_NOTE_SESSION_LIMIT = 4096;

/**
 * Keep the server guidance to the first residue note of a session: every
 * tool result is replayed on each later request, so a repeated full note
 * costs its length again on every call. Content without the note, or
 * without a session, is returned unchanged.
 */
export function residualNoteOncePerSession(content: string, sessionId: string | undefined): string {
  const note = `\n${RESIDUAL_PROCESSES_NOTE}`;
  if (sessionId === undefined || !content.endsWith(note)) return content;
  if (!sessionsWithResidualNote.has(sessionId)) {
    if (sessionsWithResidualNote.size >= RESIDUAL_NOTE_SESSION_LIMIT) {
      const oldest = sessionsWithResidualNote.values().next().value;
      if (oldest !== undefined) sessionsWithResidualNote.delete(oldest);
    }
    sessionsWithResidualNote.add(sessionId);
    return content;
  }
  return `${content.slice(0, -note.length)}\n${RESIDUAL_PROCESSES_REPEAT_NOTE}`;
}

/** Model-facing alias only; canonical results and structured facts stay intact. */
export function compactExecExitFooter(content: string): string {
  const note = [RESIDUAL_PROCESSES_NOTE, RESIDUAL_PROCESSES_REPEAT_NOTE]
    .map((text) => `\n${text}`)
    .find((text) => content.endsWith(text)) ?? "";
  const footerEnd = content.length - note.length;
  return content.slice(0, footerEnd).replace(
    /(^|\n)\[exec exit_code=(-?\d+)((?: [^\r\n]*)?)\]$/,
    "$1[exit $2$3]",
  ) + content.slice(footerEnd);
}

export function formatUnifiedExecToolContent(
  output: ExecCommandToolOutput,
  lightMode = false,
): string {
  // Output FIRST, metadata after. The previous order put a multi-line
  // "Wall time: ... / Process exited with code 0 / Original token count: N
  // / Output:" header BEFORE the actual stdout. Grok (and likely other
  // models) interpreted that prefix as an incomplete/stalled tool result
  // and re-emitted the same tool call repeatedly instead of using the
  // output it already had — see rollout sequence with three identical
  // exec_command calls each returning the same ls listing.
  //
  // Putting the output first lets the model anchor on the real result
  // immediately. The metadata footer stays for log/debug value but no
  // longer leads.
  const sections: string[] = [];
  // Strip whole terminal sequences before the untrusted-data sanitizer replaces
  // their control bytes. Otherwise color output becomes literal " [32m" text
  // repeated in every later prompt. Raw output and structured results stay intact.
  sections.push(stripVTControlCharacters(output.output));

  const footerLines: string[] = [];
  if (output.command_outcome !== undefined) {
    footerLines.push(`command_outcome=${output.command_outcome} cleanup_complete=true`);
  } else if (output.exitCode !== null) {
    footerLines.push(`exit_code=${output.exitCode}`);
  } else if (output.detached === true && output.pid !== undefined) {
    // A detached service that was still running when the yield window
    // closed. AgenC does not track it, so there is no session_id: the pid
    // and the log file are the handles the model has.
    footerLines.push(`running=true pid=${output.pid}`);
  } else if (output.process_id !== undefined) {
    // exitCode is null AND a process_id is exposed → process is still
    // alive (yielded to caller, can be resumed via write_stdin / the
    // session id). `timedOut` here is NOT a kill marker — it just
    // signals the yield window elapsed. Not an error case.
    footerLines.push(`yielded=true`);
  } else if (output.timedOut) {
    // exitCode null AND no process_id → process was killed. timedOut
    // means the configured execution timeout fired and we sent the
    // kill signal.
    footerLines.push(`timed_out=true`);
  } else {
    // exitCode null AND no process_id AND not a timeout → terminated
    // by an external signal (SIGKILL/SIGTERM/OOM/sandbox kill).
    footerLines.push(`signal_terminated=true`);
  }
  const routineLightSuccess = lightMode && output.exitCode === 0 &&
    !output.truncated && !output.timedOut && output.process_id === undefined &&
    output.session_id === undefined && output.detached !== true &&
    output.residual_processes_terminated !== true && output.residual_processes_observed !== true &&
    output.command_outcome === undefined;
  if (!routineLightSuccess) {
    footerLines.push(`wall_time=${output.wall_time_seconds.toFixed(4)}s`);
    footerLines.push(`tokens=${output.original_token_count}`);
  }
  if (lightMode && output.truncated) footerLines.push("truncated=true");
  const sessionId = output.process_id ?? output.session_id;
  if (sessionId !== undefined) {
    footerLines.push(`session_id=${sessionId}`);
  }
  if (output.detached === true) {
    footerLines.push("detached=true");
    if (output.log_path !== undefined) footerLines.push(`log=${output.log_path}`);
  }
  // Compact one-line footer separated from output by a blank line so the
  // model sees the two sections distinctly.
  sections.push("");
  sections.push(`[exec ${footerLines.join(" ")}]`);
  if (output.residual_processes_terminated === true || output.residual_processes_observed === true) {
    sections.push(RESIDUAL_PROCESSES_NOTE);
  }
  return sections.join("\n");
}

export function unifiedExecCodeModeResult(
  output: ExecCommandToolOutput,
  sandboxNotice?: string | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    wall_time_seconds: output.wall_time_seconds,
    original_token_count: output.original_token_count,
    output: output.output,
  };
  if (sandboxNotice != null) result.sandbox_notice = sandboxNotice;

  if (output.command_outcome !== undefined) {
    result.command_outcome = output.command_outcome;
    result.cleanup_complete = true;
  } else if (output.exitCode !== null) {
    result.exit_code = output.exitCode;
  } else if (output.detached === true && output.pid !== undefined) {
    result.running = true;
  } else if (output.process_id !== undefined) {
    // Process yielded and is still alive — see formatUnifiedExecToolContent
    // for the matching content-side decision. timedOut is irrelevant
    // here; it just means the yield window elapsed.
    result.yielded = true;
  } else if (output.timedOut) {
    result.timed_out = true;
  } else {
    result.signal_terminated = true;
  }

  const sessionId = output.process_id ?? output.session_id;
  if (sessionId !== undefined) {
    result.session_id = sessionId;
  }
  if (output.detached === true) {
    result.detached = true;
    if (output.pid !== undefined) result.pid = output.pid;
    if (output.log_path !== undefined) result.log_path = output.log_path;
  }
  if (output.residual_processes_terminated === true) {
    result.residual_processes_terminated = true;
  }

  if (output.residual_processes_observed === true) result.residual_processes_observed = true;

  return result;
}
