/**
 * Per-sub-agent progress tracker that mirrors Claude Code's
 * `ProgressTracker` (see
 * `../claude_code/tasks/LocalAgentTask/LocalAgentTask.tsx`).
 *
 * For every live sub-agent session the tracker maintains:
 *   - `toolUseCount` — number of tool rounds dispatched by the child.
 *   - `latestInputTokens` / `cumulativeOutputTokens` — matches Claude's
 *     token accounting: Claude's API reports `input_tokens` as the
 *     cumulative-per-turn number and `output_tokens` as per-turn, so we
 *     keep the latest input and sum outputs.
 *   - `recentActivities` — ring buffer (cap 5) of the most recent tool
 *     activities for the "last: <tool>" line.
 *
 * The tracker does not do any I/O. Callers wire its output to whichever
 * event bus the UI subscribes to.
 */

export interface SubAgentToolActivity {
  readonly toolName: string;
  readonly args?: Record<string, unknown> | undefined;
  readonly isError?: boolean;
  readonly durationMs?: number;
  readonly ts: number;
}

export interface SubAgentAgentProgress {
  readonly toolUseCount: number;
  readonly tokenCount: number;
  readonly lastToolName?: string;
  readonly lastActivity?: SubAgentToolActivity;
  readonly recentActivities: readonly SubAgentToolActivity[];
  readonly elapsedMs: number;
  readonly summary?: string;
}

interface TrackerBucket {
  readonly subagentSessionId: string;
  readonly parentSessionId?: string;
  readonly parentToolCallId?: string;
  readonly startedAt: number;
  toolUseCount: number;
  latestInputTokens: number;
  cumulativeOutputTokens: number;
  recentActivities: SubAgentToolActivity[];
  lastToolName?: string;
  lastEmittedAt: number;
  summary?: string;
}

/** Maximum entries kept in `recentActivities` per bucket. */
export const RECENT_ACTIVITIES_CAP = 5;

/** Default debounce between emitted progress snapshots per session. */
export const DEFAULT_PROGRESS_EMIT_INTERVAL_MS = 250;

export interface SubAgentProgressTrackerOptions {
  /**
   * Debounce in ms between emitted progress snapshots per
   * `subagentSessionId`. Defaults to 250ms. Set to 0 to emit on every
   * round (useful for tests).
   */
  readonly emitIntervalMs?: number;
  /** Clock injection for deterministic testing. */
  readonly now?: () => number;
}

export class SubAgentProgressTracker {
  private readonly buckets = new Map<string, TrackerBucket>();
  private readonly emitIntervalMs: number;
  private readonly now: () => number;

