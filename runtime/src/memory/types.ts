/**
 * Memory backend types for @tetsuo-ai/runtime
 *
 * Defines the core interface for pluggable memory storage backends
 * that manage conversation history, task context, and key-value state.
 *
 * @module
 */

import type { Logger } from "../utils/logger.js";
import type { LLMMessage } from "../llm/types.js";
import type { MetricsProvider } from "../task/types.js";

/**
 * Message role in a memory entry
 */
export type MemoryRole = "system" | "user" | "assistant" | "tool";

/**
 * A stored memory entry representing a single message in a conversation thread
 */
export interface MemoryEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MemoryRole;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly timestamp: number;
  readonly taskPda?: string;
  readonly metadata?: Record<string, unknown>;
  /** Context isolation scope — identifies which workspace/project/world this entry belongs to.
   *  Entries from different workspaceIds are never returned in the same retrieval.
   *  Per TODO Phase 2: prevents cross-context memory contamination (EC-1). */
  readonly workspaceId?: string;
  /** Agent identity — distinguishes parent agent from sub-agents.
   *  Format: "parent" or "subagent:{uuid}". */
  readonly agentId?: string;
  /** User identity — for multi-user deployments. */
  readonly userId?: string;
  /** World/environment identity — for sandboxed/virtual world isolation. */
  readonly worldId?: string;
  /** Channel source — "webchat", "voice", "discord", etc. */
  readonly channel?: string;
}

/**
 * Query parameters for filtering memory entries
 */
export interface MemoryQuery {
  sessionId?: string;
  taskPda?: string;
  after?: number;
  before?: number;
  role?: MemoryRole;
  limit?: number;
  /** Sort order by timestamp. Default: 'asc' */
  order?: "asc" | "desc";
  /** Filter by workspace/context scope. */
  workspaceId?: string;
  /** Filter by agent identity. */
  agentId?: string;
  /** Filter by user identity. */
  userId?: string;
  /** Filter by world/environment. */
  worldId?: string;
}

/**
 * Options for adding a new memory entry
 */
export interface AddEntryOptions {
  sessionId: string;
  role: MemoryRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  taskPda?: string;
  metadata?: Record<string, unknown>;
  /** Time-to-live in milliseconds. 0 or undefined = no expiry */
  ttlMs?: number;
  /** Context isolation scope. */
  workspaceId?: string;
  /** Agent identity. */
  agentId?: string;
  /** User identity. */
  userId?: string;
  /** World/environment identity. */
  worldId?: string;
  /** Channel source. */
  channel?: string;
}

/**
 * Scope for durable structured memory that lives outside raw conversation
 * threads.
 */
export type StrategicMemoryScope = "global" | "session" | "run";

/**
 * Categories of structured strategic memory records.
 */
export type StrategicMemoryRecordKind =
  | "goal"
  | "working_note"
  | "execution_summary"
  | "learned_pattern";

/**
 * Common envelope for durable strategic-memory records.
 */
export interface StrategicMemoryRecordEnvelope<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id: string;
  readonly kind: StrategicMemoryRecordKind;
  readonly scope: StrategicMemoryScope;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly data: TData;
}

/**
 * Durability level of a memory backend.
 *
 * - `'none'`  — data lives only in process memory (InMemory)
 * - `'async'` — data is persisted asynchronously (Redis with default AOF)
 * - `'sync'`  — data is persisted synchronously per write (SQLite WAL)
 */
export type DurabilityLevel = "none" | "async" | "sync";

/**
 * Describes the durability guarantees of a memory backend.
 */
export interface DurabilityInfo {
  readonly level: DurabilityLevel;
  readonly supportsFlush: boolean;
  readonly description: string;
}

/**
 * Operational limits and constraints for memory backends.
 */
export const MEMORY_OPERATIONAL_LIMITS = {
  /** InMemory: default max entries per session */
  IN_MEMORY_MAX_ENTRIES_PER_SESSION: 1_000,
  /** InMemory: default max total entries across all sessions */
  IN_MEMORY_MAX_TOTAL_ENTRIES: 100_000,
  /** SQLite: max recommended database size (bytes) before performance degrades */
  SQLITE_MAX_DB_SIZE_BYTES: 10 * 1024 * 1024 * 1024, // 10 GiB
  /** Redis: max recommended entries per sorted set (thread) */
  REDIS_MAX_ENTRIES_PER_THREAD: 1_000_000,
  /** Default TTL for entries (0 = no expiry) */
  DEFAULT_TTL_MS: 0,
  /** AES-256-GCM key size in bytes */
  ENCRYPTION_KEY_SIZE_BYTES: 32,
  /** AES-256-GCM IV size in bytes */
  ENCRYPTION_IV_SIZE_BYTES: 12,
  /** AES-256-GCM auth tag size in bytes */
  ENCRYPTION_AUTH_TAG_SIZE_BYTES: 16,
} as const;

/**
 * Core memory backend interface that all storage implementations provide
 */
export interface MemoryBackend {
  readonly name: string;

  // Thread operations
  addEntry(options: AddEntryOptions): Promise<MemoryEntry>;
  getThread(sessionId: string, limit?: number): Promise<MemoryEntry[]>;
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
  deleteThread(sessionId: string): Promise<number>;
  listSessions(prefix?: string): Promise<string[]>;

