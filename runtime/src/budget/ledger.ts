/**
 * Persistent per-agent budget ledger (TODO task 15).
 *
 * Tracks cumulative spend per agent per calendar window (day + month),
 * persisted to `<agencHome>/budget/ledger.json` (0600, atomic write). Windows
 * roll by date key so "daily/monthly budget" means what a user expects.
 *
 * The ledger is the external meter (never the model's self-estimate). It holds
 * worst-case debits on admit and reconciles them from real usage.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type {
  AgentBudgetState,
  BudgetRefusalReason,
  BudgetWindowSpend,
  PersistedBudgetHold,
} from "./types.js";

interface LedgerFile {
  readonly version: 1;
  agents: Record<string, AgentBudgetState>;
  /**
   * Open (reserved-but-unresolved) holds keyed by holdId — the durable
   * reservation record the frozen contract requires. Written in the SAME
   * atomic save as the worst-case debit, so reserve+debit is one durable
   * transaction. Absent in pre-reservation ledger files (loads as {}).
   */
  holds: Record<string, PersistedBudgetHold>;
}

function emptyWindow(key: string): BudgetWindowSpend {
  return { key, usd: 0, tokens: 0 };
}

function emptyState(agentId: string, dayKey: string, monthKey: string): AgentBudgetState {
  return {
    agentId,
    day: emptyWindow(dayKey),
    month: emptyWindow(monthKey),
    paused: false,
    softWarned: { day: false, month: false },
  };
}

/** `YYYY-MM-DD` and `YYYY-MM` from a Date, in the given clock's local terms. */
export function windowKeys(now: Date): { dayKey: string; monthKey: string } {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return { dayKey: `${y}-${m}-${d}`, monthKey: `${y}-${m}` };
}

export interface BudgetLedgerOptions {
  readonly agencHome: string;
  readonly now?: () => Date;
}

export class BudgetLedger {
  readonly #path: string;
  readonly #now: () => Date;
  #file: LedgerFile;

  constructor(options: BudgetLedgerOptions) {
    this.#path = join(options.agencHome, "budget", "ledger.json");
    this.#now = options.now ?? (() => new Date());
    this.#file = this.#load();
  }

