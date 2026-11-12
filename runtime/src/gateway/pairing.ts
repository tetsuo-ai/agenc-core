/**
 * DM policy engine + pairing store (TODO task 6).
 *
 * Fail-closed: unknown senders are gated behind expiring, single-use pairing
 * codes unless the channel explicitly allowlists them; `open` requires the
 * literal `"*"` allowlist entry AND `dmPolicy: "open"` — one alone is not
 * enough. State persists to `<agencHome>/gateway/pairing.json` (0600).
 *
 * Wrong codes are limited (#3443): MAX_PAIRING_ATTEMPTS failed attempts on
 * one pending code void it and lock that (channel, sender) out of pairing
 * for PAIRING_LOCKOUT_MS. Counts and lockouts persist in the same file.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeDurableAtomicFileSync } from "../utils/durable-atomic-file.js";
import { acquireLocalSqliteLock, assertLocalPrivateFile } from "../utils/sqlite-lock.js";

import {
  DEFAULT_CHANNEL_POLICY,
  type ChannelSender,
  type GatewayChannelPolicy,
} from "./types.js";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
/** Failed attempts allowed on one pending code. The last one voids the code. */
export const MAX_PAIRING_ATTEMPTS = 5;
/** How long the sender is then locked out of pairing on that channel. */
export const PAIRING_LOCKOUT_MS = 15 * 60 * 1000;

const PAIRING_ATTEMPT_MIN_LENGTH = 4;
const PAIRING_ATTEMPT_MAX_LENGTH = 64;

export type DmAccessDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "pairing_challenge";
      readonly code: string;
      /** True when this evaluation issued the code, false when a live one was reused. */
      readonly issued: boolean;
    }
  | { readonly kind: "pairing_pending" }
  | {
      readonly kind: "pairing_locked";
      /** Epoch ms until which no code is issued or redeemed (too many wrong codes). */
      readonly lockedUntil: number;
    }
  | { readonly kind: "denied"; readonly reason: string };

/** Outcome of {@link PairingStore.beginChallenge}. */
export type PairingChallenge =
  | {
      readonly kind: "challenge";
      readonly code: string;
      /** True when this call issued the code, false when a live one was reused. */
      readonly issued: boolean;
    }
  | { readonly kind: "locked"; readonly lockedUntil: number };

interface PendingPairing {
  readonly code: string;
  readonly expiresAt: number;
  /** Failed attempts on this code so far; left out until the first one. */
  readonly failedAttempts?: number;
}

interface PairingLockout {
  /** Epoch ms at which the sender may ask for a new code. */
  readonly until: number;
}

interface PairingState {
  readonly version: 1;
  /** channelId → peerId[] of paired senders. */
  paired: Record<string, string[]>;
  /**
   * Durable pending challenges so host CLI (`pairing pending` / `approve`)
   * can see codes without the secret ever being DM'd (todo-103).
   * key = `${channelId}\u0000${peerId}` → { code, expiresAt, failedAttempts? }.
   */
  pending?: Record<string, PendingPairing>;
  /**
   * Senders locked out of pairing after too many wrong codes (#3443), under
   * the same key as `pending` → { until }. The file leaves this map out
   * while it is empty, as files written before #3443 do.
   */
  lockouts: Record<string, PairingLockout>;
}

function emptyState(): PairingState {
  return { version: 1, paired: {}, pending: {}, lockouts: {} };
}

export interface PairingStoreOptions {
  readonly agencHome: string;
  readonly now?: () => number;
  readonly generateCode?: () => string;
  readonly codeTtlMs?: number;
}

function defaultGenerateCode(): string {
  // 6 random bytes, all kept: 12 hex chars (48 bits), uppercased for
  // read-back-over-voice.
  return randomBytes(6).toString("hex").toUpperCase();
}

/**
 * Whether a message could be a pairing code at all: one token of 4 to 64
 * characters once trimmed. Anything else (a sentence, a two-letter greeting)
 * cannot equal a generated code, so it is never counted as a wrong one.
 */
function isPairingAttempt(input: string): boolean {
  const candidate = input.trim();
  return (
    candidate.length >= PAIRING_ATTEMPT_MIN_LENGTH &&
    candidate.length <= PAIRING_ATTEMPT_MAX_LENGTH &&
    !/\s/u.test(candidate)
  );
}

/**
 * Failed-attempt count of a stored pending record. Files written before
 * #3443 carry none, which reads as zero. Returns undefined for anything the
 * limit cannot have produced, so the caller voids the code instead of
 * granting it a fresh set of guesses.
 */
