import { abilityPrior, updateAbility, validAbility, validFeatures, type TaskFeatures, type ModelAbility } from "./provider-selector-irt.js";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lock } from "../utils/lockfile.js";
import { CHILD_ROUTING_PROFILE_REVISION } from "./provider-selector-profiles.js";
import { CHILD_TASK_COMPLEXITIES, CHILD_TASK_KINDS } from "./provider-selector-types.js";
import type { ChildProviderHealth, ChildRoutingAggregate, ChildRoutingOutcome, ChildRoutingSnapshot } from "./provider-selector-types.js";

export type { ChildRoutingOutcome, ChildRoutingSnapshot } from "./provider-selector-types.js";

const MAX_AGGREGATES = 512;
const MAX_RECEIPTS = 4_096;
const MAX_HEALTH = 128;
const MAX_FILE_BYTES = 2_000_000;
const INFRASTRUCTURE_FAILURES = new Set([
  "insufficient_funds", "rate_limited", "provider_unavailable", "timeout", "auth_required",
  "parent_cancelled", "policy_revoked", "resume_blocked", "cost_cap_reached",
  "effect_outcome_unknown", "consent_denied", "consent_unavailable",
]);
const TASK_OUTCOMES = new Set(["completed", "step_limit", "no_progress", "model_unavailable", "context_insufficient",
  "tool_protocol_unreliable", "model_refused"]);

interface StoredHistory extends ChildRoutingSnapshot {
  readonly version: 1;
  readonly receipts: readonly { readonly id: string; readonly atMs: number }[];
  /** Old receipts beyond the bounded dedup window are ignored on replay. */
  readonly receiptFloorMs: number;
}

function emptyHistory(): StoredHistory {
  return { version: 1, aggregates: [], health: [], abilities: [], receipts: [], receiptFloorMs: 0 };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function count(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value);
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value);
}

function validAggregate(value: unknown): value is ChildRoutingAggregate {
  if (value === null || typeof value !== "object") return false;
  const item = value as ChildRoutingAggregate;
  return identity(item.provider) && identity(item.model) && identity(item.profileRevision) &&
    CHILD_TASK_KINDS.includes(item.taskKind) && CHILD_TASK_COMPLEXITIES.includes(item.complexity) &&
    [item.attempts, item.successes, item.infrastructureFailures, item.qualityObservations, item.qualitySuccesses, item.latencySamples, item.costSamples].every(count) &&
    [item.latencyTotalMs, item.costTotalUsd, item.lastObservedAtMs].every(finite) &&
    item.successes <= item.attempts - item.infrastructureFailures && item.qualitySuccesses <= item.qualityObservations &&
    item.infrastructureFailures <= item.attempts &&
    item.qualityObservations <= item.attempts && item.latencySamples <= item.attempts && item.costSamples <= item.attempts;
}

function validHealth(value: unknown): value is ChildProviderHealth {
  if (value === null || typeof value !== "object") return false;
  const item = value as ChildProviderHealth;
  return identity(item.provider) && finite(item.cooldownUntilMs) && count(item.consecutiveFailures) &&
    (item.lastObservedAtMs === undefined || finite(item.lastObservedAtMs)) &&
    (item.blockedReason === undefined || item.blockedReason === "insufficient_funds" || item.blockedReason === "auth_required");
}

function usableAbility(value: unknown): value is ModelAbility {
  if (value === null || typeof value !== "object") return false;
  const item = value as ModelAbility;
  return validAbility(item) && identity(item.provider) && identity(item.model);
}

