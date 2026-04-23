/**
 * T11 Wave 1 Agent D — network approval decision layer.
 *
 * Port of codex `tools::network_approval::NetworkApprovalService`
 * (`codex-rs/core/src/tools/network_approval.rs`, 688 LOC). This module
 * owns ONLY the approval-decision layer: session-scoped host cache
 * (allow/deny), in-flight request dedup, short-circuit guards, and
 * resolver/hook invocation. Upstream wildcard / URL / allowlist
 * matching (`NetworkDomainPermission`) is T13 scope — the cache here
 * operates on exact lowercased `host + protocol + port` triples that
 * have already cleared any upstream allowlist.
 *
 * Intentionally not ported (see task brief):
 *   - Wildcard/URL matching — T13 upstream allowlist.
 *   - Execpolicy amendment persistence backend — T11 just calls the
 *     `persistAmendment` hook; T12/T13 wires the actual on-disk write.
 *   - Deferred long-running tool coordination — T12/T13; `requestDeferredApproval`
 *     stub falls through to the immediate path.
 *
 * Invariants:
 *   - Exact codex short-circuit order: sandbox gate, then approval-policy
 *     gate (`network_approval.rs:128-133, 361-369`).
 *   - Session deny takes precedence over session allow in the same lookup
 *     turn (`network_approval.rs:320-331`).
 *   - Concurrent callers for the same `HostApprovalKey` are deduped: only
 *     the first caller runs the resolver; the rest wait on a `Notify`
 *     (`network_approval.rs:239-251, 333-336`).
 *   - Session-allow evicts session-deny and vice versa
 *     (`network_approval.rs:564-580`).
 *
 * @module
 */

import { AsyncLock } from "./_deps/async-lock.js";

// ─────────────────────────────────────────────────────────────────────
// Re-declared enum ports (kept local to avoid an import cycle with
// `session/turn-context.ts` which only has stub shapes today).
// ─────────────────────────────────────────────────────────────────────

/** Port of codex `AskForApproval`. Only `"never"` is load-bearing here. */
export type ApprovalPolicy =
  | "never"
  | "on_failure"
  | "on_request"
  | "granular"
  | "untrusted";

/**
 * Port of codex `SandboxPolicy` kinds. Only the `kind` field is load-bearing
 * for network approval. Two kinds short-circuit to deny:
 *   - `danger_full_access`: no review flow — full access is already granted.
 *   - `external_sandbox`: review flow is not available outside the managed sandbox.
 */
export interface SandboxPolicy {
  readonly kind:
    | "danger_full_access"
    | "read_only"
    | "workspace_write"
    | "external_sandbox";
}

/** Port of codex `ReviewDecision` enum (sum type with amendment payload). */
export type ReviewDecision =
  | { readonly kind: "approved" }
  | { readonly kind: "approved_execpolicy_amendment" }
  | { readonly kind: "approved_for_session" }
  | {
      readonly kind: "network_policy_amendment";
      readonly amendment: NetworkPolicyAmendment;
    }
  | { readonly kind: "denied" }
  | { readonly kind: "abort" }
  | { readonly kind: "timed_out" };

/** Port of codex `NetworkPolicyAmendment`. */
export interface NetworkPolicyAmendment {
  readonly action: "allow" | "deny";
  /** Optional human-readable justification (not load-bearing for caching). */
  readonly justification?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Host approval key + decisions
// ─────────────────────────────────────────────────────────────────────

/** Port of codex `NetworkApprovalProtocol` string labels. */
export type NetworkProtocol = "http" | "https" | "socks5-tcp" | "socks5-udp";

/** Port of codex `HostApprovalKey`. Host must already be lowercased. */
export interface HostApprovalKey {
  readonly host: string;
  readonly protocol: NetworkProtocol;
  readonly port: number;
}

/** Decision returned to the caller (codex `NetworkDecision`). */
export type NetworkDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

/** Port of codex `PendingApprovalDecision`. Internal cache-state value. */
type PendingApprovalDecision = "allow_once" | "allow_for_session" | "deny";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Lowercase, trim, and strip a single trailing dot (DNS canonical form).
 * Keeps codex parity: codex does `host.to_ascii_lowercase()` — we add the
 * trailing-dot strip for DNS canonicalization since TypeScript-land hosts
 * may come from `URL` parsing which preserves the dot.
 */
export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.endsWith(".") && trimmed.length > 1) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * Deterministic string form of a `HostApprovalKey` for use as a `Map`/`Set`
 * key. Host is normalized; protocol + port are stringified verbatim.
 *
 * Format: `"{protocol}://{host}:{port}"`.
 */
export function hostApprovalKeyToString(key: HostApprovalKey): string {
  const host = normalizeHost(key.host);
  return `${key.protocol}://${host}:${key.port}`;
}

