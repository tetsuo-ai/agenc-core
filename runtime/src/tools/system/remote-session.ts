import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import type { Tool, ToolResult } from "../types.js";
import {
  asObject,
  asTrimmedString,
  handleErrorResult,
  handleOkResult,
  isToolResult,
  normalizeHandleIdentity,
  normalizeResourceEnvelope,
  type StructuredHandleResourceEnvelope,
} from "./handle-contract.js";
import { formatDomainBlockReason, isDomainAllowed } from "./http.js";
import type { SystemRemoteSessionToolConfig } from "./types.js";

const SYSTEM_REMOTE_SESSION_FAMILY = "system_remote_session";
const SYSTEM_REMOTE_SESSION_SCHEMA_VERSION = 1;
const SYSTEM_REMOTE_SESSION_ROOT = "/tmp/agenc-system-remote-sessions";
const DEFAULT_POLL_TIMEOUT_MS = 5_000;
const MAX_RECENT_CALLBACK_IDS = 64;
const MAX_REMOTE_SESSION_ARTIFACTS = 32;
const MAX_REMOTE_SESSION_EVENTS = 128;
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);

type SystemRemoteSessionMode = "callback" | "poll";
type SystemRemoteSessionState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
type SystemRemoteSessionRestartPolicy = "manual" | "resume";
type SystemRemoteSessionHttpMethod = "POST" | "PUT" | "PATCH";

interface SystemRemoteSessionArtifact {
  readonly kind: "file" | "url" | "report" | "payload";
  readonly locator: string;
  readonly label?: string;
  readonly source: "callback" | "poll" | "manual" | "send";
  readonly observedAt: number;
}

interface SystemRemoteSessionEvent {
  readonly id: string;
  readonly direction: "outbound" | "inbound" | "lifecycle";
  readonly kind: "message" | "status" | "control" | "artifact";
  readonly summary: string;
  readonly source: "manual" | "callback" | "poll" | "send";
  readonly observedAt: number;
  readonly payload?: Record<string, unknown>;
}

interface SystemRemoteSessionRecord {
  readonly version: number;
  readonly sessionHandleId: string;
  readonly label?: string;
  readonly idempotencyKey?: string;
  readonly serverName: string;
  readonly remoteSessionId: string;
  readonly mode: SystemRemoteSessionMode;
  readonly retryable: boolean;
  readonly restartPolicy: SystemRemoteSessionRestartPolicy;
  readonly callbackPath?: string;
  readonly callbackTokenHash?: string;
  readonly callbackTokenIssuedAt?: number;
  readonly statusUrl?: string;
  readonly stopUrl?: string;
  readonly stopMethod?: "POST" | "DELETE";
  readonly messageUrl?: string;
  readonly messageMethod?: SystemRemoteSessionHttpMethod;
  readonly viewerOnly: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly resourceEnvelope?: StructuredHandleResourceEnvelope;
  readonly createdAt: number;
  readonly startedAt: number;
  updatedAt: number;
  state: SystemRemoteSessionState;
  lastEventAt?: number;
  lastMessageAt?: number;
  endedAt?: number;
  progressSummary?: string;
  lastError?: string;
  lastStatusCode?: number;
  artifacts: SystemRemoteSessionArtifact[];
  events: SystemRemoteSessionEvent[];
  recentCallbackIds: readonly string[];
}

interface PersistedSystemRemoteSessionRegistry {
  readonly version: number;
  readonly sessions: readonly SystemRemoteSessionRecord[];
}

interface PollResult {
  readonly state?: SystemRemoteSessionState;
  readonly progressSummary?: string;
  readonly error?: string;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly remoteSessionId?: string;
  readonly serverName?: string;
  readonly viewerOnly?: boolean;
  readonly events: readonly SystemRemoteSessionEvent[];
  readonly artifacts: readonly SystemRemoteSessionArtifact[];
}

const TERMINAL_REMOTE_SESSION_STATES = new Set<SystemRemoteSessionState>([
  "completed",
  "failed",
  "cancelled",
]);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeState(value: unknown): SystemRemoteSessionState | undefined {
  if (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  const normalized = asTrimmedString(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "queued" || normalized === "accepted") return "pending";
  if (
    normalized === "active" ||
    normalized === "processing" ||
    normalized === "ready" ||
    normalized === "idle" ||
    normalized === "connected"
  ) {
    return "running";
  }
  if (normalized === "complete" || normalized === "done" || normalized === "succeeded") {
    return "completed";
  }
  if (normalized === "error") return "failed";
  if (normalized === "canceled") return "cancelled";
  return undefined;
}

function normalizeMode(value: unknown): SystemRemoteSessionMode | undefined {
  return value === "callback" || value === "poll" ? value : undefined;
}

function normalizeRestartPolicy(
  value: unknown,
): SystemRemoteSessionRestartPolicy | undefined {
  return value === "manual" || value === "resume" ? value : undefined;
}

function normalizeHttpMethod(
  value: unknown,
): SystemRemoteSessionHttpMethod | undefined {
  return value === "POST" || value === "PUT" || value === "PATCH"
    ? value
    : undefined;
}

function parseArtifactArray(
  value: unknown,
  source: SystemRemoteSessionArtifact["source"],
  observedAt: number,
  operation: string,
): readonly SystemRemoteSessionArtifact[] | ToolResult {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return handleErrorResult(
      SYSTEM_REMOTE_SESSION_FAMILY,
      "system_remote_session.invalid_artifacts",
      "artifacts must be an array when provided",
      false,
      undefined,
      operation,
      "validation",
    );
  }
  const artifacts: SystemRemoteSessionArtifact[] = [];
  for (const entry of value) {
    const obj = asObject(entry);
    const locator =
      asTrimmedString(obj?.locator) ??
      asTrimmedString(obj?.path) ??
      asTrimmedString(obj?.url);
    if (!locator) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.invalid_artifacts",
        "each artifact must include locator, path, or url",
        false,
        undefined,
        operation,
        "validation",
      );
    }
    const kindValue = asTrimmedString(obj?.kind)?.toLowerCase();
    const kind =
      kindValue === "file" ||
      kindValue === "url" ||
      kindValue === "report" ||
      kindValue === "payload"
        ? (kindValue as SystemRemoteSessionArtifact["kind"])
        : locator.startsWith("http://") || locator.startsWith("https://")
          ? "url"
          : "file";
    artifacts.push({
      kind,
      locator,
      ...(asTrimmedString(obj?.label) ? { label: asTrimmedString(obj?.label) } : {}),
      source,
      observedAt,
    });
  }
  return artifacts.slice(-MAX_REMOTE_SESSION_ARTIFACTS);
}

