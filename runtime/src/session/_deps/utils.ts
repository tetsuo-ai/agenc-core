export { monotonicMs } from "../../utils/monotonic.js";
export { AsyncLock } from "../../utils/async-lock.js";
export { AsyncQueue } from "../../utils/async-queue.js";
export { BehaviorSubject } from "../../utils/behavior-subject.js";

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function hasExactErrorMessage(error: unknown, message: string): boolean {
  return errorMessage(error) === message;
}

export function logError(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(error);
}