/**
 * Normalize a caller-supplied `HostApprovalKey` so comparisons and
 * cache lookups are insensitive to case / trailing dot.
 */
function canonicalKey(key: HostApprovalKey): HostApprovalKey {
  return {
    host: normalizeHost(key.host),
    protocol: key.protocol,
    port: key.port,
  };
}

// ─────────────────────────────────────────────────────────────────────
// PendingHostApproval — concurrent-request dedup primitive
// ─────────────────────────────────────────────────────────────────────

/**
 * Coordinates multiple concurrent approval requests for the same host
 * key. Only the owner (first caller) runs the resolver; subsequent
 * callers `await wait()` until the owner calls `set()`.
 *
 * Codex uses `tokio::sync::Notify` + `Mutex<Option<...>>`. We use a
 * single promise+resolver pair — all waiters share the same pending
 * promise and are released together when `set()` fires.
 */
export class PendingHostApproval {
  private decisionValue: PendingApprovalDecision | null = null;
  private readonly ready: Promise<PendingApprovalDecision>;
  private readonly resolveReady: (value: PendingApprovalDecision) => void;

  constructor() {
    // Capture the resolver so `set()` can release waiters.
    let capturedResolve: (value: PendingApprovalDecision) => void = () => {
      /* replaced immediately below */
    };
    this.ready = new Promise<PendingApprovalDecision>((resolve) => {
      capturedResolve = resolve;
    });
    this.resolveReady = capturedResolve;
  }

  /** Current decision if already set, else null. */
  decision(): PendingApprovalDecision | null {
    return this.decisionValue;
  }

  /** Block until `set()` is called; returns the stored decision. */
  async wait(): Promise<PendingApprovalDecision> {
    if (this.decisionValue !== null) return this.decisionValue;
    return this.ready;
  }

