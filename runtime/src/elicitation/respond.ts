/**
 * Client response helpers for pending user-input and MCP elicitation requests.
 *
 * Why this lives here / shape difference from upstream:
 *   - The donor routes responses through protocol-specific handler methods.
 *     AgenC exposes one small response adapter so daemon, TUI, and tests can
 *     resolve the same session pending maps without duplicating validation.
 *
 * Cross-cuts deliberately NOT carried:
 *   - UI rendering. This file only validates and forwards completed answers.
 *
 * @module
 */

import type {
  McpElicitationAction,
  McpElicitationResponse,
  McpRequestId,
  RequestUserInputAnswer,
  RequestUserInputResponse,
} from "./types.js";
import { asRecord } from "../utils/record.js";

export type ElicitationResponseKind = "request_user_input" | "mcp";

export interface SessionElicitationResponseParams {
  readonly kind: ElicitationResponseKind;
  readonly requestId: McpRequestId;
  readonly serverName?: string;
  readonly response: unknown;
}

export interface SessionElicitationResponder {
  notifyUserInputResponse(
    requestId: string,
    response: RequestUserInputResponse | null,
  ): Promise<boolean>;
  notifyMcpElicitationResponse(
    serverName: string,
    requestId: McpRequestId,
    response: McpElicitationResponse,
  ): Promise<boolean>;
}

function readStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function normalizeUserInputAnswer(
  value: unknown,
  field: string,
): RequestUserInputAnswer {
  const record = asRecord(value);
  if (record === null) {
    throw new Error(`${field} must be an object`);
  }
  return { answers: readStringArray(record.answers, `${field}.answers`) };
}

export function normalizeRequestUserInputResponse(
  value: unknown,
): RequestUserInputResponse | null {
  const record = asRecord(value);
  if (record?.action === "cancel") {
    return null;
  }
  const answers = asRecord(record?.answers);
  if (answers === null) {
    throw new Error("request_user_input response requires answers");
  }
  const normalized: Record<string, RequestUserInputAnswer> = {};
  for (const [id, answer] of Object.entries(answers)) {
    normalized[id] = normalizeUserInputAnswer(answer, `answers.${id}`);
  }
  return { answers: normalized };
}

function normalizeMcpAction(value: unknown): McpElicitationAction {
  if (value === "accept" || value === "decline" || value === "cancel") {
    return value;
  }
  throw new Error("MCP elicitation response action must be accept, decline, or cancel");
}

function isMcpContentValue(
  value: unknown,
): value is string | number | boolean | readonly string[] {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    );
}

function normalizeMcpContent(
  value: unknown,
): McpElicitationResponse["content"] {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (record === null) {
    throw new Error("MCP elicitation response content must be an object");
  }
  for (const [key, contentValue] of Object.entries(record)) {
    if (!isMcpContentValue(contentValue)) {
      throw new Error(
        `MCP elicitation response content.${key} must be string, number, boolean, or string[]`,
      );
    }
  }
  return record as McpElicitationResponse["content"];
}

export function normalizeMcpElicitationResponse(
  value: unknown,
): McpElicitationResponse {
  const record = asRecord(value);
  if (record === null) {
    throw new Error("MCP elicitation response must be an object");
  }
  return {
    action: normalizeMcpAction(record.action),
    ...(record.content !== undefined
      ? { content: normalizeMcpContent(record.content) }
      : {}),
    ...(record._meta !== undefined
      ? { meta: record._meta }
      : record.meta !== undefined
        ? { meta: record.meta }
        : {}),
  };
}

export async function respondToSessionElicitation(
  session: Pick<
    SessionElicitationResponder,
    "notifyUserInputResponse" | "notifyMcpElicitationResponse"
  >,
  params: SessionElicitationResponseParams,
): Promise<boolean> {
  if (params.kind === "request_user_input") {
    return session.notifyUserInputResponse(
      String(params.requestId),
      normalizeRequestUserInputResponse(params.response),
    );
  }
  if (typeof params.serverName !== "string" || params.serverName.length === 0) {
    throw new Error("MCP elicitation response requires serverName");
  }
  return session.notifyMcpElicitationResponse(
    params.serverName,
    params.requestId,
    normalizeMcpElicitationResponse(params.response),
  );
}
