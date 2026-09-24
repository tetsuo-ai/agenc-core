import { AsyncLocalStorage } from "node:async_hooks";
import { redactLiteralSecrets } from "../utils/redact-literal-secrets.js";
import type { Logger } from "./_deps/logger.js";
import { createToolEffectDispositionEvidence } from "../tools/effect-boundary.js";
import type { ToolEffectDispositionEvidence } from "../contracts/run-contracts.js";
import { desktopAuthorityProofIssue, hasDesktopAuthority, type DesktopAuthorityGrant } from "./desktop-authority.js";
import { isDisplayStructuralValue } from "./display-attachments.js";

/** Runtime-owned turn provenance; never populated from model arguments or metadata. */
const localTurn = new AsyncLocalStorage<{ allowed: boolean; active: boolean }>();
const dispatchGuard = new AsyncLocalStorage<{ check: () => void; sent: boolean }>();
export class DesktopMcpPreflightRefusal extends Error {}
export function withDesktopMcpDispatchGuard<T>(guard: () => void, run: () => Promise<T>): Promise<T> {
  return dispatchGuard.run({ check: guard, sent: false }, run);
}
/** Transport calls this after async socket checks, immediately before fetch. */
export function assertDesktopMcpDispatchGuard(required = false): void {
  const guard = dispatchGuard.getStore();
  if (!guard && required) throw new DesktopMcpPreflightRefusal("Desktop tools require a currently admitted local runtime call.");
  if (guard) {
    try { guard.check(); }
    catch (error) {
      // A later retry/recovery must not claim zero effects after an earlier
      // request may already have reached the host.
      if (guard.sent && error instanceof DesktopMcpPreflightRefusal) throw new Error(error.message);
      throw error;
    }
    guard.sent = true;
  }
}

export function hasLocalMcpAccess(): boolean {
  const lease = localTurn.getStore();
  return lease?.allowed === true && lease.active;
}

export async function withLocalMcpAccess<T>(allowed: boolean, run: () => Promise<T>): Promise<T> {
  const lease = { allowed, active: true };
  try {
    return await localTurn.run(lease, run);
  } finally {
    // Work scheduled by a completed turn must not retain its local authority.
    lease.active = false;
  }
}

/** Validate the new ephemeral HTTP attachment fields without echoing secrets. */
export function sessionMcpAttachmentIssue(config: {
  readonly transport?: string;
  readonly endpoint?: string;
  readonly headers?: unknown;
  readonly localOnly?: unknown;
  readonly desktopAuthority?: unknown;
}): string | undefined {
  const proofIssue = desktopAuthorityProofIssue(config.desktopAuthority);
  if (proofIssue) return proofIssue;
  if (config.desktopAuthority !== undefined && config.localOnly !== true) return "desktopAuthority requires localOnly";
  if (config.localOnly !== undefined && typeof config.localOnly !== "boolean") {
    return "localOnly must be a boolean";
  }
  if (config.headers === undefined && config.localOnly !== true) return undefined;
  if (config.transport !== "http") return "authenticated session attachments require HTTP transport";
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint ?? ""); }
  catch { return "session attachment requires a valid endpoint"; }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    (config.endpoint?.length ?? 0) > 2048
  ) return "session attachment endpoint must be HTTP(S), without credentials, query or fragment";
  if (config.localOnly === true && (
    endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port || endpoint.pathname !== "/mcp"
  )) return "localOnly requires an explicit 127.0.0.1 HTTP port and /mcp path";
  if (typeof config.headers !== "object" || config.headers === null || Array.isArray(config.headers)) {
    return "session attachment headers must be an object";
  }
  const entries = Object.entries(config.headers);
  if (entries.length < 1 || entries.length > 8) return "session attachment requires 1 to 8 headers";
  const names = new Set<string>();
  let bytes = 0;
  for (const [name, value] of entries) {
    const normalized = name.toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) || names.has(normalized) ||
      ["host", "origin", "connection", "content-length", "transfer-encoding", "mcp-session-id"].includes(normalized)) {
      return "session attachment contains an invalid, duplicate or reserved header";
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
      return "session attachment header values must be bounded printable strings";
    }
    names.add(normalized);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (bytes > 8192) return "session attachment headers exceed 8192 bytes";
  if (config.localOnly === true && (
    entries.length !== 1 || entries[0]![0].toLowerCase() !== "authorization" ||
    !/^Bearer [A-Za-z0-9._~-]{32,512}$/.test(String(entries[0]![1]))
  )) return "localOnly requires one bounded Authorization bearer header";
  return undefined;
}

