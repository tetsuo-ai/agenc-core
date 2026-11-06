/**
 * What a poll or write learns about a session that already exited. The
 * manager remembers how each session it released ended (exit status and the
 * tail of the output it last returned), so a stale poll is answered in plain
 * words instead of `Unknown process id`.
 *
 * @module
 */

import { stripVTControlCharacters } from "node:util";

export interface ExitedSession {
  readonly exitCode: number | null;
  readonly signal?: string | number;
  readonly ownerId?: string;
  /** Tail of the output last returned for the session; absent when it was never read. */
  readonly finalOutput?: string;
}

/** Exited sessions one manager remembers; the oldest is forgotten first. */
export const MAX_EXITED_SESSIONS = 256;

const TAIL_LINES = 20;
const TAIL_CHARS = 2_000;

/** The last lines of an output, bounded, without terminal control sequences. */
export function finalOutputTail(output: string): string {
  const lines = stripVTControlCharacters(output).replace(/\s+$/u, "").split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

/**
 * The answer to a poll (`chars` empty) or a write of an exited session. The
 * text depends only on the session, so repeated polls get the identical
 * result: it is not a failure, so it never feeds the repeat refusal, and a
 * model that keeps polling is still stopped by the behavioral backstop, which
 * trips on identical results. `unreadOutput` is output the call itself
 * collected because no earlier call had read it.
 */
export function exitedSessionMessage(
  sessionId: number,
  session: ExitedSession,
  call: "poll" | "write",
  unreadOutput?: string,
): string {
  const ended = session.exitCode !== null
    ? `already exited with code ${session.exitCode}`
    : session.signal !== undefined
      ? `was already stopped by signal ${session.signal}`
      : "already ended";
  const head = call === "write"
    ? `Session ${sessionId} ${ended}, so the input was not sent. Start a new command if you need to run it again.`
    : `Session ${sessionId} ${ended}. Nothing more will come from it, so there is nothing left to poll.`;
  if (unreadOutput !== undefined) {
    const output = stripVTControlCharacters(unreadOutput).replace(/\s+$/u, "");
    return output === "" ? `${head} It printed nothing more.` : `${head} Its remaining output:\n${output}`;
  }
  if (session.finalOutput === undefined) return `${head} Its output was not kept.`;
  if (session.finalOutput === "") return `${head} Its final output, returned earlier, was empty.`;
  return `${head} Its final output, returned earlier, ended with:\n${session.finalOutput}`;
}
