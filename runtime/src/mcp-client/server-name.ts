/**
 * Canonical validation for outbound MCP server identifiers.
 *
 * Server names are embedded in the runtime tool identity
 * `mcp.<server>.<tool>`, so `.` is reserved as the namespace delimiter.
 * `:` remains available for AgenC's plugin-scoped server identifiers.
 */

import { MAX_SERVER_IDENTIFIER_LENGTH } from "../identifiers/server-name.js";

export const MAX_MCP_SERVER_NAME_LENGTH = MAX_SERVER_IDENTIFIER_LENGTH;

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9:_-]+$/u;

export function mcpServerNameValidationIssue(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return "must be a string";
  if (value.length === 0) return "must not be empty";
  if (value.length > MAX_MCP_SERVER_NAME_LENGTH) {
    return `must be at most ${MAX_MCP_SERVER_NAME_LENGTH} characters`;
  }
  if (!MCP_SERVER_NAME_PATTERN.test(value)) {
    return "must contain only ASCII letters, numbers, colons, hyphens, and underscores";
  }
  return undefined;
}

export function isValidMcpServerName(value: unknown): value is string {
  return mcpServerNameValidationIssue(value) === undefined;
}

export function assertValidMcpServerName(
  value: unknown,
): asserts value is string {
  const issue = mcpServerNameValidationIssue(value);
  if (issue !== undefined) {
    throw new Error(`Invalid MCP server name: ${issue}`);
  }
}
