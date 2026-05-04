import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveAgencHome } from "../config/env.js";
import { redactSecrets } from "../secrets/index.js";

export type PermissionAuditEventKind =
  | "rule_change"
  | "user_decision"
  | "policy_outcome";

export type PermissionAuditDecision = "approved" | "denied" | "revoked";

export type PermissionAuditSubjectType =
  | "rule"
  | "tool_request"
  | "tool_execution";

export interface PermissionAuditEventInput {
  readonly eventKind: PermissionAuditEventKind;
  readonly decision: PermissionAuditDecision;
  readonly source: string;
  readonly subjectType: PermissionAuditSubjectType;
  readonly reasonCode?: string;
  readonly toolName?: string;
  readonly requestId?: string;
  readonly callId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly rule?: string;
  readonly destination?: string;
  readonly scope?: string;
  readonly metadata?: PermissionAuditMetadataInput;
}

export type PermissionAuditMetadataInput = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

export interface PermissionAuditRecord extends PermissionAuditEventInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly recordedAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export type PermissionAuditLogger = (
  event: PermissionAuditEventInput,
) => Promise<void> | void;

export type PermissionAuditErrorHandler = (
  error: unknown,
  event: PermissionAuditEventInput,
) => void;

export interface PermissionAuditLogPathOptions {
  readonly agencHome?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PermissionAuditFileLoggerOptions
  extends PermissionAuditLogPathOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

const MAX_AUDIT_FIELD_CHARS = 512;
const MAX_AUDIT_METADATA_KEYS = 16;
const PERMISSION_AUDIT_SCHEMA_VERSION = 1 as const;
const ALLOWED_METADATA_KEYS = new Set([
  "approvalSource",
  "approvalStage",
  "permissionSource",
  "policySource",
  "scope",
  "destination",
]);

class PermissionAuditNonFatalFsError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "PermissionAuditNonFatalFsError";
  }
}

export function resolvePermissionAuditLogPath(
  options: PermissionAuditLogPathOptions = {},
): string {
  return join(
    options.agencHome ?? resolveAgencHome(options.env ?? process.env),
    "audit",
    "permission-audit.jsonl",
  );
}

export function createPermissionAuditFileLogger(
  options: PermissionAuditFileLoggerOptions = {},
): PermissionAuditLogger {
  return async (event) => {
    const path = resolvePermissionAuditLogPath(options);
    const auditDir = dirname(path);
    let nonFatalError: unknown;

    await mkdir(auditDir, { recursive: true, mode: 0o700 });
    try {
      await chmod(auditDir, 0o700);
    } catch (error) {
      nonFatalError = error;
    }

    const record = buildPermissionAuditRecord(event, {
      now: options.now ?? (() => new Date()),
      createId: options.createId ?? randomUUID,
    });
    await appendFile(path, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await chmod(path, 0o600);
    } catch (error) {
      nonFatalError ??= error;
    }

    if (nonFatalError !== undefined) {
      throw new PermissionAuditNonFatalFsError(
        "permission audit log permission repair failed",
        nonFatalError,
      );
    }
  };
}

export async function recordPermissionAuditEvent(
  logger: PermissionAuditLogger | undefined,
  event: PermissionAuditEventInput,
  onError?: PermissionAuditErrorHandler,
): Promise<void> {
  if (logger === undefined) return;
  try {
    await logger(event);
  } catch (error) {
    onError?.(error, event);
  }
}

export function buildPermissionAuditRecord(
  event: PermissionAuditEventInput,
  options: {
    readonly now: () => Date;
    readonly createId: () => string;
  },
): PermissionAuditRecord {
  return dropUndefined({
    schemaVersion: PERMISSION_AUDIT_SCHEMA_VERSION,
    id: sanitizeAuditField(options.createId()),
    recordedAt: options.now().toISOString(),
    eventKind: event.eventKind,
    decision: event.decision,
    source: sanitizeAuditField(event.source),
    subjectType: event.subjectType,
    reasonCode:
      event.reasonCode === undefined
        ? undefined
        : sanitizeAuditField(event.reasonCode),
    toolName:
      event.toolName === undefined ? undefined : sanitizeAuditField(event.toolName),
    requestId:
      event.requestId === undefined
        ? undefined
        : sanitizeAuditField(event.requestId),
    callId:
      event.callId === undefined ? undefined : sanitizeAuditField(event.callId),
    sessionId:
      event.sessionId === undefined
        ? undefined
        : sanitizeAuditField(event.sessionId),
    agentId:
      event.agentId === undefined ? undefined : sanitizeAuditField(event.agentId),
    rule: event.rule === undefined ? undefined : sanitizeAuditField(event.rule),
    destination:
      event.destination === undefined
        ? undefined
        : sanitizeAuditField(event.destination),
    scope:
      event.scope === undefined ? undefined : sanitizeAuditField(event.scope),
    metadata:
      event.metadata === undefined
        ? undefined
        : sanitizePermissionAuditMetadata(event.metadata),
  });
}

function sanitizePermissionAuditMetadata(
  metadata: PermissionAuditMetadataInput,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(out).length >= MAX_AUDIT_METADATA_KEYS) break;
    if (!ALLOWED_METADATA_KEYS.has(key) || value === undefined) continue;
    const safeKey = sanitizeAuditField(key);
    out[safeKey] = typeof value === "string" ? sanitizeAuditField(value) : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeAuditField(value: string): string {
  const redacted = redactSecrets(value).replace(/[\u0000-\u001f\u007f]/g, " ");
  if (redacted.length <= MAX_AUDIT_FIELD_CHARS) return redacted;
  return `${redacted.slice(0, MAX_AUDIT_FIELD_CHARS)}...[truncated]`;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) out[key] = field;
  }
  return out as T;
}
