/**
 * RolloutTraceRecorder — best-effort, opt-in hot-path trace recorder.
 *
 * Hand-port of upstream AgenC runtime `AgenC runtime-rs/rollout-trace/src/recorder.rs`
 * (core handle) plus the narrow slice of `writer.rs`, `raw_event.rs`,
 * `bundle.rs`, and `payload.rs` required to land the lifecycle surface.
 *
 * This recorder complements, and does NOT replace, `RolloutStore`
 * (the authoritative rollout event log). Upstream keeps them separate:
 *   - `rollout`            → persistent rollout items (session state source)
 *   - `rollout_trace`      → diagnostic trace bundle (replayable post-mortem)
 *
 * Upstream surface coverage
 * =========================
 *
 * Implemented (WIRED) — methods that match the upstream public recorder surface:
 *   - `disabled()`                              → no-op recorder
 *   - `createRootOrDisabled(threadId)`          → reads env, returns root or disabled
 *   - `createInRootForTest(root, threadId)`     → creates bundle at known root
 *   - `recordThreadStarted(metadata)`           → emits ThreadStarted lifecycle
 *   - `recordAgenC runtimeTurnStarted(threadId, turnId)`→ emits AgenC runtimeTurnStarted lifecycle
 *   - File-backed `TraceWriter` (manifest.json + trace.jsonl + payloads/*.json)
 *   - Raw event envelope + schema versioning
 *
 * Stubbed as no-op, INCOMPLETE vs upstream:
 *   - `codeCellTraceContext(...)`  → always returns a disabled context; upstream
 *     returns a live `CodeCellTraceContext` when enabled. Needs the code-mode
 *     runtime cell lifecycle port before it can record.
 *   - `startToolDispatchTrace(...)` → always returns a disabled context.
 *     Needs the dispatch-level tool invocation/result model.
 *   - `inferenceTraceContext(...)`  → always returns a disabled context.
 *     Needs the inference attempt + request/response payload ports.
 *   - `compactionTraceContext(...)` → always returns a disabled context.
 *     Needs the remote-compaction checkpoint port.
 *   - Reducer (`replay_bundle`)     → not ported. Replay / reduced-state
 *     projection lives in a separate tranche.
 *
 * Not ported (honest INCOMPLETE flags):
 *   - Upstream emits `RolloutEnded`, `ThreadEnded`, and `AgenC runtimeTurnEnded` raw
 *     events from context-destruction and reducer paths, not from standalone
 *     `record_*` methods on the recorder. Those paths (runtime cells, tool
 *     dispatch, inference, compaction) land in future tranches; the raw event
 *     variants for them have not been defined yet and will appear when the
 *     producing subsystems are ported.
 *   - The `start_code_cell_trace` convenience wrapper is not ported because
 *     its child context does not have a working lifecycle yet.
 *
 * The stubbed context factories preserve call-site shape so downstream code can
 * call them unconditionally without branching on whether diagnostic recording
 * is enabled, matching upstream's no-op-capable design. They simply never land
 * an event until their respective ports complete.
 *
 * @module
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Environment + schema constants
// ---------------------------------------------------------------------------

/**
 * Environment variable that enables local trace-bundle recording.
 *
 * When set to a directory, each independent root session gets one child
 * bundle under that root.
 * When unset, `createRootOrDisabled` returns a disabled recorder that
 * accepts every call and records nothing.
 */
export const AGENC_ROLLOUT_TRACE_ROOT_ENV = "AGENC_ROLLOUT_TRACE_ROOT";

/** Current raw event envelope schema version. Matches upstream. */
export const RAW_TRACE_EVENT_SCHEMA_VERSION = 1;

/** Trace manifest schema version. Matches upstream. */
export const TRACE_MANIFEST_SCHEMA_VERSION = 1;