function parseHistory(text: string): StoredHistory | undefined {
  try {
    const value = JSON.parse(text) as StoredHistory;
    if (value === null || value.version !== 1 || !Array.isArray(value.aggregates) ||
        value.aggregates.length > MAX_AGGREGATES || !value.aggregates.every(validAggregate) ||
        !Array.isArray(value.health) || value.health.length > MAX_HEALTH || !value.health.every(validHealth) ||
        !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS ||
        !value.receipts.every(item => item !== null && identity(item.id) && finite(item.atMs)) ||
        !finite(value.receiptFloorMs) || (value.abilities !== undefined && (!Array.isArray(value.abilities) ||
        value.abilities.length > MAX_AGGREGATES))) return undefined;
    // Rebuild the allowed fields. Extra fields from disk must never survive a write.
    return {
      version: 1,
      // An ability from another IRT revision, or a damaged one, is dropped on
      // its own. It must never take health blocks and receipts with it.
      abilities: (value.abilities ?? []).filter(usableAbility).map(item => ({ provider: item.provider, model: item.model,
        skill: item.skill, revision: item.revision, mean: item.mean, variance: item.variance, observations: item.observations })),
      aggregates: value.aggregates.map(item => ({
        provider: item.provider, model: item.model, taskKind: item.taskKind, complexity: item.complexity,
        profileRevision: item.profileRevision, attempts: item.attempts, successes: item.successes,
        infrastructureFailures: item.infrastructureFailures,
        qualityObservations: item.qualityObservations, qualitySuccesses: item.qualitySuccesses,
        latencySamples: item.latencySamples, latencyTotalMs: item.latencyTotalMs,
        costSamples: item.costSamples, costTotalUsd: item.costTotalUsd, lastObservedAtMs: item.lastObservedAtMs,
      })),
      health: value.health.map(item => ({ provider: item.provider, cooldownUntilMs: item.cooldownUntilMs,
        consecutiveFailures: item.consecutiveFailures,
        ...(item.lastObservedAtMs !== undefined ? { lastObservedAtMs: item.lastObservedAtMs } : {}),
        ...(item.blockedReason !== undefined ? { blockedReason: item.blockedReason } : {}) })),
      receipts: value.receipts.map(item => ({ id: item.id, atMs: item.atMs })),
      receiptFloorMs: value.receiptFloorMs,
    };
  } catch { return undefined; }
}

function validOutcome(item: ChildRoutingOutcome): boolean {
  return identity(item.receiptId) && identity(item.provider) && identity(item.model) &&
    CHILD_TASK_KINDS.includes(item.taskKind) && CHILD_TASK_COMPLEXITIES.includes(item.complexity) &&
    identity(item.terminalReason) && typeof item.success === "boolean" && finite(item.latencyMs) && finite(item.atMs) &&
    (INFRASTRUCTURE_FAILURES.has(item.terminalReason) || TASK_OUTCOMES.has(item.terminalReason)) &&
    (!item.success || item.terminalReason === "completed") &&
    (item.verifiedSuccess === undefined || typeof item.verifiedSuccess === "boolean") &&
    (item.features === undefined || validFeatures(item.features)) &&
    (item.costUsd === undefined || finite(item.costUsd)) && (item.retryAfterMs === undefined || finite(item.retryAfterMs)) &&
    (item.retryable === undefined || typeof item.retryable === "boolean");
}

function aggregateKey(item: Pick<ChildRoutingAggregate, "provider" | "model" | "taskKind" | "complexity" | "profileRevision">): string {
  return JSON.stringify([item.provider, item.model, item.taskKind, item.complexity, item.profileRevision]);
}

