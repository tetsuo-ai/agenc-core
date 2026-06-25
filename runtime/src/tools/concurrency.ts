/**
 * AgenC-original concurrency contract for tool execution.
 *
 * `ConcurrencyClass` is AgenC-original. It expands a single
 * `supports_parallel_tool_calls` capability flag into a 4-class
 * `ConcurrencyClass` enum + a per-serverId `Semaphore` map for MCP
 * tools + an AgenC-style
 * `isConcurrencySafe(args)` runtime predicate that can downgrade an
 * otherwise-parallel call to `exclusive` on untrusted input.
 *
 * The runtime primitive for spawn + cancellation token + router
 * dispatch lives in `phases/execute-tools.ts` and
 * `tools/streaming-executor.ts`. This module only owns the
 * classification + guard-acquisition surface.
 *
 * Classes (each with its rationale):
 *   - **exclusive** — serial writer. Blocks all other tools via
 *     write-lock on the shared RwLock. Default for writes + unknowns.
 *   - **shared_read** — concurrent-safe reader. Parallel with other
 *     shared_read calls via read-lock on the shared RwLock. Covers
 *     read-only filesystem + network GETs.
 *   - **shared_server(id)** — concurrent across servers, serialized
 *     per-server. Per-id `Semaphore` (I-61) so `mcp.dbA.query` and
 *     `mcp.dbB.query` don't block each other while same-id calls do.
 *   - **background_terminal** — long-running, off-ladder. No shared
 *     RwLock participation; each invocation owns its own subprocess
 *     AbortController (e.g. `bash`).
 *
 * Invariants wired here:
 *   I-61 (SharedServer per-id semaphore) — `Map<serverId, Semaphore>`
 *        keyed on serverId; never a global semaphore.
 *   I-65 (tool result completion ordering) — guarded by the caller
 *        (StreamingToolExecutor) which yields in submission order;
 *        this module only controls start ordering.
 *
 * @module
 */

import { AsyncRwLock } from "../utils/async-rwlock.js";

// ─────────────────────────────────────────────────────────────────────
// ConcurrencyClass — enum + tagged discriminated shape for SharedServer
// ─────────────────────────────────────────────────────────────────────

export type ConcurrencyClass =
  | { readonly kind: "exclusive" }
  | { readonly kind: "shared_read" }
  | { readonly kind: "shared_server"; readonly serverId: string }
  | { readonly kind: "background_terminal" };

export const EXCLUSIVE: ConcurrencyClass = Object.freeze({ kind: "exclusive" });
export const SHARED_READ: ConcurrencyClass = Object.freeze({
  kind: "shared_read",
});
export const BACKGROUND_TERMINAL: ConcurrencyClass = Object.freeze({
  kind: "background_terminal",
});
export function sharedServer(serverId: string): ConcurrencyClass {
  return Object.freeze({ kind: "shared_server", serverId });
}

// ─────────────────────────────────────────────────────────────────────
// Per-id semaphore (I-61)
// ─────────────────────────────────────────────────────────────────────

/**
 * Identity-carrying FIFO waiter record. The grant decision (`pumpNext`)
 * and the cancel decision (`cancelWaiter`) both read-then-write `state`
 * with no `await` between them, so exactly one of them claims the waiter;
 * the loser is inert. A grant() (= resolve()) is irrevocable.
 */
interface SemWaiter {
  state: "queued" | "granted" | "cancelled";
  grant: () => void;
  reject: (err: unknown) => void;
}

/**
 * Minimal semaphore with abort-aware acquisition. Each `serverId` gets
 * its own instance so calls to `mcp.dbA.query` and `mcp.dbB.query` don't
 * block each other (I-61).
 *
 * The default capacity is 1 (strict serialization per server).
 * Callers can construct with >1 for parallel-safe servers.
 *
 * Permit accounting uses the DIRECT-TRANSFER model: `acquired` is
 * incremented at grant time (fast path) and never re-touched by a woken
 * waiter. On release the permit is either FORWARDED to a live waiter
 * (`acquired` unchanged) or FREED (`acquired -= 1`). A queued waiter
 * aborted before it is granted is removed from the FIFO atomically; a
 * waiter already in the `granted` state already owns its permit and is
 * never force-rejected here (the awaiting caller will take the permit and
 * release normally via the signal-checked stage-2 withRead).
 */
export class Semaphore {
  private readonly capacity: number;
  private acquired = 0;
  private waiters: SemWaiter[] = [];

