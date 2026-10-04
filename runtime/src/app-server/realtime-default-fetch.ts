import type { AgenCRealtimeFetch, AgenCRealtimeHttpResponse } from "./realtime-transport.js";

export function defaultRealtimeFetch(): AgenCRealtimeFetch {
  const fetch = globalThis.fetch as
    | undefined
    | ((
        url: string,
        init: {
          readonly method: "POST";
          readonly headers: Readonly<Record<string, string>>;
          readonly body: string;
        },
      ) => Promise<AgenCRealtimeHttpResponse>);
  if (fetch === undefined) {
    throw new Error("global fetch is unavailable for realtime calls");
  }
  return fetch;
}