const MANIFEST_FILE_NAME = "manifest.json";
const RAW_EVENT_LOG_FILE_NAME = "trace.jsonl";
const PAYLOADS_DIR_NAME = "payloads";

// ---------------------------------------------------------------------------
// Type primitives (narrow mirror of upstream `model/*.rs`)
// ---------------------------------------------------------------------------

/** Upstream `AgentThreadId`. Kept as a bare string here. */
export type AgentThreadId = string;

/** Upstream `AgenC runtimeTurnId`. Kept as a bare string here. */
export type AgenCTurnId = string;

/** Upstream `CompactionId`. Kept as a bare string here. */
export type CompactionId = string;

// ---------------------------------------------------------------------------
// Raw payload + event envelope (narrow mirror of upstream `raw_event.rs`)
// ---------------------------------------------------------------------------

/** Upstream `RawPayloadKind` — coarse role for out-of-band payload files. */
export type RawPayloadKind =
  | "inference_request"
  | "inference_response"
  | "compaction_request"
  | "compaction_checkpoint"
  | "compaction_response"
  | "tool_invocation"
  | "tool_result"
  | "tool_runtime_event"
  | "terminal_runtime_event"
  | "protocol_event"
  | "session_metadata"
  | "agent_result";

/** Upstream `RawPayloadRef`. Bundle-relative reference to a payload file. */
export interface RawPayloadRef {
  readonly rawPayloadId: string;
  readonly kind: RawPayloadKind;
  /** Path relative to the bundle root (always written as a bundle-local file). */
  readonly path: string;
}

/** Event envelope context supplied by producers. */
export interface RawTraceEventContext {
  readonly threadId?: AgentThreadId;
  readonly agencTurnId?: AgenCTurnId;
}

/**
 * Narrow subset of upstream `RawTraceEventPayload`.
 *
 * Only the lifecycle variants actually emitted by the ported recorder surface
 * appear here. Additional variants (inference, tool-dispatch, code-cell,
 * compaction, agent-result, protocol-event, rollout/thread/turn-ended) remain
 * in upstream and will be mirrored as each subsystem port lands.
 */
export type RawTraceEventPayload =
  | {
      readonly type: "rollout_started";
      readonly traceId: string;
      readonly rootThreadId: AgentThreadId;
    }
  | {
      readonly type: "thread_started";
      readonly threadId: AgentThreadId;
      readonly agentPath: string;
      readonly metadataPayload?: RawPayloadRef;
    }
  | {
      readonly type: "agenc_turn_started";
      readonly agencTurnId: AgenCTurnId;
      readonly threadId: AgentThreadId;
    };

/** Upstream `RawTraceEvent`. */
export interface RawTraceEvent {
  readonly schemaVersion: number;
  readonly seq: number;
  readonly wallTimeUnixMs: number;
  readonly rolloutId: string;
  readonly threadId?: AgentThreadId;
  readonly agencTurnId?: AgenCTurnId;
  readonly payload: RawTraceEventPayload;
}

// ---------------------------------------------------------------------------
// Thread-started metadata (narrow mirror of upstream `ThreadStartedTraceMetadata`)
// ---------------------------------------------------------------------------

/**
 * Metadata captured once at thread/session start.
 *
 * Mirrors upstream `ThreadStartedTraceMetadata` with fields relaxed to
 * `string | undefined` because `SessionSource` and other structured types
 * are not ported yet in the gut branch.
 */
export interface ThreadStartedTraceMetadata {
  readonly threadId: string;
  readonly agentPath: string;
  readonly taskName?: string;
  readonly nickname?: string;
  readonly agentRole?: string;
  /** Stringified session-source tag (upstream uses `SessionSource`). */
  readonly sessionSource?: string;
  readonly cwd: string;
  readonly rolloutPath?: string;
  readonly model: string;
  readonly providerName: string;
  readonly approvalPolicy?: string;
  readonly sandboxPolicy?: string;
}

// ---------------------------------------------------------------------------
// Bundle manifest
// ---------------------------------------------------------------------------

