export function isTerminalDaemonErrorPayload(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { readonly terminal?: unknown }).terminal === true
  );
}
