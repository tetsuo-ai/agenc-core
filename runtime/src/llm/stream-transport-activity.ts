import { AsyncLocalStorage } from "node:async_hooks";

// Scope observations to one sampling attempt, even when a provider client is
// shared by concurrent sessions. SDK parsers consume comments and keepalives
// without producing model chunks, so observe the body before parsing it.
const activity = new AsyncLocalStorage<() => void>();

export function withStreamTransportActivity<T>(
  onBytes: () => void,
  execute: () => Promise<T>,
): Promise<T> {
  return activity.run(onBytes, execute);
}

export function observeStreamTransportActivity(response: Response): Response {
  const onBytes = activity.getStore();
  if (!onBytes || !response.body || !response.ok) return response;
  // Headers are also evidence of a live connection. After this point only
  // nonempty body reads refresh liveness, including partial SSE frames.
  onBytes();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= response.body!.getReader();
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          reader.releaseLock();
        } else {
          if (next.value.byteLength > 0) onBytes();
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      if (reader) {
        try { await reader.cancel(reason); }
        finally { reader.releaseLock(); }
      } else {
        await response.body!.cancel(reason);
      }
    },
  }, { highWaterMark: 0 });
  const observed = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const key of ["url", "redirected", "type"] as const) {
    Object.defineProperty(observed, key, { value: response[key] });
  }
  return observed;
}