  // Key-value operations
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /** Returns the stored value or undefined. Performs an unchecked cast to T. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  listKeys(prefix?: string): Promise<string[]>;

  // Durability
  getDurability(): DurabilityInfo;
  flush(): Promise<void>;

  // Lifecycle
  clear(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
}

/**
 * Versioned transcript event schema version supported by the built-in
 * transcript-capable backends.
 */
export const TRANSCRIPT_EVENT_VERSION = 1 as const;

export type TranscriptEventVersion = typeof TRANSCRIPT_EVENT_VERSION;

export type TranscriptEventKind =
  | "message"
  | "compact_boundary"
  | "metadata_projection"
  | "content_replacement"
  | "context_collapse"
  | "custom";

export interface TranscriptMessagePayload {
  readonly role: MemoryRole;
  readonly content: LLMMessage["content"];
  readonly phase?: LLMMessage["phase"];
  readonly toolCalls?: LLMMessage["toolCalls"];
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface TranscriptCompactBoundaryPayload {
  readonly boundaryId: string;
  readonly source?: string;
  readonly summaryText?: string;
  readonly sourceMessageCount?: number;
  readonly retainedTailCount?: number;
  readonly headEventId?: string;
  readonly anchorEventId?: string;
  readonly tailEventId?: string;
}

export interface TranscriptMetadataProjectionPayload {
  readonly key: string;
  readonly value: unknown;
}

export interface TranscriptContentReplacementPayload {
  readonly replacementId: string;
  readonly target: string;
  readonly value: unknown;
}

export interface TranscriptContextCollapsePayload {
  readonly collapseId: string;
  readonly summary: string;
  readonly detail?: string;
}

export interface TranscriptCustomPayload {
  readonly name: string;
  readonly data?: unknown;
}

export interface TranscriptEventPayloadMap {
  readonly message: TranscriptMessagePayload;
  readonly compact_boundary: TranscriptCompactBoundaryPayload;
  readonly metadata_projection: TranscriptMetadataProjectionPayload;
  readonly content_replacement: TranscriptContentReplacementPayload;
  readonly context_collapse: TranscriptContextCollapsePayload;
  readonly custom: TranscriptCustomPayload;
}

export type TranscriptEventPayload = {
  [K in TranscriptEventKind]: TranscriptEventPayloadMap[K];
}[TranscriptEventKind];

export type TranscriptEvent<
  K extends TranscriptEventKind = TranscriptEventKind,
> = {
  readonly version: TranscriptEventVersion;
  readonly streamId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly kind: K;
  readonly payload: TranscriptEventPayloadMap[K];
  readonly timestamp: number;
  readonly metadata?: Record<string, unknown>;
  readonly dedupeKey?: string;
};

export type TranscriptEventInput<
  K extends TranscriptEventKind = TranscriptEventKind,
> = {
  readonly version?: TranscriptEventVersion;
  readonly eventId: string;
  readonly kind: K;
  readonly payload: TranscriptEventPayloadMap[K];
  readonly timestamp?: number;
  readonly metadata?: Record<string, unknown>;
  readonly dedupeKey?: string;
};

export interface TranscriptLoadOptions {
  readonly afterSeq?: number;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

/**
 * Optional, non-breaking transcript storage capability. Backends that do not
 * implement this continue to satisfy `MemoryBackend`.
 */
export interface TranscriptCapableMemoryBackend {
  appendTranscript(
    streamId: string,
    events: readonly TranscriptEventInput[],
  ): Promise<TranscriptEvent[]>;
  loadTranscript(
    streamId: string,
    options?: TranscriptLoadOptions,
  ): Promise<TranscriptEvent[]>;
  deleteTranscript(streamId: string): Promise<number>;
  listTranscriptStreams(prefix?: string): Promise<string[]>;
}

/**
 * Shared configuration for all memory backends
 */
export interface MemoryBackendConfig {
  logger?: Logger;
  /** Default TTL in milliseconds. 0 = no expiry */
  defaultTtlMs?: number;
  /** Optional metrics provider for instrumentation */
  metrics?: MetricsProvider;
}

// ============================================================================
// LLM Interop Helpers
// ============================================================================

/**
 * Convert a MemoryEntry to an LLMMessage for use with LLM providers
 */
export function entryToMessage(entry: MemoryEntry): LLMMessage {
  const msg: LLMMessage = {
    role: entry.role,
    content: entry.content,
  };
  if (entry.toolCallId) msg.toolCallId = entry.toolCallId;
  if (entry.toolName) msg.toolName = entry.toolName;
  return msg;
}

/**
 * Convert an LLMMessage to AddEntryOptions (caller provides sessionId)
 */
export function messageToEntryOptions(
  msg: LLMMessage,
  sessionId: string,
): Omit<AddEntryOptions, "taskPda" | "metadata" | "ttlMs"> {
  const content =
    typeof msg.content === "string"
      ? msg.content
      : msg.content
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n");
  const opts: Omit<AddEntryOptions, "taskPda" | "metadata" | "ttlMs"> = {
    sessionId,
    role: msg.role,
    content,
  };
  if (msg.toolCallId) (opts as AddEntryOptions).toolCallId = msg.toolCallId;
  if (msg.toolName) (opts as AddEntryOptions).toolName = msg.toolName;
  return opts;
}
