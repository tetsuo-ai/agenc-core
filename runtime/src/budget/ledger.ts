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

import type { AgentBudgetState, BudgetWindowSpend } from "./types.js";

interface LedgerFile {
  readonly version: 1;
  agents: Record<string, AgentBudgetState>;
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
    if (!existsSync(this.#path)) return { version: 1, agents: {} };
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        (raw as { version?: unknown }).version === 1 &&
        typeof (raw as { agents?: unknown }).agents === "object" &&
        (raw as { agents?: unknown }).agents !== null
      ) {
        return { version: 1, agents: (raw as LedgerFile).agents };
      }
    } catch {
      // Corrupt ledger fails toward zero spend — the caps still apply going
      // forward; we never fabricate spend the agent didn't make.
    }
    return { version: 1, agents: {} };
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
  #withDiskLock(mutate: () => void): void {
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
          mutate();
          this.#save();
          return;
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
      mutate();
      this.#save();
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

  /** Operator reset: clear an agent's spend, pause flag, and warn flags. */
  reset(agentId: string): void {
    this.#withDiskLock(() => {
      const { dayKey, monthKey } = windowKeys(this.#now());
      this.#file.agents[agentId] = emptyState(agentId, dayKey, monthKey);
    });
  }

  /** All agents with a ledger entry (windows rolled). */
  listAgents(): readonly string[] {
    return Object.keys(this.#file.agents).sort();
  }
}
