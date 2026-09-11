import { getGlobalDispatcher, type Dispatcher } from "undici";

/** Keep a streaming POST from queuing other model requests in Node's H2 pool. */
export function concurrentChatFetch(): typeof fetch {
  // Retain the existing dispatcher's proxy/TLS policy. This only changes ALPN
  // for these requests; it neither mutates nor takes ownership of that pool.
  const dispatcher = getGlobalDispatcher().compose(
    (dispatch) => (options, handler) => {
      const http1Options = { ...options, allowH2: false };
      return dispatch(http1Options, handler);
    },
  );
  return (input, init) => {
    const options: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher };
    return fetch(input, options);
  };
}
