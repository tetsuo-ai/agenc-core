/**
 * A1 — AgenC protocol transport contract.
 *
 * The runtime deliberately carries NO in-process on-chain client: no
 * `@solana/web3.js`, no Anchor, no wallet material, no signing (see
 * docs/security/slm-transaction-guard.md). A `ProtocolTransport` is the
 * narrow seam the `/claim` (and future protocol) slash commands talk to.
 *
 * Verb classes:
 *   - READ-ONLY verbs (`listClaimable`, `taskDetail`) may be implemented
 *     today. They must never sign, spend, read wallets, or mutate chain
 *     state.
 *   - MUTATING verbs (`claimTask`, `delegateStep`, `submitProof`,
 *     `settleTask`, `adjustStake`) are typed on the interface so the
 *     command surface is stable, but every current implementation MUST
 *     return a typed `VERB_NOT_ENABLED` / `TRANSPORT_NOT_CONFIGURED`
 *     error. Wiring them is owner-gated future work: it requires an
 *     explicit human-approved signer flow that does not exist in this
 *     runtime by design.
 *
 * All marketplace-derived content (task text, job specs, moderation
 * labels) is UNTRUSTED DATA. Implementations must never let fetched
 * content influence command construction, and callers must sanitize it
 * before rendering into a terminal.
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────
// Result / error surface
// ─────────────────────────────────────────────────────────────────────

export type ProtocolErrorCode =
  /** No transport configured — `[protocol]` is disabled or adapter is "null". */
  | "TRANSPORT_NOT_CONFIGURED"
  /** Mutating verb invoked — owner-gated, never enabled in current impls. */
  | "VERB_NOT_ENABLED"
  /** Caller-supplied argument failed validation (e.g. malformed task PDA). */
  | "INVALID_ARGUMENT"
  /** The marketplace CLI binary could not be resolved. */
  | "CLI_NOT_FOUND"
  /** The CLI ran but exited non-zero / reported `success: false`. */
  | "CLI_FAILED"
  /** The CLI exceeded the execution timeout and was killed. */
  | "CLI_TIMEOUT"
  /** The CLI produced unparseable, oversized, or shape-invalid output. */
  | "CLI_BAD_OUTPUT";

export interface ProtocolTransportError {
  readonly code: ProtocolErrorCode;
  readonly message: string;
}

/**
 * Discriminated result: transports never throw for expected failures —
 * they return `{ ok: false }` with a typed error so command handlers can
 * render honest text without try/catch soup.
 */
export type ProtocolResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtocolTransportError };

export function protocolError(
  code: ProtocolErrorCode,
  message: string,
): ProtocolResult<never> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code, message }),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Read-only data shapes (parsed defensively from untrusted CLI JSON)
// ─────────────────────────────────────────────────────────────────────

export interface ListClaimableOptions {
  /** Max tasks to request (clamped to 1..MAX_LIST_LIMIT; default 10). */
  readonly limit?: number;
}

export interface ClaimableTaskSummary {
  readonly taskPda: string;
  readonly status?: string;
  readonly reward?: string;
  readonly description?: string;
}

export interface ClaimableTaskList {
  readonly tasks: readonly ClaimableTaskSummary[];
}

export interface TaskModerationSummary {
  readonly status?: string;
  readonly riskScore?: number;
  readonly advisoryOnly?: boolean;
  readonly hardBoundary?: boolean;
}

export interface TaskDetail {
  readonly taskPda: string;
  readonly status?: string;
  readonly reward?: string;
  readonly description?: string;
  readonly moderation?: TaskModerationSummary;
}

// ─────────────────────────────────────────────────────────────────────
// Transport interface
// ─────────────────────────────────────────────────────────────────────

export interface ProtocolTransport {
  /** Adapter kind, for status text ("null" | "marketplace-cli"). */
  readonly kind: string;

  // ── Read-only verbs (implementable today) ──────────────────────────
  listClaimable(
    opts?: ListClaimableOptions,
  ): Promise<ProtocolResult<ClaimableTaskList>>;
  taskDetail(taskPda: string): Promise<ProtocolResult<TaskDetail>>;

  // ── Mutating verbs (typed, owner-gated, NEVER enabled here) ────────
  // Each returns Promise<ProtocolResult<never>>: the only legal outcome
  // in every current implementation is a typed error. Enabling any of
  // these requires an explicit, human-approved signing path outside this
  // runtime.
  claimTask(taskPda: string): Promise<ProtocolResult<never>>;
  delegateStep(agent: string, step: string): Promise<ProtocolResult<never>>;
  submitProof(target?: string): Promise<ProtocolResult<never>>;
  settleTask(taskPda?: string): Promise<ProtocolResult<never>>;
  adjustStake(amount?: string): Promise<ProtocolResult<never>>;
}

// ─────────────────────────────────────────────────────────────────────
// Argument validation / untrusted-text hygiene
// ─────────────────────────────────────────────────────────────────────

/**
 * Solana account addresses (task PDAs) are base58 (Bitcoin alphabet: no
 * 0, O, I, l) and decode to 32 bytes → 32..44 base58 characters. This
 * is intentionally strict: anything with whitespace, shell
 * metacharacters, quotes, or a leading `-` (flag smuggling) fails the
 * alphabet check and is rejected BEFORE any process is spawned.
 */
const TASK_PDA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidTaskPda(value: string): boolean {
  return TASK_PDA_RE.test(value);
}

/**
 * Sanitize marketplace-derived text before it is rendered into a
 * terminal: strips C0/C1 control characters (incl. ESC, so no ANSI
 * escape injection), collapses newlines to spaces, and truncates.
 * Untrusted data is display-only — it must never reach a command line.
 */
export function sanitizeUntrustedText(value: string, maxLength = 200): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, maxLength)}…`;
}
