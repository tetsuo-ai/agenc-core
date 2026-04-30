import React from "react";

import { Box, Text } from "../../agenc/upstream/ink.js";

type SafeParseResult =
  | { readonly success: true; readonly data: Record<string, unknown> }
  | { readonly success: false; readonly error: Error };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectFromUnknown(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function shortJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    if (text.length <= 140) return text;
    return `${text.slice(0, 137)}...`;
  } catch {
    return String(value);
  }
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(resultText).join("\n");
  if (isRecord(value) && typeof value.content === "string") return value.content;
  return shortJson(value);
}

export function createBridgeTool(name: string): any {
  return {
    name,
    aliases: [],
    maxResultSizeChars: Infinity,
    inputSchema: {
      safeParse(input: unknown): SafeParseResult {
        return { success: true, data: objectFromUnknown(input) };
      },
    },
    async call() {
      return { result: undefined };
    },
    async description() {
      return name;
    },
    async prompt() {
      return `${name} is provided by the AgenC runtime bridge.`;
    },
    async checkPermissions() {
      return { behavior: "ask", message: `Permission required to use ${name}` };
    },
    isConcurrencySafe() {
      return false;
    },
    isEnabled() {
      return true;
    },
    isReadOnly() {
      return false;
    },
    isDestructive() {
      return false;
    },
    toAutoClassifierInput(input: unknown) {
      return input;
    },
    userFacingName() {
      return name;
    },
    getActivityDescription(input: unknown) {
      return `${name} ${shortJson(input)}`;
    },
    renderToolUseMessage(input: unknown) {
      const summary = shortJson(input);
      return summary.length > 0 ? summary : name;
    },
    renderToolResultMessage(content: unknown) {
      const text = resultText(content);
      return (
        <Box flexDirection="column">
          <Text>{text}</Text>
        </Box>
      );
    },
    mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string) {
      return {
        type: "tool_result",
        tool_use_id: toolUseID,
        content: resultText(content),
      };
    },
  };
}

export function createBridgeTools(names: Iterable<string>): readonly any[] {
  const unique = new Set<string>([
    "Bash",
    "Task",
    "Agent",
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
    "MCP",
  ]);
  for (const name of names) {
    if (name.trim().length > 0) unique.add(name);
  }
  return [...unique].sort().map(createBridgeTool);
}
