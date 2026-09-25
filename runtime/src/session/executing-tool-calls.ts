/** Physical tool calls that crossed approval and execution admission. */
interface ExecutingCall {
  readonly signal?: AbortSignal;
  readonly turnAbortController?: AbortController;
}

const executingBySession = new WeakMap<object, Map<string, ExecutingCall>>();

export function beginExecutingToolCall(
  session: object & { activeTurn?: { unsafePeek(): { abortController: AbortController } | null } },
  callId: string,
  signal?: AbortSignal,
): () => void {
  let calls = executingBySession.get(session);
  if (calls === undefined) {
    calls = new Map();
    executingBySession.set(session, calls);
  }
  const turnAbortController = session.activeTurn?.unsafePeek()?.abortController;
  const call: ExecutingCall = {
    ...(signal !== undefined ? { signal } : {}),
    ...(turnAbortController !== undefined ? { turnAbortController } : {}),
  };
  calls.set(callId, call);
  return () => {
    if (calls.get(callId) === call) calls.delete(callId);
  };
}

export function isToolCallPhysicallyExecuting(
  session: object,
  callId: string,
  turnAbortController: AbortController,
): boolean {
  const call = executingBySession.get(session)?.get(callId);
  return call !== undefined &&
    call.turnAbortController === turnAbortController &&
    !turnAbortController.signal.aborted &&
    call.signal?.aborted !== true;
}
