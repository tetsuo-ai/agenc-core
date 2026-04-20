/**
 * Four-class concurrency contract for tool execution.
 *
 * Hand-port of codex `core/src/tools/parallel.rs` (194 LOC).
 * Combines codex's explicit enum-driven concurrency class with
 * openclaude's per-tool `isConcurrencySafe(args)` runtime predicate
 * (StreamingToolExecutor.ts:106-113). AgenC uses the enum as the
 * stable label and the predicate as a per-call refinement.
 *
 * Classes:
 *   - **Exclusive** — serial writer. Blocks all other tools for the
 *     duration (acquires the shared RwLock for write).
 *   - **SharedRead** — concurrent-safe reader. Parallel with other
 *     SharedRead calls (acquires the shared RwLock for read).
 *   - **SharedServer(id)** — concurrent within a server scope but
 *     serialized per-server. Holds a per-id semaphore keyed on
 *     `serverId` (I-61). MCP tools map here.
 *   - **BackgroundTerminal** — long-running, off-ladder. Doesn't
 *     participate in the shared RwLock at all (e.g. `bash` with
 *     sleep; each invocation owns its own subprocess AbortController).
 *
 * Invariants wired here:
 *   I-61 (SharedServer per-id semaphore) — `Map<serverId, Semaphore>`
 *        keyed on serverId; never a global semaphore.
 *   I-65 (tool result completion ordering) — guarded by the caller
 *        (StreamingToolExecutor) which yields in submission order; this
 *        module only controls start ordering.
 *
 * @module
 */

import { AsyncRwLock } from "../utils/async-rwlock.js";
import type { AsyncLock } from "../utils/async-lock.js";

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
 * Minimal semaphore built on promise-chain serialization. Each
 * `serverId` gets its own instance so calls to `mcp.dbA.query` and
 * `mcp.dbB.query` don't block each other (I-61).
 *
 * The default capacity is 1 (strict serialization per server).
 * Callers can construct with >1 for parallel-safe servers.
 */
export class Semaphore {
  private readonly capacity: number;
  private acquired = 0;
  private waiters: Array<() => void> = [];

  constructor(capacity = 1) {
    if (capacity < 1) throw new RangeError("Semaphore capacity must be ≥ 1");
    this.capacity = capacity;
  }

  async acquire(): Promise<() => void> {
    if (this.acquired < this.capacity) {
      this.acquired += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.acquired += 1;
    return () => this.release();
  }

  private release(): void {
    this.acquired -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  get available(): number {
    return Math.max(0, this.capacity - this.acquired);
  }

  get queueDepth(): number {
    return this.waiters.length;
  }
}

// ─────────────────────────────────────────────────────────────────────
// ToolCallRuntime — the shared gate
// ─────────────────────────────────────────────────────────────────────

/** Arbitrary side-effect run under a concurrency guard. */
export type GuardedFn<T> = () => Promise<T>;

export interface ToolCallRuntimeOpts {
  /** Optional session-scoped AsyncLock<unknown> to synchronize with
   *  unrelated session writes. Not used today; T9 may wire subagent
   *  slot reservations here. */
  readonly sessionSync?: AsyncLock<unknown>;
  /** Default capacity for SharedServer semaphores. Default 1. */
  readonly sharedServerCapacity?: number;
}

/**
 * ToolCallRuntime — wraps the shared `AsyncRwLock` + per-serverId
 * `Semaphore` map. Every tool dispatch funnels through `run()` which
 * acquires the right guard for the supplied ConcurrencyClass.
 *
 * Mirrors codex `ToolCallRuntime::handle_tool_call` (parallel.rs:82-141).
 * Codex uses `tokio::sync::RwLock`; AgenC uses `AsyncRwLock` (T5).
 */
export class ToolCallRuntime {
  private readonly lock = new AsyncRwLock<void>(undefined);
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly sharedServerCapacity: number;
  private readonly sessionSync?: AsyncLock<unknown>;

  constructor(opts: ToolCallRuntimeOpts = {}) {
    this.sharedServerCapacity = opts.sharedServerCapacity ?? 1;
    this.sessionSync = opts.sessionSync;
    void this.sessionSync; // reserved for future wiring
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
  async run<T>(klass: ConcurrencyClass, fn: GuardedFn<T>): Promise<T> {
    switch (klass.kind) {
      case "exclusive":
        return this.lock.withWrite(() => fn());
      case "shared_read":
        return this.lock.withRead(() => fn());
      case "shared_server": {
        const semaphore = this.getOrCreateSemaphore(klass.serverId);
        const release = await semaphore.acquire();
        try {
          return await this.lock.withRead(() => fn());
        } finally {
          release();
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

  /** Diagnostics hook — returns per-server semaphore stats. */
  getSemaphoreStats(): ReadonlyArray<{
    readonly serverId: string;
    readonly available: number;
    readonly queueDepth: number;
  }> {
    return Array.from(this.semaphores.entries()).map(([serverId, s]) => ({
      serverId,
      available: s.available,
      queueDepth: s.queueDepth,
    }));
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
 * Classify a single tool call. Codex flow (router.rs:142-169):
 *
 *   1. If `spec.supportsParallelToolCalls` is false → `exclusive`.
 *   2. Otherwise, MCP tools map to `shared_server(serverId)`.
 *   3. Function tools with `supportsParallelToolCalls=true` map to
 *      `shared_read`.
 *
 * AgenC adds a per-call refinement via `tool.isConcurrencySafe(args)`
 * (openclaude pattern) — a read-tool with a dangerous arg (e.g.
 * `system.bash` with `sudo`) can downgrade itself to `exclusive` at
 * call time. When the predicate returns false, classification becomes
 * `exclusive` regardless of the static class.
 */
export function classify(
  tool: ConcurrencyClassifiable,
  args: Record<string, unknown>,
): ConcurrencyClass {
  const base = tool.concurrencyClass ?? EXCLUSIVE;

  // Per-call downgrade hook (openclaude pattern).
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

/** Read-only filesystem tools (readFile, listDir, stat, glob, grep). */
export function isReadOnlyFilesystemTool(name: string): boolean {
  return (
    name === "system.readFile" ||
    name === "system.listDir" ||
    name === "system.stat" ||
    name === "system.glob" ||
    name === "system.grep" ||
    name === "system.findFiles"
  );
}

/** Write filesystem tools (writeFile, editFile, appendFile, delete, move, mkdir). */
export function isWriteFilesystemTool(name: string): boolean {
  return (
    name === "system.writeFile" ||
    name === "system.editFile" ||
    name === "system.appendFile" ||
    name === "system.delete" ||
    name === "system.move" ||
    name === "system.mkdir"
  );
}

/** Network tools (http.fetch/get/post/browse/extractLinks/htmlToMarkdown). */
export function isNetworkTool(name: string): boolean {
  return name.startsWith("http.") || name === "system.browse";
}

/** The bash tool family. Stays `background_terminal` — each invocation
 *  owns its own subprocess lifecycle. */
export function isBashTool(name: string): boolean {
  return (
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
