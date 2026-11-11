import type { Dispatcher } from "undici";
import { getUndiciGlobalDispatcher } from "./undici-dispatcher.js";

type FetchDispatcher = Pick<Dispatcher, "dispatch">;
type DispatchRequestInit = RequestInit & { dispatcher?: FetchDispatcher };

const silentDispatchers = new WeakMap<FetchDispatcher, FetchDispatcher>();

/** Reviewed reasoning models can remain silent while computing a response. */
export const REASONING_SILENCE_LIMIT_MS = 20 * 60_000;

/** A request's own limit is only ever lengthened; 0 already means no limit. */
function silenceLimit(requested: number | null | undefined): number {
  return requested === 0 ? 0 : Math.max(requested ?? 0, REASONING_SILENCE_LIMIT_MS);
}

/**
 * Lengthen Undici's header and body silence timers for a reviewed model.
 * Delegate to the original pool without owning its sockets or changing its
 * policy. Request deadlines, the stream watchdog and caller signals still
 * apply, and a longer or unbounded dispatch limit stays unchanged.
 */
export function transportSilenceFetch(fetchImpl?: typeof fetch): typeof fetch {
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