function readFailedAttempts(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < MAX_PAIRING_ATTEMPTS
    ? value
    : undefined;
}

/** A stored instant that a Date can hold, so it is safe to compare and print. */
function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(new Date(value).getTime());
}

export class PairingStore {
  readonly #path: string;
  readonly #now: () => number;
  readonly #generateCode: () => string;
  readonly #ttlMs: number;
  #state: PairingState;

  constructor(options: PairingStoreOptions) {
    this.#path = join(options.agencHome, "gateway", "pairing.json");
    this.#now = options.now ?? Date.now;
    this.#generateCode = options.generateCode ?? defaultGenerateCode;
    this.#ttlMs = options.codeTtlMs ?? PAIRING_CODE_TTL_MS;
    this.#state = this.#load();
  }

  #load(): PairingState {
    if (!existsSync(this.#path)) return emptyState();
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        (raw as { version?: unknown }).version === 1 &&
        typeof (raw as { paired?: unknown }).paired === "object" &&
        (raw as { paired?: unknown }).paired !== null
      ) {
        const paired: Record<string, string[]> = {};
        for (const [channel, peers] of Object.entries(
          (raw as PairingState).paired,
        )) {
          if (Array.isArray(peers)) {
            paired[channel] = peers.filter(
              (p): p is string => typeof p === "string",
            );
          }
        }
        const pending: Record<string, PendingPairing> = {};
        const rawPending = (raw as PairingState).pending;
        if (typeof rawPending === "object" && rawPending !== null) {
          for (const [key, value] of Object.entries(rawPending)) {
            if (
              typeof value === "object" &&
              value !== null &&
              typeof (value as PendingPairing).code === "string" &&
              typeof (value as PendingPairing).expiresAt === "number"
            ) {
              const failedAttempts = readFailedAttempts(
                (value as { failedAttempts?: unknown }).failedAttempts,
              );
              if (failedAttempts === undefined) continue;
              pending[key] = {
                code: (value as PendingPairing).code,
                expiresAt: (value as PendingPairing).expiresAt,
                ...(failedAttempts > 0 ? { failedAttempts } : {}),
              };
            }
          }
        }
        const lockouts: Record<string, PairingLockout> = {};
        const rawLockouts = (raw as { lockouts?: unknown }).lockouts;
        if (typeof rawLockouts === "object" && rawLockouts !== null) {
          for (const [key, value] of Object.entries(rawLockouts)) {
            if (typeof value !== "object" || value === null) continue;
            const until = (value as { until?: unknown }).until;
            if (isEpochMs(until)) lockouts[key] = { until };
          }
        }
        return { version: 1, paired, pending, lockouts };
      }
    } catch {
      // Corrupt state fails closed: nobody is paired.
    }
    return emptyState();
  }

  #save(): void {
    // pairing.json holds paired peers + host-only pending codes (0600).
    // An empty lockout map is left out, so a file with no lockouts keeps
    // the shape earlier releases wrote.
    const { lockouts, ...state } = this.#state;
    const persisted =
      Object.keys(lockouts).length > 0 ? { ...state, lockouts } : state;
    writeDurableAtomicFileSync(
      this.#path,
      `${this.#path}.${process.pid}.${randomUUID()}.tmp`,
      `${JSON.stringify(persisted, null, 2)}\n`,
      0o600,
    );
  }

  async #mutate<Value>(change: () => { value: Value; changed: boolean }): Promise<Value> {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const release = await acquireLocalSqliteLock(`${this.#path}.lock.sqlite`, {
      timeoutMs: 5_000,
      label: "pairing store transaction",
    });
    try {
      try {
        await assertLocalPrivateFile(this.#path, { label: "pairing state" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.#reloadFromDisk();
      const result = change();
      if (result.changed) this.#save();
      return result.value;
    } finally {
      release();
    }
  }

  /**
   * GW-02: CLI and live gateway each construct a PairingStore. Always
   * re-read disk before mutating or answering access checks so host
   * `pairing approve` is visible and cannot be clobbered by a stale
   * in-memory `#state` on the next `#save()`.
   */
  #reloadFromDisk(): void {
    this.#state = this.#load();
  }

  #key(channelId: string, peerId: string): string {
    return `${channelId}\u0000${peerId}`;
  }

  #pendingMap(): Record<string, PendingPairing> {
    if (this.#state.pending === undefined) {
      this.#state.pending = {};
    }
    return this.#state.pending;
  }

  /** Drops expired pending codes and expired lockouts alike. */
  #pruneExpired(): boolean {
    const now = this.#now();
    const pending = this.#pendingMap();
    let dirty = false;
    for (const [key, entry] of Object.entries(pending)) {
      if (entry.expiresAt <= now) {
        delete pending[key];
        dirty = true;
      }
    }
    const lockouts = this.#state.lockouts;
    for (const [key, entry] of Object.entries(lockouts)) {
      if (entry.until <= now) {
        delete lockouts[key];
        dirty = true;
      }
    }
    return dirty;
  }

  /** End of the live lockout stored under `key`, if there is one. */
  #liveLockout(key: string): number | undefined {
    const lockout = this.#state.lockouts[key];
    return lockout !== undefined && lockout.until > this.#now()
      ? lockout.until
      : undefined;
  }

  isPaired(channelId: string, peerId: string): boolean {
    this.#reloadFromDisk();
    return (this.#state.paired[channelId] ?? []).includes(peerId);
  }

  /**
   * Epoch ms at which the sender's pairing lockout ends, or undefined when
   * the sender is not locked out (#3443). Read-only like `isPaired`, so a
   * message from a locked-out sender costs no transaction.
   */
  lockedUntil(channelId: string, peerId: string): number | undefined {
    this.#reloadFromDisk();
    return this.#liveLockout(this.#key(channelId, peerId));
  }

  listPaired(channelId: string): readonly string[] {
    this.#reloadFromDisk();
    return this.#state.paired[channelId] ?? [];
  }

  async revoke(channelId: string, peerId: string): Promise<boolean> {
    return this.#mutate(() => {
      const peers = this.#state.paired[channelId] ?? [];
      if (!peers.includes(peerId)) return { value: false, changed: false };
      this.#state.paired[channelId] = peers.filter((peer) => peer !== peerId);
      return { value: true, changed: true };
    });
  }

  /**
   * Host-only view of pending challenges (codes never DM'd — todo-103).
   * Durable so a separate CLI process can list/approve.
   */
  async listPending(): Promise<readonly {
    readonly channelId: string;
    readonly peerId: string;
    readonly code: string;
    readonly expiresAt: number;
  }[]> {
    return this.#mutate(() => {
      const changed = this.#pruneExpired();
      const out: {
        channelId: string;
        peerId: string;
        code: string;
        expiresAt: number;
      }[] = [];
      for (const [key, pending] of Object.entries(this.#pendingMap())) {
        const separator = key.indexOf("\u0000");
        if (separator < 0) continue;
        out.push({
          channelId: key.slice(0, separator),
          peerId: key.slice(separator + 1),
          code: pending.code,
          expiresAt: pending.expiresAt,
        });
      }
      return { value: out, changed };
    });
  }

  /**
   * Host-side approve: pair without the remote party seeing a code (todo-103).
   * Clears any pending challenge and any lockout for the peer.
   */
  async approve(channelId: string, peerId: string): Promise<void> {
    return this.#mutate(() => {
      const key = this.#key(channelId, peerId);
      const pending = this.#pendingMap();
      delete pending[key];
      delete this.#state.lockouts[key];
      const peers = this.#state.paired[channelId] ?? [];
      if (!peers.includes(peerId)) {
        this.#state.paired[channelId] = [...peers, peerId];
      }
      return { value: undefined, changed: true };
    });
  }

  /**
   * Begin (or refresh) a pairing challenge for a sender. Reuses the live
   * code when one is pending so repeated messages don't rotate it, and
   * reports whether this call issued the code. A locked-out sender gets no
   * code (#3443).
   */
  async beginChallenge(
    channelId: string,
    sender: ChannelSender,
  ): Promise<PairingChallenge> {
    return this.#mutate<PairingChallenge>(() => {
      const changed = this.#pruneExpired();
      const key = this.#key(channelId, sender.peerId);
      const lockedUntil = this.#liveLockout(key);
      if (lockedUntil !== undefined) {
        return { value: { kind: "locked", lockedUntil }, changed };
      }
      const pending = this.#pendingMap();
      const existing = pending[key];
      if (existing !== undefined && existing.expiresAt > this.#now()) {
        return {
          value: { kind: "challenge", code: existing.code, issued: false },
          changed,
        };
      }
      const code = this.#generateCode();
      pending[key] = { code, expiresAt: this.#now() + this.#ttlMs };
      return { value: { kind: "challenge", code, issued: true }, changed: true };
    });
  }

  /**
   * Code-only form of {@link beginChallenge}. Rejects when the sender is
   * locked out, because there is no code to return.
   */
  async challenge(channelId: string, sender: ChannelSender): Promise<string> {
    const challenge = await this.beginChallenge(channelId, sender);
    if (challenge.kind === "locked") {
      throw new Error(
        `pairing is locked for '${sender.peerId}' on '${channelId}' until ${new Date(challenge.lockedUntil).toISOString()}`,
      );
    }
    return challenge.code;
  }

  /**
   * Attempt to redeem a pairing code. Exact match, unexpired, same sender,
   * single-use. Successful redemption persists the pairing.
   *
   * Codes are disclosed only on the gateway host (`listPending` / logs), not
   * in the channel DM (todo-103).
   *
   * Wrong codes are limited (#3443). Input that could be a code but does not
   * match is a failed attempt on the pending code. Reaching
   * MAX_PAIRING_ATTEMPTS voids the code and locks the sender out for
   * PAIRING_LOCKOUT_MS, during which even the correct code is refused.
   */
  async redeem(channelId: string, sender: ChannelSender, input: string): Promise<boolean> {
    return this.#mutate(() => {
      const changed = this.#pruneExpired();
      const key = this.#key(channelId, sender.peerId);
      if (this.#liveLockout(key) !== undefined) return { value: false, changed };
      const pending = this.#pendingMap();
      const entry = pending[key];
      if (entry === undefined) return { value: false, changed };
      if (entry.expiresAt <= this.#now()) {
        delete pending[key];
        return { value: false, changed: true };
      }
      if (input.trim().toUpperCase() !== entry.code) {
        // Chatter is not a guess: only input shaped like a code is counted.
        if (!isPairingAttempt(input)) return { value: false, changed };
        const failedAttempts = (entry.failedAttempts ?? 0) + 1;
        if (failedAttempts >= MAX_PAIRING_ATTEMPTS) {
          delete pending[key];
          this.#state.lockouts[key] = {
            until: this.#now() + PAIRING_LOCKOUT_MS,
          };
        } else {
          pending[key] = { ...entry, failedAttempts };
        }
        return { value: false, changed: true };
      }
      delete pending[key];
      const peers = this.#state.paired[channelId] ?? [];
      if (!peers.includes(sender.peerId)) {
        this.#state.paired[channelId] = [...peers, sender.peerId];
      }
      return { value: true, changed: true };
    });
  }
}