interface TraceBundleManifest {
  readonly schemaVersion: number;
  readonly traceId: string;
  readonly rolloutId: string;
  readonly rootThreadId: AgentThreadId;
  readonly startedAtUnixMs: number;
  readonly rawEventLog: string;
  readonly payloadsDir: string;
}

function buildManifest(
  traceId: string,
  rolloutId: string,
  rootThreadId: AgentThreadId,
  startedAtUnixMs: number,
): TraceBundleManifest {
  return {
    schemaVersion: TRACE_MANIFEST_SCHEMA_VERSION,
    traceId,
    rolloutId,
    rootThreadId,
    startedAtUnixMs,
    rawEventLog: RAW_EVENT_LOG_FILE_NAME,
    payloadsDir: PAYLOADS_DIR_NAME,
  };
}

// ---------------------------------------------------------------------------
// TraceWriter — file-backed append-only writer
// ---------------------------------------------------------------------------

/**
 * Append-only trace bundle writer.
 *
 * Mirrors upstream `TraceWriter`:
 *   - writes `manifest.json`
 *   - opens `trace.jsonl` append-only
 *   - creates `payloads/<ordinal>.json` when asked for a payload ref
 *   - assigns monotonic `seq` per event and `ordinal` per payload
 *
 * Errors from the underlying filesystem are thrown to the caller. The
 * recorder above layers "best-effort" semantics on top.
 */
export class TraceWriter {
  private readonly manifest: TraceBundleManifest;
  private readonly bundleDir: string;
  private readonly payloadsDir: string;
  private readonly eventLogFd: number;
  private nextSeq = 1;
  private nextPayloadOrdinal = 1;
  private closed = false;

  private constructor(
    manifest: TraceBundleManifest,
    bundleDir: string,
    payloadsDir: string,
    eventLogFd: number,
  ) {
    this.manifest = manifest;
    this.bundleDir = bundleDir;
    this.payloadsDir = payloadsDir;
    this.eventLogFd = eventLogFd;
  }

  static create(opts: {
    readonly bundleDir: string;
    readonly traceId: string;
    readonly rolloutId: string;
    readonly rootThreadId: AgentThreadId;
  }): TraceWriter {
    const { bundleDir, traceId, rolloutId, rootThreadId } = opts;
    const payloadsDir = join(bundleDir, PAYLOADS_DIR_NAME);
    mkdirSync(payloadsDir, { recursive: true });

    const startedAtUnixMs = Date.now();
    const manifest = buildManifest(
      traceId,
      rolloutId,
      rootThreadId,
      startedAtUnixMs,
    );
    const manifestPath = join(bundleDir, MANIFEST_FILE_NAME);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const eventLogPath = join(bundleDir, RAW_EVENT_LOG_FILE_NAME);
    const fd = openSync(eventLogPath, "a");

    return new TraceWriter(manifest, bundleDir, payloadsDir, fd);
  }

  get rolloutId(): string {
    return this.manifest.rolloutId;
  }

  get path(): string {
    return this.bundleDir;
  }

  /**
   * Writes a JSON payload file and returns its reference. Payload files
   * are materialised BEFORE the event that references them, matching
   * upstream ordering guarantees (a replay interrupted after an event is
   * appended must never see a dangling ref).
   */
  writeJsonPayload(kind: RawPayloadKind, value: unknown): RawPayloadRef {
    this.ensureOpen();
    const ordinal = this.nextPayloadOrdinal++;
    const rawPayloadId = `raw_payload:${ordinal}`;
    const relativePath = `${PAYLOADS_DIR_NAME}/${ordinal}.json`;
    const absolutePath = join(this.payloadsDir, `${ordinal}.json`);
    writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return { rawPayloadId, kind, path: relativePath };
  }

