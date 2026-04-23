/**
 * Lean stub for the context-collapse runtime service that
 * `Session` injects as a default into `services.contextCollapse`.
 *
 * The openclaude port owns a full collapse-and-resume archival
 * subsystem. The gut runtime does not implement collapse, so this
 * stub returns the disabled-path values: messages pass through,
 * stats stay empty, and `recoverFromOverflow` is a pass-through.
 * Callers may inject their own implementation via the session
 * services bag if they actually want collapse behavior.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

const EMPTY_STATS = Object.freeze({
  collapsedSpans: 0,
  collapsedMessages: 0,
  stagedSpans: 0,
  health: Object.freeze({
    totalSpawns: 0,
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
  }),
});

const EMPTY_STATE = Object.freeze({
  commits: [],
  staged: [],
  armed: false,
  lastSpawnTokens: 0,
});

export const contextCollapseService = Object.freeze({
  isContextCollapseEnabled: () => false,
  isEnabled: () => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getContextCollapseState: () => EMPTY_STATE as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStats: () => EMPTY_STATS as any,
  subscribe: (_listener: () => void) => () => {},
  resetContextCollapse: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ..._args: any[]
  ): void => {},
  maybeCollapseContext: (
    messages: ReadonlyArray<AnyMessage>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _ctx?: any,
  ): ReadonlyArray<AnyMessage> => messages,
  recoverFromOverflow: (
    messages: ReadonlyArray<AnyMessage>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _querySource?: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _ctx?: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => ({ messages, recovered: false }) as any,
});
