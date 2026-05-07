export const REDACTED_MCP_VALUE = "<redacted>";

export function redactMcpDisplayValue(_key: string, _value: unknown): string {
  return REDACTED_MCP_VALUE;
}
