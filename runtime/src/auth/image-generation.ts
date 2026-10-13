/** Managed image authority and public metadata. No upstream credential crosses this boundary. */
export const MANAGED_IMAGE_MODEL = "qwen-image-2.1";
export const MANAGED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
// Server waits at most 30 seconds before admission, then bounds the worker leg to 185 seconds.
// Leave room for network/JSON transfer without automatically retrying a POST.
export const MANAGED_IMAGE_TIMEOUT_MS = 240_000;
const MAX_RESPONSE_BYTES = Math.ceil(MANAGED_IMAGE_MAX_BYTES / 3) * 4 + 4096;

export interface AuthImageGenerationAccess {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly model: { readonly id: typeof MANAGED_IMAGE_MODEL; readonly name: string };
  readonly sizes: readonly ["1024x1024"];
  readonly maxImages: 1;
  readonly priceUsd: 0;
  readonly quota: { readonly dailyLimit: number; readonly remaining: number };
  readonly reason?: string;
}

export interface AuthImageGenerationRequest {
  readonly prompt: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface AuthGeneratedImage {
  readonly bytes: Uint8Array;
  readonly model: typeof MANAGED_IMAGE_MODEL;
  readonly requestId: string;
  readonly priceUsd: 0;
}

export class ManagedImageError extends Error {
  constructor(message: string, readonly noEffect: boolean, readonly code: string) {
    super(message);
    this.name = "ManagedImageError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid managed image response");
  return value as Record<string, unknown>;
}

/** Explicit public projection: no server diagnostics, tokens, URLs or identity fields. */
export function parseImageGenerationAccess(value: unknown): AuthImageGenerationAccess {
  const data = record(value), model = record(data.model), quota = record(data.quota);
  if (typeof data.enabled !== "boolean" || typeof data.available !== "boolean" ||
      (data.available && !data.enabled) || model.id !== MANAGED_IMAGE_MODEL ||
      typeof model.name !== "string" || !model.name.trim() || model.name.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(model.name) || data.priceUsd !== 0 || data.maxImages !== 1 ||
      !Array.isArray(data.sizes) || data.sizes.length !== 1 || data.sizes[0] !== "1024x1024" ||
      !Number.isSafeInteger(quota.dailyLimit) || (quota.dailyLimit as number) < 0 ||
      !Number.isSafeInteger(quota.remaining) || (quota.remaining as number) < 0 ||
      (quota.remaining as number) > (quota.dailyLimit as number)) throw new Error("Invalid managed image capability");
  return {
    enabled: data.enabled, available: data.available,
    model: { id: MANAGED_IMAGE_MODEL, name: model.name }, sizes: ["1024x1024"], maxImages: 1, priceUsd: 0,
    quota: { dailyLimit: quota.dailyLimit as number, remaining: quota.remaining as number },
    // Reasons are public codes, never arbitrary upstream messages.
    ...(typeof data.reason === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(data.reason) ? { reason: data.reason } : {}),
  };
}

async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Managed image response exceeds its size limit");
  }
  if (!response.body) throw new Error("Empty managed image response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error("Managed image response exceeds its size limit");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

const MESSAGES: Readonly<Record<string, string>> = {
  image_generation_unavailable: "Free AgenC image generation is temporarily unavailable. Try again later.",
  image_generation_busy: "Free AgenC image generation is busy. Try again later.",
  image_quota_exceeded: "Your daily free image allowance is exhausted. Try again after the quota resets.",
  invalid_request: "The image request was refused. Use one 1024×1024 image and a prompt of at most 4000 characters.",
  idempotency_conflict: "This image request identifier was already used for different inputs.",
  image_generation_in_progress: "This image request is still in progress. Do not start a replacement request.",
  image_generation_outcome_unknown: "The image request outcome could not be confirmed. Do not retry with a new request identifier.",
};

export function createManagedImageClient(options: {
  readonly origin: string;
  readonly getToken: () => Promise<string | undefined>;
  readonly fetchImpl: typeof fetch;
  readonly transport?: RequestInit;
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("Managed images require the configured identity service over HTTPS");
  const request = async (path: string, init: RequestInit, timeoutMs: number, maxBytes: number): Promise<unknown> => {
    const token = await options.getToken();
    if (!token) throw new ManagedImageError("Sign in with AgenC to use free image generation.", true, "authentication_required");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await options.fetchImpl(new URL(path, origin.origin).toString(), {
      ...options.transport, ...init, signal, redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new ManagedImageError("Sign in with AgenC again to use free image generation.", true, "authentication_required");
      }
      let code = "image_generation_failed";
      try {
        const error = record(record(await readJson(response, 32 * 1024, signal)).error);
        if (typeof error.code === "string" && Object.hasOwn(MESSAGES, error.code)) code = error.code;
      } catch { /* Never expose a raw server response. */ }
      const noEffect = init.method === "GET" ||
        (["invalid_request", "idempotency_conflict", "image_generation_busy", "image_quota_exceeded"].includes(code) && response.status >= 400 && response.status < 500);
      throw new ManagedImageError(MESSAGES[code] ?? "AgenC image generation failed. Its outcome could not be confirmed.", noEffect, code);
    }
    return readJson(response, maxBytes, signal);
  };
  return {
    async access(signal?: AbortSignal): Promise<AuthImageGenerationAccess | undefined> {
      signal?.throwIfAborted();
      if (!await options.getToken()) return undefined;
      return parseImageGenerationAccess(await request("/v1/auth/image-generation", { method: "GET", signal }, 30_000, 32 * 1024));
    },
    async generate(input: AuthImageGenerationRequest): Promise<AuthGeneratedImage> {
      input.signal?.throwIfAborted();
      if (!input.prompt.trim() || input.prompt.length > 4000 || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(input.requestId)) {
        throw new ManagedImageError(MESSAGES.invalid_request!, true, "invalid_request");
      }
      const data = record(await request("/v1/images/generations", {
        method: "POST", signal: input.signal, headers: { "Idempotency-Key": input.requestId },
        body: JSON.stringify({ model: MANAGED_IMAGE_MODEL, prompt: input.prompt, n: 1, size: "1024x1024", response_format: "b64_json" }),
      }, MANAGED_IMAGE_TIMEOUT_MS, MAX_RESPONSE_BYTES));
      if (data.model !== MANAGED_IMAGE_MODEL || data.request_id !== input.requestId || data.price_usd !== 0 ||
          !Array.isArray(data.data) || data.data.length !== 1) throw new Error("Invalid managed image result");
      const image = record(data.data[0]);
      if (image.mime_type !== "image/png" || image.url !== undefined || typeof image.b64_json !== "string" ||
          image.b64_json.length > MAX_RESPONSE_BYTES || image.b64_json.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(image.b64_json)) throw new Error("Invalid managed image encoding");
      const bytes = Buffer.from(image.b64_json, "base64");
      if (bytes.length < 45 || bytes.length > MANAGED_IMAGE_MAX_BYTES || bytes.toString("base64") !== image.b64_json ||
          !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
          bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" ||
          bytes.readUInt32BE(16) !== 1024 || bytes.readUInt32BE(20) !== 1024 ||
          !bytes.subarray(-12).equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]))) throw new Error("Managed image must be a 1024×1024 PNG");
      return { bytes, model: MANAGED_IMAGE_MODEL, requestId: input.requestId, priceUsd: 0 };
    },
  };
}