  /** Appends one raw event with no extra envelope context. */
  append(payload: RawTraceEventPayload): RawTraceEvent {
    return this.appendWithContext({}, payload);
  }

  /** Appends one raw event with explicit thread/turn context. */
  appendWithContext(
    context: RawTraceEventContext,
    payload: RawTraceEventPayload,
  ): RawTraceEvent {
    this.ensureOpen();
    const event: RawTraceEvent = {
      schemaVersion: RAW_TRACE_EVENT_SCHEMA_VERSION,
      seq: this.nextSeq++,
      wallTimeUnixMs: Date.now(),
      rolloutId: this.manifest.rolloutId,
      ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
      ...(context.agencTurnId !== undefined
        ? { agencTurnId: context.agencTurnId }
        : {}),
      payload,
    };
    const line = `${JSON.stringify(event)}\n`;
    writeSync(this.eventLogFd, line);
    return event;
  }

  /** Flush buffered data to disk. */
  flush(): void {
    if (this.closed) return;
    fsyncSync(this.eventLogFd);
  }

  /** Close the underlying event-log file handle. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fsyncSync(this.eventLogFd);
    } catch {
      // fsync best-effort; diagnostic writer must not throw on close.
    }
    closeSync(this.eventLogFd);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("TraceWriter is closed");
    }
  }
}

// ---------------------------------------------------------------------------
// No-op context stubs
// ---------------------------------------------------------------------------

/**
 * Disabled-only stub for upstream `CodeCellTraceContext`.
 *
 * Upstream exposes a rich lifecycle: `recordInitialResponse`, `recordEnded`,
 * nested tool dispatch start, etc. Those require the code-mode runtime-cell
 * port to land first. This stub keeps the recorder's factory shape usable.
 */
export interface CodeCellTraceContext {
  readonly enabled: boolean;
  /** Stub: no-op until the code-cell lifecycle port lands. */
  recordEnded(status: string): void;
}

/** Disabled-only stub for upstream `ToolDispatchTraceContext`. */
export interface ToolDispatchTraceContext {
  readonly enabled: boolean;
  /** Stub: no-op until the tool-dispatch payload port lands. */
  recordResult(status: string): void;
}

/** Disabled-only stub for upstream `InferenceTraceContext`. */
export interface InferenceTraceContext {
  readonly enabled: boolean;
  /** Stub: no-op until the inference attempt port lands. */
  startAttempt(): void;
}

/** Disabled-only stub for upstream `CompactionTraceContext`. */
export interface CompactionTraceContext {
  readonly enabled: boolean;
  /** Stub: no-op until the remote-compaction checkpoint port lands. */
  recordInstalled(): void;
}

const DISABLED_CODE_CELL_CONTEXT: CodeCellTraceContext = Object.freeze({
  enabled: false,
  recordEnded: () => {},
});

const DISABLED_TOOL_DISPATCH_CONTEXT: ToolDispatchTraceContext = Object.freeze({
  enabled: false,
  recordResult: () => {},
});

const DISABLED_INFERENCE_CONTEXT: InferenceTraceContext = Object.freeze({
  enabled: false,
  startAttempt: () => {},
});

const DISABLED_COMPACTION_CONTEXT: CompactionTraceContext = Object.freeze({
  enabled: false,
  recordInstalled: () => {},
});

// ---------------------------------------------------------------------------
// RolloutTraceRecorder — session-scoped handle
// ---------------------------------------------------------------------------

/**
 * Lightweight session-scoped handle stored in `SessionServices`.
 *
 * Disabled handles intentionally accept the same calls as enabled handles
 * so hot-path session code can describe traceable events without repeatedly
 * branching on whether diagnostic recording is live. Mirrors upstream.
 */
export class RolloutTraceRecorder {
  private readonly writer: TraceWriter | undefined;

  private constructor(writer: TraceWriter | undefined) {
    this.writer = writer;
  }

