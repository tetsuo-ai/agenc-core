/**
 * AgenC daemon health method handlers.
 *
 * F-03j owns the in-process health payloads. Transport-specific exposure over
 * the daemon socket is wired by later request-dispatch rows.
 */

import type {
  HealthMemoryStats,
  HealthPingResult,
  HealthReadyResult,
  HealthSessionStats,
  HealthStatsResult,
} from "./protocol/index.js";
import type { AgenCSessionCounts } from "./session-lifecycle.js";

export interface AgenCHealthSessionCounter {
  countSessions(): Promise<AgenCSessionCounts> | AgenCSessionCounts;
}

export interface AgenCDaemonHealthServiceOptions {
  readonly startedAtMs?: number;
  readonly nowMs?: () => number;
  readonly memoryUsage?: () => NodeJS.MemoryUsage;
  readonly sessionCounter?: AgenCHealthSessionCounter;
  readonly ready?: () => boolean;
}

export class AgenCDaemonHealthService {
  readonly #startedAtMs: number;
  readonly #nowMs: () => number;
  readonly #memoryUsage: () => NodeJS.MemoryUsage;
  readonly #sessionCounter?: AgenCHealthSessionCounter;
  readonly #ready: () => boolean;

  constructor(options: AgenCDaemonHealthServiceOptions = {}) {
    this.#startedAtMs = options.startedAtMs ?? Date.now();
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.#sessionCounter = options.sessionCounter;
    this.#ready = options.ready ?? (() => true);
  }

  ping(): HealthPingResult {
    return {
      ok: true,
      now: this.#nowIso(),
    };
  }

  ready(): HealthReadyResult {
    return {
      ready: this.#ready(),
      uptimeMs: this.#uptimeMs(),
      now: this.#nowIso(),
    };
  }

  async stats(): Promise<HealthStatsResult> {
    return {
      uptimeMs: this.#uptimeMs(),
      now: this.#nowIso(),
      sessions: await this.#sessionStats(),
      memory: toHealthMemoryStats(this.#memoryUsage()),
    };
  }

  #uptimeMs(): number {
    return Math.max(0, this.#nowMs() - this.#startedAtMs);
  }

  #nowIso(): string {
    return new Date(this.#nowMs()).toISOString();
  }

  async #sessionStats(): Promise<HealthSessionStats> {
    const counts = await Promise.resolve(this.#sessionCounter?.countSessions());
    return {
      active: counts?.active ?? 0,
      closed: counts?.closed ?? 0,
      total: counts?.total ?? 0,
    };
  }
}

export function toHealthMemoryStats(
  memory: NodeJS.MemoryUsage,
): HealthMemoryStats {
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}
