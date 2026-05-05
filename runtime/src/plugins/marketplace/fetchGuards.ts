import type { Fetcher, FetchResponse } from "./marketplace.js";

const DEFAULT_ERROR_BODY_MAX_BYTES = 8 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeUrlHostname(hostname);
  return host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^127\./u.test(host);
}

function normalizeUrlHostname(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

export function assertHttpsOrLoopbackUrl(
  rawUrl: string,
  label: string,
  options: {
    readonly allowLoopbackHttp?: boolean;
    readonly allowedHttpsHosts?: readonly string[];
  } = {},
): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "https:") {
    if (
      options.allowedHttpsHosts !== undefined &&
      !options.allowedHttpsHosts.includes(parsed.hostname.toLowerCase())
    ) {
      throw new Error(`${label} host is not allowed: ${parsed.hostname}`);
    }
    return parsed;
  }
  if (parsed.protocol === "http:" && options.allowLoopbackHttp === true && isLoopbackHostname(parsed.hostname)) {
    return parsed;
  }
  throw new Error(`${label} must use HTTPS${options.allowLoopbackHttp === true ? " or loopback HTTP" : ""}`);
}

export async function readResponseTextWithLimit(
  response: Pick<FetchResponse, "body" | "arrayBuffer">,
  maxBytes: number,
  label: string,
): Promise<string> {
  return (await readResponseBytesWithLimit(response, maxBytes, label)).toString("utf8");
}

export async function readResponseErrorText(
  response: Pick<FetchResponse, "body" | "arrayBuffer" | "text">,
  maxBytes = DEFAULT_ERROR_BODY_MAX_BYTES,
): Promise<string> {
  try {
    return await readResponseTextWithLimit(response, maxBytes, "error response body");
  } catch {
    return "";
  }
}

export async function readResponseBytesWithLimit(
  response: Pick<FetchResponse, "body" | "arrayBuffer">,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  if (response.body !== undefined && response.body !== null) {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await cancelReader(reader);
          throw new Error(`${label} exceeded maximum size of ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The stream may already be closed after cancellation.
      }
    }
    return Buffer.concat(chunks, total);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${label} exceeded maximum size of ${maxBytes} bytes`);
  }
  return bytes;
}

export async function fetchWithTimeout(
  fetcher: Fetcher,
  url: string,
  init: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
  options: {
    readonly timeoutMs?: number;
    readonly label?: string;
  } = {},
): Promise<FetchResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    return await fetcher(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${options.label ?? "request"} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function redactUrlForError(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const query = parsed.search.length > 0 ? "?<redacted>" : "";
    const hash = parsed.hash.length > 0 ? "#<redacted>" : "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}${hash}`;
  } catch {
    return rawUrl.replace(/([?&](?:token|key|signature|sig|secret|credential|auth|expires|x-amz-[^=]+)=)[^&\s]+/giu, "$1<redacted>");
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Best effort: the caller is already failing with the size-limit error.
  }
}
