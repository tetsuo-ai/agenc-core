import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import { getGlobalDispatcher, type Dispatcher } from "undici";

export type DeepSeekProviderConfig = OpenAIProviderConfig;

function concurrentDeepSeekFetch(): typeof fetch {
  // Node's HTTP/2 fetch transport can queue a POST body behind an active SSE
  // response. Force HTTP/1.1 for this provider so the existing dispatcher opens
  // another connection. Keep its proxy/TLS policy and never mutate it globally.
  const dispatcher = getGlobalDispatcher().compose(
    (dispatch) => (options, handler) => {
      const http1Options = { ...options, allowH2: false };
      return dispatch(http1Options, handler);
    },
  );
  return (input, init) => {
    const options: RequestInit & { dispatcher: Dispatcher } = {
      ...init,
      dispatcher,
    };
    return fetch(input, options);
  };
}

export class DeepSeekProvider extends OpenAIProvider {
  constructor(config: DeepSeekProviderConfig) {
    super({
      ...config,
      providerName: "deepseek",
      useResponsesApi: false,
      // Explicit transports remain authoritative; Bun has its own HTTP stack.
      ...(config.fetchImpl || typeof Bun !== "undefined"
        ? {}
        : { fetchImpl: concurrentDeepSeekFetch() }),
    });
  }
}