  /** Builds a recorder handle that accepts trace calls and records nothing. */
  static disabled(): RolloutTraceRecorder {
    return new RolloutTraceRecorder(undefined);
  }

  /**
   * Creates and starts a root trace bundle, or returns a disabled recorder.
   *
   * Trace startup is best-effort: a failure here must not make the session
   * unusable. Mirrors upstream `create_root_or_disabled`.
   */
  static createRootOrDisabled(threadId: string): RolloutTraceRecorder {
    const root = process.env[AGENC_ROLLOUT_TRACE_ROOT_ENV];
    if (!root) return RolloutTraceRecorder.disabled();
    try {
      return RolloutTraceRecorder.createInRoot(root, threadId);
    } catch {
      return RolloutTraceRecorder.disabled();
    }
  }

  /**
   * Creates a trace bundle in a known root directory.
   *
   * Public so integration tests can replay the exact bundle they produced
   * without mutating process environment (mirrors upstream
   * `create_in_root_for_test`).
   */
  static createInRootForTest(
    root: string,
    threadId: string,
  ): RolloutTraceRecorder {
    return RolloutTraceRecorder.createInRoot(root, threadId);
  }

  private static createInRoot(
    root: string,
    threadId: string,
  ): RolloutTraceRecorder {
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
    }
    const traceId = randomUUID();
    const bundleDir = join(root, `trace-${traceId}-${threadId}`);
    mkdirSync(bundleDir, { recursive: true });
    const writer = TraceWriter.create({
      bundleDir,
      traceId,
      rolloutId: threadId,
      rootThreadId: threadId,
    });
    const recorder = new RolloutTraceRecorder(writer);
    recorder.appendBestEffort({
      type: "rollout_started",
      traceId,
      rootThreadId: threadId,
    });
    return recorder;
  }

  /** Whether this handle records events. */
  get enabled(): boolean {
    return this.writer !== undefined;
  }

  /** Underlying bundle directory when enabled, else undefined. */
  get bundleDir(): string | undefined {
    return this.writer?.path;
  }

  /** Force a flush of buffered trace data. No-op when disabled. */
  flush(): void {
    this.writer?.flush();
  }

  /** Close the underlying writer. Idempotent. No-op when disabled. */
  close(): void {
    this.writer?.close();
  }

  /**
   * Emits the lifecycle event and metadata for one thread.
   * Mirrors upstream `record_thread_started`.
   */
  recordThreadStarted(metadata: ThreadStartedTraceMetadata): void {
    if (!this.writer) return;
    const metadataPayload = this.writeJsonPayloadBestEffort(
      "session_metadata",
      metadata,
    );
    this.appendBestEffort({
      type: "thread_started",
      threadId: metadata.threadId,
      agentPath: metadata.agentPath,
      ...(metadataPayload !== undefined ? { metadataPayload } : {}),
    });
  }

  /**
   * Emits a turn-start lifecycle event.
   *
   * Mirrors upstream `record_AgenC runtime_turn_started`. Most production turn
   * lifecycle wiring lives in higher-level session code; this explicit hook
   * lets trace-focused integration tests produce valid reducer inputs
   * without exercising the full session loop.
   */
  recordAgenCTurnStarted(
    threadId: AgentThreadId,
    agencTurnId: AgenCTurnId,
  ): void {
    if (!this.writer) return;
    this.appendWithContextBestEffort(
      { threadId, agencTurnId },
      {
        type: "agenc_turn_started",
        agencTurnId,
        threadId,
      },
    );
  }

  // --- Higher-level context factories ---------------------------------------
  // These match upstream shape but always return disabled contexts because
  // their child subsystems (code-mode runtime, tool-dispatch payloads,
  // inference attempts, remote compaction) have not been ported yet.
  // Call sites can use them unconditionally; they land nothing until the
  // respective port completes. INCOMPLETE relative to upstream.