export type McpTextPosition = "payload" | "mime" | "uri" | "prompt-alias" | "content-type" | "role" | "audience" | "encoding";

export function redactMcpAttachmentText(text: string, headers?: Readonly<Record<string, string>>, position: McpTextPosition = "payload", issuedAliases?: ReadonlySet<string>): string {
  const secrets = attachmentSecrets(headers);
  const redact = (value: string) => redactLiteralSecrets(value, secrets);
  if (position === "mime") {
    const separator = text.indexOf(";");
    const routing = (separator < 0 ? text : text.slice(0, separator)).trim();
    // Core routes on type/subtype; parameters remain plugin payload.
    if (ROUTING_MIME_TYPES.has(routing.toLowerCase())) {
      return separator < 0 ? text : text.slice(0, separator + 1) + redact(text.slice(separator + 1));
    }
  }
  if (position === "uri") {
    // A generated alias is an opaque Core identity, while a file URI's path
    // can still contain a saved secret.
    if (issuedAliases?.has(text)) return text;
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*:)([\s\S]*)$/u.exec(text);
    if (scheme?.[1]?.toLowerCase() === "file:") return scheme[1] + redact(scheme[2] ?? "");
  }
  if (position === "prompt-alias" && issuedAliases?.has(text)) return text;
  // Only known wire markers are structure; a matching word in payload text
  // still goes through literal redaction.
  if (position === "content-type" && CONTENT_TYPES.has(text) ||
      position === "role" && (text === "user" || text === "assistant") ||
      position === "audience" && (text === "user" || text === "assistant") ||
      position === "encoding" && ENCODING_MARKERS.has(text)) return text;
  return redact(text);
}

const CONTENT_TYPES = new Set(["text", "image", "audio", "resource", "resource_link"]);
const ENCODING_MARKERS = new Set(["base64", "utf8", "utf-8", "binary", "text"]);

function attachmentSecrets(headers?: Readonly<Record<string, string>>): string[] {
  return [...new Set(Object.values(headers ?? {}).flatMap(value => [value, value.replace(/^Bearer\s+/i, "")]))]
    .filter(secret => secret.length >= 4);
}

