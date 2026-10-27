import { OLLAMA_WEB_FETCH_URL } from "../gateway-web-search.js";

/** Observed balance debit for a successful /api/web_fetch, 2026-10-21. */
export const OLLAMA_WEB_FETCH_USD_PER_REQUEST = 0.001;
const MAX_BYTES = 4_000_000;
export type OllamaFetchOutcome =
  | { kind: "content"; title: string; content: string; links: string[]; costUsd: number }
  | { kind: "failed"; reason: string; costUsd: number };

/** The caller validates the target URL. Provider credentials only reach Ollama. */
export async function runOllamaWebFetch(options: {
  apiKey: string; url: string; signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch;
}): Promise<OllamaFetchOutcome> {
  let costUsd = 0;
  try {
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 30_000, 120_000)));
    const response = await (options.fetchImpl ?? fetch)(OLLAMA_WEB_FETCH_URL, {
      method: "POST", headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ url: options.url }), redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "failed", reason: `HTTP ${response.status}`, costUsd };
    }
    costUsd = OLLAMA_WEB_FETCH_USD_PER_REQUEST;
    const reader = response.body?.getReader();
    if (!reader) return { kind: "failed", reason: "empty response", costUsd };
    const decoder = new TextDecoder();
    let bytes = 0;
    let raw = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES) return { kind: "failed", reason: "response too large", costUsd };
        raw += decoder.decode(next.value, { stream: true });
      }
      raw += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value?.content !== "string") return { kind: "failed", reason: "missing page content", costUsd };
    return { kind: "content", content: value.content, title: typeof value.title === "string" ? value.title : "",
      links: Array.isArray(value.links) ? value.links.filter((link): link is string => typeof link === "string" && /^https?:\/\//.test(link)).slice(0, 100) : [],
      costUsd };
  } catch {
    options.signal?.throwIfAborted();
    // Never include an upstream body or exception which could echo a credential.
    return { kind: "failed", reason: "request failed", costUsd };
  }
}
