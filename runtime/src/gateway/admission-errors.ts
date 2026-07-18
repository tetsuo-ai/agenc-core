/**
 * Recognize an execution-admission refusal after it crosses the daemon SDK
 * boundary. JSON-RPC preserves structured `data` when available, while older
 * transports expose only the canonical error message.
 */
export function isExecutionAdmissionDenied(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return /execution admission (?:deny|approval_required|cancelled):/i.test(
      String(error),
    );
  }
  const record = error as {
    readonly code?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
    readonly data?: unknown;
    readonly cause?: unknown;
  };
  if (record.code === "ADMISSION_DENIED") return true;
  if (
    typeof record.message === "string" &&
    /execution admission (?:deny|approval_required|cancelled):/i.test(
      record.message,
    )
  ) {
    return true;
  }
  return (
    (record.data !== error && isExecutionAdmissionDenied(record.data)) ||
    (record.cause !== error && isExecutionAdmissionDenied(record.cause))
  );
}

export function executionAdmissionErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const reason = (error as { readonly reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
    const data = (error as { readonly data?: unknown }).data;
    if (data !== error && isExecutionAdmissionDenied(data)) {
      return executionAdmissionErrorMessage(data);
    }
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}
