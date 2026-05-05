export type HookCallbackMatcher = {
  readonly matcher?: string;
  readonly callback?: (...args: readonly unknown[]) => unknown;
};