function parseSessionEvents(
  value: unknown,
  source: SystemRemoteSessionEvent["source"],
  observedAt: number,
  operation: string,
): readonly SystemRemoteSessionEvent[] | ToolResult {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return handleErrorResult(
      SYSTEM_REMOTE_SESSION_FAMILY,
      "system_remote_session.invalid_events",
      "events must be an array when provided",
      false,
      undefined,
      operation,
      "validation",
    );
  }
  const events: SystemRemoteSessionEvent[] = [];
  for (const entry of value) {
    const obj = asObject(entry);
    const summary =
      asTrimmedString(obj?.summary) ??
      asTrimmedString(obj?.message) ??
      asTrimmedString(obj?.content);
    if (!summary) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.invalid_events",
        "each event must include summary, message, or content",
        false,
        undefined,
        operation,
        "validation",
      );
    }
    const directionValue = asTrimmedString(obj?.direction)?.toLowerCase();
    const direction =
      directionValue === "outbound" ||
      directionValue === "inbound" ||
      directionValue === "lifecycle"
        ? (directionValue as SystemRemoteSessionEvent["direction"])
        : "inbound";
    const kindValue = asTrimmedString(obj?.kind)?.toLowerCase();
    const kind =
      kindValue === "message" ||
      kindValue === "status" ||
      kindValue === "control" ||
      kindValue === "artifact"
        ? (kindValue as SystemRemoteSessionEvent["kind"])
        : "message";
    events.push({
      id:
        asTrimmedString(obj?.id) ??
        `rsevt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      direction,
      kind,
      summary,
      source,
      observedAt:
        typeof obj?.observedAt === "number" && Number.isFinite(obj.observedAt)
          ? obj.observedAt
          : observedAt,
      ...(obj ? { payload: cloneJson(obj) } : {}),
    });
  }
  return events.slice(-MAX_REMOTE_SESSION_EVENTS);
}

function buildSummaryEvent(
  summary: string,
  source: SystemRemoteSessionEvent["source"],
  observedAt: number,
  overrides?: Partial<SystemRemoteSessionEvent>,
): SystemRemoteSessionEvent {
  return {
    id: `rsevt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    direction: "lifecycle",
    kind: "status",
    summary,
    source,
    observedAt,
    ...overrides,
  };
}

function buildRemoteSessionResponse(
  record: SystemRemoteSessionRecord,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sessionHandleId: record.sessionHandleId,
    ...(record.label ? { label: record.label } : {}),
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    serverName: record.serverName,
    remoteSessionId: record.remoteSessionId,
    mode: record.mode,
    state: record.state,
    retryable: record.retryable,
    restartPolicy: record.restartPolicy,
    viewerOnly: record.viewerOnly,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.lastEventAt !== undefined ? { lastEventAt: record.lastEventAt } : {}),
    ...(record.lastMessageAt !== undefined ? { lastMessageAt: record.lastMessageAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.progressSummary ? { progressSummary: record.progressSummary } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.lastStatusCode !== undefined
      ? { lastStatusCode: record.lastStatusCode }
      : {}),
    ...(record.resourceEnvelope ? { resourceEnvelope: record.resourceEnvelope } : {}),
    ...(record.metadata ? { metadata: record.metadata } : {}),
    eventCount: record.events.length,
    artifactCount: record.artifacts.length,
    ...(record.statusUrl ? { statusUrl: record.statusUrl } : {}),
    ...(record.stopUrl ? { stopUrl: record.stopUrl } : {}),
    ...(record.stopMethod ? { stopMethod: record.stopMethod } : {}),
    ...(record.messageUrl
      ? {
        message: {
          url: record.messageUrl,
          method: record.messageMethod ?? "POST",
        },
      }
      : {}),
    ...(record.callbackPath
      ? {
        callback: {
          path: record.callbackPath,
        },
      }
      : {}),
    ...extra,
  };
}

function mergeArtifacts(
  existing: readonly SystemRemoteSessionArtifact[],
  incoming: readonly SystemRemoteSessionArtifact[],
): SystemRemoteSessionArtifact[] {
  const merged = [...existing];
  for (const artifact of incoming) {
    const duplicate = merged.find(
      (entry) => entry.kind === artifact.kind && entry.locator === artifact.locator,
    );
    if (!duplicate) {
      merged.push(artifact);
    }
  }
  return merged.slice(-MAX_REMOTE_SESSION_ARTIFACTS);
}

