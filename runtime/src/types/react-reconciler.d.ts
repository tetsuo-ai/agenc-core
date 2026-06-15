declare module 'react-reconciler' {
  import type { ReactNode } from 'react';

  export interface FiberRoot {
    readonly current: unknown;
  }

  export interface DevToolsConfig {
    readonly bundleType: 0 | 1;
    readonly version: string;
    readonly rendererPackageName: string;
  }

  export interface ReconcilerInstance {
    createContainer(
      containerInfo: unknown,
      tag: number,
      hydrationCallbacks: null,
      isStrictMode: boolean,
      concurrentUpdatesByDefaultOverride: null,
      identifierPrefix: string,
      onUncaughtError: (error: unknown) => void,
      onCaughtError: (error: unknown) => void,
      onRecoverableError: (error: unknown) => void,
      onDefaultTransitionIndicator: ((error?: unknown) => void) | null,
    ): FiberRoot;
    updateContainerSync(
      element: ReactNode | null,
      container: FiberRoot,
      parentComponent: unknown,
      callback: (() => void) | null,
    ): number;
    flushSyncWork(): boolean;
    flushSyncFromReconciler<T>(fn?: () => T): T | void;
    injectIntoDevTools(config: DevToolsConfig): boolean;
    discreteUpdates<A, B, C, D, R>(
      fn: (a: A, b: B, c: C, d: D) => R,
      a: A,
      b: B,
      c: C,
      d: D,
    ): R;
  }

  const createReconciler: (hostConfig: unknown) => ReconcilerInstance;
  export default createReconciler;
}

declare module 'react-reconciler/constants.js' {
  export const LegacyRoot: 0;
  export const ContinuousEventPriority: 8;
  export const DefaultEventPriority: 32;
  export const DiscreteEventPriority: 2;
}