function applyOutcome(history: StoredHistory, item: ChildRoutingOutcome): StoredHistory {
  const identityFields = { provider: item.provider, model: item.model, taskKind: item.taskKind,
    complexity: item.complexity, profileRevision: CHILD_ROUTING_PROFILE_REVISION };
  const key = aggregateKey(identityFields);
  const prior = history.aggregates.find(row => aggregateKey(row) === key);
  const infrastructureFailure = INFRASTRUCTURE_FAILURES.has(item.terminalReason);
  const qualityObservation = !infrastructureFailure && item.verifiedSuccess !== undefined;
  const row: ChildRoutingAggregate = {
    ...identityFields,
    attempts: (prior?.attempts ?? 0) + 1,
    successes: (prior?.successes ?? 0) + Number(item.success),
    infrastructureFailures: (prior?.infrastructureFailures ?? 0) + Number(infrastructureFailure),
    qualityObservations: (prior?.qualityObservations ?? 0) + Number(qualityObservation),
    qualitySuccesses: (prior?.qualitySuccesses ?? 0) + Number(qualityObservation && item.verifiedSuccess === true),
    latencySamples: (prior?.latencySamples ?? 0) + 1,
    latencyTotalMs: (prior?.latencyTotalMs ?? 0) + item.latencyMs,
    costSamples: (prior?.costSamples ?? 0) + Number(item.costUsd !== undefined),
    costTotalUsd: (prior?.costTotalUsd ?? 0) + (item.costUsd ?? 0),
    lastObservedAtMs: Math.max(prior?.lastObservedAtMs ?? 0, item.atMs),
  };
  const health = history.health.filter(entry => entry.provider !== item.provider);
  const previousHealth = history.health.find(entry => entry.provider === item.provider);
  const failures = (previousHealth?.consecutiveFailures ?? 0) + 1;
  if (previousHealth?.lastObservedAtMs !== undefined && item.atMs < previousHealth.lastObservedAtMs) {
    health.push(previousHealth);
  } else if (item.terminalReason === "insufficient_funds" || item.terminalReason === "auth_required") {
    health.push({ provider: item.provider, blockedReason: item.terminalReason,
      cooldownUntilMs: 0, consecutiveFailures: failures, lastObservedAtMs: item.atMs });
  } else if (!item.success && item.retryable !== false &&
      ["rate_limited", "provider_unavailable", "timeout"].includes(item.terminalReason)) {
    const base = item.terminalReason === "rate_limited" ? 30_000 : 5_000;
    const delay = Math.max(item.retryAfterMs ?? 0, Math.min(15 * 60_000, base * 2 ** Math.min(failures - 1, 8)));
    health.push({ provider: item.provider, consecutiveFailures: failures,
      lastObservedAtMs: item.atMs,
      cooldownUntilMs: Math.max(previousHealth?.cooldownUntilMs ?? 0, item.atMs + delay),
      ...(previousHealth?.blockedReason !== undefined ? { blockedReason: previousHealth.blockedReason } : {}) });
  } else if (!item.success && previousHealth !== undefined) {
    health.push(previousHealth);
  } else if (item.success) {
    // Keep a timestamp even after recovery so a delayed older failure cannot
    // undo newer evidence that the provider is usable again.
    health.push({ provider: item.provider, cooldownUntilMs: 0, consecutiveFailures: 0, lastObservedAtMs: item.atMs });
  }
  const allReceipts = [...history.receipts, { id: item.receiptId, atMs: item.atMs }]
    .sort((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id));
  const removed = allReceipts.slice(0, Math.max(0, allReceipts.length - MAX_RECEIPTS));
  return {
    version: 1,
    abilities: qualityObservation && item.features !== undefined
      ? updatedAbilities(history.abilities ?? [], item.provider, item.model, item.features, item.verifiedSuccess!)
      : history.abilities ?? [],
    aggregates: [...history.aggregates.filter(entry => aggregateKey(entry) !== key), row]
      .sort((left, right) => right.lastObservedAtMs - left.lastObservedAtMs).slice(0, MAX_AGGREGATES),
    health: health.slice(-MAX_HEALTH), receipts: allReceipts.slice(-MAX_RECEIPTS),
    receiptFloorMs: Math.max(history.receiptFloorMs, ...removed.map(receipt => receipt.atMs)),
  };
}

function updatedAbilities(abilities: readonly ModelAbility[], provider: string, model: string,
  features: TaskFeatures, passed: boolean): readonly ModelAbility[] {
  const matches = (item: ModelAbility) => item.provider === provider && item.model === model && item.skill === features.skill;
  const prior = abilities.find(matches) ?? abilityPrior(provider, model, features.skill);
  return [...abilities.filter(item => !matches(item)), updateAbility(prior, features, passed)].slice(-MAX_AGGREGATES);
}

function hasProviderFailure(history: StoredHistory, provider: string): boolean {
  const entry = history.health.find(item => item.provider === provider);
  return entry !== undefined && (entry.cooldownUntilMs > 0 || entry.consecutiveFailures > 0 || entry.blockedReason !== undefined);
}

async function readHistoryFile(filePath: string): Promise<{ readonly history: StoredHistory; readonly invalid: boolean }> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { history: emptyHistory(), invalid: false };
    throw error;
  }
  try {
    const data = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    const parsed = bytesRead <= MAX_FILE_BYTES ? parseHistory(data.subarray(0, bytesRead).toString("utf8")) : undefined;
    return { history: parsed ?? emptyHistory(), invalid: parsed === undefined };
  } finally { await handle.close(); }
}

const TEMPORARY_SUFFIX = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;

/**
 * Remove temporaries a crashed writer left between its write and rename.
 * Call only while holding the file's lock: no live writer has one open then.
 */
async function removeStrayTemporaries(filePath: string): Promise<void> {
  const directory = dirname(filePath);
  const name = basename(filePath);
  let entries: string[];
  try { entries = await readdir(directory); } catch { return; }
  await Promise.all(entries
    .filter(entry => entry.startsWith(name) && TEMPORARY_SUFFIX.test(entry.slice(name.length)))
    .map(entry => unlink(join(directory, entry)).catch(() => {})));
}

/**
 * One instance per process and state path. The TUI and the daemon can share
 * an AgenC home, so every write rereads the file under a lock, merges into
 * what is there and replaces it atomically. A write that cannot get the lock
 * in time is dropped: this is routing telemetry, never a durable receipt.
 */
