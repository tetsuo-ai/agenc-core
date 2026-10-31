/**
 * A tool that a code-mode script calls can be refused in a way that must end
 * the turn: a shell tool while unified exec is paused (`execUnavailableStop`).
 * The script only sees a thrown error, which it may catch and retry, and the
 * enclosing `exec` or `wait` result does not carry the nested result's
 * metadata. So the turn host keeps the stop here, per session, and the turn
 * loop ends the turn with it: after each tool batch, where a turn would end,
 * and at the top of each loop iteration (a script that yielded can meet its
 * refusal at any later point of the turn).
 *
 * @module
 */

/** A pending stop and the turn it belongs to. */
interface PendingStop {
  readonly turn: object | undefined;
  readonly explanation: string;
}

const pendingStops = new WeakMap<object, PendingStop>();
/**
 * The turn each session is running now (its code-mode turn host's token).
 * Stops and nested-call results are scoped to it.
 */
const currentTurns = new WeakMap<object, object>();

/** A session's turn starts: stops recorded from now on belong to `turn`. */
export function startCodeModeNestedStopTurn(session: object, turn: object): void {
  currentTurns.set(session, turn);
  pendingStops.delete(session);
}

/** That turn ended: a result that arrives later belongs to no turn. */
export function endCodeModeNestedStopTurn(session: object, turn: object): void {
  if (currentTurns.get(session) === turn) currentTurns.delete(session);
  if (pendingStops.get(session)?.turn === turn) pendingStops.delete(session);
}

/** Whether `turn` is still the session's running turn. */
export function isCurrentCodeModeTurn(session: object, turn: object): boolean {
  return currentTurns.get(session) === turn;
}

/**
 * Keep the first turn-ending stop a nested tool result carried. A result from
 * a turn that is not the session's current one (a nested call that completed
 * after its turn ended) is ignored, so it cannot end a later turn.
 */
export function recordCodeModeNestedStop(
  session: object,
  metadata: Readonly<Record<string, unknown>> | undefined,
  turn?: object,
): void {
  const stop = metadata?.execUnavailableStop;
  if (typeof stop !== "object" || stop === null) return;
  const explanation = (stop as { readonly explanation?: unknown }).explanation;
  if (typeof explanation !== "string" || explanation.length === 0) return;
  if (turn !== undefined && currentTurns.get(session) !== turn) return;
  if (!pendingStops.has(session)) pendingStops.set(session, { turn, explanation });
}

/** The pending stop of the session's current turn, if any. */
function currentStop(session: object): PendingStop | undefined {
  const stop = pendingStops.get(session);
  if (stop === undefined || stop.turn === undefined) return stop;
  return currentTurns.get(session) === stop.turn ? stop : undefined;
}

/** Whether a stop is pending, without taking it. */
export function hasCodeModeNestedStop(session: object): boolean {
  return currentStop(session) !== undefined;
}

/** The pending stop's explanation, once; undefined when there is none. */
export function takeCodeModeNestedStop(session: object): string | undefined {
  const stop = currentStop(session);
  pendingStops.delete(session);
  return stop?.explanation;
}

/** A stop belongs to the turn that saw it; a new turn starts without one. */
export function clearCodeModeNestedStop(session: object): void {
  pendingStops.delete(session);
}