const DISPLAY_MIMES = new Set(["application/vnd.agenc.chart+json", "application/vnd.agenc.table+json"]);
const DISPLAY_SCHEMA_KEYS = new Set([
  "version", "kind", "title", "subtitle", "currency", "series", "markers", "categories", "slices",
  "name", "scale", "precision", "type", "data", "time", "value", "open", "high", "low", "close",
  "text", "values", "x", "y", "label", "columns", "rows", "key", "format",
]);
function displaySchemaKey(chart: boolean, path: readonly string[], key: string): boolean {
  if (!DISPLAY_SCHEMA_KEYS.has(key)) return false;
  if (path.length === 0) return chart
    ? ["version", "kind", "title", "subtitle", "currency", "series", "markers", "categories", "slices"].includes(key)
    : ["version", "title", "columns", "rows"].includes(key);
  if (!chart) return path.length === 2 && path[0] === "columns" && path[1] === "*" && ["key", "label", "format"].includes(key);
  if (path.length === 2 && path[1] === "*") {
    if (path[0] === "series") return ["name", "scale", "precision", "type", "data", "values"].includes(key);
    if (path[0] === "markers") return ["time", "text"].includes(key);
    if (path[0] === "slices") return ["label", "value"].includes(key);
  }
  return path.length === 4 && path[0] === "series" && path[1] === "*" && path[2] === "data" && path[3] === "*" &&
    ["time", "value", "open", "high", "low", "close", "x", "y"].includes(key);
}
/** Parse display JSON while its schema is still intact; redact plugin payload leaves. */
function redactDisplayJsonText(text: string, mimeType: string, headers: Readonly<Record<string, string>>): string {
  const displayMime = mimeType.toLowerCase();
  if (!DISPLAY_MIMES.has(displayMime) || Buffer.byteLength(text, "utf8") > 512 * 1024) {
    return redactMcpAttachmentText(text, headers);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return redactMcpAttachmentText(text, headers); }
  const chart = displayMime === "application/vnd.agenc.chart+json";
  const chartKind = chart && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).kind : undefined;
  const walk = (value: unknown, path: readonly string[] = []): unknown => {
    if (path.length > 64) return redactMcpAttachmentText(JSON.stringify(value), headers);
    if (typeof value === "string") {
      const field = path.at(-1);
      if (chart && field !== undefined && isDisplayStructuralValue(path, value, chartKind)) return value;
      return redactMcpAttachmentText(value, headers);
    }
    if (Array.isArray(value)) return value.map(item => walk(item, [...path, "*"]));
    if (typeof value === "number" || typeof value === "boolean") return redactMcpAttachmentValue(value, headers);
    if (value === null || typeof value !== "object") return value;
    const output: Record<string, unknown> = Object.create(null);
    for (const [childKey, child] of Object.entries(value)) {
      const safeKey = displaySchemaKey(chart, path, childKey)
        ? childKey : redactMcpAttachmentText(childKey, headers);
      output[safeKey] = walk(child, [...path, childKey]);
    }
    return output;
  };
  return JSON.stringify(walk(parsed));
}

/**
 * Protects against a non-malicious plugin accidentally disclosing its saved
 * secrets in Core diagnostics, stderr/logs, tool results/errors, progress,
 * resource contents/URIs, and prompt descriptions/messages. Core redacts
 * complete literal values in runtime data keys and values before its own
 * splitting or truncation, and preserves protocol shape. Plugin-declared
 * identifiers and input-schema literal values are outside this boundary, as
 * are copies the plugin itself encodes or splits.
 */
export type McpRedactionShape = "data" | "schema" | "schema-properties" | "tool-result" | "content-list" | "content-block" | "content-source" | "prompt" | "resource" | "annotations" | "annotation-audience";

function redactedDataKey(
  key: string,
  shape: McpRedactionShape,
  headers: Readonly<Record<string, string>>,
  used: Set<string>,
  issuedAliases?: ReadonlySet<string>,
): string {
  // Only runtime data holds dynamic keys. Keys of protocol-shaped objects
  // (prompt, content, resource, schema) are structure and are never renamed,
  // even when a saved secret happens to equal one of them.
  const dataKey = shape === "data" ||
    shape === "tool-result" && !["content", "structuredContent", "_meta", "isError"].includes(key);
  const base = dataKey ? redactMcpAttachmentText(key, headers, "payload", issuedAliases) : key;
  let result = base;
  for (let number = 2; used.has(result); number += 1) result = `${base}#${number}`;
  used.add(result);
  return result;
}

