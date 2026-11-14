import { readBodyBounded } from "../shared/bounded-body.js";
import { record } from "./tool-api.js";
import { acquireDeepSeekOcrSlot } from "./tool-rate-limit.js";

export const DEEPSEEK_OCR_MAX_BYTES = 100 * 1024 * 1024;
export const DEEPSEEK_OCR_MAX_PAGES = 1000;
export const DEEPSEEK_OCR_USD_PER_PAGE = 0.000225;
export const DEEPSEEK_OCR_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type DeepSeekOcrOutcome =
  | { kind: "text"; text: string; pageCount: number; incomplete: boolean; costUsd: number }
  | { kind: "failed"; reason: string; costUsd: number | null };

export async function runDeepSeekOcr(request: {
  endpoint: string;
  apiKey: string;
  bytes: Uint8Array;
  filename: string;
  signal?: AbortSignal;
  fetchOptions?: Readonly<Record<string, unknown>>;
}): Promise<DeepSeekOcrOutcome> {
  const failed = (reason: string, costUsd: number | null = 0): DeepSeekOcrOutcome => ({ kind: "failed", reason, costUsd });
  if (!request.bytes.length || request.bytes.length > DEEPSEEK_OCR_MAX_BYTES) {
    return failed("DeepSeek OCR requires a nonempty file of at most 100 MiB.");
  }
  request.signal?.throwIfAborted();
  const release = acquireDeepSeekOcrSlot();
  if (release === undefined) return failed("DeepSeek OCR already has 15 recognitions in progress in this process. Try later.");
  const started = Date.now();
  const timeout = AbortSignal.timeout(DEEPSEEK_OCR_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  let uncertain = false;
  try {
    const form = new FormData();
    // DeepSeek requires purpose before file. Never include extra multipart fields.
    form.append("purpose", "text_recognition");
    form.append("file", new Blob([new Uint8Array(request.bytes)]), request.filename);
    uncertain = true;
    const response = await fetch(request.endpoint, {
      ...(request.fetchOptions ?? {}), method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${request.apiKey}`, accept: "application/json" }, body: form,
    } as RequestInit);
    if (response.status !== 200) {
      await response.body?.cancel();
      uncertain = false;
      return failed(`DeepSeek OCR failed (HTTP ${response.status}).`);
    }
    const raw = await readBodyBounded(response, MAX_RESPONSE_BYTES, signal);
    if (raw.overflow) return failed("DeepSeek OCR response exceeded the 8 MiB local limit; billing is unknown.", null);
    const body = record(JSON.parse(raw.text)); // leading keepalive newlines are valid JSON whitespace
    if (body?.error !== undefined) {
      uncertain = false;
      return failed("DeepSeek OCR could not recognize this file. Check its format, password, and 1,000-page limit.");
    }
    const count = body?.page_count;
    if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > DEEPSEEK_OCR_MAX_PAGES) {
      return failed("DeepSeek OCR returned an invalid page count; billing is unknown.", null);
    }
    const costUsd = (count as number) * DEEPSEEK_OCR_USD_PER_PAGE;
    uncertain = false;
    if (!Array.isArray(body?.pages) || body.pages.length !== count) return failed("DeepSeek OCR returned an incomplete page list.", costUsd);
    const text: string[] = [];
    let incomplete = false;
    for (let index = 0; index < body.pages.length; index++) {
      const page = record(body.pages[index]);
      if (page?.index !== index || typeof page.text !== "string" || !["stop", "length"].includes(String(page.finish_reason))) {
        return failed("DeepSeek OCR returned a malformed page.", costUsd);
      }
      incomplete ||= page.finish_reason === "length";
      text.push(`--- Page ${index + 1} ---\n${page.text}`);
    }
    return { kind: "text", text: text.join("\n\n"), pageCount: count as number, incomplete, costUsd };
  } catch {
    request.signal?.throwIfAborted();
    // Do not expose provider errors, file content, or credentials. Do not retry uploads:
    // a disconnected recognition can still finish and be billed.
    return failed("DeepSeek OCR did not return a usable result; recognition may still complete and be billed. No automatic retry was made.", null);
  } finally {
    if (uncertain) {
      // An abandoned recognition still consumes the account concurrency quota.
      setTimeout(release, Math.max(1, DEEPSEEK_OCR_TIMEOUT_MS - (Date.now() - started))).unref();
    } else release();
  }
}
