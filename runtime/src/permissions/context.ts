/**
 * T11 Wave 2-A — permission dialog context + queue + resolve-once.
 *
 * Ports AgenC's `src/hooks/toolPermission/PermissionContext.ts`
 * into a framework-agnostic module. The REPL supplies React-backed
 * queue ops; the daemon and tests supply plain-callback ops.
 *
 * Exports:
 *   - `PermissionApprovalSource` / `PermissionRejectionSource` — telemetry
 *     discriminators so every decision funnels through a typed source.
 *   - `PendingPermissionRequest` — single queue item. Carries the I-44
 *     `turnId` stamp so the dispatcher can reject stale modal
 *     decisions after a turn swap.
 *   - `createResolveOnce` — atomic single-resolve promise gate. `claim()`
 *     returns true exactly once, closing the async race between
 *     `isResolved()` and the actual `resolve()` call.
 *   - `createPermissionQueueOps` — generic queue-ops factory over any
 *     setter-style sink (React `useState`, daemon event bus, test array).
 *   - `createPermissionContext` — frozen per-request dialog context.
 *
 * @module
 */

import type {
  PermissionAllowDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMode,
  PermissionUpdate,
} from "./types.js";
import { applyPermissionUpdates } from "./rules.js";
import type { ToolPermissionContext } from "./types.js";

// ---------------------------------------------------------------------------
// Telemetry source unions
// ---------------------------------------------------------------------------

export type PermissionApprovalSource =
  | { readonly type: "hook"; readonly permanent?: boolean }
  | { readonly type: "user"; readonly permanent: boolean }
  | { readonly type: "classifier" };

export type PermissionRejectionSource =
  | { readonly type: "hook" }
  | { readonly type: "user_abort" }
  | { readonly type: "user_reject"; readonly hasFeedback: boolean };

export type PermissionDecisionSource =
  | PermissionApprovalSource
  | PermissionRejectionSource;

// ---------------------------------------------------------------------------
// Queue surface
// ---------------------------------------------------------------------------

export interface PendingPermissionRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly message: string;
  readonly submittedAt: number;
  /**
   * I-44 stamp. Set by the orchestrator to the currently-active turn
   * id before pushing onto the queue. The dispatcher validates freshness
   * before acting on a decision so a stale dialog response — arriving
   * after a turn has advanced — is rejected with
   * `warning:{cause:"stale_modal_decision"}`.
   */
  readonly turnId: string;
  /** Optional suggestions passed through from the ask decision. */
  readonly suggestions?: readonly PermissionUpdate[];
  /** Optional blocked path passthrough (e.g. for file-edit asks). */
  readonly blockedPath?: string;
}

export interface PermissionQueueOps {
  push(item: PendingPermissionRequest): void;
  remove(requestId: string): void;
  update(requestId: string, patch: Partial<PendingPermissionRequest>): void;
}

/**
 * Bridge between a typical React `useState`-like setter and the queue
 * interface. Non-React callers can bypass this and implement
 * `PermissionQueueOps` directly. The setter is called with a fresh
 * array each time — callers should treat the previous array as
 * immutable.
 */
