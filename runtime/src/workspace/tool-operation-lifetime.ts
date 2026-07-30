import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkspaceOperationLifetime {
  retain(): () => void;
  release(): Promise<void>;
  settled(): Promise<void>;
}

type WorkspaceOperationLifetimeContext = {
  readonly retain: () => () => void;
};

const operationLifetimeStorage =
  new AsyncLocalStorage<WorkspaceOperationLifetimeContext>();

/**
 * Keep a workspace fence alive across a supervised process that outlives the
 * tool call which created it. Callers must invoke the returned release exactly
 * once when that process/task reaches a terminal state.
 */
export function retainCurrentWorkspaceOperation(): () => void {
  return operationLifetimeStorage.getStore()?.retain() ?? (() => {});
}

export function hasCurrentWorkspaceOperationLifetime(): boolean {
  return operationLifetimeStorage.getStore() !== undefined;
}

export function runWithWorkspaceOperationLifetime<T>(
  lifetime: WorkspaceOperationLifetimeContext,
  operation: () => Promise<T>,
): Promise<T> {
  return operationLifetimeStorage.run(lifetime, operation);
}

export function createWorkspaceOperationLifetime(
  onSettled: () => Promise<void> | void,
): WorkspaceOperationLifetime {
  let references = 1;
  let settling: Promise<void> | null = null;
  let ownerReleased = false;
  let resolveSettled: (() => void) | null = null;
  let rejectSettled: ((error: unknown) => void) | null = null;
  const settledPromise = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });

  const settleIfReleased = (): Promise<void> => {
    if (references !== 0) return Promise.resolve();
    if (settling !== null) return settling;
    settling = Promise.resolve()
      .then(onSettled)
      .then(
        () => {
          resolveSettled?.();
        },
        (error) => {
          rejectSettled?.(error);
          throw error;
        },
      );
    return settling;
  };

  return {
    retain(): () => void {
      if (references === 0) {
        throw new Error("workspace operation lifetime is already settled");
      }
      references += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        references -= 1;
        void settleIfReleased().catch(() => {});
      };
    },
    release(): Promise<void> {
      if (!ownerReleased) {
        ownerReleased = true;
        references -= 1;
      }
      return settleIfReleased();
    },
    settled(): Promise<void> {
      return settledPromise;
    },
  };
}
