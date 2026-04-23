/**
 * SidecarManager — parallel subscribers to `Session.txEvent` / `EventLog`.
 *
 * Sidecars perform secondary observability work (file-history
 * snapshots, error-log, cost tracking) that runs alongside the main
 * event-log rollout write. Each sidecar is isolated so one's failure
 * doesn't break another (I-43).
 *
 * Invariants wired here:
 *   I-8  (every error site emits) — sidecar errors emit `warning`
 *        events via the reserved error buffer when disk fails.
 *   I-12 (filesystem error handling) — each sidecar owns its own
 *        `DegradedStore`; disk failure per-sidecar doesn't leak.
 *   I-43 (per-sidecar isolation + reserved 64KB error buffer) — the
 *        manager holds a 64KB in-memory ring that always accepts
 *        writes so the error-logging path itself can't recurse on
 *        ENOSPC.
 *
 * @module
 */

import type { Event, EventLog } from "./event-log.js";
import { monotonicMs } from "./_deps/utils.js";

/** Events a sidecar can emit back into the manager for logging. */
export interface SidecarDiagnostic {
  readonly sidecar: string;
  readonly level: "warning" | "error";
  readonly cause: string;
  readonly message: string;
  readonly at: number;
}

/**
 * Sidecar contract. `onEvent` is called synchronously per emit
 * (listeners are single-threaded in Node.js, so no locking needed),
 * but may enqueue async work internally.
 */
export interface Sidecar {
  readonly name: string;
  /** Called per event. Should not throw; swallow + emit diagnostic. */
  onEvent(event: Event): void | Promise<void>;
  /** Lifecycle: called before first event. */
  start?(): Promise<void> | void;
  /** Lifecycle: called on manager shutdown. */
  stop?(): Promise<void> | void;
  /** Expose degraded-mode state for telemetry. */
  isDegraded?(): boolean;
}

/**
 * Reserved 64KB error buffer. The error-log sidecar writes to disk,
 * but if its disk target fails, its own error output must go
 * somewhere that can't itself fail. This in-memory ring buffer is
 * always writable and callers check `getOverflowCount()` for visibility.
 */
export class ReservedErrorBuffer {
  private readonly maxBytes: number;
  private readonly buf: SidecarDiagnostic[] = [];
  private currentBytes = 0;
  private overflowCount = 0;

  constructor(maxBytes = 64 * 1024) {
    this.maxBytes = maxBytes;
  }

  append(d: SidecarDiagnostic): void {
    const size = estimateDiagnosticBytes(d);
    while (
      this.buf.length > 0 &&
      this.currentBytes + size > this.maxBytes
    ) {
      const evicted = this.buf.shift()!;
      this.currentBytes -= estimateDiagnosticBytes(evicted);
      this.overflowCount += 1;
    }
    this.buf.push(d);
    this.currentBytes += size;
  }

  drain(): SidecarDiagnostic[] {
    const out = this.buf.splice(0);
    this.currentBytes = 0;
    return out;
  }

  snapshot(): ReadonlyArray<SidecarDiagnostic> {
    return [...this.buf];
  }

  getOverflowCount(): number {
    return this.overflowCount;
  }
}

function estimateDiagnosticBytes(d: SidecarDiagnostic): number {
  return (
    d.sidecar.length + d.cause.length + d.message.length + d.level.length + 64
  );
}

// ─────────────────────────────────────────────────────────────────────
// SidecarManager
// ─────────────────────────────────────────────────────────────────────

export interface SidecarManagerOptions {
  readonly reservedErrorBufferBytes?: number;
  /**
   * Called whenever a diagnostic lands in the reserved buffer. The
   * session-level listener can choose to surface warnings via the
   * normal event log, but must be prepared for the log itself being
   * in degraded mode.
   */
  readonly onDiagnostic?: (d: SidecarDiagnostic) => void;
}

export class SidecarManager {
  private readonly sidecars = new Map<string, Sidecar>();
  private readonly unsubscribers = new Map<string, () => void>();
  readonly reservedBuffer: ReservedErrorBuffer;
  private readonly onDiagnostic?: (d: SidecarDiagnostic) => void;

  constructor(opts: SidecarManagerOptions = {}) {
    this.reservedBuffer = new ReservedErrorBuffer(opts.reservedErrorBufferBytes);
    this.onDiagnostic = opts.onDiagnostic;
  }

  register(sidecar: Sidecar): void {
    if (this.sidecars.has(sidecar.name)) {
      throw new Error(`sidecar already registered: ${sidecar.name}`);
    }
    this.sidecars.set(sidecar.name, sidecar);
  }

  unregister(name: string): void {
    const unsub = this.unsubscribers.get(name);
    if (unsub) {
      unsub();
      this.unsubscribers.delete(name);
    }
    this.sidecars.delete(name);
  }

  async start(log: EventLog): Promise<void> {
    for (const [name, sidecar] of this.sidecars) {
      try {
        await sidecar.start?.();
      } catch (err) {
        this.recordDiagnostic({
          sidecar: name,
          level: "error",
          cause: "sidecar_start_failed",
          message: err instanceof Error ? err.message : String(err),
          at: monotonicMs(),
        });
      }
      const unsub = log.subscribe((event) => {
        // I-43: isolate per-sidecar failure.
        try {
          const result = sidecar.onEvent(event);
          if (result && typeof (result as Promise<unknown>).catch === "function") {
            (result as Promise<unknown>).catch((err: unknown) => {
              this.recordDiagnostic({
                sidecar: name,
                level: "warning",
                cause: "sidecar_event_threw_async",
                message: err instanceof Error ? err.message : String(err),
                at: monotonicMs(),
              });
            });
          }
        } catch (err) {
          this.recordDiagnostic({
            sidecar: name,
            level: "warning",
            cause: "sidecar_event_threw",
            message: err instanceof Error ? err.message : String(err),
            at: monotonicMs(),
          });
        }
      });
      this.unsubscribers.set(name, unsub);
    }
  }

  async stop(): Promise<void> {
    for (const [name, sidecar] of this.sidecars) {
      const unsub = this.unsubscribers.get(name);
      if (unsub) {
        unsub();
        this.unsubscribers.delete(name);
      }
      try {
        await sidecar.stop?.();
      } catch (err) {
        this.recordDiagnostic({
          sidecar: name,
          level: "warning",
          cause: "sidecar_stop_failed",
          message: err instanceof Error ? err.message : String(err),
          at: monotonicMs(),
        });
      }
    }
  }

  getSidecar(name: string): Sidecar | undefined {
    return this.sidecars.get(name);
  }

  getSidecarNames(): ReadonlyArray<string> {
    return Array.from(this.sidecars.keys());
  }

  /**
   * Snapshot per-sidecar degraded status for telemetry + status-line
   * display (T12 TUI consumes).
   */
  getDegradedStatus(): ReadonlyArray<{ name: string; degraded: boolean }> {
    return Array.from(this.sidecars.entries()).map(([name, s]) => ({
      name,
      degraded: s.isDegraded?.() ?? false,
    }));
  }

  /**
   * Append to the reserved 64KB error buffer. Always succeeds; on
   * overflow, oldest entries are evicted.
   */
  recordDiagnostic(d: SidecarDiagnostic): void {
    this.reservedBuffer.append(d);
    this.onDiagnostic?.(d);
  }
}
