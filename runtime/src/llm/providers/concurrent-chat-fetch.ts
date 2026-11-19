import type { Dispatcher } from "undici";
import { getUndiciGlobalDispatcher, loadUndiciAgent } from "../undici-dispatcher.js";

/**
 * How long an idle DeepSeek chat connection stays open for the next request.
 *
 * Undici closes an idle connection after 4 s unless the server names a
 * keep-alive time, and DeepSeek names none. A person rarely sends the next
 * message within 4 s, so nearly every turn in the TUI or Desktop first opened a
 * new TCP and TLS connection to api.deepseek.com: 0.5 to 1 s more before the
 * first token (measured from this Mac on 2026-11-19). In the same measurement
 * DeepSeek closed an idle HTTP/1.1 connection itself after about 240 s; a
 * minute covers an ordinary pause between messages and stays well under that.
 */
export const DEEPSEEK_IDLE_CONNECTION_MS = 60_000;

const keepAliveDispatchers = new WeakMap<object, Dispatcher>();

/**
 * True for undici's own default Agent: no connector, TLS, origin or factory
 * setting that a dispatcher of ours would have to repeat. Anything else (a
 * proxy agent, a configured Agent, a test's mock) keeps its own policy.
 */
function isDefaultAgent(dispatcher: Dispatcher): boolean {
  if (dispatcher.constructor?.name !== "Agent") return false;
  const record = dispatcher as unknown as Record<symbol, unknown>;
  const symbols = Object.getOwnPropertySymbols(dispatcher);
  const optionsSymbol = symbols.find((symbol) => symbol.description === "options");
  const factorySymbol = symbols.find((symbol) => symbol.description === "factory");
  const options = optionsSymbol === undefined ? undefined : record[optionsSymbol];
  const factory = factorySymbol === undefined ? undefined : record[factorySymbol];
  if (options === null || typeof options !== "object") return false;
  if (typeof factory !== "function" || factory.name !== "defaultFactory") return false;
  const { maxOrigins, connect, tls, ...rest } = options as Record<string, unknown>;
  return connect == null && tls == null &&
    (maxOrigins == null || maxOrigins === Number.POSITIVE_INFINITY) &&
    Object.values(rest).every((value) => value === undefined);
}

/**
 * Keep a streaming POST from queuing other model requests in Node's H2 pool,
 * and keep the connection between turns.
 */
export function concurrentChatFetch(): typeof fetch {
  const global = getUndiciGlobalDispatcher();
  let dispatcher: Dispatcher;
  if (isDefaultAgent(global)) {
    // The same default policy, with HTTP/1.1 and a longer idle time. One per
    // global dispatcher, so every DeepSeek session shares the warm connection.
    dispatcher = keepAliveDispatchers.get(global) ?? new (loadUndiciAgent())({
      allowH2: false,
      keepAliveTimeout: DEEPSEEK_IDLE_CONNECTION_MS,
    });
    keepAliveDispatchers.set(global, dispatcher);
  } else {
    // Retain the existing dispatcher's proxy/TLS policy. This only changes ALPN
    // for these requests; it neither mutates nor takes ownership of that pool.
    dispatcher = global.compose(
      (dispatch) => (options, handler) => {
        const http1Options = { ...options, allowH2: false };
        return dispatch(http1Options, handler);
      },
    );
  }
  return (input, init) => {
    const options: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher };
    return fetch(input, options);
  };
}
