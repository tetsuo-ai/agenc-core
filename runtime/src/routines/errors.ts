/** A routine request Core refused before changing anything; `code` is the stable public reason. */
export class RoutineError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RoutineError"; }
}
