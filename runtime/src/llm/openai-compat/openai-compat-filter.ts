/**
 * Startup validation filter for the openai-compat local LLM provider.
 *
 * Three pure validators run in order during provider construction, before
 * the daemon accepts any requests. All checks are mandatory — there is no
 * config flag to skip them.
 *
 *   1. {@link validateBaseUrl} — confirms the configured baseUrl resolves to
 *      a local or LAN address. Throws a plain Error on public IPs or external
 *      hostnames. Prevents accidental routing of local-model config to an
 *      external service.
 *
 *   2. {@link validateServerReachable} — hits GET {baseUrl}/models with a
 *      5-second timeout. Throws {@link OpenAICompatServerUnreachableError} on
 *      connection failure, timeout, or non-2xx response. Returns the list of
 *      model IDs from the server response on success.
 *
 *   3. {@link validateModelPresent} — confirms the configured model appears
 *      in the list returned by step 2. Throws
 *      {@link OpenAICompatUnknownModelError} if absent. The server's
 *      /v1/models response is the authoritative source of truth — no separate
 *      config field is used.
 *
 * {@link validateOpenAICompatConfig} is the convenience entry point that calls
 * all three in order. This is what the adapter calls on construction.
 *
 * @module
 */

import type { OpenAICompatProviderConfig } from "./types.js";
import {
  OpenAICompatServerUnreachableError,
  OpenAICompatUnknownModelError,
} from "./types.js";

export {
  OpenAICompatServerUnreachableError,
  OpenAICompatUnknownModelError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Section A — baseUrl local-address validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the given hostname is a loopback or RFC-1918 private address,
 * or the literal string "localhost".
 *
 * Accepted ranges:
 *   - localhost
 *   - ::1 (IPv6 loopback)
 *   - 127.0.0.0/8
 *   - 10.0.0.0/8
 *   - 192.168.0.0/16
 *   - 172.16.0.0/12  (172.16.x.x – 172.31.x.x)
 */
function isLocalHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") {
    return true;
  }

  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map(Number);
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }

  const [a, b] = octets;

  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;

  return false;
}

/**
 * Validates that `baseUrl` resolves to a local or LAN address.
 *
 * Throws a plain `Error` if the hostname is a public IP or external domain.
 * The openai-compat provider is intended exclusively for locally-hosted
 * servers — routing it to an external endpoint would expose credentials and
 * bypass the startup model-presence check against the wrong server.
 *
 * @throws {Error} if the hostname is not a recognized local/LAN address.
 */
export function validateBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(
      `openai-compat: baseUrl "${baseUrl}" is not a valid URL. ` +
        `Expected a local address such as "http://127.0.0.1:1234/v1".`,
    );
  }

  const hostname = parsed.hostname;
  if (!isLocalHostname(hostname)) {
    throw new Error(
      `openai-compat: baseUrl hostname "${hostname}" is not a local or LAN address. ` +
        `The openai-compat provider only connects to locally-hosted servers ` +
        `(127.x, 10.x, 192.168.x, 172.16-31.x, localhost). ` +
        `Use provider "grok" or "ollama" for remote endpoints.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Section B — server reachability and model list
// ---------------------------------------------------------------------------

/**
 * Hits GET {baseUrl}/models with a 5-second timeout using native fetch.
 *
 * On success, parses the OpenAI-format response (`data[].id`) and returns
 * the list of available model ID strings.
 *
 * @throws {@link OpenAICompatServerUnreachableError} on connection failure,
 *   AbortError (timeout), or a non-2xx HTTP response.
 */
export async function validateServerReachable(baseUrl: string): Promise<string[]> {
  const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  let response: Response;
  try {
    response = await fetch(modelsUrl, { signal: controller.signal });
  } catch (err: unknown) {
    clearTimeout(timer);
    const isTimeout =
      err instanceof Error && err.name === "AbortError";
    const cause = isTimeout
      ? "request timed out after 5 seconds"
      : err instanceof Error
        ? err.message
        : String(err);
    throw new OpenAICompatServerUnreachableError(baseUrl, cause);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new OpenAICompatServerUnreachableError(
      baseUrl,
      `GET /models returned HTTP ${response.status} ${response.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OpenAICompatServerUnreachableError(
      baseUrl,
      "GET /models response body is not valid JSON",
    );
  }

  const data =
    body !== null &&
    typeof body === "object" &&
    "data" in body &&
    Array.isArray((body as { data: unknown }).data)
      ? (body as { data: Array<{ id?: unknown }> }).data
      : null;

  if (data === null) {
    throw new OpenAICompatServerUnreachableError(
      baseUrl,
      'GET /models response did not contain a "data" array (expected OpenAI /v1/models format)',
    );
  }

  return data
    .map((entry) => (typeof entry.id === "string" ? entry.id : null))
    .filter((id): id is string => id !== null);
}

// ---------------------------------------------------------------------------
// Section C — model presence check
// ---------------------------------------------------------------------------

/**
 * Confirms that `model` appears in `availableModels` (exact string match).
 *
 * The server's /v1/models response is the authoritative source of truth.
 * No config-side alias resolution is performed — the model ID must match
 * exactly as returned by the server.
 *
 * @throws {@link OpenAICompatUnknownModelError} if the model is not found.
 */
export function validateModelPresent(
  model: string,
  availableModels: string[],
  baseUrl: string,
): void {
  if (!availableModels.includes(model)) {
    throw new OpenAICompatUnknownModelError(model, baseUrl);
  }
}

// ---------------------------------------------------------------------------
// Section D — convenience entry point
// ---------------------------------------------------------------------------

/**
 * Runs all three startup validation checks in order for the given config:
 *
 *   1. {@link validateBaseUrl} — local/LAN address check (synchronous)
 *   2. {@link validateServerReachable} — GET /v1/models reachability (async)
 *   3. {@link validateModelPresent} — model presence in server response
 *
 * Called by the adapter on construction before the provider is returned
 * to the daemon. Throws on the first failed check.
 */
export async function validateOpenAICompatConfig(
  config: OpenAICompatProviderConfig,
): Promise<void> {
  validateBaseUrl(config.baseUrl);
  const models = await validateServerReachable(config.baseUrl);
  validateModelPresent(config.model, models, config.baseUrl);
}