  /**
   * Record the decision and release every waiter. Idempotent: a second
   * call with a different value is ignored (codex behavior).
   */
  set(decision: PendingApprovalDecision): void {
    if (this.decisionValue !== null) return;
    this.decisionValue = decision;
    this.resolveReady(decision);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Resolver + hook contracts
// ─────────────────────────────────────────────────────────────────────

/**
 * Contextual data handed to resolvers and hooks. Mirrors the fields
 * codex gathers before calling `request_command_approval` or the
 * permission-request hook runtime.
 */
export interface NetworkApprovalContext {
  readonly host: string;
  readonly protocol: NetworkProtocol;
  readonly port: number;
  /**
   * Pretty target string (e.g. `"https://example.com:443"`). Provided as
   * a convenience for UI layers; ALWAYS derivable from the other fields.
   */
  readonly target: string;
}

/**
 * Hook return shape. A hook may return `null` to defer to the next
 * hook/resolver, `{ allow: true }` to approve once, or `{ deny: reason }`
 * to reject.
 */
export type NetworkApprovalHookResult =
  | { readonly allow: true }
  | { readonly deny: string }
  | null;

/**
 * Permission-request hook (codex `run_permission_request_hooks`). Runs
 * with the highest precedence, short-circuiting the resolver when any
 * hook returns a non-null result.
 */
export type NetworkApprovalHook = (
  ctx: NetworkApprovalContext,
) => Promise<NetworkApprovalHookResult> | NetworkApprovalHookResult;

/** Resolver interface — UI / guardian / adapter layer implements this. */
export interface NetworkApprovalResolver {
  requestNetworkApproval(ctx: NetworkApprovalContext): Promise<ReviewDecision>;
}

/**
 * Persistence callback for network-policy amendments. Codex calls
 * `session.persist_network_policy_amendment` — T11 exposes this as a
 * swap-in callback so T12/T13 can wire the real write path.
 *
 * Throwing from this callback is non-fatal for the approval flow: the
 * amendment still takes effect for the current session; the error is
 * surfaced via `onAmendmentPersistError` if provided.
 */
export type PersistNetworkPolicyAmendment = (
  amendment: NetworkPolicyAmendment,
  ctx: NetworkApprovalContext,
) => Promise<void> | void;

// ─────────────────────────────────────────────────────────────────────
// Request options + error classes
// ─────────────────────────────────────────────────────────────────────

/** Port of codex `NetworkApprovalMode`. */
export type NetworkApprovalMode = "immediate" | "deferred";

export interface RequestNetworkApprovalOptions {
  readonly key: HostApprovalKey;
  readonly sandboxPolicy: SandboxPolicy;
  readonly approvalPolicy: ApprovalPolicy;
  readonly mode?: NetworkApprovalMode;
  readonly resolver?: NetworkApprovalResolver;
  readonly hooks?: ReadonlyArray<NetworkApprovalHook>;
  readonly persistAmendment?: PersistNetworkPolicyAmendment;
  readonly onAmendmentPersistError?: (err: unknown) => void;
  readonly signal?: AbortSignal;
}

/** Distinguishable rejection: the user actively denied the prompt. */
export class DeniedByUser extends Error {
  readonly kind = "denied_by_user" as const;
  constructor(message = "rejected by user") {
    super(message);
    this.name = "DeniedByUser";
  }
}

/** Distinguishable rejection: policy/sandbox refused the approval flow. */
export class DeniedByPolicy extends Error {
  readonly kind = "denied_by_policy" as const;
  constructor(message: string) {
    super(message);
    this.name = "DeniedByPolicy";
  }
}

// ─────────────────────────────────────────────────────────────────────
// NetworkApprovalService — the approval decision layer
// ─────────────────────────────────────────────────────────────────────

interface MutablePending {
  readonly map: Map<string, PendingHostApproval>;
}

export class NetworkApprovalService {
  /** JSON-stringified `HostApprovalKey` → present means "session allow". */
  private readonly sessionApprovedHosts = new Set<string>();

  /** JSON-stringified `HostApprovalKey` → present means "session deny". */
  private readonly sessionDeniedHosts = new Set<string>();

  /**
   * In-flight host approvals keyed by `hostApprovalKeyToString`. Guarded
   * by `pendingLock` so concurrent callers observe a consistent owner.
   */
  private readonly pendingLock = new AsyncLock<MutablePending>({
    map: new Map(),
  });

  // ───── Session reset ────────────────────────────────────────────────

  /**
   * Clear both session caches. Codex `Session::reset` / `/clear` calls
   * this on new session bootstrap. Does NOT touch in-flight pending
   * approvals — those resolve themselves.
   */
  clearSessionHosts(): void {
    this.sessionApprovedHosts.clear();
    this.sessionDeniedHosts.clear();
  }

  /** Test/observability helper: current session-allow set size. */
  get sessionAllowedSize(): number {
    return this.sessionApprovedHosts.size;
  }

  /** Test/observability helper: current session-deny set size. */
  get sessionDeniedSize(): number {
    return this.sessionDeniedHosts.size;
  }

  /** Test/observability helper: in-flight pending approval count. */
  pendingSize(): number {
    return this.pendingLock.unsafePeek().map.size;
  }

  // ───── Main entrypoint ──────────────────────────────────────────────

  /**
   * Port of codex `NetworkApprovalService::handle_inline_policy_request`.
   * Consult caches, dedup concurrent callers, and invoke hooks/resolver
   * exactly once per host key.
   *
   * Short-circuit order (codex parity):
   *   1. Signal already aborted → throw `AbortError`.
   *   2. Sandbox policy disallows review flow → deny.
   *   3. Approval policy is `"never"` → deny.
   *   4. Session-deny hit → deny.
   *   5. Session-allow hit → allow.
   *   6. Pending-map lookup: waiter path vs owner path.
   */
  async requestNetworkApproval(
    opts: RequestNetworkApprovalOptions,
  ): Promise<NetworkDecision> {
    // Signal check — codex spawns the approval task on the runtime; we
    // proactively refuse if the caller already cancelled.
    if (opts.signal?.aborted) {
      throw makeAbortError(opts.signal);
    }

    // (1) Sandbox gate — `network_approval.rs:128-133`.
    if (
      opts.sandboxPolicy.kind === "danger_full_access" ||
      opts.sandboxPolicy.kind === "external_sandbox"
    ) {
      return { kind: "deny", reason: "not_allowed_in_sandbox_mode" };
    }

    // (2) Approval policy gate — `network_approval.rs:361-369`.
    if (opts.approvalPolicy === "never") {
      return { kind: "deny", reason: "approval_policy_never" };
    }

    const normalizedKey = canonicalKey(opts.key);
    const stringKey = hostApprovalKeyToString(normalizedKey);

    // (3) Session-deny takes precedence over session-allow.
    if (this.sessionDeniedHosts.has(stringKey)) {
      return { kind: "deny", reason: "not_allowed" };
    }

    // (4) Session-allow hit.
    if (this.sessionApprovedHosts.has(stringKey)) {
      return { kind: "allow" };
    }

    // (5) Pending-map lookup — owner vs waiter.
    const { pending, isOwner } = await this.getOrCreatePending(stringKey);

    if (!isOwner) {
      // Waiter path: block until owner notifies, then project the
      // decision. Abort propagates if the caller cancels while waiting.
      const pendingDecision = await raceAbort(pending.wait(), opts.signal);
      return pendingDecisionToNetwork(pendingDecision);
    }

    // Owner path: run hooks → resolver → project decision.
    try {
      const resolved = await this.resolveApproval(normalizedKey, opts);

      // Cache side effects (codex `network_approval.rs:564-580`).
      if (resolved === "allow_for_session") {
        this.sessionDeniedHosts.delete(stringKey);
        this.sessionApprovedHosts.add(stringKey);
      } else if (resolved === "deny_for_session") {
        this.sessionApprovedHosts.delete(stringKey);
        this.sessionDeniedHosts.add(stringKey);
      }

      // Normalize cached-deny to the plain `deny` value exposed via
      // `PendingApprovalDecision`. Waiters only see the coarse enum.
      const publicDecision: PendingApprovalDecision =
        resolved === "deny_for_session" ? "deny" : resolved;

      pending.set(publicDecision);
      return pendingDecisionToNetwork(publicDecision);
    } catch (err) {
      // Release waiters with a deny so they don't hang; rethrow for owner.
      pending.set("deny");
      throw err;
    } finally {
      await this.removePending(stringKey);
    }
  }

  /**
   * T11 immediate-mode entrypoint — parity delegate. `mode` on the
   * options is inspected for compatibility with future deferred flow.
   *
   * TODO T12/T13: deferred mode requires long-running tool coordination
   * via `DeferredNetworkApproval` handles and an out-of-band registration
   * store. For T11 we only ship the immediate path; the deferred stub
   * falls through to the same decision computation.
   */
  async requestDeferredApproval(
    opts: RequestNetworkApprovalOptions,
  ): Promise<NetworkDecision> {
    return this.requestNetworkApproval({ ...opts, mode: "deferred" });
  }

  // ───── Internals ────────────────────────────────────────────────────

  private async getOrCreatePending(
    stringKey: string,
  ): Promise<{ pending: PendingHostApproval; isOwner: boolean }> {
    return this.pendingLock.with((state) => {
      const existing = state.map.get(stringKey);
      if (existing !== undefined) {
        return { pending: existing, isOwner: false };
      }
      const created = new PendingHostApproval();
      state.map.set(stringKey, created);
      return { pending: created, isOwner: true };
    });
  }

  private async removePending(stringKey: string): Promise<void> {
    await this.pendingLock.with((state) => {
      state.map.delete(stringKey);
    });
  }

  /**
   * Compute the approval outcome for the OWNER caller only. Runs hooks
   * (highest precedence), then the resolver, then maps the resolver's
   * `ReviewDecision` to an internal `PendingApprovalDecision | "deny_for_session"`
   * discriminator (the sentinel `"deny_for_session"` is how we ask the
   * outer caller to record a session-level deny).
   */
  private async resolveApproval(
    key: HostApprovalKey,
    opts: RequestNetworkApprovalOptions,
  ): Promise<PendingApprovalDecision | "deny_for_session"> {
    const ctx: NetworkApprovalContext = {
      host: key.host,
      protocol: key.protocol,
      port: key.port,
      target: formatNetworkTarget(key),
    };

    // (a) Hooks — highest precedence. First non-null wins.
    for (const hook of opts.hooks ?? []) {
      if (opts.signal?.aborted) throw makeAbortError(opts.signal);
      const result = await hook(ctx);
      if (result === null || result === undefined) continue;
      if ("allow" in result && result.allow === true) return "allow_once";
      if ("deny" in result) throw new DeniedByPolicy(result.deny);
    }

    // (b) Resolver — default-deny when absent.
    if (!opts.resolver) return "deny";
    if (opts.signal?.aborted) throw makeAbortError(opts.signal);

    const review = await opts.resolver.requestNetworkApproval(ctx);

    // (c) Map ReviewDecision → PendingApprovalDecision (+ amendment persistence).
    switch (review.kind) {
      case "approved":
      case "approved_execpolicy_amendment":
        return "allow_once";

      case "approved_for_session":
        return "allow_for_session";

      case "network_policy_amendment": {
        try {
          await opts.persistAmendment?.(review.amendment, ctx);
        } catch (err) {
          opts.onAmendmentPersistError?.(err);
        }
        return review.amendment.action === "allow"
          ? "allow_for_session"
          : "deny_for_session";
      }

      case "denied":
      case "abort":
      case "timed_out":
        return "deny";
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

function pendingDecisionToNetwork(
  decision: PendingApprovalDecision,
): NetworkDecision {
  switch (decision) {
    case "allow_once":
    case "allow_for_session":
      return { kind: "allow" };
    case "deny":
      return { kind: "deny", reason: "not_allowed" };
  }
}

function formatNetworkTarget(key: HostApprovalKey): string {
  return `${key.protocol}://${key.host}:${key.port}`;
}

function makeAbortError(signal: AbortSignal): Error {
  const reason = signal.reason instanceof Error
    ? signal.reason
    : new Error("aborted");
  (reason as { name?: string }).name = "AbortError";
  return reason;
}

/**
 * Await `promise`; if `signal` fires while waiting, reject with an
 * AbortError. The underlying promise is NOT cancelled — callers that
 * need true cancellation must thread their own logic through the
 * resolver.
 */
async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw makeAbortError(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(makeAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