export function redactMcpAttachmentValue<T>(
  value: T,
  headers?: Readonly<Record<string, string>>,
  seen = new WeakMap<object, unknown>(),
  shape: McpRedactionShape = "data",
  position: McpTextPosition = "payload",
  issuedAliases?: ReadonlySet<string>,
): T {
  if (!headers) return value;
  if (typeof value === "string") return redactMcpAttachmentText(value, headers, position, issuedAliases) as T;
  if (typeof value === "number" || typeof value === "boolean") {
    const literal = String(value);
    return Object.values(headers).some(secret => secret.length >= 4 && (secret === literal || secret.replace(/^Bearer\s+/i, "") === literal))
      ? "[REDACTED]" as T : value;
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return seen.get(value) as T;
    if ((shape === "content-block" || shape === "resource") && !Array.isArray(value)) {
      const block = value as Record<string, unknown>;
      const binary = [block.data, block.blob].filter((item): item is string => typeof item === "string");
      const secrets = attachmentSecrets(headers);
      if (binary.some(item => secrets.some(secret => item.includes(secret) || Buffer.from(item, "base64").includes(Buffer.from(secret, "utf8"))))) {
        const omitted: Record<string, unknown> = {};
        seen.set(value, omitted);
        const used = new Set<string>(["omitted"]);
        for (const [key, item] of Object.entries(block)) {
          Object.defineProperty(omitted, redactedDataKey(key, shape, headers, used, issuedAliases), {
            value: key === "data" || key === "blob" ? "" :
              protocolField(key, shape, item) ? item : redactMcpAttachmentValue(item, headers, seen, childShape(shape, key), fieldPosition(shape, key), issuedAliases),
            enumerable: true, configurable: true, writable: true,
          });
        }
        omitted.omitted = true;
        return omitted as T;
      }
    }
    if (value instanceof Error) {
      // Preserve cleanup-error prototypes/ownership fields, including frozen
      // errors, while keeping the original object untouched.
      const result = Object.create(Object.getPrototypeOf(value)) as Error;
      seen.set(value, result);
      const used = new Set<string>(["name", "message", "stack", "cause"]);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        Object.defineProperty(result, ["name", "message", "stack", "cause"].includes(key) ? key : redactedDataKey(key, shape, headers, used, issuedAliases), "value" in descriptor
          ? { ...descriptor, value: protocolField(key, shape, descriptor.value) ? descriptor.value : redactMcpAttachmentValue(descriptor.value, headers, seen, childShape(shape, key), fieldPosition(shape, key), issuedAliases) }
          : descriptor);
      }
      return result as T;
    }
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    const used = new Set<string>();
    for (const [key, item] of Object.entries(value)) Object.defineProperty(result, Array.isArray(value) ? key : redactedDataKey(key, shape, headers, used, issuedAliases), {
      value: shape === "resource" && key === "text" && typeof item === "string" && typeof (value as Record<string, unknown>).mimeType === "string"
        ? redactDisplayJsonText(item, (value as Record<string, string>).mimeType, headers)
        : protocolField(key, shape, item) ? item : redactMcpAttachmentValue(item, headers, seen, Array.isArray(value) && (shape === "content-block" || shape === "resource") ? shape : childShape(shape, key), Array.isArray(value) ? position : fieldPosition(shape, key), issuedAliases), enumerable: true, configurable: true, writable: true,
    });
    return result as T;
  }
  return value;
}

function protocolField(key: string, shape: McpRedactionShape, value: unknown): boolean {
  return shape === "schema" && SCHEMA_CONTROL_FIELDS.has(key) ||
    shape === "schema" && key === "additionalProperties" && typeof value === "boolean" ||
    shape === "tool-result" && key === "isError" ||
    shape === "content-block" && (key === "blob" || key === "data") ||
    shape === "prompt" && key === "required" ||
    shape === "resource" && (key === "truncated" || key === "bytesReturned" || key === "blob") ||
    shape === "annotations" && key === "priority" && typeof value === "number";
}

function fieldPosition(shape: McpRedactionShape, key: string): McpTextPosition {
  if ((shape === "content-block" || shape === "resource") && (key === "mimeType" || key === "mediaType")) return "mime";
  if ((shape === "content-block" || shape === "resource") && key === "uri") return "uri";
  if (shape === "content-block" && key === "type") return "content-type";
  if (shape === "content-source" && key === "type" ||
      (shape === "content-block" || shape === "resource" || shape === "content-source") && key === "encoding") return "encoding";
  if (shape === "prompt" && key === "role") return "role";
  // renderPrompt adds promptName after sanitizing the plugin response.
  if (shape === "prompt" && key === "promptName") return "prompt-alias";
  if (shape === "annotations" && key === "audience") return "audience";
  return "payload";
}

// Core routes or chooses a persisted extension from these MIME types.
const ROUTING_MIME_TYPES = new Set([
  "application/vnd.agenc.chart+json", "application/vnd.agenc.table+json",
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml",
  "application/octet-stream", "text/plain", "text/csv", "text/calendar", "application/pdf", "application/zip",
  "application/json", "text/markdown", "text/html",
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm",
  "video/mp4", "video/webm", "application/msword", "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const SCHEMA_CONTROL_FIELDS = new Set([
  "type", "required", "$ref", "$schema", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties",
]);

