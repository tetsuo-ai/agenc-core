/** Non-executable feedback for a known function emitted with invalid arguments. */
import { Ajv } from "ajv";
import type { LLMTool } from "../../types.js";
import { decodeMcpToolNameFromWire } from "../../wire/mcp-tool-naming.js";
import { standaloneTextToolCallCandidate } from "./salvage-tool-calls.js";

export interface RejectedTextToolCall {
  readonly toolName: string;
  readonly reason: "invalid_arguments" | "not_advertised";
  readonly message: string;
}

const MAX_CHARS = 1_048_576;
const MAX_CALLS = 64;
const MAX_DEPTH = 64;
const MCP_NAME = /^mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;

function unloadedMcpName(name: string): string | undefined {
  try {
    const canonical = decodeMcpToolNameFromWire(name);
    return canonical.length <= 256 && MCP_NAME.test(canonical) ? canonical : undefined;
  } catch { return undefined; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedValue(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > MAX_DEPTH) return false;
    if (typeof current.value === "number" && !Number.isFinite(current.value)) return false;
    if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

/**
 * Diagnose only an entire JSON reply matching the narrow invocation envelope.
 * A single JSON/bare fence already accepted by salvage is eligible only for
 * exact advertised names. Surrounding prose, arbitrary unknown names, malformed
 * JSON and unsupported schemas are not reinterpreted. An unloaded MCP name in
 * plain JSON may
 * receive discovery feedback, never authority to execute. This returns no tool call and
 * must never be dispatched: the turn loop may ask for a corrected response
 * through a separately admitted sample, subject to its retry bound.
 */
export function diagnoseRejectedTextToolCall(
  content: string,
  tools: readonly LLMTool[] | undefined,
): RejectedTextToolCall | undefined {
  if (!tools?.length || content.length > MAX_CHARS) return undefined;
  const trimmed = content.trim();
  const plainJson = trimmed[0] === "{" || trimmed[0] === "[";
  const text = plainJson ? trimmed : standaloneTextToolCallCandidate(content);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return undefined; }
  if (!boundedValue(parsed)) return undefined;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (!entries.length || entries.length > MAX_CALLS) return undefined;
  const catalog = new Map(tools.map(tool => [tool.function.name, tool]));
  // Fenced diagnostics do not expand the unloaded-MCP discovery protocol.
  const discoveryAvailable = plainJson && catalog.has("system.searchTools");
  const candidates: Array<{ name: string; args: unknown; tool?: LLMTool }> = [];
  for (const entry of entries) {
    if (!record(entry) || Object.keys(entry).some(key => !["name", "arguments", "parameters"].includes(key))) return undefined;
    if ("arguments" in entry && "parameters" in entry) return undefined;
    if (typeof entry.name !== "string" || entry.name.length > 256) return undefined;
    const tool = catalog.get(entry.name);
    const unloadedName = !tool && discoveryAvailable ? unloadedMcpName(entry.name) : undefined;
    if (!tool && !unloadedName) return undefined;
    let args = "arguments" in entry ? entry.arguments : "parameters" in entry ? entry.parameters : {};
    if (typeof args === "string") {
      try { args = JSON.parse(args) as unknown; } catch {
        // Only an exact advertised identity can receive shape correction.
        // The string remains data; never invent or coerce replacement args.
        if (!tool) return undefined;
      }
    }
    if (!boundedValue(args) || (!tool && !record(args))) return undefined;
    candidates.push({ name: unloadedName ?? entry.name, args, tool });
  }
  const ajv = new Ajv({ strict: false, validateFormats: false, ownProperties: true });
  for (const { name, args, tool } of candidates) {
    if (!tool) {
      return { toolName: name, reason: "not_advertised", message: "This MCP function is not in the current request. Discover and load the exact function with system.searchTools before calling it." };
    }
    try {
      const validate = ajv.compile(tool.function.parameters);
      if (!record(args)) {
        return { toolName: name, reason: "invalid_arguments", message: "Arguments must be a JSON object matching the advertised schema." };
      }
      if (validate(args)) continue;
      // JSON quoting keeps property paths/error text data rather than prompt
      // instructions. Never include argument values or the rejected payload.
      const issues = (validate.errors ?? []).slice(0, 3).map(error => ({
        path: error.instancePath.slice(0, 160),
        issue: (error.message ?? error.keyword).slice(0, 200),
      }));
      return { toolName: name, reason: "invalid_arguments", message: `Arguments did not match the advertised schema: ${JSON.stringify(issues)}` };
    } catch {
      // If the schema cannot be validated, no speculative correction protocol.
      return undefined;
    }
  }
  return undefined;
}
