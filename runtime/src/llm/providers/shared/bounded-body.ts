/**
 * Bounded reads of a provider tool API's response body (DeepSeek's Search
 * and Fetch APIs, the gateway web searches): a body over the cap is
 * cancelled as soon as it passes it, never buffered whole first.
 *
 * @module
 */

export interface BoundedBody {
  readonly text: string;
  readonly overflow: boolean;
}

/**
 * Read a response body up to `maxBytes`. `signal` ends the read too: a body
 * that stalls after the headers is cancelled when the budget runs out, and
 * the abort reason is thrown.
 */
export async function readBodyBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BoundedBody> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { text: "", overflow: true };
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: await response.text(), overflow: false };
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { text: "", overflow: true };
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return { text, overflow: false };
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
