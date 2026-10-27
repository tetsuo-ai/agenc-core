import type { TokenAccountingResult } from "../llm/token-accounting.js";

/** The exact main-request input accounting used by the pre-dispatch gate.
 * Output is reported separately; it never changes this window denominator.
 * Runtime-only telemetry, never an authority or a durable history projection.
 */
export interface PreparedContextPressure {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly effectiveWindowTokens: number;
  readonly autoCompactThresholdTokens: number;
  readonly reservedOutputTokens: number;
  readonly source: TokenAccountingResult["source"];
  readonly measuredAtMs: number;
}

const pressureBySession = new WeakMap<object, PreparedContextPressure>();

export function recordPreparedContextPressure(session: object, value: PreparedContextPressure): void {
  pressureBySession.set(session, Object.freeze({ ...value }));
}

export function readPreparedContextPressure(session: object): PreparedContextPressure | undefined {
  return pressureBySession.get(session);
}

export function clearPreparedContextPressure(session: object): void {
  pressureBySession.delete(session);
}
