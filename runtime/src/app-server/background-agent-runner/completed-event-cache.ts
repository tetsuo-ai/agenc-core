import { Buffer } from "node:buffer";

import { EVENT_GAP_EVENT } from "../../contracts/run-contracts.js";
import {
  BACKGROUND_RUNNER_GAP_SOURCE,
  boundBufferedAgentEvents,
} from "./snapshot-retention.js";
import type { BackgroundAgentDaemonEvent } from "./shared.js";

export const COMPLETED_EVENT_CACHE_LIMITS = {
  entries: 128,
  bytes: 8 * 1_024 * 1_024,
  entryBytes: 1_024 * 1_024,
  ttlMs: 5 * 60_000,
} as const;

interface CompletedEventEntry {
  readonly data: Buffer;
  readonly bytes: number;
  readonly expiresAt: number;
}

/** Terminal-only replay cache. The runner fences writes by active generation. */
export class CompletedAgentEventCache {
  readonly #entries = new Map<string, CompletedEventEntry>();
  #bytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  get retained(): { readonly entries: number; readonly bytes: number } {
    return { entries: this.#entries.size, bytes: this.#bytes };
  }

  put(agentId: string, events: BackgroundAgentDaemonEvent[]): void {
    this.delete(agentId);
    this.#expire();
    try {
      // Own the bytes instead of retaining payload graphs or string slices.
      const key: string = JSON.parse(
        Buffer.from(JSON.stringify(agentId), "utf8").toString("utf8"),
      );
      const data = Buffer.from(
        JSON.stringify(boundBufferedAgentEvents(events, agentId)),
        "utf8",
      );
      const bytes = data.byteLength + Buffer.byteLength(key, "utf8");
      if (bytes > COMPLETED_EVENT_CACHE_LIMITS.entryBytes) return;
      this.#entries.set(key, {
        data,
        bytes,
        expiresAt: Date.now() + COMPLETED_EVENT_CACHE_LIMITS.ttlMs,
      });
      this.#bytes += bytes;
      // Entries are consumed on read, so the least recently used survivor is
      // the oldest insertion/replacement. No per-agent tombstones are kept.
      while (
        this.#entries.size > COMPLETED_EVENT_CACHE_LIMITS.entries ||
        this.#bytes > COMPLETED_EVENT_CACHE_LIMITS.bytes
      ) {
        const oldest = this.#entries.keys().next().value;
        if (oldest === undefined) break;
        this.#remove(oldest);
      }
    } catch {
      // Unserializable or oversized buffers require durable replay on attach.
    } finally {
      this.#scheduleExpiry();
    }
  }

  take(agentId: string): BackgroundAgentDaemonEvent[] | undefined {
    this.#expire();
    const entry = this.#entries.get(agentId);
    this.delete(agentId);
    return entry === undefined
      ? undefined
      : JSON.parse(entry.data.toString("utf8"));
  }

  delete(agentId: string): void {
    this.#remove(agentId);
    this.#scheduleExpiry();
  }

  #remove(agentId: string): void {
    const entry = this.#entries.get(agentId);
    if (entry === undefined) return;
    this.#bytes -= entry.bytes;
    this.#entries.delete(agentId);
  }

  #expire(): void {
    const now = Date.now();
    for (const [agentId, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#remove(agentId);
    }
  }

  #scheduleExpiry(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    let deadline = Infinity;
    for (const entry of this.#entries.values())
      deadline = Math.min(deadline, entry.expiresAt);
    if (deadline === Infinity) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#expire();
        this.#scheduleExpiry();
      },
      Math.max(1, deadline - Date.now()),
    );
    this.#timer.unref();
  }
}

/** A cache miss cannot prove either a complete stream or an exact loss count. */
export function completedEventReplayRequired(
  agentId: string,
): BackgroundAgentDaemonEvent {
  return {
    id: `runner-gap:${agentId}`,
    type: EVENT_GAP_EVENT,
    payload: {
      kind: EVENT_GAP_EVENT,
      reason: "retention",
      source: BACKGROUND_RUNNER_GAP_SOURCE,
      runId: agentId,
      retiredCount: 0,
      retiredCountKnown: false,
      coordinatesAvailable: false,
    },
  };
}