function mergeEvents(
  existing: readonly SystemRemoteSessionEvent[],
  incoming: readonly SystemRemoteSessionEvent[],
): SystemRemoteSessionEvent[] {
  const merged = [...existing];
  for (const event of incoming) {
    const duplicate = merged.find((entry) => entry.id === event.id);
    if (!duplicate) {
      merged.push(event);
    }
  }
  return merged
    .sort((left, right) => left.observedAt - right.observedAt)
    .slice(-MAX_REMOTE_SESSION_EVENTS);
}

function constantTimeTokenMatches(
  expectedHash: string,
  providedToken: string | undefined,
): boolean {
  if (!providedToken) {
    return false;
  }
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashToken(providedToken), "hex");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

async function parsePollResponse(
  response: Response,
): Promise<PollResult> {
  const text = await response.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    parsed = undefined;
  }

  const observedAt = Date.now();
  const artifacts = parseArtifactArray(parsed?.artifacts, "poll", observedAt, "status");
  const events =
    parseSessionEvents(
      parsed?.events ?? parsed?.messages,
      "poll",
      observedAt,
      "status",
    );
  const normalizedArtifacts = isToolResult(artifacts) ? [] : artifacts;
  const normalizedEvents = isToolResult(events) ? [] : events;
  const progressSummary =
    asTrimmedString(parsed?.summary) ??
    asTrimmedString(parsed?.message) ??
    (text.length > 0 && !parsed ? text.slice(0, 240) : undefined);
  return {
    state:
      normalizeState(parsed?.state) ??
      (response.ok ? "running" : "failed"),
    progressSummary,
    error:
      !response.ok
        ? asTrimmedString(parsed?.error) ?? `Polling failed with HTTP ${response.status}`
        : asTrimmedString(parsed?.error),
    statusCode: response.status,
    retryable:
      typeof parsed?.retryable === "boolean"
        ? parsed.retryable
        : response.status >= 500,
    remoteSessionId:
      asTrimmedString(parsed?.sessionId) ??
      asTrimmedString(parsed?.remoteSessionId),
    serverName: asTrimmedString(parsed?.serverName),
    viewerOnly:
      typeof parsed?.viewerOnly === "boolean" ? parsed.viewerOnly : undefined,
    events:
      progressSummary && normalizedEvents.length === 0
        ? [buildSummaryEvent(progressSummary, "poll", observedAt)]
        : normalizedEvents,
    artifacts: normalizedArtifacts,
  };
}

