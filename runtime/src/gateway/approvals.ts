/**
 * Channel approval round-trip (TODO task 6).
 *
 * When a turn raises a permission request, the gateway renders it into the
 * conversation and BLOCKS the turn on an exact-token reply:
 *
 *     approve A1B2C3      or      deny A1B2C3
 *
 * Authority rules (backlog protocol rule 6 — enforced here, tested, and
 * never relaxed by prompt text):
 *  - Only an EXACT `approve <token>` / `deny <token>` message authorizes.
 *    Free text, partial matches, or the token embedded in a sentence do not.
 *  - Only the sender the request was rendered to may respond.
 *  - Tokens are single-use and expire; timeout resolves to DENY (fail
 *    closed).
 */

import { randomBytes } from "node:crypto";

import type {
  GatewayPermissionDecision,
  GatewayPermissionRequest,
} from "./types.js";

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingApproval {
  readonly token: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly peerId: string;
  readonly expiresAt: number;
  resolve(decision: GatewayPermissionDecision): void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ApprovalRegistryOptions {
  readonly now?: () => number;
  readonly generateToken?: () => string;
  readonly timeoutMs?: number;
}

function defaultGenerateToken(): string {
  return randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

/** `approve <token>` / `deny <token>` — nothing else, case-insensitive. */
const APPROVAL_REPLY = /^\s*(approve|deny)\s+([a-z0-9]+)\s*$/i;

export function formatApprovalPrompt(
  request: GatewayPermissionRequest,
  token: string,
): string {
  const lines: string[] = [];
  lines.push(`Permission request: ${request.toolName ?? "tool"}`);
  if (request.permissions.length > 0) {
    lines.push(`  needs: ${request.permissions.join(", ")}`);
  }
  if (request.reason !== undefined && request.reason.length > 0) {
    lines.push(`  reason: ${request.reason}`);
  }
  lines.push("");
  lines.push(`Reply exactly:  approve ${token}   or   deny ${token}`);
  lines.push("(expires in 5 minutes; anything else is ignored)");
  return lines.join("\n");
}

export class ApprovalRegistry {
  readonly #now: () => number;
  readonly #generateToken: () => string;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingApproval>();

  constructor(options: ApprovalRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#generateToken = options.generateToken ?? defaultGenerateToken;
    this.#timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  }

  /**
   * Register a pending approval scoped to one sender in one conversation.
   * Returns the token (for rendering) and a promise resolving to the
   * decision — DENY on timeout.
   */
  register(scope: {
    readonly channelId: string;
    readonly conversationId: string;
    readonly peerId: string;
  }): { token: string; decision: Promise<GatewayPermissionDecision> } {
    const token = this.#generateToken();
    let resolveFn!: (decision: GatewayPermissionDecision) => void;
    const decision = new Promise<GatewayPermissionDecision>((resolve) => {
      resolveFn = resolve;
    });
    const pending: PendingApproval = {
      token,
      channelId: scope.channelId,
      conversationId: scope.conversationId,
      peerId: scope.peerId,
      expiresAt: this.#now() + this.#timeoutMs,
      resolve: resolveFn,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      this.#settle(token, {
        behavior: "deny",
        reason: "approval timed out in the channel",
      });
    }, this.#timeoutMs);
    // Never keep the process alive just for an approval timer.
    pending.timer.unref?.();
    this.#pending.set(token.toUpperCase(), pending);
    return { token, decision };
  }

  #settle(token: string, decision: GatewayPermissionDecision): void {
    const pending = this.#pending.get(token.toUpperCase());
    if (pending === undefined) return;
    this.#pending.delete(token.toUpperCase());
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.resolve(decision);
  }

  /**
   * Try to interpret an inbound message as an approval reply. Returns true
   * when the message was consumed as one (matched, authorized, settled);
   * false means the message is ordinary conversation input.
   *
   * A matched-but-unauthorized reply (wrong sender, expired, unknown token)
   * is CONSUMED (returns "rejected") without settling, so it never reaches
   * the agent as prompt text.
   */
  handleReply(message: {
    readonly channelId: string;
    readonly conversationId: string;
    readonly peerId: string;
    readonly text: string;
  }): "settled" | "rejected" | "not_approval" {
    const match = APPROVAL_REPLY.exec(message.text);
    if (match === null) return "not_approval";
    const verb = match[1].toLowerCase();
    const token = match[2].toUpperCase();
    const pending = this.#pending.get(token);
    if (pending === undefined) return "rejected";
    if (pending.expiresAt <= this.#now()) {
      this.#settle(token, {
        behavior: "deny",
        reason: "approval token expired",
      });
      return "rejected";
    }
    if (
      pending.channelId !== message.channelId ||
      pending.conversationId !== message.conversationId ||
      pending.peerId !== message.peerId
    ) {
      // Same-sender rule: someone else replying with a leaked token never
      // authorizes — and does not burn the token for the real approver.
      return "rejected";
    }
    this.#settle(
      token,
      verb === "approve"
        ? { behavior: "allow", scope: "once" }
        : { behavior: "deny", reason: "denied in the channel" },
    );
    return "settled";
  }

  pendingCount(): number {
    return this.#pending.size;
  }
}