export function createPermissionQueueOps(
  setter: (updater: (queue: readonly PendingPermissionRequest[]) => readonly PendingPermissionRequest[]) => void,
): PermissionQueueOps {
  return {
    push(item) {
      setter((queue) => [...queue, item]);
    },
    remove(requestId) {
      setter((queue) => queue.filter((q) => q.requestId !== requestId));
    },
    update(requestId, patch) {
      setter((queue) =>
        queue.map((q) =>
          q.requestId === requestId
            ? ({ ...q, ...patch } as PendingPermissionRequest)
            : q,
        ),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// resolveOnce — atomic check-and-mark
// ---------------------------------------------------------------------------

export interface ResolveOnce<T> {
  resolve(value: T): void;
  isResolved(): boolean;
  /**
   * Atomically check and mark as resolved. Returns true iff this call
   * was the first to claim the slot; subsequent callers get false.
   * Use BEFORE any `await` in async callbacks so you don't hand a
   * second value to `resolve()` from a parallel branch.
   */
  claim(): boolean;
}

export function createResolveOnce<T>(
  resolve: (value: T) => void,
): ResolveOnce<T> {
  let claimed = false;
  let delivered = false;
  return {
    resolve(value: T): void {
      if (delivered) return;
      delivered = true;
      claimed = true;
      resolve(value);
    },
    isResolved(): boolean {
      return claimed;
    },
    claim(): boolean {
      if (claimed) return false;
      claimed = true;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Dialog context
// ---------------------------------------------------------------------------

export interface PermissionDialogContext {
  readonly requestId: string;
  logDecision(source: PermissionDecisionSource): void;
  logCancelled(): void;
  persistPermissions(updates: readonly PermissionUpdate[]): Promise<boolean>;
  cancelAndAbort(
    feedback?: string,
    isAbort?: boolean,
    contentBlocks?: readonly unknown[],
  ): PermissionDecision;
  tryClassifier(
    pendingCheck: unknown,
    updatedInput?: unknown,
  ): Promise<PermissionDecision | null>;
  runHooks(
    permissionMode: PermissionMode,
    suggestions: readonly PermissionUpdate[] | undefined,
    updatedInput: unknown,
    startTime: number,
  ): Promise<PermissionDecision | null>;
  buildAllow(decision: PermissionAllowDecision): PermissionAllowDecision;
  buildDeny(decision: PermissionDenyDecision): PermissionDenyDecision;
  handleUserAllow(
    input: unknown,
    source: PermissionApprovalSource,
  ): PermissionAllowDecision;
  handleHookAllow(
    input: unknown,
    source: PermissionApprovalSource,
  ): PermissionAllowDecision;
}

// ---------------------------------------------------------------------------
// Plumbing shapes
// ---------------------------------------------------------------------------

export interface PermissionToolLike {
  readonly name: string;
  inputsEquivalent?(a: unknown, b: unknown): boolean;
}

export interface PersistDestinationCheck {
  (destination: PermissionUpdate["destination"]): boolean;
}

/**
 * Default persistence check — mirrors AgenC's
 * `supportsPersistence`: only the three on-disk destinations
 * correspond to persisted rules.
 */
export const defaultSupportsPersistence: PersistDestinationCheck = (dest) =>
  dest === "userSettings" ||
  dest === "projectSettings" ||
  dest === "localSettings";

export interface PermissionHookResult {
  readonly behavior: "allow" | "deny";
  readonly message?: string;
  readonly updatedInput?: unknown;
  readonly updatedPermissions?: readonly PermissionUpdate[];
  readonly interrupt?: boolean;
}

/**
 * Permission-request hook. Returns the first decisive result. W3 wires
 * the real hook pipeline; W2-A only defines the shape and a simple
 * iterator over a hook list.
 */
export type PermissionRequestHook = (
  toolName: string,
  requestId: string,
  input: unknown,
  mode: PermissionMode | undefined,
  suggestions: readonly PermissionUpdate[] | undefined,
  signal?: AbortSignal,
) => AsyncIterable<PermissionHookResult> | Iterable<PermissionHookResult>;

export interface DialogLogger {
  (event: { readonly requestId: string; readonly toolName: string; readonly source: PermissionDecisionSource }): void;
}

export interface CreatePermissionContextOpts {
  readonly tool: PermissionToolLike;
  readonly input: unknown;
  readonly requestId: string;
  readonly turnId: string;
  readonly setToolPermissionContext: (context: ToolPermissionContext) => void;
  readonly getToolPermissionContext: () => ToolPermissionContext;
  readonly abortController: AbortController;
  readonly queueOps?: PermissionQueueOps;
  readonly logDecisionSink?: DialogLogger;
  readonly logCancelledSink?: (event: {
    readonly requestId: string;
    readonly toolName: string;
  }) => void;
  readonly supportsPersistence?: PersistDestinationCheck;
  /**
   * Bash-style classifier "did we already auto-approve this turn?"
   * probe. W3 wires the real `awaitClassifierAutoApproval`; W2-A
   * keeps it optional so tests can inject deterministic results.
   */
  readonly classifierProbe?: (
    pendingCheck: unknown,
    signal: AbortSignal,
  ) => Promise<PermissionDecisionReason | null> | PermissionDecisionReason | null;
  readonly hooks?: readonly PermissionRequestHook[];
  readonly rejectMessages?: {
    readonly plain: string;
    readonly withFeedback: (feedback: string) => string;
  };
  readonly persistPermissionUpdates?: (
    updates: readonly PermissionUpdate[],
  ) => Promise<void> | void;
}

function defaultRejectPlain(): string {
  return "The user rejected this action.";
}

function defaultRejectWithFeedback(feedback: string): string {
  return `The user rejected this action with feedback: ${feedback}`;
}

/**
 * Build a frozen {@link PermissionDialogContext}. Used once per
 * pending permission request — the returned context is safe to hand
 * to arbitrary dialog code because none of its methods leak the
 * underlying setter / sinks.
 */
export function createPermissionContext(
  opts: CreatePermissionContextOpts,
): PermissionDialogContext {
  const supportsPersistence =
    opts.supportsPersistence ?? defaultSupportsPersistence;
  const rejectPlain = opts.rejectMessages?.plain ?? defaultRejectPlain();
  const rejectWithFeedback =
    opts.rejectMessages?.withFeedback ?? defaultRejectWithFeedback;

  const ctx: PermissionDialogContext = {
    requestId: opts.requestId,

    logDecision(source) {
      opts.logDecisionSink?.({
        requestId: opts.requestId,
        toolName: opts.tool.name,
        source,
      });
    },

    logCancelled() {
      opts.logCancelledSink?.({
        requestId: opts.requestId,
        toolName: opts.tool.name,
      });
    },

    async persistPermissions(updates) {
      if (updates.length === 0) return false;
      if (typeof opts.persistPermissionUpdates === "function") {
        await opts.persistPermissionUpdates(updates);
      }
      const nextContext = applyPermissionUpdates(
        opts.getToolPermissionContext(),
        updates,
      );
      opts.setToolPermissionContext(nextContext);
      return updates.some((u) => supportsPersistence(u.destination));
    },

    cancelAndAbort(feedback, isAbort, _contentBlocks) {
      const trimmed = feedback?.trim();
      const message = trimmed
        ? rejectWithFeedback(trimmed)
        : rejectPlain;
      if (isAbort === true || !trimmed) {
        opts.abortController.abort();
      }
      const denyReason: PermissionDecisionReason = {
        type: "other" as const,
        reason: message,
      };
      return {
        behavior: "deny" as const,
        message,
        decisionReason: denyReason,
      } satisfies PermissionDenyDecision;
    },

    async tryClassifier(pendingCheck, updatedInput) {
      if (!pendingCheck || typeof opts.classifierProbe !== "function") {
        return null;
      }
      const reason = await opts.classifierProbe(
        pendingCheck,
        opts.abortController.signal,
      );
      if (!reason) return null;
      const input =
        updatedInput !== undefined ? updatedInput : opts.input;
      return {
        behavior: "allow" as const,
        updatedInput: (input as Record<string, unknown>) ?? undefined,
        userModified: false,
        decisionReason: reason,
      } satisfies PermissionAllowDecision;
    },

    async runHooks(
      permissionMode,
      suggestions,
      updatedInput,
      _startTime,
    ) {
      const hooks = opts.hooks ?? [];
      for (const hook of hooks) {
        const iterable = hook(
          opts.tool.name,
          opts.requestId,
          opts.input,
          permissionMode,
          suggestions,
          opts.abortController.signal,
        );
        for await (const result of iterable as AsyncIterable<PermissionHookResult>) {
          if (!result) continue;
          if (result.behavior === "allow") {
            const finalInput =
              (result.updatedInput as Record<string, unknown>) ??
              (updatedInput as Record<string, unknown>) ??
              (opts.input as Record<string, unknown>);
            if (result.updatedPermissions?.length) {
              await ctx.persistPermissions(result.updatedPermissions);
            }
            opts.logDecisionSink?.({
              requestId: opts.requestId,
              toolName: opts.tool.name,
              source: { type: "hook" as const, permanent: false },
            });
            return {
              behavior: "allow" as const,
              updatedInput: finalInput,
              decisionReason: {
                type: "hook" as const,
                hookName: "PermissionRequest",
              },
            } satisfies PermissionAllowDecision;
          }
          if (result.behavior === "deny") {
            opts.logDecisionSink?.({
              requestId: opts.requestId,
              toolName: opts.tool.name,
              source: { type: "hook" as const },
            });
            if (result.interrupt === true) {
              opts.abortController.abort();
            }
            return {
              behavior: "deny" as const,
              message: result.message ?? "Permission denied by hook",
              decisionReason: {
                type: "hook" as const,
                hookName: "PermissionRequest",
                reason: result.message,
              },
            } satisfies PermissionDenyDecision;
          }
        }
      }
      return null;
    },

    buildAllow(decision) {
      return { ...decision, behavior: "allow" as const } as PermissionAllowDecision;
    },

    buildDeny(decision) {
      return { ...decision, behavior: "deny" as const } as PermissionDenyDecision;
    },

    handleUserAllow(input, source) {
      const userModified =
        typeof opts.tool.inputsEquivalent === "function"
          ? !opts.tool.inputsEquivalent(opts.input, input)
          : false;
      opts.logDecisionSink?.({
        requestId: opts.requestId,
        toolName: opts.tool.name,
        source,
      });
      return {
        behavior: "allow" as const,
        updatedInput: (input as Record<string, unknown>) ?? undefined,
        userModified,
      };
    },

    handleHookAllow(input, source) {
      opts.logDecisionSink?.({
        requestId: opts.requestId,
        toolName: opts.tool.name,
        source,
      });
      return {
        behavior: "allow" as const,
        updatedInput: (input as Record<string, unknown>) ?? undefined,
        userModified: false,
        decisionReason: { type: "hook" as const, hookName: "PermissionRequest" },
      };
    },
  };

  return Object.freeze(ctx);
}
