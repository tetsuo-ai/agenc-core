import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "./_deps/logger.js";
import { createToolEffectDispositionEvidence } from "../tools/effect-boundary.js";
import type { ToolEffectDispositionEvidence } from "../contracts/run-contracts.js";
import { desktopAuthorityProofIssue, hasDesktopAuthority, type DesktopAuthorityGrant } from "./desktop-authority.js";

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

export function redactMcpAttachmentText(text: string, headers?: Readonly<Record<string, string>>): string {
  let result = text;
  for (const value of Object.values(headers ?? {})) {
    for (const secret of [value, value.replace(/^Bearer\s+/i, "")]) {
      if (secret) result = result.split(secret).join("[REDACTED]");
    }
  }
  return result;
}

export function redactMcpAttachmentValue<T>(value: T, headers?: Readonly<Record<string, string>>, seen = new WeakMap<object, unknown>()): T {
  if (!headers) return value;
  if (typeof value === "string") return redactMcpAttachmentText(value, headers) as T;
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return seen.get(value) as T;
    if (value instanceof Error) {
      // Preserve cleanup-error prototypes/ownership fields, including frozen
      // errors, while keeping the original object untouched.
      const result = Object.create(Object.getPrototypeOf(value)) as Error;
      seen.set(value, result);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        Object.defineProperty(result, key, "value" in descriptor
          ? { ...descriptor, value: redactMcpAttachmentValue(descriptor.value, headers, seen) }
          : descriptor);
      }
      return result as T;
    }
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    for (const [key, item] of Object.entries(value)) Object.defineProperty(result, redactMcpAttachmentText(key, headers), {
      value: redactMcpAttachmentValue(item, headers, seen), enumerable: true, configurable: true, writable: true,
    });
    return result as T;
  }
  return value;
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
  return { debug: level("debug"), info: level("info"), warn: level("warn"), error: level("error") };
}