  constructor(options: SubAgentProgressTrackerOptions = {}) {
    this.emitIntervalMs =
      options.emitIntervalMs ?? DEFAULT_PROGRESS_EMIT_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Start (or continue) tracking a sub-agent session. Idempotent.
   */
  attach(params: {
    subagentSessionId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
  }): void {
    if (this.buckets.has(params.subagentSessionId)) return;
    const now = this.now();
    this.buckets.set(params.subagentSessionId, {
      subagentSessionId: params.subagentSessionId,
      parentSessionId: params.parentSessionId,
      parentToolCallId: params.parentToolCallId,
      startedAt: now,
      toolUseCount: 0,
      latestInputTokens: 0,
      cumulativeOutputTokens: 0,
      recentActivities: [],
      lastEmittedAt: 0,
    });
  }

  /**
   * Record a tool dispatch starting. Increments `toolUseCount` and
   * records the activity.
   */
  onToolExecuting(params: {
    subagentSessionId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): void {
    const bucket = this.ensureBucket(params);
    bucket.toolUseCount += 1;
    bucket.lastToolName = params.toolName;
    const activity: SubAgentToolActivity = {
      toolName: params.toolName,
      args: params.args,
      ts: this.now(),
    };
    bucket.recentActivities.push(activity);
    while (bucket.recentActivities.length > RECENT_ACTIVITIES_CAP) {
      bucket.recentActivities.shift();
    }
  }

  /**
   * Record a tool result. Updates the latest activity with
   * `isError`/`durationMs` so the "last" line reflects the completed
   * round.
   */
  onToolResult(params: {
    subagentSessionId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    toolName: string;
    isError?: boolean;
    durationMs?: number;
  }): void {
    const bucket = this.ensureBucket(params);
    const last = bucket.recentActivities[bucket.recentActivities.length - 1];
    if (last && last.toolName === params.toolName) {
      const annotated: SubAgentToolActivity = {
        ...last,
        ...(params.isError !== undefined ? { isError: params.isError } : {}),
        ...(params.durationMs !== undefined
          ? { durationMs: params.durationMs }
          : {}),
      };
      bucket.recentActivities[bucket.recentActivities.length - 1] = annotated;
    }
  }

  /**
   * Update token accounting from provider usage. `inputTokens` is taken
   * as the latest cumulative-per-turn value; `outputTokens` is summed.
   */
  onProviderUsage(params: {
    subagentSessionId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    inputTokens?: number;
    outputTokens?: number;
  }): void {
    const bucket = this.ensureBucket(params);
    if (typeof params.inputTokens === "number" && params.inputTokens >= 0) {
      bucket.latestInputTokens = params.inputTokens;
    }
    if (typeof params.outputTokens === "number" && params.outputTokens >= 0) {
      bucket.cumulativeOutputTokens += params.outputTokens;
    }
  }

  /**
   * Attach an opaque summary string (e.g. a short verifier finding).
   */
  setSummary(subagentSessionId: string, summary: string | undefined): void {
    const bucket = this.buckets.get(subagentSessionId);
    if (!bucket) return;
    bucket.summary = summary;
  }

  /**
   * Consume-if-ready: returns a snapshot for emission when the debounce
   * window has elapsed, otherwise returns `null`. Callers use this
   * after every tool round so emission stays bounded.
   */
  consumeSnapshotIfDue(subagentSessionId: string): SubAgentAgentProgress | null {
    const bucket = this.buckets.get(subagentSessionId);
    if (!bucket) return null;
    const now = this.now();
    if (
      this.emitIntervalMs > 0 &&
      now - bucket.lastEmittedAt < this.emitIntervalMs
    ) {
      return null;
    }
    bucket.lastEmittedAt = now;
    return this.buildSnapshot(bucket);
  }

  /**
   * Force a snapshot regardless of debounce (use at completion or when
   * the caller knows the child is about to report).
   */
  flushSnapshot(subagentSessionId: string): SubAgentAgentProgress | null {
    const bucket = this.buckets.get(subagentSessionId);
    if (!bucket) return null;
    bucket.lastEmittedAt = this.now();
    return this.buildSnapshot(bucket);
  }

  /**
   * Release the bucket. Safe to call multiple times.
   */
  detach(subagentSessionId: string): void {
    this.buckets.delete(subagentSessionId);
  }

  /** Test helper. */
  getBucketForTesting(subagentSessionId: string): TrackerBucket | undefined {
    return this.buckets.get(subagentSessionId);
  }

  private ensureBucket(params: {
    subagentSessionId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
  }): TrackerBucket {
    let bucket = this.buckets.get(params.subagentSessionId);
    if (!bucket) {
      this.attach(params);
      bucket = this.buckets.get(params.subagentSessionId);
    }
    if (!bucket) {
      throw new Error(
        `SubAgentProgressTracker: bucket for ${params.subagentSessionId} missing after attach`,
      );
    }
    return bucket;
  }

  private buildSnapshot(bucket: TrackerBucket): SubAgentAgentProgress {
    const tokenCount = bucket.latestInputTokens + bucket.cumulativeOutputTokens;
    const recent = bucket.recentActivities.slice();
    const last = recent[recent.length - 1];
    return {
      toolUseCount: bucket.toolUseCount,
      tokenCount,
      ...(bucket.lastToolName ? { lastToolName: bucket.lastToolName } : {}),
      ...(last ? { lastActivity: last } : {}),
      recentActivities: recent,
      elapsedMs: this.now() - bucket.startedAt,
      ...(bucket.summary ? { summary: bucket.summary } : {}),
    };
  }
}
