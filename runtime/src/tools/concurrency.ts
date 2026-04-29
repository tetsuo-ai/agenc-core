/**
 * AgenC-original concurrency contract for tool execution.
 *
 * Provenance note: `ConcurrencyClass` is AgenC-original — AgenC runtime has
 * no equivalent enum. Earlier docs (feature-matrix.md:73,
 * architecture.md:228 + architecture.md:387-390) mistakenly framed
 * this as a "port of AgenC runtime `parallel.rs:28-140`"; in fact AgenC runtime only
 * exposes the boolean `supports_parallel_tool_calls` flag referenced
 * below, and AgenC extends it here. W4 is correcting the docs.
 *
 * AgenC runtime `core/src/tools/parallel.rs` inspired the boolean
 * `supports_parallel_tool_calls` flag, but AgenC expands that single
 * boolean into a 4-class `ConcurrencyClass` enum + a per-serverId
 * `Semaphore` map for MCP tools + an AgenC-style
 * `isConcurrencySafe(args)` runtime predicate that can downgrade an
 * otherwise-parallel call to `exclusive` on untrusted input.
 *
 * The AgenC runtime primitive — `ToolCallRuntime::handle_tool_call` as
 * spawn + cancellation token + router dispatch — is NOT ported here.
 * That lives in `phases/execute-tools.ts` and
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
  /** Default capacity for SharedServer semaphores. Default 1. */
  readonly sharedServerCapacity?: number;
}

/**
 * ToolCallRuntime — wraps the shared `AsyncRwLock` + per-serverId
 * `Semaphore` map. Every tool dispatch funnels through `run()` which
 * acquires the right guard for the supplied ConcurrencyClass.
 *
 * AgenC runtime `parallel.rs` uses `tokio::sync::RwLock`; AgenC uses
 * `AsyncRwLock` (T5). The guard-acquisition policy here is AgenC's
 * own; AgenC runtime has no per-id semaphore or per-call downgrade path.
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
    name === "system.glob" ||
    name === "system.grep" ||
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
export function isNetworkTool(name: string): boolean {
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