function childShape(shape: McpRedactionShape, key: string): McpRedactionShape {
  if (shape === "tool-result") return key === "content" ? "content-list" : "data";
  if (shape === "content-list") return "content-block";
  if (shape === "schema-properties") return "schema";
  if (shape === "schema" && ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key)) return "schema-properties";
  if (shape === "schema") return key === "default" || key === "enum" || key === "const" || key === "examples" ? "data" : "schema";
  if (shape === "prompt") return key === "rawContent" || key === "content" ? "content-block" : "prompt";
  if (shape === "annotations" && key === "audience") return "annotation-audience";
  if ((shape === "content-block" || shape === "resource") && key === "annotations") return "annotations";
  if (shape === "content-block" && key === "resource") return "resource";
  if (shape === "content-block" && key === "source") return "content-source";
  return shape === "resource" && key === "contents" ? "resource" : "data";
}

/** Accept a bound receipt only from the explicitly attached local Desktop endpoint. */
export function desktopControlEffectReceipt(raw: unknown, options: {
  readonly serverName: string;
  readonly toolName: string;
  readonly toolUseId?: string;
  readonly localOnly?: boolean;
  readonly sensitiveHeaders?: Readonly<Record<string, string>>;
  readonly desktopAuthorityGrant?: DesktopAuthorityGrant;
}): ToolEffectDispositionEvidence | undefined {
  if (options.serverName !== "agenc-desktop-control" || options.localOnly !== true ||
    !options.sensitiveHeaders || !options.toolUseId || !hasLocalMcpAccess() ||
    !hasDesktopAuthority(options.desktopAuthorityGrant)) return undefined;
  if (raw === null || typeof raw !== "object") return undefined;
  const meta = (raw as Record<string, unknown>)._meta;
  if (meta === null || typeof meta !== "object") return undefined;
  const receipt = (meta as Record<string, unknown>)["agenc.desktopControl.effect"];
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
  const value = receipt as Record<string, unknown>;
  if (Object.keys(value).some(key => !["version", "toolUseId", "toolName", "disposition", "evidence"].includes(key)) ||
    value.version !== 1 || value.toolUseId !== options.toolUseId || value.toolName !== options.toolName ||
    (value.disposition !== "confirmed_committed" && value.disposition !== "confirmed_no_effect") ||
    typeof value.evidence !== "string" || value.evidence.trim().length === 0 || value.evidence.length > 2048) return undefined;
  const evidence = redactMcpAttachmentText(value.evidence, options.sensitiveHeaders);
  return createToolEffectDispositionEvidence({
    disposition: value.disposition,
    evidenceKind: "provider_receipt",
    evidenceRef: `desktop-mcp:${options.toolUseId}:${options.toolName}`,
    evidenceMaterial: JSON.stringify({ ...value, evidence }),
  });
}

export function attachmentLogger(logger: Logger, headers?: Readonly<Record<string, string>>): Logger {
  if (!headers) return logger;
  const level = (name: keyof Logger) => (message: string, ...args: unknown[]) =>
    logger[name](redactMcpAttachmentText(message, headers), ...args.map(arg => redactMcpAttachmentValue(arg, headers)));
  const wrapped = { debug: level("debug"), info: level("info"), warn: level("warn"), error: level("error") };
  attachmentLoggerSecrets.set(wrapped, attachmentSecrets(headers).map(secret => Buffer.from(secret, "utf8")));
  attachmentLoggerHeaders.set(wrapped, headers);
  return wrapped;
}

const attachmentLoggerSecrets = new WeakMap<Logger, readonly Buffer[]>();
const attachmentLoggerHeaders = new WeakMap<Logger, Readonly<Record<string, string>>>();
export function literalSecretsForAttachmentLogger(logger: Logger): readonly Buffer[] {
  return attachmentLoggerSecrets.get(logger) ?? [];
}
export function redactAttachmentLoggerText(logger: Logger, value: string): string {
  return redactMcpAttachmentText(value, attachmentLoggerHeaders.get(logger));
}
