import type { ProcessBrokerV3Outcome } from "./process-broker-protocol-v3.js";

/** Only the private session executor can register these virtual process handles. */
export interface SessionProcessBoundary {
  alive(): boolean;
  settled: Promise<void>;
  outcome(): ProcessBrokerV3Outcome | undefined;
  terminate(): Promise<{
    readonly commandOutcome?: ProcessBrokerV3Outcome;
    readonly residualProcessesTerminated: boolean;
    readonly residualProcessesObserved?: boolean;
  }>;
}
export const sessionProcessBoundaries = new WeakMap<object, SessionProcessBoundary>();
