import { AsyncLocalStorage } from "node:async_hooks";
import { validateExecutionIdentity } from "./identity.js";
import { ExecutionEnvironmentError, type ExecutionCallIdentity, type ExecutionOperationIdentity } from "./types.js";

interface ExecutionCallScope {
  readonly identity: ExecutionCallIdentity;
  readonly signal: AbortSignal;
  readonly crossEffectBoundary: () => void;
  nextIndex: number;
  active: boolean;
}

const executionCalls = new AsyncLocalStorage<ExecutionCallScope>();

/** Installed only after the canonical effect intent is durably committed. */
export async function withAdmittedExecutionCall<T>(
  identity: ExecutionCallIdentity,
  dispatch: { readonly signal: AbortSignal; readonly crossEffectBoundary: () => void },
  invoke: () => Promise<T>,
): Promise<T> {
  validateExecutionIdentity(identity);
  const scope: ExecutionCallScope = {
    identity: Object.freeze({ runId: identity.runId, callId: identity.callId, attempt: identity.attempt }),
    signal: dispatch.signal, crossEffectBoundary: dispatch.crossEffectBoundary, nextIndex: 0, active: true,
  };
  try {
    return await executionCalls.run(scope, invoke);
  } finally {
    // Detached async callbacks may still inherit AsyncLocalStorage. They cannot
    // turn an already-settled tool call into fresh execution authority.
    scope.active = false;
  }
}

export interface AdmittedExecutionOperation {
  readonly identity: ExecutionOperationIdentity;
  readonly signal: AbortSignal;
  readonly crossEffectBoundary: () => void;
}

/** Allocate a subordinate coordinate; this function never repeats an operation. */
export function prepareAdmittedExecutionOperation(): AdmittedExecutionOperation {
  const scope = executionCalls.getStore();
  const assertActive = (): void => {
    if (!scope?.active) throw new ExecutionEnvironmentError("missing_admission", "Task execution has no active admitted call", false);
    if (scope.signal.aborted) throw new ExecutionEnvironmentError("aborted", "Admitted task execution was cancelled before dispatch", false);
  };
  assertActive();
  const operationIndex = scope!.nextIndex++;
  if (!Number.isSafeInteger(operationIndex)) throw new ExecutionEnvironmentError("operation_limit", "Too many physical operations in one call", false);
  return Object.freeze({
    identity: Object.freeze({ ...scope!.identity, operationIndex }), signal: scope!.signal,
    crossEffectBoundary: () => { assertActive(); scope!.crossEffectBoundary(); },
  });
}
