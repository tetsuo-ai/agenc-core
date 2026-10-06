import type { ToolInvocation, ToolPayload } from "./context.js";

export function buildPayloadForArgs(
  payload: ToolPayload,
  args: Record<string, unknown>,
): ToolPayload {
  const serialized = stringifyToolArgsWithBigInt(args);
  switch (payload.kind) {
    case "function":
      return { kind: "function", arguments: serialized };
    case "mcp":
      return {
        kind: "mcp",
        server: payload.server,
        tool: payload.tool,
        rawArguments: serialized,
      };
    case "custom":
    case "tool_search":
    case "local_shell":
      return payload;
  }
}

export function stringifyToolArgsWithBigInt(args: Record<string, unknown>): string {
  const { rawJSON } = JSON as typeof JSON & {
    rawJSON: (text: string) => unknown;
  };
  return JSON.stringify(args, (_key, value: unknown) =>
    typeof value === "bigint" ? rawJSON(value.toString()) : value,
  );
}

/** Execution-facing payload; the original invocation remains history provenance. */
export function invocationForArgs(
  invocation: ToolInvocation,
  args: Record<string, unknown>,
): ToolInvocation {
  return { ...invocation, payload: buildPayloadForArgs(invocation.payload, args) };
}