  constructor(capacity = 1) {
    if (capacity < 1) throw new RangeError("Semaphore capacity must be ≥ 1");
    this.capacity = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw this.abortError(signal);

    // Fast path: a permit is free → take it immediately.
    if (this.acquired < this.capacity) {
      this.acquired += 1;
      return this.makeRelease();
    }

    // Slow path: enqueue an identity-carrying waiter.
    const waiter: SemWaiter = {
      state: "queued",
      grant: () => {},
      reject: () => {},
    };
    const granted = new Promise<void>((resolve, reject) => {
      waiter.grant = () => resolve();
      waiter.reject = reject;
    });
    this.waiters.push(waiter);

    const onAbort = (): void => {
      this.cancelWaiter(waiter, this.abortError(signal!));
    };
    if (signal) {
      // Re-check after enqueue: the abort may have fired between the
      // top-of-method guard and here.
      if (signal.aborted) {
        this.cancelWaiter(waiter, this.abortError(signal));
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      await granted; // resolves only when a permit is HANDED to us
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    // The permit was already counted into `acquired` at grant time (NOT
    // here). We just take it.
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent — double-release is a no-op
      released = true;
      this.release();
    };
  }

  private release(): void {
    // A real permit is being returned. Either hand it to the next live
    // waiter (keeping `acquired` unchanged — direct permit transfer) or
    // free it.
    if (!this.pumpNext()) {
      this.acquired -= 1;
      if (this.acquired < 0) throw new Error("Semaphore acquired underflow");
    }
  }

  /**
   * Returns true iff the permit was forwarded to a live waiter (`acquired`
   * stays put). Skips cancelled waiters. SINGLE synchronous critical
   * section.
   */
  private pumpNext(): boolean {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (next.state !== "queued") continue; // cancelled mid-flight → skip
      next.state = "granted"; // SYNC claim — `acquired` already accounts for it
      next.grant();
      return true; // permit forwarded; acquired unchanged
    }
    return false; // no live waiter — caller frees the permit
  }

  /**
   * Cancel a waiter. ONLY a still-`queued` waiter is removed from the
   * queue here. A `granted` waiter already owns its permit
   * (grant() = resolve() is irrevocable, so reject() would be a no-op and
   * the caller WOULD still take the permit). Force-forwarding in that case
   * would double-grant the permit → two holders → underflow. So the
   * granted case is a NO-OP `return`: the waiter keeps the permit, takes
   * it on resume, and releases normally (its stage-2 withRead rechecks the
   * signal and frees the permit in finally). `acquired` accounting stays
   * exact.
   */
  private cancelWaiter(waiter: SemWaiter, err: unknown): void {
    if (waiter.state !== "queued") return; // granted or already-cancelled → inert
    waiter.state = "cancelled";
    waiter.reject(err);
    const i = this.waiters.indexOf(waiter);
    if (i >= 0) this.waiters.splice(i, 1); // FIFO-preserving identity splice
    // It never held a permit → acquired untouched.
  }

  private abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  get available(): number {
    return Math.max(0, this.capacity - this.acquired);
  }

  get acquiredCount(): number {
    return this.acquired;
  }

  get queueDepth(): number {
    // Only count still-live waiters (cancelled ones are spliced eagerly).
    return this.waiters.filter((w) => w.state === "queued").length;
  }
}

// ─────────────────────────────────────────────────────────────────────
// ToolCallRuntime — the shared gate
// ─────────────────────────────────────────────────────────────────────

/** Arbitrary side-effect run under a concurrency guard. */
export type GuardedFn<T> = () => Promise<T>;

export interface ToolCallRuntimeOpts {
  /** Default capacity for SharedServer semaphores. Default 1. */
  readonly sharedServerCapacity?: number;
}

/**
 * ToolCallRuntime — wraps the shared `AsyncRwLock` + per-serverId
 * `Semaphore` map. Every tool dispatch funnels through `run()` which
 * acquires the right guard for the supplied ConcurrencyClass.
 *
 * AgenC uses `AsyncRwLock` (T5). The guard-acquisition policy here is
 * AgenC-owned and includes per-id semaphores plus per-call downgrade
 * support.
 */
export class ToolCallRuntime {
  private readonly lock = new AsyncRwLock<void>(undefined);
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly sharedServerCapacity: number;

  constructor(opts: ToolCallRuntimeOpts = {}) {
    this.sharedServerCapacity = opts.sharedServerCapacity ?? 1;
  }

  /**
   * Run `fn` under the guard implied by `klass`.
   *
   * - exclusive          → write-lock on the shared RwLock
   * - shared_read        → read-lock on the shared RwLock
   * - shared_server(id)  → per-id semaphore acquisition (+ read-lock
   *                         on the shared RwLock so an exclusive
   *                         tool still blocks)
   * - background_terminal → no guard (subprocess owns its lifetime)
   */
  async run<T>(
    klass: ConcurrencyClass,
    fn: GuardedFn<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    switch (klass.kind) {
      case "exclusive":
        return this.lock.withWrite(() => fn(), signal);
      case "shared_read":
        return this.lock.withRead(() => fn(), signal);
      case "shared_server": {
        const semaphore = this.getOrCreateSemaphore(klass.serverId);
        // Stage 1 (abortable): acquire the per-server permit.
        const release = await semaphore.acquire(signal);
        try {
          // Stage 2 (abortable): the shared read lock. If this aborts,
          // the finally below rolls back stage 1 (the permit is forwarded
          // to the next live waiter by pumpNext).
          return await this.lock.withRead(() => fn(), signal);
        } finally {
          release(); // idempotent; releases the stage-1 permit
        }
      }
      case "background_terminal":
        return fn();
      default: {
        // Exhaustive check.
        const _exhaustive: never = klass;
        void _exhaustive;
        throw new Error("unhandled ConcurrencyClass");
      }
    }
  }