  /**
   * INCOMPLETE: always returns a disabled context. See module header.
   * Upstream: returns a live `CodeCellTraceContext` when enabled.
   */
  codeCellTraceContext(_: {
    readonly threadId: AgentThreadId;
    readonly agencTurnId: AgenCTurnId;
    readonly runtimeCellId: string;
  }): CodeCellTraceContext {
    return DISABLED_CODE_CELL_CONTEXT;
  }

  /**
   * INCOMPLETE: always returns a disabled context. See module header.
   * Upstream: returns a live `ToolDispatchTraceContext` when enabled.
   */
  startToolDispatchTrace(
    _invocation: () => unknown | undefined,
  ): ToolDispatchTraceContext {
    return DISABLED_TOOL_DISPATCH_CONTEXT;
  }

  /**
   * INCOMPLETE: always returns a disabled context. See module header.
   * Upstream: returns a live `InferenceTraceContext` when enabled.
   */
  inferenceTraceContext(_: {
    readonly threadId: AgentThreadId;
    readonly agencTurnId: AgenCTurnId;
    readonly model: string;
    readonly providerName: string;
  }): InferenceTraceContext {
    return DISABLED_INFERENCE_CONTEXT;
  }

  /**
   * INCOMPLETE: always returns a disabled context. See module header.
   * Upstream: returns a live `CompactionTraceContext` when enabled.
   */
  compactionTraceContext(_: {
    readonly threadId: AgentThreadId;
    readonly agencTurnId: AgenCTurnId;
    readonly compactionId: CompactionId;
    readonly model: string;
    readonly providerName: string;
  }): CompactionTraceContext {
    return DISABLED_COMPACTION_CONTEXT;
  }

  // --- Internal helpers -----------------------------------------------------

  private appendBestEffort(payload: RawTraceEventPayload): void {
    if (!this.writer) return;
    try {
      this.writer.append(payload);
    } catch {
      // Diagnostic recording is best-effort. Swallow errors so a failed
      // trace write never destabilises the session.
    }
  }

  private appendWithContextBestEffort(
    context: RawTraceEventContext,
    payload: RawTraceEventPayload,
  ): void {
    if (!this.writer) return;
    try {
      this.writer.appendWithContext(context, payload);
    } catch {
      // Best-effort. Same rationale as `appendBestEffort`.
    }
  }

  private writeJsonPayloadBestEffort(
    kind: RawPayloadKind,
    value: unknown,
  ): RawPayloadRef | undefined {
    if (!this.writer) return undefined;
    try {
      return this.writer.writeJsonPayload(kind, value);
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory that constructs a recorder for a new session.
 *
 * Mirrors the upstream call-site shape used in session bootstrap:
 * spawned child threads inherit the parent recorder; root sessions
 * create a fresh bundle from env config (or a disabled handle).
 */
export interface CreateRolloutTraceRecorderOpts {
  /** Root thread ID used to name the bundle directory. */
  readonly threadId: string;
  /**
   * When provided, overrides the env-var root. Primarily for tests.
   * Matches upstream `create_in_root_for_test`.
   */
  readonly root?: string;
  /** When true, always returns a disabled handle regardless of env. */
  readonly disabled?: boolean;
  /**
   * An already-materialised recorder that should be inherited verbatim
   * (e.g. a child thread keeping its root's bundle). When set, all other
   * fields are ignored.
   */
  readonly inherit?: RolloutTraceRecorder;
}

export function createRolloutTraceRecorder(
  opts: CreateRolloutTraceRecorderOpts,
): RolloutTraceRecorder {
  if (opts.inherit) return opts.inherit;
  if (opts.disabled) return RolloutTraceRecorder.disabled();
  if (opts.root) {
    try {
      return RolloutTraceRecorder.createInRootForTest(opts.root, opts.threadId);
    } catch {
      return RolloutTraceRecorder.disabled();
    }
  }
  return RolloutTraceRecorder.createRootOrDisabled(opts.threadId);
}
