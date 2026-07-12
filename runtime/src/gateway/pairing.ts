/**
 * DM policy engine + pairing store (TODO task 6).
 *
 * Fail-closed: unknown senders are gated behind expiring, single-use pairing
 * codes unless the channel explicitly allowlists them; `open` requires the
 * literal `"*"` allowlist entry AND `dmPolicy: "open"` — one alone is not
 * enough. State persists to `<agencHome>/gateway/pairing.json` (0600).
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  DEFAULT_CHANNEL_POLICY,
  type ChannelSender,
  type GatewayChannelPolicy,
} from "./types.js";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export type DmAccessDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "pairing_challenge"; readonly code: string }
  | { readonly kind: "pairing_pending" }
  | { readonly kind: "denied"; readonly reason: string };

interface PendingPairing {
  readonly code: string;
  readonly expiresAt: number;
}

interface PairingState {
  readonly version: 1;
  /** channelId → peerId[] of paired senders. */
  paired: Record<string, string[]>;
  /**
   * Durable pending challenges so host CLI (`pairing pending` / `approve`)
   * can see codes without the secret ever being DM'd (todo-103).
   * key = `${channelId}\u0000${peerId}` → { code, expiresAt }.
   */
  pending?: Record<string, { code: string; expiresAt: number }>;
}

function emptyState(): PairingState {
  return { version: 1, paired: {}, pending: {} };
}

export interface PairingStoreOptions {
  readonly agencHome: string;
  readonly now?: () => number;
  readonly generateCode?: () => string;
  readonly codeTtlMs?: number;
}

function defaultGenerateCode(): string {
  // 6 hex bytes → 8 base36 chars, uppercased for read-back-over-voice.
  return randomBytes(6).toString("hex").slice(0, 8).toUpperCase();
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
              pending[key] = {
                code: (value as PendingPairing).code,
                expiresAt: (value as PendingPairing).expiresAt,
              };
            }
          }
        }
        return { version: 1, paired, pending };
      }
    } catch {
      // Corrupt state fails closed: nobody is paired.
    }
    return emptyState();
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    // pairing.json holds paired peers + host-only pending codes (0600).
    writeFileSync(this.#path, `${JSON.stringify(this.#state, null, 2)}\n`, {
      mode: 0o600,
    });
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

  #pruneExpiredPending(): void {
    const now = this.#now();
    const pending = this.#pendingMap();
    let dirty = false;
    for (const [key, entry] of Object.entries(pending)) {
      if (entry.expiresAt <= now) {
        delete pending[key];
        dirty = true;
      }
    }
    if (dirty) this.#save();
  }

  isPaired(channelId: string, peerId: string): boolean {
    return (this.#state.paired[channelId] ?? []).includes(peerId);
  }

  listPaired(channelId: string): readonly string[] {
    return this.#state.paired[channelId] ?? [];
  }

  revoke(channelId: string, peerId: string): boolean {
    const peers = this.#state.paired[channelId] ?? [];
    if (!peers.includes(peerId)) return false;
    this.#state.paired[channelId] = peers.filter((p) => p !== peerId);
    this.#save();
    return true;
  }

  /**
   * Host-only view of pending challenges (codes never DM'd — todo-103).
   * Durable so a separate CLI process can list/approve.
   */
  listPending(): readonly {
    readonly channelId: string;
    readonly peerId: string;
    readonly code: string;
    readonly expiresAt: number;
  }[] {
    this.#pruneExpiredPending();
    const out: {
      channelId: string;
      peerId: string;
      code: string;
      expiresAt: number;
    }[] = [];
    for (const [key, pending] of Object.entries(this.#pendingMap())) {
      const sep = key.indexOf("\u0000");
      if (sep < 0) continue;
      out.push({
        channelId: key.slice(0, sep),
        peerId: key.slice(sep + 1),
        code: pending.code,
        expiresAt: pending.expiresAt,
      });
    }
    return out;
  }

  /**
   * Host-side approve: pair without the remote party seeing a code (todo-103).
   * Clears any pending challenge for the peer.
   */
  approve(channelId: string, peerId: string): void {
    const pending = this.#pendingMap();
    delete pending[this.#key(channelId, peerId)];
    const peers = this.#state.paired[channelId] ?? [];
    if (!peers.includes(peerId)) {
      this.#state.paired[channelId] = [...peers, peerId];
    }
    this.#save();
  }

  /**
   * Begin (or refresh) a pairing challenge for a sender. Reuses the live
   * code when one is pending so repeated messages don't rotate it.
   */
  challenge(channelId: string, sender: ChannelSender): string {
    this.#pruneExpiredPending();
    const key = this.#key(channelId, sender.peerId);
    const pending = this.#pendingMap();
    const existing = pending[key];
    if (existing !== undefined && existing.expiresAt > this.#now()) {
      return existing.code;
    }
    const code = this.#generateCode();
    pending[key] = { code, expiresAt: this.#now() + this.#ttlMs };
    this.#save();
    return code;
  }

  /**
   * Attempt to redeem a pairing code. Exact match, unexpired, same sender,
   * single-use. Successful redemption persists the pairing.
   *
   * Codes are disclosed only on the gateway host (`listPending` / logs), not
   * in the channel DM (todo-103).
   */
  redeem(channelId: string, sender: ChannelSender, input: string): boolean {
    this.#pruneExpiredPending();
    const key = this.#key(channelId, sender.peerId);
    const pending = this.#pendingMap();
    const entry = pending[key];
    if (entry === undefined) return false;
    if (entry.expiresAt <= this.#now()) {
      delete pending[key];
      this.#save();
      return false;
    }
    if (input.trim().toUpperCase() !== entry.code) return false;
    delete pending[key];
    const peers = this.#state.paired[channelId] ?? [];
    if (!peers.includes(sender.peerId)) {
      this.#state.paired[channelId] = [...peers, sender.peerId];
    }
    this.#save();
    return true;
  }
}

/**
 * Decide whether a DM sender may reach an agent right now. Pure policy
 * evaluation; the caller renders challenges/denials back to the channel.
 */
export function evaluateDmAccess(options: {
  readonly policy?: GatewayChannelPolicy;
  readonly channelId: string;
  readonly sender: ChannelSender;
  readonly store: PairingStore;
}): DmAccessDecision {
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
      return {
        kind: "pairing_challenge",
        code: options.store.challenge(options.channelId, options.sender),
      };
    }
  }
}
