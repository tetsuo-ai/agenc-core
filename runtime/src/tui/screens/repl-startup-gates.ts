/**
 * REPL startup gates.
 *
 * Defers startup checks (plugin/recommendation/policy bootstrap that may
 * surface focus-stealing dialogs) until the user has actually engaged
 * with the prompt. A pure timeout grace is insufficient because pausing
 * before typing would still allow dialogs to steal focus. Only the
 * user's first submission guarantees the prompt is no longer in the
 * vulnerable pre-interaction window.
 *
 * AgenC scope: this module is the upstream state-machine core; the AgenC
 * REPL wires it to:
 *   - `permissions/approval-policy.ts::ProjectTrust` (trust gate)
 *   - basic API-key presence (api-key gate)
 *   - basic policy load (policy gate)
 *
 * Upstream-only gates (memory-file external-includes confirmation,
 * console-oauth, channel-downgrade) are intentionally out of scope.
 */

/**
 * Determines whether startup checks should run.
 *
 * Startup checks are deferred until the user has submitted their first
 * message. This guarantees the prompt was the first thing the user
 * interacted with, so no recommendation dialog can steal focus before
 * the first keystroke.
 */
export function shouldRunStartupChecks(options: {
  readonly isRemoteSession: boolean;
  readonly hasStarted: boolean;
  readonly hasHadFirstSubmission: boolean;
}): boolean {
  if (options.isRemoteSession) return false;
  if (options.hasStarted) return false;
  if (!options.hasHadFirstSubmission) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// AgenC startup-gate state machine
// ─────────────────────────────────────────────────────────────────────────

/**
 * Names of the gates the AgenC REPL waits on before considering startup
 * complete. Order matters — the REPL processes gates in declaration
 * order so the user sees a deterministic sequence of confirmations.
 *
 *  - `trust`   → ProjectTrust check (workspace marked trusted/untrusted).
 *  - `apiKey`  → API key presence on the configured provider.
 *  - `policy`  → Approval/sandbox policy load completed without errors.
 */
export type StartupGateName = "trust" | "apiKey" | "policy";

export const STARTUP_GATE_ORDER: readonly StartupGateName[] = [
  "trust",
  "apiKey",
  "policy",
];

/**
 * State of a single gate. `pending` is the initial state; `cleared`
 * means the gate is satisfied and the REPL can move on; `blocked`
 * means the gate has surfaced an interactive prompt or failure that
 * the user must resolve before startup finishes.
 */
export type StartupGateState = "pending" | "cleared" | "blocked";

export type StartupGatesSnapshot = Readonly<
  Record<StartupGateName, StartupGateState>
>;

export function createInitialStartupGates(): StartupGatesSnapshot {
  return {
    trust: "pending",
    apiKey: "pending",
    policy: "pending",
  };
}

export function setStartupGate(
  snapshot: StartupGatesSnapshot,
  gate: StartupGateName,
  state: StartupGateState,
): StartupGatesSnapshot {
  if (snapshot[gate] === state) return snapshot;
  return { ...snapshot, [gate]: state };
}

export function allStartupGatesCleared(
  snapshot: StartupGatesSnapshot,
): boolean {
  return STARTUP_GATE_ORDER.every((gate) => snapshot[gate] === "cleared");
}

export function anyStartupGateBlocked(snapshot: StartupGatesSnapshot): boolean {
  return STARTUP_GATE_ORDER.some((gate) => snapshot[gate] === "blocked");
}

/**
 * Return the first gate that is still pending in declaration order, or
 * `null` when none remain. The REPL renders the corresponding overlay
 * only for the active pending gate so we never stack two blocking
 * dialogs at once.
 */
export function nextPendingStartupGate(
  snapshot: StartupGatesSnapshot,
): StartupGateName | null {
  for (const gate of STARTUP_GATE_ORDER) {
    if (snapshot[gate] === "pending") return gate;
  }
  return null;
}
