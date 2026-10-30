/**
 * A tool that a code-mode script calls can be refused in a way that must end
 * the turn: a shell tool while unified exec is paused (`execUnavailableStop`).
 * The script only sees a thrown error, which it may catch and retry, and the
 * enclosing `exec` or `wait` result does not carry the nested result's
 * metadata. So the turn host keeps the stop here, per session, and the turn
 * loop takes it after each tool batch and ends the turn with it.
 *
 * @module
 */

const pendingStops = new WeakMap<object, string>();

/** Keep the first turn-ending stop a nested tool result carried. */
export function recordCodeModeNestedStop(
  session: object,
  metadata: Readonly<Record<string, unknown>> | undefined,
): void {
  const stop = metadata?.execUnavailableStop;
  if (typeof stop !== "object" || stop === null) return;
  const explanation = (stop as { readonly explanation?: unknown }).explanation;
  if (typeof explanation !== "string" || explanation.length === 0) return;
  if (!pendingStops.has(session)) pendingStops.set(session, explanation);
}

/** Whether a stop is pending, without taking it. */
export function hasCodeModeNestedStop(session: object): boolean {
  return pendingStops.has(session);
}

/** The pending stop's explanation, once; undefined when there is none. */
export function takeCodeModeNestedStop(session: object): string | undefined {
  const explanation = pendingStops.get(session);
  pendingStops.delete(session);
  return explanation;
}

/** A stop belongs to the turn that saw it; a new turn starts without one. */
export function clearCodeModeNestedStop(session: object): void {
  pendingStops.delete(session);
}
