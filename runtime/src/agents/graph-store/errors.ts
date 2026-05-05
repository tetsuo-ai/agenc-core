export type AgentGraphStoreErrorKind = "invalid_request" | "internal";

export class AgentGraphStoreError extends Error {
  readonly kind: AgentGraphStoreErrorKind;

  private constructor(kind: AgentGraphStoreErrorKind, message: string) {
    super(message);
    this.name = "AgentGraphStoreError";
    this.kind = kind;
  }

  static invalidRequest(message: string): AgentGraphStoreError {
    return new AgentGraphStoreError(
      "invalid_request",
      `invalid agent graph store request: ${message}`,
    );
  }

  static internal(cause: unknown): AgentGraphStoreError {
    return new AgentGraphStoreError(
      "internal",
      `agent graph store internal error: ${messageFromUnknown(cause)}`,
    );
  }
}

function messageFromUnknown(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
