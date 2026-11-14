import type { Dispatcher } from "undici";
import { getUndiciGlobalDispatcher } from "../../undici-dispatcher.js";
import { resolveGeminiThinkingModel } from "../../registry/gemini-thinking-models.js";

type FetchDispatcher = Pick<Dispatcher, "dispatch">;
type DispatchRequestInit = RequestInit & { dispatcher?: FetchDispatcher };

const silentDispatchers = new WeakMap<FetchDispatcher, FetchDispatcher>();

/** Google asks a Gemini 4 client to wait at least this long for a response. */
export const GEMINI_4_SILENCE_LIMIT_MS = 20 * 60_000;

/** A request's own limit is only ever lengthened; 0 already means no limit. */
function silenceLimit(requested: number | null | undefined): number {
  return requested === 0 ? 0 : Math.max(requested ?? 0, GEMINI_4_SILENCE_LIMIT_MS);
}

/**
 * Gemini 4 can think silently for longer than Undici's five-minute header and
 * body inactivity timers, so requests for these reviewed models wait 20
 * minutes instead. The limit stays finite on purpose: a connection that died
 * without a reset would otherwise hold the turn until someone cancelled it.
 * Core's request deadlines, stream watchdog and caller signal still apply.
 * Other models retain the original fetch and all its options unchanged.
 */
export function geminiTransportFetch(
  model: string,
  fetchImpl?: typeof fetch,
): typeof fetch | undefined {
  const registered = resolveGeminiThinkingModel(model)?.model;
  if (registered !== "gemini-4-argon" && registered !== "gemini-4-carbon") return fetchImpl;

  return (input, init) => {
    const base = (init as DispatchRequestInit | undefined)?.dispatcher ?? getUndiciGlobalDispatcher();
    let dispatcher = silentDispatchers.get(base);
    if (dispatcher === undefined) {
      // Delegate to the same pool, including its proxy, TLS and DNS policy.
      // This wrapper owns no sockets and never closes or mutates that pool.
      const dispatch: Dispatcher["dispatch"] = (options, handler) => base.dispatch({
        ...options,
        headersTimeout: silenceLimit(options.headersTimeout),
        bodyTimeout: silenceLimit(options.bodyTimeout),
      }, handler);
      // Fetch also reads dispatcher metadata such as isMockActive. Resolve
      // getters on the original object, as Undici's compose wrapper does.
      dispatcher = new Proxy(base, {
        get: (target, key) => key === "dispatch" ? dispatch : Reflect.get(target, key, target),
      });
      silentDispatchers.set(base, dispatcher);
    }
    const options: DispatchRequestInit = { ...init, dispatcher };
    return (fetchImpl ?? fetch)(input, options);
  };
}