/**
 * Decide whether a DM sender may reach an agent right now. Pure policy
 * evaluation; the caller renders challenges/denials back to the channel.
 */
export async function evaluateDmAccess(options: {
  readonly policy?: GatewayChannelPolicy;
  readonly channelId: string;
  readonly sender: ChannelSender;
  readonly store: PairingStore;
}): Promise<DmAccessDecision> {
  const policy = options.policy ?? DEFAULT_CHANNEL_POLICY;
  switch (policy.dmPolicy) {
    case "disabled":
      return { kind: "denied", reason: "DMs are disabled on this channel" };
    case "open":
      // `open` is only honored with the explicit `"*"` allowlist marker —
      // a lone config typo must not expose the agent.
      if (policy.allowlist.includes("*")) return { kind: "allowed" };
      return {
        kind: "denied",
        reason:
          'dmPolicy "open" requires the explicit "*" allowlist entry; falling back to deny',
      };
    case "allowlist":
      if (policy.allowlist.includes(options.sender.peerId)) {
        return { kind: "allowed" };
      }
      return { kind: "denied", reason: "sender is not allowlisted" };
    case "pairing": {
      if (
        policy.allowlist.includes(options.sender.peerId) ||
        options.store.isPaired(options.channelId, options.sender.peerId)
      ) {
        return { kind: "allowed" };
      }
      // A plain read answers for a locked-out sender (#3443), so an ignored
      // message costs the host no transaction.
      const lockedUntil = options.store.lockedUntil(
        options.channelId,
        options.sender.peerId,
      );
      if (lockedUntil !== undefined) {
        return { kind: "pairing_locked", lockedUntil };
      }
      const challenge = await options.store.beginChallenge(
        options.channelId,
        options.sender,
      );
      if (challenge.kind === "locked") {
        // A wrong code from a concurrent message locked the sender out
        // between the read above and this transaction.
        return { kind: "pairing_locked", lockedUntil: challenge.lockedUntil };
      }
      return {
        kind: "pairing_challenge",
        code: challenge.code,
        issued: challenge.issued,
      };
    }
  }
}
