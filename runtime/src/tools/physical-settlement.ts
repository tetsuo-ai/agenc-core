export type CallerStopKind = "timeout" | "abort";

export interface PendingPhysicalSettlement<T> {
  readonly callerStop: CallerStopKind;
  readonly callerStoppedAt: string;
  readonly settlement: Promise<T>;
}

const PENDING_SETTLEMENTS = new WeakMap<object, PendingPhysicalSettlement<unknown>>();

export function attachPendingPhysicalSettlement<T>(
  error: object,
  pending: PendingPhysicalSettlement<T>,
): void {
  PENDING_SETTLEMENTS.set(error, pending);
}

export function readPendingPhysicalSettlement<T>(
  error: unknown,
): PendingPhysicalSettlement<T> | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return undefined;
  }
  return PENDING_SETTLEMENTS.get(error) as
    | PendingPhysicalSettlement<T>
    | undefined;
}
