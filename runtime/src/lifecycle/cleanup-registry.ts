/**
 * Ports the donor cleanup registry utility onto AgenC lifecycle primitives.
 *
 * Why this lives here:
 *   - AgenC has multiple runtime owners that need an idempotent graceful
 *     shutdown path: daemon sockets, command child processes, background
 *     agents, MCP connections, and durable session stores.
 *
 * Cross-cuts deliberately NOT carried:
 *   - cache-retention cleanup from the donor cleanup utility; AgenC's port
 *     item F-07 owns shutdown cleanup, not periodic cache GC.
 */

export type AgenCCleanupReason =
  | "daemon_shutdown"
  | "process_exit"
  | "session_shutdown"
  | "signal";

export interface AgenCCleanupContext {
  readonly reason: AgenCCleanupReason;
  readonly signal?: NodeJS.Signals;
}

export interface AgenCCleanupResult {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: unknown;
}

export type AgenCCleanupTask = (
  context: AgenCCleanupContext,
) => void | Promise<void>;

export class AgenCCleanupRegistry {
  readonly #tasks = new Map<string, AgenCCleanupTask>();
  #running: Promise<readonly AgenCCleanupResult[]> | null = null;
  #completed: readonly AgenCCleanupResult[] | null = null;

  register(name: string, task: AgenCCleanupTask): () => void {
    if (this.#tasks.has(name)) {
      throw new Error(`AgenC cleanup task already registered: ${name}`);
    }
    this.#tasks.set(name, task);
    return () => {
      this.#tasks.delete(name);
    };
  }

  get size(): number {
    return this.#tasks.size;
  }

  async run(
    context: AgenCCleanupContext,
  ): Promise<readonly AgenCCleanupResult[]> {
    if (this.#completed !== null) return this.#completed;
    if (this.#running !== null) return this.#running;
    this.#running = this.#runOnce(context);
    this.#completed = await this.#running;
    return this.#completed;
  }

  async #runOnce(
    context: AgenCCleanupContext,
  ): Promise<readonly AgenCCleanupResult[]> {
    const results: AgenCCleanupResult[] = [];
    const tasks = [...this.#tasks.entries()].reverse();
    for (const [name, task] of tasks) {
      try {
        await task(context);
        results.push({ name, ok: true });
      } catch (error) {
        results.push({ name, ok: false, error });
      }
    }
    return results;
  }
}