  private getOrCreateSemaphore(serverId: string): Semaphore {
    let s = this.semaphores.get(serverId);
    if (!s) {
      s = new Semaphore(this.sharedServerCapacity);
      this.semaphores.set(serverId, s);
    }
    return s;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Classification — decide ConcurrencyClass for a tool call.
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimum shape for tool metadata that contributes to classification.
 * The `Tool` type in tools/types.ts extends this via the updated T7
 * registry fields. A null return from `isConcurrencySafe` means "use
 * the static class unchanged"; a boolean narrows exclusive → shared_read.
 */
export interface ConcurrencyClassifiable {
  readonly name: string;
  readonly concurrencyClass?: ConcurrencyClass;
  readonly isConcurrencySafe?: (args: Record<string, unknown>) => boolean;
  /** For MCP tools, the owning server id (used when concurrencyClass
   *  resolves to `shared_server`). */
  readonly serverId?: string;
}

/**
 * Classify a single tool call under AgenC's 4-class model:
 *
 *   1. Base class comes from `tool.concurrencyClass` (defaults to
 *      `exclusive` for unknowns/writes). MCP tools typically declare
 *      `shared_server(serverId)`; read-only function tools declare
 *      `shared_read`.
 *   2. AgenC-style per-call refinement via
 *      `tool.isConcurrencySafe(args)`: a nominally parallel tool whose
 *      arguments look risky (e.g. a read-class tool invoked with a
 *      path that would write) downgrades itself to `exclusive` at call
 *      time. A throwing or false-returning predicate is treated as
 *      unsafe.
 *   3. For `shared_server`, the tool's `serverId` wins over the
 *      base class's `serverId` so a single tool instance can be
 *      re-bound without re-tagging its static class.
 */
export function classify(
  tool: ConcurrencyClassifiable,
  args: Record<string, unknown>,
): ConcurrencyClass {
  const base = tool.concurrencyClass ?? EXCLUSIVE;

  // Per-call downgrade hook (AgenC pattern).
  if (tool.isConcurrencySafe) {
    let safe = false;
    try {
      safe = Boolean(tool.isConcurrencySafe(args));
    } catch {
      safe = false;
    }
    if (!safe) return EXCLUSIVE;
  }

  // MCP tools: resolve `serverId` if the static class says shared_server.
  if (base.kind === "shared_server") {
    if (tool.serverId && tool.serverId !== base.serverId) {
      return sharedServer(tool.serverId);
    }
    return base;
  }

  return base;
}

// ─────────────────────────────────────────────────────────────────────
// Convenience classifier helpers for built-in AgenC tools.
// ─────────────────────────────────────────────────────────────────────

/** Read-only filesystem tools (FileRead, listDir, stat, glob, grep). */
export function isReadOnlyFilesystemTool(name: string): boolean {
  return (
    name === "FileRead" ||
    name === "system.listDir" ||
    name === "system.stat" ||
    name === "Glob" ||
    name === "Grep" ||
    name === "system.findFiles"
  );
}

/** Write filesystem tools (Write, Edit, delete, move, mkdir). */
export function isWriteFilesystemTool(name: string): boolean {
  return (
    name === "Write" ||
    name === "Edit" ||
    name === "system.delete" ||
    name === "system.move" ||
    name === "system.mkdir"
  );
}

/** Network tools. Raw system HTTP tools are not exposed; product web tools are read-only. */
function isNetworkTool(name: string): boolean {
  return name === "WebFetch" || name === "WebSearch";
}

/** The bash tool family. Stays `background_terminal` — each invocation
 *  owns its own subprocess lifecycle. */
export function isBashTool(name: string): boolean {
  return (
    name === "exec_command" ||
    name === "write_stdin" ||
    name === "system.bash" ||
    name === "system.background.bash" ||
    name === "bash"
  );
}

/** Default-class resolver for built-in tools. T7-C uses this when
 *  tagging tools at registry construction time. */
export function defaultConcurrencyClassFor(name: string): ConcurrencyClass {
  if (isReadOnlyFilesystemTool(name)) return SHARED_READ;
  if (isNetworkTool(name)) return SHARED_READ;
  if (isBashTool(name)) return BACKGROUND_TERMINAL;
  // Writes + unknowns stay exclusive by default.
  return EXCLUSIVE;
}