export class ChildRoutingOutcomeStore {
  #history: StoredHistory;
  #pending: Promise<unknown> = Promise.resolve();
  readonly loadWarning: "invalid_local_routing_history" | undefined;

  private constructor(readonly filePath: string, history: StoredHistory, invalid: boolean) {
    this.#history = history;
    this.loadWarning = invalid ? "invalid_local_routing_history" : undefined;
  }

  static async open(filePath: string): Promise<ChildRoutingOutcomeStore> {
    const { history, invalid } = await readHistoryFile(filePath);
    return new ChildRoutingOutcomeStore(filePath, history, invalid);
  }

  snapshot(): ChildRoutingSnapshot {
    return structuredClone({ aggregates: this.#history.aggregates, health: this.#history.health,
      ...(this.#history.abilities?.length ? { abilities: this.#history.abilities } : {}) });
  }

  /** Reread the shared file so outcomes another process recorded count too. */
  refresh(): Promise<void> {
    const pending = this.#pending.then(async () => {
      this.#history = (await readHistoryFile(this.filePath)).history;
    });
    this.#pending = pending.catch(() => undefined);
    return pending.catch(() => undefined);
  }

  /** Serializes concurrent children and commits a receipt only after atomic persistence. */
  record(outcome: ChildRoutingOutcome): Promise<boolean> {
    const item = { ...outcome };
    const pending = this.#pending.then(async () => {
      if (!validOutcome(item)) throw new Error("Invalid child routing outcome");
      return this.#update(history =>
        item.atMs <= history.receiptFloorMs || history.receipts.some(receipt => receipt.id === item.receiptId)
          ? undefined : applyOutcome(history, item));
    });
    this.#pending = pending.catch(() => undefined);
    return pending;
  }

  /** Add a delayed independent verdict without counting execution or dollars twice. */
  recordVerification(outcome: { readonly receiptId: string; readonly provider: string; readonly model: string;
    readonly features: TaskFeatures; readonly passed: boolean; readonly atMs: number }): Promise<boolean> {
    const item = structuredClone(outcome);
    const pending = this.#pending.then(async () => {
      const id = `verified:${item.receiptId}`;
      if (!identity(id) || !identity(item.provider) || !identity(item.model) || !validFeatures(item.features) ||
          typeof item.passed !== "boolean" || !finite(item.atMs)) throw new Error("Invalid independent verdict");
      return this.#update(history => {
        if (item.atMs <= history.receiptFloorMs || history.receipts.some(receipt => receipt.id === id)) return undefined;
        const receipts = [...history.receipts, { id, atMs: item.atMs }]
          .sort((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id));
        const removed = receipts.slice(0, Math.max(0, receipts.length - MAX_RECEIPTS));
        return { ...history,
          abilities: updatedAbilities(history.abilities ?? [], item.provider, item.model, item.features, item.passed),
          receipts: receipts.slice(-MAX_RECEIPTS),
          receiptFloorMs: Math.max(history.receiptFloorMs, ...removed.map(receipt => receipt.atMs)) };
      });
    });
    this.#pending = pending.catch(() => undefined);
    return pending;
  }

  /**
   * Call when a provider served a child again, or after an explicit reconnect.
   * Funds/auth failures never expire silently. Writes nothing when the
   * provider has no recorded failure.
   */
  clearProviderFailure(provider: string, nowMs = Date.now()): Promise<void> {
    const pending = this.#pending.then(async () => {
      if (!identity(provider) || !finite(nowMs)) throw new Error("Invalid provider recovery evidence");
      await this.#update(history => !hasProviderFailure(history, provider) ? undefined : {
        ...history, health: [...history.health.filter(item => item.provider !== provider),
          { provider, cooldownUntilMs: 0, consecutiveFailures: 0, lastObservedAtMs: nowMs }].slice(-MAX_HEALTH) });
    });
    this.#pending = pending.catch(() => undefined);
    return pending;
  }

  async #update(change: (history: StoredHistory) => StoredHistory | undefined): Promise<boolean> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const release = await lock(this.filePath, {
      realpath: false, stale: 10_000,
      retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
      // A lost lock must not throw from a timer in a long-lived process.
      onCompromised: () => {},
    });
    try {
      await removeStrayTemporaries(this.filePath);
      const current = (await readHistoryFile(this.filePath)).history;
      const next = change(current);
      if (next !== undefined) await this.#persist(next);
      this.#history = next ?? current;
      return next !== undefined;
    } finally {
      await release().catch(() => {});
    }
  }

  async #persist(history: StoredHistory): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(history), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}
