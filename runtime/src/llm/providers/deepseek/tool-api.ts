/**
 * What DeepSeek's two tool APIs, Search (`POST /v1/tools/search`, behind
 * WebSearch) and Fetch (`POST /v1/tools/fetch`, behind web_fetch), have in
 * common: the on/off switch, where the endpoint lives for a session's chat
 * base URL, and how a failed request is described in the fallback note.
 *
 * @see https://api-docs.deepseek.com/guides/search
 * @module
 */

import { isEnvDefinedFalsy, isEnvTruthy } from "../../../utils/envBoolean.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../../registry/provider-info.js";

/** DeepSeek's own API host, taken from the provider registry. */
const OFFICIAL_DEEPSEEK_API = new URL(BUILT_IN_PROVIDER_BASE_URLS.deepseek);
const ERROR_MESSAGE_MAX_CHARS = 160;

/**
 * `auto`: on for a deepseek session on DeepSeek's own API host (the caller
 * may add conditions); `on`: on for every deepseek session; `off`: never.
 */
export type DeepSeekToolSetting = "auto" | "on" | "off";

/** The session environment value wins over the config.toml value. */
export function resolveDeepSeekToolSetting(
  environmentValue: string | undefined,
  configured: boolean | undefined,
): DeepSeekToolSetting {
  if (isEnvTruthy(environmentValue)) return "on";
  if (isEnvDefinedFalsy(environmentValue)) return "off";
  if (configured === true) return "on";
  if (configured === false) return "off";
  return "auto";
}

export function parseHttpUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function isOfficialDeepSeekApiHost(baseURL: string): boolean {
  const url = parseHttpUrl(baseURL);
  return url?.protocol === "https:" && url.hostname.toLowerCase() === OFFICIAL_DEEPSEEK_API.hostname;
}

export type DeepSeekToolApi = "search" | "fetch";

/**
 * The tool API URL for a DeepSeek chat base URL. The official host always
 * uses the documented endpoint; another host (a proxy the session already
 * sends its key to) keeps its path prefix, so `https://gw.example/deepseek/v1`
 * becomes `https://gw.example/deepseek/v1/tools/fetch`.
 */
export function deepSeekToolEndpoint(
  baseURL: string,
  tool: DeepSeekToolApi,
): string | undefined {
  const url = parseHttpUrl(baseURL);
  if (url === undefined) return undefined;
  if (isOfficialDeepSeekApiHost(baseURL)) {
    return `${OFFICIAL_DEEPSEEK_API.origin}/v1/tools/${tool}`;
  }
  const prefix = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  return `${url.origin}${prefix}/v1/tools/${tool}`;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whitespace collapsed to single spaces; undefined when nothing is left. */
export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  return `${(lastSpace >= max / 2 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

function redact(value: string, secret: string): string {
  return secret.length > 0 ? value.split(secret).join("[redacted]") : value;
}

/** A short reason for the fallback note: status plus DeepSeek's own message. */
export function deepSeekHttpFailureReason(
  status: number,
  body: string,
  apiKey: string,
): string {
  let message: string | undefined;
  try {
    message = text(record(record(JSON.parse(body))?.error)?.message);
  } catch {
    message = undefined;
  }
  const cleaned = message
    ?.replace(/\s*\(request_id:[^)]*\)\s*$/u, "")
    .trim();
  const detail = cleaned ? `: ${clip(redact(cleaned, apiKey), ERROR_MESSAGE_MAX_CHARS)}` : "";
  return `HTTP ${status}${detail}`;
}

/** A transport error, with the key removed in case the message echoes it. */
export function deepSeekRequestFailureReason(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `request failed: ${clip(redact(message, apiKey), ERROR_MESSAGE_MAX_CHARS)}`;
}

export function deepSeekTimeoutReason(timeoutMs: number): string {
  return `timed out after ${timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`}`;
}