interface SystemRemoteSessionWebhookInput {
  readonly sessionHandleId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export class SystemRemoteSessionManager {
  private readonly rootDir: string;
  private readonly registryPath: string;
  private readonly callbackBaseUrl?: string;
  private readonly defaultPollTimeoutMs: number;
  private readonly allowedDomains?: readonly string[];
  private readonly blockedDomains?: readonly string[];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly records = new Map<string, SystemRemoteSessionRecord>();
  private loaded = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(config?: SystemRemoteSessionToolConfig) {
    this.rootDir = config?.rootDir ?? SYSTEM_REMOTE_SESSION_ROOT;
    this.registryPath = join(this.rootDir, "registry.json");
    this.callbackBaseUrl = asTrimmedString(config?.callbackBaseUrl);
    this.defaultPollTimeoutMs =
      config?.defaultPollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.allowedDomains = config?.allowedDomains;
    this.blockedDomains = config?.blockedDomains;
    this.logger = config?.logger ?? silentLogger;
    this.now = config?.now ?? (() => Date.now());
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await mkdir(this.rootDir, { recursive: true });
    if (existsSync(this.registryPath)) {
      try {
        const raw = await readFile(this.registryPath, "utf8");
        const parsed = JSON.parse(raw) as PersistedSystemRemoteSessionRegistry;
        for (const record of parsed.sessions ?? []) {
          if (
            record &&
            typeof record.sessionHandleId === "string" &&
            typeof record.serverName === "string" &&
            typeof record.remoteSessionId === "string"
          ) {
            this.records.set(record.sessionHandleId, cloneJson(record));
          }
        }
      } catch (error) {
        this.logger.warn("Failed to load system remote session registry", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedSystemRemoteSessionRegistry = {
      version: SYSTEM_REMOTE_SESSION_SCHEMA_VERSION,
      sessions: [...this.records.values()].map((record) => cloneJson(record)),
    };
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const tempPath = `${this.registryPath}.tmp`;
      await writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(tempPath, this.registryPath);
    });
    await this.persistChain;
  }

  private findByLabel(label: string): SystemRemoteSessionRecord | undefined {
    let best: SystemRemoteSessionRecord | undefined;
    for (const record of this.records.values()) {
      if (record.label !== label) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (
        !TERMINAL_REMOTE_SESSION_STATES.has(record.state) &&
        TERMINAL_REMOTE_SESSION_STATES.has(best.state)
      ) {
        best = record;
        continue;
      }
      if (record.updatedAt > best.updatedAt) {
        best = record;
      }
    }
    return best;
  }

  private findByIdempotencyKey(
    idempotencyKey: string,
  ): SystemRemoteSessionRecord | undefined {
    let best: SystemRemoteSessionRecord | undefined;
    for (const record of this.records.values()) {
      if (record.idempotencyKey !== idempotencyKey) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (
        !TERMINAL_REMOTE_SESSION_STATES.has(record.state) &&
        TERMINAL_REMOTE_SESSION_STATES.has(best.state)
      ) {
        best = record;
        continue;
      }
      if (record.updatedAt > best.updatedAt) {
        best = record;
      }
    }
    return best;
  }

  private async resolveRecord(
    args: Record<string, unknown>,
    operation: string,
  ): Promise<SystemRemoteSessionRecord | ToolResult> {
    await this.ensureLoaded();
    const handleId = asTrimmedString(args.sessionHandleId);
    const identity = normalizeHandleIdentity(
      SYSTEM_REMOTE_SESSION_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const record = handleId
      ? this.records.get(handleId)
      : identity.idempotencyKey
        ? this.findByIdempotencyKey(identity.idempotencyKey)
        : identity.label
          ? this.findByLabel(identity.label)
          : undefined;
    if (!record) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.not_found",
        "Remote session handle not found. Provide sessionHandleId or a previously used label/idempotencyKey.",
        false,
        undefined,
        operation,
        "not_found",
      );
    }
    return record;
  }

  private validateRemoteUrl(
    urlValue: string,
    operation: string,
  ): ToolResult | null {
    let parsed: URL;
    try {
      parsed = new URL(urlValue);
    } catch {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.invalid_url",
        "Remote session URLs must be valid absolute HTTP(S) URLs",
        false,
        undefined,
        operation,
        "validation",
      );
    }
    const protocol = parsed.protocol.replace(":", "");
    if (protocol !== "http" && protocol !== "https") {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.invalid_url",
        "Remote session URLs must use http or https",
        false,
        undefined,
        operation,
        "validation",
      );
    }
    if (LOOPBACK_HOSTS.has(parsed.hostname)) {
      return null;
    }
    const decision = isDomainAllowed(
      urlValue,
      this.allowedDomains,
      this.blockedDomains,
    );
    if (decision.allowed) {
      return null;
    }
    return handleErrorResult(
      SYSTEM_REMOTE_SESSION_FAMILY,
      "system_remote_session.url_blocked",
      formatDomainBlockReason(decision.reason ?? "Blocked remote session URL"),
      false,
      undefined,
      operation,
      "permission_denied",
    );
  }

  private async pollRecord(
    record: SystemRemoteSessionRecord,
  ): Promise<SystemRemoteSessionRecord | ToolResult> {
    if (
      record.mode !== "poll" ||
      !record.statusUrl ||
      TERMINAL_REMOTE_SESSION_STATES.has(record.state)
    ) {
      return record;
    }
    const urlValidation = this.validateRemoteUrl(record.statusUrl, "status");
    if (urlValidation) {
      return urlValidation;
    }
    try {
      const response = await fetch(record.statusUrl, {
        method: "GET",
        signal: AbortSignal.timeout(this.defaultPollTimeoutMs),
      });
      const pollResult = await parsePollResponse(response);
      const now = this.now();
      const nextEvents = mergeEvents(record.events, pollResult.events);
      const nextRecord: SystemRemoteSessionRecord = {
        ...record,
        state: pollResult.state ?? record.state,
        updatedAt: now,
        lastEventAt: now,
        ...(pollResult.progressSummary ? { progressSummary: pollResult.progressSummary } : {}),
        ...(pollResult.error ? { lastError: pollResult.error } : {}),
        ...(pollResult.statusCode !== undefined
          ? { lastStatusCode: pollResult.statusCode }
          : {}),
        ...(pollResult.remoteSessionId
          ? { remoteSessionId: pollResult.remoteSessionId }
          : {}),
        ...(pollResult.serverName ? { serverName: pollResult.serverName } : {}),
        ...(typeof pollResult.viewerOnly === "boolean"
          ? { viewerOnly: pollResult.viewerOnly }
          : {}),
        retryable:
          typeof pollResult.retryable === "boolean"
            ? pollResult.retryable
            : record.retryable,
        artifacts: mergeArtifacts(record.artifacts, pollResult.artifacts),
        events: nextEvents,
        ...(pollResult.state && TERMINAL_REMOTE_SESSION_STATES.has(pollResult.state)
          ? { endedAt: now }
          : {}),
      };
      this.records.set(record.sessionHandleId, nextRecord);
      await this.persist();
      return nextRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextRecord: SystemRemoteSessionRecord = {
        ...record,
        updatedAt: this.now(),
        lastError: `Polling failed: ${message}`,
      };
      this.records.set(record.sessionHandleId, nextRecord);
      await this.persist();
      return nextRecord;
    }
  }

  async start(args: Record<string, unknown>): Promise<ToolResult> {
    await this.ensureLoaded();
    const serverName = asTrimmedString(args.serverName);
    const remoteSessionId =
      asTrimmedString(args.remoteSessionId) ??
      asTrimmedString(args.sessionId);
    if (!serverName) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.invalid_server_name",
        "serverName must be a non-empty string",
        false,
        undefined,
        "start",
        "validation",
      );
    }
    if (!remoteSessionId) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.invalid_remote_session_id",
        "remoteSessionId must be a non-empty string",
        false,
        undefined,
        "start",
        "validation",
      );
    }
    const mode = normalizeMode(args.mode) ?? (args.statusUrl ? "poll" : "callback");
    const restartPolicy = normalizeRestartPolicy(args.restartPolicy) ?? "resume";
    const retryable = typeof args.retryable === "boolean" ? args.retryable : true;
    const viewerOnly = args.viewerOnly === true;
    const identity = normalizeHandleIdentity(
      SYSTEM_REMOTE_SESSION_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const resourceEnvelope = normalizeResourceEnvelope(
      SYSTEM_REMOTE_SESSION_FAMILY,
      args.resourceEnvelope,
      "start",
    );
    if (isToolResult(resourceEnvelope)) {
      return resourceEnvelope;
    }
    const metadata = asObject(args.metadata);
    const statusUrl = asTrimmedString(args.statusUrl);
    const stopUrl = asTrimmedString(args.stopUrl) ?? asTrimmedString(args.cancelUrl);
    const messageUrl = asTrimmedString(args.messageUrl) ?? asTrimmedString(args.sendUrl);
    const messageMethod = normalizeHttpMethod(args.messageMethod) ?? "POST";
    if (statusUrl) {
      const validation = this.validateRemoteUrl(statusUrl, "start");
      if (validation) return validation;
    }
    if (stopUrl) {
      const validation = this.validateRemoteUrl(stopUrl, "start");
      if (validation) return validation;
    }
    if (messageUrl) {
      const validation = this.validateRemoteUrl(messageUrl, "start");
      if (validation) return validation;
    }
    const stopMethod =
      args.stopMethod === "DELETE" || args.stopMethod === "POST"
        ? args.stopMethod
        : undefined;
    const initialArtifacts = parseArtifactArray(
      args.artifacts,
      "manual",
      this.now(),
      "start",
    );
    if (isToolResult(initialArtifacts)) {
      return initialArtifacts;
    }
    const initialEvents = parseSessionEvents(
      args.events,
      "manual",
      this.now(),
      "start",
    );
    if (isToolResult(initialEvents)) {
      return initialEvents;
    }

    const matchesSpec = (record: SystemRemoteSessionRecord): boolean =>
      record.serverName === serverName &&
      record.remoteSessionId === remoteSessionId &&
      record.mode === mode &&
      record.statusUrl === statusUrl &&
      record.stopUrl === stopUrl &&
      record.messageUrl === messageUrl &&
      record.messageMethod === messageMethod &&
      record.viewerOnly === viewerOnly &&
      record.restartPolicy === restartPolicy &&
      JSON.stringify(record.metadata ?? null) === JSON.stringify(metadata ?? null) &&
      JSON.stringify(record.resourceEnvelope ?? null) ===
        JSON.stringify(resourceEnvelope ?? null);

    const idempotentMatch = identity.idempotencyKey
      ? this.findByIdempotencyKey(identity.idempotencyKey)
      : undefined;
    if (idempotentMatch) {
      if (
        matchesSpec(idempotentMatch) &&
        !TERMINAL_REMOTE_SESSION_STATES.has(idempotentMatch.state)
      ) {
        return handleOkResult(buildRemoteSessionResponse(idempotentMatch, {
          reused: true,
        }));
      }
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.idempotency_conflict",
        "A remote session handle already exists for that idempotencyKey.",
        false,
        {
          sessionHandleId: idempotentMatch.sessionHandleId,
          state: idempotentMatch.state,
        },
        "start",
        "idempotency_conflict",
      );
    }

    const labelMatch = identity.label ? this.findByLabel(identity.label) : undefined;
    if (labelMatch) {
      if (
        labelMatch.idempotencyKey === identity.idempotencyKey &&
        matchesSpec(labelMatch) &&
        !TERMINAL_REMOTE_SESSION_STATES.has(labelMatch.state)
      ) {
        return handleOkResult(buildRemoteSessionResponse(labelMatch, {
          reused: true,
        }));
      }
      if (!TERMINAL_REMOTE_SESSION_STATES.has(labelMatch.state)) {
        return handleErrorResult(
          SYSTEM_REMOTE_SESSION_FAMILY,
          "system_remote_session.label_conflict",
          "A remote session handle already exists for that label.",
          false,
          {
            sessionHandleId: labelMatch.sessionHandleId,
            state: labelMatch.state,
          },
          "start",
          "label_conflict",
        );
      }
      this.records.set(labelMatch.sessionHandleId, {
        ...labelMatch,
        label: undefined,
        updatedAt: this.now(),
      });
    }

    const startedAt = this.now();
    const sessionHandleId = `rsess_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const callbackToken = mode === "callback"
      ? randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")
      : undefined;
    const callbackPath =
      mode === "callback"
        ? `/webhooks/remote-session/${sessionHandleId}`
        : undefined;

    const record: SystemRemoteSessionRecord = {
      version: SYSTEM_REMOTE_SESSION_SCHEMA_VERSION,
      sessionHandleId,
      ...(identity.label ? { label: identity.label } : {}),
      ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
      serverName,
      remoteSessionId,
      mode,
      retryable,
      restartPolicy,
      ...(callbackPath ? { callbackPath } : {}),
      ...(callbackToken
        ? {
          callbackTokenHash: hashToken(callbackToken),
          callbackTokenIssuedAt: startedAt,
        }
        : {}),
      ...(statusUrl ? { statusUrl } : {}),
      ...(stopUrl ? { stopUrl } : {}),
      ...(stopMethod ? { stopMethod } : {}),
      ...(messageUrl ? { messageUrl } : {}),
      ...(messageMethod ? { messageMethod } : {}),
      viewerOnly,
      ...(metadata ? { metadata: cloneJson(metadata) } : {}),
      ...(resourceEnvelope ? { resourceEnvelope } : {}),
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt,
      state: "running",
      artifacts: [...initialArtifacts],
      events: [...initialEvents],
      recentCallbackIds: [],
    };
    this.records.set(sessionHandleId, record);
    await this.persist();
    return handleOkResult(
      buildRemoteSessionResponse(record, {
        started: true,
        ...(callbackPath
          ? {
            callback: {
              path: callbackPath,
              ...(this.callbackBaseUrl
                ? { url: `${this.callbackBaseUrl}${callbackPath}` }
                : {}),
              ...(callbackToken
                ? {
                  authToken: callbackToken,
                  authHeader: "Authorization: Bearer <token>",
                }
                : {}),
            },
          }
          : {}),
      }),
    );
  }

  async status(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "status");
    if (isToolResult(record)) return record;
    const refreshed = await this.pollRecord(record);
    if (isToolResult(refreshed)) return refreshed;
    return handleOkResult(buildRemoteSessionResponse(refreshed));
  }

  async resume(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "resume");
    if (isToolResult(record)) return record;
    const refreshed = await this.pollRecord(record);
    if (isToolResult(refreshed)) return refreshed;
    return handleOkResult(buildRemoteSessionResponse(refreshed, {
      resumed: !TERMINAL_REMOTE_SESSION_STATES.has(refreshed.state),
    }));
  }

  async events(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "events");
    if (isToolResult(record)) return record;
    return handleOkResult({
      sessionHandleId: record.sessionHandleId,
      ...(record.label ? { label: record.label } : {}),
      ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
      state: record.state,
      viewerOnly: record.viewerOnly,
      events: record.events,
      artifacts: record.artifacts,
    });
  }

  async send(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "send");
    if (isToolResult(record)) return record;
    if (record.viewerOnly) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.viewer_only",
        "This remote session handle is viewer-only and cannot accept outbound messages.",
        false,
        {
          sessionHandleId: record.sessionHandleId,
        },
        "send",
        "permission_denied",
      );
    }
    if (!record.messageUrl) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.message_channel_missing",
        "This remote session handle does not define a messageUrl.",
        false,
        {
          sessionHandleId: record.sessionHandleId,
        },
        "send",
        "blocked",
      );
    }
    if (TERMINAL_REMOTE_SESSION_STATES.has(record.state)) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.not_running",
        "This remote session handle is already terminal and cannot accept new messages.",
        false,
        {
          sessionHandleId: record.sessionHandleId,
          state: record.state,
        },
        "send",
        "blocked",
      );
    }
    const content =
      asTrimmedString(args.content) ??
      asTrimmedString(args.message) ??
      asTrimmedString(args.input);
    if (!content) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.invalid_message",
        "content must be a non-empty string",
        false,
        undefined,
        "send",
        "validation",
      );
    }
    const urlValidation = this.validateRemoteUrl(record.messageUrl, "send");
    if (urlValidation) {
      return urlValidation;
    }
    const observedAt = this.now();
    const outboundEvent: SystemRemoteSessionEvent = {
      id: `rsevt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      direction: "outbound",
      kind: "message",
      summary: content,
      source: "send",
      observedAt,
      payload: {
        content,
        ...(Array.isArray(args.attachments) ? { attachments: cloneJson(args.attachments) } : {}),
        ...(asObject(args.metadata) ? { metadata: cloneJson(asObject(args.metadata)) } : {}),
      },
    };
    try {
      const response = await fetch(record.messageUrl, {
        method: record.messageMethod ?? "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content,
          ...(Array.isArray(args.attachments) ? { attachments: args.attachments } : {}),
          ...(asObject(args.metadata) ? { metadata: args.metadata } : {}),
          remoteSessionId: record.remoteSessionId,
          sessionHandleId: record.sessionHandleId,
          serverName: record.serverName,
        }),
        signal: AbortSignal.timeout(this.defaultPollTimeoutMs),
      });

      const pollResult = await parsePollResponse(response);
      const nextEvents = mergeEvents(record.events, [
        outboundEvent,
        ...pollResult.events,
      ]);
      const nextRecord: SystemRemoteSessionRecord = {
        ...record,
        state: pollResult.state ?? record.state,
        updatedAt: observedAt,
        lastEventAt: observedAt,
        lastMessageAt: observedAt,
        ...(pollResult.progressSummary ? { progressSummary: pollResult.progressSummary } : {}),
        ...(pollResult.error ? { lastError: pollResult.error } : {}),
        ...(pollResult.statusCode !== undefined
          ? { lastStatusCode: pollResult.statusCode }
          : {}),
        ...(typeof pollResult.viewerOnly === "boolean"
          ? { viewerOnly: pollResult.viewerOnly }
          : {}),
        artifacts: mergeArtifacts(record.artifacts, pollResult.artifacts),
        events: nextEvents,
        ...(pollResult.state && TERMINAL_REMOTE_SESSION_STATES.has(pollResult.state)
          ? { endedAt: observedAt }
          : {}),
      };
      this.records.set(record.sessionHandleId, nextRecord);
      await this.persist();
      return handleOkResult(buildRemoteSessionResponse(nextRecord, {
        delivered: response.ok,
      }));
    } catch (error) {
      return handleErrorResult(
        SYSTEM_REMOTE_SESSION_FAMILY,
        "system_remote_session.send_failed",
        `Remote session send failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
        {
          sessionHandleId: record.sessionHandleId,
        },
        "send",
        "internal",
      );
    }
  }

  async stop(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "stop");
    if (isToolResult(record)) return record;
    if (TERMINAL_REMOTE_SESSION_STATES.has(record.state)) {
      return handleOkResult(buildRemoteSessionResponse(record, {
        stopped: record.state === "cancelled",
        remoteStopIssued: false,
      }));
    }

    let remoteStopIssued = false;
    if (record.stopUrl) {
      const validation = this.validateRemoteUrl(record.stopUrl, "stop");
      if (validation) return validation;
      try {
        const response = await fetch(record.stopUrl, {
          method: record.stopMethod ?? "POST",
          signal: AbortSignal.timeout(this.defaultPollTimeoutMs),
        });
        if (!response.ok) {
          return handleErrorResult(
            SYSTEM_REMOTE_SESSION_FAMILY,
            "system_remote_session.stop_failed",
            `Remote session stop failed with HTTP ${response.status}`,
            true,
            {
              sessionHandleId: record.sessionHandleId,
              status: response.status,
            },
            "stop",
            "stop_failed",
          );
        }
        remoteStopIssued = true;
      } catch (error) {
        return handleErrorResult(
          SYSTEM_REMOTE_SESSION_FAMILY,
          "system_remote_session.stop_failed",
          `Remote session stop failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
          {
            sessionHandleId: record.sessionHandleId,
          },
          "stop",
          "stop_failed",
        );
      }
    }

    const now = this.now();
    const nextRecord: SystemRemoteSessionRecord = {
      ...record,
      state: "cancelled",
      updatedAt: now,
      endedAt: now,
      lastEventAt: now,
      progressSummary: remoteStopIssued
        ? "Remote session stop requested."
        : "Remote session supervision stopped locally.",
      events: mergeEvents(record.events, [
        buildSummaryEvent(
          remoteStopIssued
            ? "Remote session stop requested."
            : "Remote session supervision stopped locally.",
          "manual",
          now,
          {
            kind: "control",
            direction: "lifecycle",
          },
        ),
      ]),
    };
    this.records.set(record.sessionHandleId, nextRecord);
    await this.persist();
    return handleOkResult(buildRemoteSessionResponse(nextRecord, {
      stopped: true,
      remoteStopIssued,
    }));
  }

  async handleWebhook(input: SystemRemoteSessionWebhookInput): Promise<{
    readonly status: number;
    readonly body: Record<string, unknown>;
  }> {
    await this.ensureLoaded();
    const record = this.records.get(input.sessionHandleId);
    if (!record) {
      return {
        status: 404,
        body: {
          error: {
            family: SYSTEM_REMOTE_SESSION_FAMILY,
            code: "system_remote_session.not_found",
            kind: "not_found",
            message: "Remote session handle not found.",
            retryable: false,
            operation: "webhook",
          },
        },
      };
    }
    if (!record.callbackTokenHash) {
      return {
        status: 409,
        body: {
          error: {
            family: SYSTEM_REMOTE_SESSION_FAMILY,
            code: "system_remote_session.webhook_not_enabled",
            kind: "blocked",
            message: "This remote session handle is not configured for callbacks.",
            retryable: false,
            operation: "webhook",
          },
        },
      };
    }
    const authHeader = asTrimmedString(input.headers.authorization);
    const token =
      authHeader?.toLowerCase().startsWith("bearer ")
        ? authHeader.slice("bearer ".length).trim()
        : asTrimmedString(input.headers["x-agenc-webhook-token"]);
    if (!constantTimeTokenMatches(record.callbackTokenHash, token)) {
      return {
        status: 401,
        body: {
          error: {
            family: SYSTEM_REMOTE_SESSION_FAMILY,
            code: "system_remote_session.permission_denied",
            kind: "permission_denied",
            message: "Invalid remote session webhook token.",
            retryable: false,
            operation: "webhook",
          },
        },
      };
    }

    const body = asObject(input.body);
    if (!body) {
      return {
        status: 400,
        body: {
          error: {
            family: SYSTEM_REMOTE_SESSION_FAMILY,
            code: "system_remote_session.invalid_callback",
            kind: "validation",
            message: "Webhook body must be a JSON object.",
            retryable: false,
            operation: "webhook",
          },
        },
      };
    }

    const eventId =
      asTrimmedString(body.eventId) ??
      asTrimmedString(body.callbackId) ??
      asTrimmedString(input.headers["x-agenc-event-id"]);
    if (eventId && record.recentCallbackIds.includes(eventId)) {
      return {
        status: 202,
        body: {
          accepted: true,
          duplicate: true,
          sessionHandleId: record.sessionHandleId,
        },
      };
    }

    const observedAt = this.now();
    const state = normalizeState(body.state) ?? record.state;
    const artifacts = parseArtifactArray(
      body.artifacts,
      "callback",
      observedAt,
      "webhook",
    );
    if (isToolResult(artifacts)) {
      return {
        status: 400,
        body: JSON.parse(artifacts.content) as Record<string, unknown>,
      };
    }
    const events = parseSessionEvents(
      body.events ?? body.messages,
      "callback",
      observedAt,
      "webhook",
    );
    if (isToolResult(events)) {
      return {
        status: 400,
        body: JSON.parse(events.content) as Record<string, unknown>,
      };
    }
    const summary =
      asTrimmedString(body.summary) ??
      asTrimmedString(body.message) ??
      asTrimmedString(body.content);
    const inlineEvent = summary
      ? [buildSummaryEvent(summary, "callback", observedAt)]
      : [];
    const inlineArtifactPath =
      asTrimmedString(body.artifactPath) ??
      asTrimmedString(body.path) ??
      asTrimmedString(body.url);
    const inlineArtifacts = inlineArtifactPath
      ? [{
        kind:
          inlineArtifactPath.startsWith("http://") ||
            inlineArtifactPath.startsWith("https://")
            ? ("url" as const)
            : ("file" as const),
        locator: inlineArtifactPath,
        source: "callback" as const,
        observedAt,
      }]
      : [];
    const recentCallbackIds = eventId
      ? [...record.recentCallbackIds, eventId].slice(-MAX_RECENT_CALLBACK_IDS)
      : record.recentCallbackIds;

    const nextRecord: SystemRemoteSessionRecord = {
      ...record,
      state,
      updatedAt: observedAt,
      lastEventAt: observedAt,
      ...(typeof body.status === "number"
        ? { lastStatusCode: body.status }
        : typeof body.statusCode === "number"
          ? { lastStatusCode: body.statusCode }
          : {}),
      ...(summary ? { progressSummary: summary } : {}),
      ...(asTrimmedString(body.error) ? { lastError: asTrimmedString(body.error) } : {}),
      ...(typeof body.retryable === "boolean" ? { retryable: body.retryable } : {}),
      ...(typeof body.viewerOnly === "boolean" ? { viewerOnly: body.viewerOnly } : {}),
      artifacts: mergeArtifacts(record.artifacts, [...artifacts, ...inlineArtifacts]),
      events: mergeEvents(record.events, [...events, ...inlineEvent]),
      recentCallbackIds,
      ...(TERMINAL_REMOTE_SESSION_STATES.has(state) ? { endedAt: observedAt } : {}),
    };
    this.records.set(record.sessionHandleId, nextRecord);
    await this.persist();
    return {
      status: 202,
      body: {
        accepted: true,
        sessionHandleId: nextRecord.sessionHandleId,
        state: nextRecord.state,
      },
    };
  }

  async resetForTesting(): Promise<void> {
    this.records.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    await rm(this.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  resetForTestingSync(): void {
    this.records.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    rmSync(this.rootDir, { recursive: true, force: true });
  }
}

export function createRemoteSessionTools(
  config?: SystemRemoteSessionToolConfig,
  manager = new SystemRemoteSessionManager(config),
): Tool[] {
  return [
    {
      name: "system.remoteSessionStart",
      description:
        "Register or create a durable handle for an interactive remote session. " +
        "Persists session IDs, callback or polling mode, send/stop endpoints, session metadata, viewer-only policy, and resource envelope.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: { type: "string" },
          remoteSessionId: { type: "string" },
          mode: { type: "string", enum: ["callback", "poll"] },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          viewerOnly: { type: "boolean" },
          statusUrl: { type: "string" },
          stopUrl: { type: "string" },
          stopMethod: { type: "string", enum: ["POST", "DELETE"] },
          messageUrl: { type: "string" },
          messageMethod: { type: "string", enum: ["POST", "PUT", "PATCH"] },
          retryable: { type: "boolean" },
          restartPolicy: { type: "string", enum: ["manual", "resume"] },
          metadata: { type: "object" },
          events: {
            type: "array",
            items: { type: "object" },
          },
          artifacts: {
            type: "array",
            items: { type: "object" },
          },
          resourceEnvelope: {
            type: "object",
            description:
              "Optional resource budget contract: cpu, memoryMb, diskMb, network, wallClockMs, sandboxAffinity, environmentClass, enforcement.",
          },
        },
        required: ["serverName", "remoteSessionId"],
      },
      execute: (args) => manager.start(asObject(args) ?? {}),
    },
    {
      name: "system.remoteSessionStatus",
      description:
        "Inspect a durable remote session handle and optionally refresh it from the configured polling endpoint.",
      inputSchema: {
        type: "object",
        properties: {
          sessionHandleId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.status(asObject(args) ?? {}),
    },
    {
      name: "system.remoteSessionResume",
      description:
        "Reattach to a durable remote session handle after restart and return the latest durable state.",
      inputSchema: {
        type: "object",
        properties: {
          sessionHandleId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.resume(asObject(args) ?? {}),
    },
    {
      name: "system.remoteSessionSend",
      description:
        "Send a message or input payload to a durable interactive remote session handle.",
      inputSchema: {
        type: "object",
        properties: {
          sessionHandleId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          content: { type: "string" },
          attachments: {
            type: "array",
            items: { type: "object" },
          },
          metadata: { type: "object" },
        },
        required: ["content"],
      },
      execute: (args) => manager.send(asObject(args) ?? {}),
    },
    {
      name: "system.remoteSessionStop",
      description:
        "Stop supervision for a durable remote session handle and optionally issue a configured remote stop request.",
      inputSchema: {
        type: "object",
        properties: {
          sessionHandleId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.stop(asObject(args) ?? {}),
    },
    {
      name: "system.remoteSessionEvents",
      description:
        "List durable events and artifacts recorded for a remote session handle.",
      inputSchema: {
        type: "object",
        properties: {
          sessionHandleId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.events(asObject(args) ?? {}),
    },
  ];
}