  #load(): LedgerFile {
    if (!existsSync(this.#path)) return { version: 1, agents: {}, holds: {} };
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        (raw as { version?: unknown }).version === 1 &&
        typeof (raw as { agents?: unknown }).agents === "object" &&
        (raw as { agents?: unknown }).agents !== null
      ) {
        const holds = (raw as { holds?: unknown }).holds;
        return {
          version: 1,
          agents: (raw as LedgerFile).agents,
          holds:
            typeof holds === "object" && holds !== null && !Array.isArray(holds)
              ? (holds as Record<string, PersistedBudgetHold>)
              : {},
        };
      }
    } catch {
      // Corrupt ledger fails toward zero spend — the caps still apply going
      // forward; we never fabricate spend the agent didn't make.
    }
    return { version: 1, agents: {}, holds: {} };
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
  }

  /**
   * Cross-process exclusive lock for multi-instance ledger writers
   * (heartbeat / hooks / cron each construct their own BudgetLedger — todo-110).
   * Re-loads disk state under the lock so concurrent addSpend merges.
   */
  #withDiskLock<T>(mutate: () => T): T {
    const lockPath = `${this.#path}.lock`;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 5_000;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lockPath, "wx");
      } catch {
        if (Date.now() > deadline) {
          // Fail open to local mutate if lock stuck (still better than hang).
          const result = mutate();
          this.#save();
          return result;
        }
        // Busy-wait briefly for the lock holder.
        const start = Date.now();
        while (Date.now() - start < 10) {
          /* spin */
        }
      }
    }
    try {
      // Merge: re-read disk then apply mutate against this.#file.
      this.#file = this.#load();
      const result = mutate();
      this.#save();
      return result;
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Get the agent's state, rolling any window whose date key changed (a new
   * day/month resets that window's spend + soft-warn flag). Mutates + persists
   * on roll.
   */
  #stateRolled(agentId: string): AgentBudgetState {
    const { dayKey, monthKey } = windowKeys(this.#now());
    let state = this.#file.agents[agentId];
    let changed = false;
    if (state === undefined) {
      state = emptyState(agentId, dayKey, monthKey);
      this.#file.agents[agentId] = state;
      changed = true;
    }
    if (state.day.key !== dayKey) {
      state.day = emptyWindow(dayKey);
      state.softWarned.day = false;
      changed = true;
    }
    if (state.month.key !== monthKey) {
      state.month = emptyWindow(monthKey);
      state.softWarned.month = false;
      changed = true;
    }
    if (changed) this.#save();
    return state;
  }

  /** Read-only snapshot (with windows rolled to now). */
  snapshot(agentId: string): AgentBudgetState {
    const s = this.#stateRolled(agentId);
    return {
      agentId: s.agentId,
      day: { ...s.day },
      month: { ...s.month },
      paused: s.paused,
      softWarned: { ...s.softWarned },
    };
  }

  currentKeys(): { dayKey: string; monthKey: string } {
    return windowKeys(this.#now());
  }

  /** Add spend to both windows and persist. */
  addSpend(agentId: string, usd: number, tokens: number): void {
    this.#withDiskLock(() => {
      const s = this.#stateRolled(agentId);
      s.day.usd += usd;
      s.day.tokens += tokens;
      s.month.usd += usd;
      s.month.tokens += tokens;
    });
  }

  /** Drop holds whose day window has rolled: their debit no longer exists. */
  #pruneExpiredHolds(dayKey: string): void {
    for (const [holdId, hold] of Object.entries(this.#file.holds)) {
      if (hold.dayKey !== dayKey) delete this.#file.holds[holdId];
    }
  }

  /**
   * Transactional reserve: under the cross-process disk lock, roll the
   * agent's windows, run the caller's admission `check` against the LOCKED
   * state, and — only if it passes — apply the worst-case debit AND record
   * the open hold in one atomic save. This closes the check-outside-lock
   * TOCTOU: two concurrent reservers serialize on the lock and the second
   * sees the first's debit.
   *
   * The persisted hold's window keys are stamped from the rolled state (the
   * authoritative clock inside the lock), not from the caller.
   */
  tryReserve(
    request: Omit<PersistedBudgetHold, "dayKey" | "monthKey">,
    check: (state: AgentBudgetState) => BudgetRefusalReason | null,
  ):
    | { readonly reserved: true; readonly hold: PersistedBudgetHold }
    | { readonly reserved: false; readonly reason: BudgetRefusalReason } {
    return this.#withDiskLock(() => {
      const state = this.#stateRolled(request.agentId);
      this.#pruneExpiredHolds(state.day.key);
      const reason = check(state);
      if (reason !== null) return { reserved: false, reason };
      const hold: PersistedBudgetHold = {
        ...request,
        dayKey: state.day.key,
        monthKey: state.month.key,
      };
      state.day.usd += hold.estimatedUsd;
      state.day.tokens += hold.estimatedTokens;
      state.month.usd += hold.estimatedUsd;
      state.month.tokens += hold.estimatedTokens;
      this.#file.holds[hold.holdId] = hold;
      return { reserved: true, hold };
    });
  }

  /**
   * Exactly-once hold resolution: under the disk lock, look up the persisted
   * hold by id. Present and current → apply `(actual − estimated)` from the
   * PERSISTED estimate, delete the hold, save (one durable transaction) →
   * "reconciled". Absent → a duplicate call; the ledger is untouched.
   * Present but its day window rolled → the debit was already zeroed by the
   * roll, so the stale hold is discarded with NO refund ("window_rolled" —
   * unknown usage is never refunded as if the call were free).
   */
  consumeHold(
    holdId: string,
    actualUsd: number,
    actualTokens: number,
  ): "reconciled" | "duplicate" | "window_rolled" {
    return this.#withDiskLock(() => {
      const hold = this.#file.holds[holdId];
      if (hold === undefined) return "duplicate";
      const state = this.#stateRolled(hold.agentId);
      if (hold.dayKey !== state.day.key) {
        delete this.#file.holds[holdId];
        return "window_rolled";
      }
      state.day.usd += actualUsd - hold.estimatedUsd;
      state.day.tokens += actualTokens - hold.estimatedTokens;
      state.month.usd += actualUsd - hold.estimatedUsd;
      state.month.tokens += actualTokens - hold.estimatedTokens;
      delete this.#file.holds[holdId];
      return "reconciled";
    });
  }

  /** Open (unresolved) holds, optionally filtered by agent. */
  listOpenHolds(agentId?: string): readonly PersistedBudgetHold[] {
    return Object.values(this.#file.holds)
      .filter((hold) => agentId === undefined || hold.agentId === agentId)
      .sort((a, b) => a.holdId.localeCompare(b.holdId));
  }

  setPaused(agentId: string, paused: boolean): void {
    this.#withDiskLock(() => {
      const s = this.#stateRolled(agentId);
      if (s.paused !== paused) {
        s.paused = paused;
      }
    });
  }

  markSoftWarned(agentId: string, window: "day" | "month"): void {
    this.#withDiskLock(() => {
      const s = this.#stateRolled(agentId);
      if (!s.softWarned[window]) {
        s.softWarned[window] = true;
      }
    });
  }

  /** Operator reset: clear an agent's spend, holds, pause and warn flags. */
  reset(agentId: string): void {
    this.#withDiskLock(() => {
      const { dayKey, monthKey } = windowKeys(this.#now());
      this.#file.agents[agentId] = emptyState(agentId, dayKey, monthKey);
      for (const [holdId, hold] of Object.entries(this.#file.holds)) {
        if (hold.agentId === agentId) delete this.#file.holds[holdId];
      }
    });
  }

  /** All agents with a ledger entry (windows rolled). */
  listAgents(): readonly string[] {
    return Object.keys(this.#file.agents).sort();
  }
}
