import { stripVTControlCharacters } from "node:util";
import type { ExecCommandToolOutput, SessionEndNotice } from "../../unified-exec/types.js";
import { formatDuration } from "../../unified-exec/process-state.js";

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
 * loop on its port or log line, requests and `kill $!` in one command. A
 * check that waited with `timeout 2` or `sleep` and cleaned up after itself
 * leaves no residue; {@link SERVER_CHECK_NOTE} carries the same guidance then.
 */
export const RESIDUAL_PROCESSES_NOTE =
  "[note: this command left processes running after it exited. Cleanup is complete; those processes are no longer running. Nothing is left to stop or look for. To check a server, start it in the background, wait for its port or log line in a bounded loop instead of a fixed sleep (for example up to 50 tries of `curl -sf <url>` with `sleep 0.1`), then make the requests and `kill $!` in the same command. To keep a process running in this session, run it in the foreground (a server too: nginx -g 'daemon off;', sshd -D) as its own exec_command with background: true; it stops at session end. To start a service that must keep running after this session ends, use detach: true only outside the sandbox (an approved require_escalated launch, if permitted).]";

/**
 * {@link RESIDUAL_PROCESSES_NOTE} without its server guidance, for a session
 * whose exec_command description already says how to check a server on every
 * request (tools/light-presentation.ts LIGHT_GLM_SERVER_CHECKS).
 */
export const RESIDUAL_PROCESSES_NOTE_WITHOUT_SERVER_GUIDANCE =
  "[note: this command left processes running after it exited. Cleanup is complete; those processes are no longer running. Nothing is left to stop or look for. To keep a process running in this session, run it in the foreground (a server too: nginx -g 'daemon off;', sshd -D) as its own exec_command with background: true; it stops at session end. To start a service that must keep running after this session ends, use detach: true only outside the sandbox (an approved require_escalated launch, if permitted).]";

/**
 * The command's timeoutMs passed while it was running: AgenC kept it running
 * as a session instead of stopping it (the DSH-style background job).
 */
export function timeoutBackgroundedNote(timeoutMs: number, sessionId: number): string {
  return `[note: timeoutMs=${timeoutMs} passed and the command is still running; AgenC kept it running as session ${sessionId} instead of stopping it. write_stdin polls it, kill_process stops it.]`;
}

/** The timeout passed at the background-session limit, so the command was stopped. */
export function timeoutStoppedAtSessionLimitNote(limit: number): string {
  return `[note: timeoutMs passed while ${limit} background sessions of this conversation were running, the limit, so AgenC stopped this command. Stop a session you no longer need with kill_process to free a slot.]`;
}

/** Shown on the first background start of a conversation; later starts carry only the footer. */
export function backgroundStartedNote(sessionId: number): string {
  return `[note: session ${sessionId} runs in the background. A later exec result says when it ends; write_stdin polls its output, kill_process stops it.]`;
}

const END_NOTICE_COMMAND_CHARS = 40;

/** One line for a background session that ended while nothing was showing it. */
export function formatSessionEndNotice(notice: SessionEndNotice): string {
  const command = notice.command.replace(/\s+/gu, " ").trim();
  const preview = command.length > END_NOTICE_COMMAND_CHARS
    ? `${command.slice(0, END_NOTICE_COMMAND_CHARS - 3)}...`
    : command;
  const status = notice.exitCode !== null
    ? `exit ${notice.exitCode}${notice.signal !== undefined ? ` (${notice.signal})` : ""}`
    : notice.signal !== undefined ? `killed by ${notice.signal}` : "ended without an exit status";
  const oom = notice.outOfMemory === true ? ", likely out of memory (the cgroup OOM killer fired while it ran)" : "";
  return `[session ${notice.sessionId} ended after ${formatDuration(notice.durationMs)}: ${status}${oom} (\`${preview}\`). write_stdin session_id=${notice.sessionId} returns its remaining output.]`;
}

/** `content` followed by one line per end notice. */
export function withSessionEndNotices(content: string, notices: readonly SessionEndNotice[] | undefined): string {
  if (notices === undefined || notices.length === 0) return content;
  return `${content}\n${notices.map(formatSessionEndNotice).join("\n")}`;
}

/** Conversations that already got {@link backgroundStartedNote}; bounded like the other notes. */
const sessionsWithBackgroundNote = new Set<string>();

/** {@link backgroundStartedNote} once per conversation; undefined after the first or without one. */
export function backgroundStartedNoteOncePerSession(
  sessionId: string | undefined,
  execSessionId: number,
): string | undefined {
  if (sessionId === undefined) return backgroundStartedNote(execSessionId);
  return firstFor(sessionsWithBackgroundNote, sessionId) ? backgroundStartedNote(execSessionId) : undefined;
}

/** The same fact on a later command of a session that already got {@link RESIDUAL_PROCESSES_NOTE}. */
export const RESIDUAL_PROCESSES_REPEAT_NOTE =
  "[note: this command left processes running after it exited. Cleanup is complete; those processes are no longer running.]";

/**
 * How to check a server: the pattern {@link SERVER_CHECK_NOTE} and the first
 * {@link RESIDUAL_PROCESSES_NOTE} of a session give once. The exec_command
 * description of a Light session on abliteration.ai Large V2 opens with it on
 * every request (tools/light-presentation.ts LIGHT_GLM_SERVER_CHECKS).
 */
export const SERVER_CHECK_GUIDANCE =
  "To check a server, start it in the background, wait for its port or log line in a bounded loop instead of a fixed sleep or timeout (for example up to 50 tries of `curl -sf <url>` with `sleep 0.1`), then make the requests and `kill $!` in the same command.";

/**
 * Shown once per session after a command that started a program and waited a
 * fixed time for it without leaving it running (`server & pid=$!; sleep 1;
 * curl ...; kill $pid`, `timeout 2 node server.js`): the same server guidance
 * as {@link RESIDUAL_PROCESSES_NOTE}, for the next check.
 */
export const SERVER_CHECK_NOTE =
  `[note: exec_command stops every process a command leaves running when it returns, so nothing needs a later kill, pkill or pgrep. ${SERVER_CHECK_GUIDANCE}]`;

/**
 * {@link SERVER_CHECK_NOTE} for a check that was still running when it
 * returned (a yielded session, which kill_process or a poll handles next, or
 * a detached service): the guidance without the claim that nothing needs a
 * later kill.
 */
export const SERVER_CHECK_RUNNING_NOTE = `[note: ${SERVER_CHECK_GUIDANCE}]`;

/**
 * A command that started something in the background and then slept, or ran a
 * program (not its tests) under a timeout of a few seconds to see it start.
 * `&&`, `2>&1` and `&>` are not background jobs.
 */
const FIXED_WAIT_FOR_PROGRAM = new RegExp([
  String.raw`(?:^|[^&>])&(?![&>\d])[^|]*?\bsleep\s+\d`,
  String.raw`\btimeout\s+(?:-\S+\s+)*[0-5](?:\.\d+)?s?\s+(?:\w+=\S*\s+)*(?:node|nodejs|python3?|npm|npx|pnpm|yarn|deno|bun|ruby|rails|php|go|java|uvicorn|gunicorn|flask|cargo|dotnet)\b(?![^;&|\n]*\btest)`,
].join("|"), "u");

/** A shell loop: a command that already polls needs no advice about polling. */
const SHELL_LOOP = /(?:^|[\s;&|(])(?:for|while|until)\s/u;

/** Whether `command` waits a fixed time for a program it started. */
export function waitsFixedTimeForProgram(command: string): boolean {
  return FIXED_WAIT_FOR_PROGRAM.test(command) && !SHELL_LOOP.test(command);
}

/** Sessions that got each note, oldest first; bounded for long-lived daemons. */
const sessionsWithResidualNote = new Set<string>();
const sessionsWithServerGuidance = new Set<string>();
const NOTE_SESSION_LIMIT = 4096;

/** Record `sessionId`; true when it was not recorded before. */
function firstFor(sessions: Set<string>, sessionId: string): boolean {
  if (sessions.has(sessionId)) return false;
  if (sessions.size >= NOTE_SESSION_LIMIT) {
    const oldest = sessions.values().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  sessions.add(sessionId);
  return true;
}

/**
 * The residue note once per session. Every tool result is replayed on each
 * later request, so a repeated full note costs its length again on every
 * call: a session's first residue note is the full one (and gives the session
 * the server guidance), later ones are a line. Without a session the content
 * is returned unchanged.
 *
 * `serverGuidanceDescribed`: the session's exec_command description carries
 * the server guidance on every request, so its first note (and a note without
 * a session) leaves it out. If the session later loses that description (a
 * model switch), its next residue note is the full one.
 */
export function residualNoteOncePerSession(
  content: string,
  sessionId: string | undefined,
  serverGuidanceDescribed = false,
): string {
  const note = `\n${RESIDUAL_PROCESSES_NOTE}`;
  if (!content.endsWith(note)) return content;
  const result = content.slice(0, -note.length);
  if (sessionId === undefined) {
    return serverGuidanceDescribed ? `${result}\n${RESIDUAL_PROCESSES_NOTE_WITHOUT_SERVER_GUIDANCE}` : content;
  }
  const first = firstFor(sessionsWithResidualNote, sessionId);
  if (serverGuidanceDescribed) {
    return `${result}\n${first ? RESIDUAL_PROCESSES_NOTE_WITHOUT_SERVER_GUIDANCE : RESIDUAL_PROCESSES_REPEAT_NOTE}`;
  }
  if (!first && sessionsWithServerGuidance.has(sessionId)) {
    return `${result}\n${RESIDUAL_PROCESSES_REPEAT_NOTE}`;
  }
  sessionsWithServerGuidance.add(sessionId);
  return content;
}

/**
 * {@link SERVER_CHECK_NOTE} for a command that waited a fixed time for a
 * program it started, once per session and only when the session has not had
 * the server guidance yet; undefined otherwise. A command still running when
 * it returned (`stillRunning`) gets {@link SERVER_CHECK_RUNNING_NOTE}.
 */
export function serverCheckNoteOncePerSession(
  sessionId: string | undefined,
  command: string,
  stillRunning = false,
): string | undefined {
  if (sessionId === undefined || !waitsFixedTimeForProgram(command)) return undefined;
  if (!firstFor(sessionsWithServerGuidance, sessionId)) return undefined;
  return stillRunning ? SERVER_CHECK_RUNNING_NOTE : SERVER_CHECK_NOTE;
}

/** Model-facing alias only; canonical results and structured facts stay intact. */
export function compactExecExitFooter(content: string): string {
  const note = [
    RESIDUAL_PROCESSES_NOTE,
    RESIDUAL_PROCESSES_NOTE_WITHOUT_SERVER_GUIDANCE,
    RESIDUAL_PROCESSES_REPEAT_NOTE,
    SERVER_CHECK_NOTE,
    SERVER_CHECK_RUNNING_NOTE,
  ].map((text) => `\n${text}`)
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
    if (output.timedOut) footerLines.push("timed_out=true");
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
  // Notes about a running session come before the residue note, which
  // residualNoteOncePerSession and compactExecExitFooter expect last.
  if (output.timeout_backgrounded_ms !== undefined && sessionId !== undefined) {
    sections.push(timeoutBackgroundedNote(output.timeout_backgrounded_ms, sessionId));
  }
  if (output.timeout_stopped_at_session_limit !== undefined) {
    sections.push(timeoutStoppedAtSessionLimitNote(output.timeout_stopped_at_session_limit));
  }
  if (output.process_state !== undefined) sections.push(output.process_state);
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
    if (output.timedOut) result.timed_out = true;
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
  if (output.timeout_backgrounded_ms !== undefined) result.timeout_backgrounded_ms = output.timeout_backgrounded_ms;
  if (output.timeout_stopped_at_session_limit !== undefined) {
    result.timeout_stopped_at_session_limit = output.timeout_stopped_at_session_limit;
  }
  if (output.process_state !== undefined) result.process_state = output.process_state;

  return result;
}
