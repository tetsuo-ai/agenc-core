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
  LedgerSolanaTransferClientResult,
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

function requiredString(
  record: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`clientResult.${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`clientResult.${field} must be a non-empty string when provided`);
  }
  return value;
}

const LEDGER_RESULT_FIELDS = new Set([
  "type",
  "intentId",
  "responseNonce",
  "status",
  "network",
  "to",
  "lamports",
  "from",
  "signature",
  "reason",
]);
const LEDGER_CANCELLATION_REASON = /^[a-z0-9_]{1,80}$/u;

function normalizeLedgerClientResult(
  value: unknown,
): LedgerSolanaTransferClientResult {
  const record = asRecord(value);
  if (record === null) {
    throw new Error("clientResult must be an object");
  }
  for (const key of Object.keys(record)) {
    if (!LEDGER_RESULT_FIELDS.has(key)) {
      throw new Error(`clientResult contains unsupported field: ${key}`);
    }
  }
  if (record.type !== "ledger_solana_transfer_receipt_v1") {
    throw new Error(
      "clientResult.type must be ledger_solana_transfer_receipt_v1",
    );
  }
  if (record.network !== "mainnet-beta") {
    throw new Error("clientResult.network must be mainnet-beta");
  }
  if (record.status !== "submitted" && record.status !== "cancelled") {
    throw new Error("clientResult.status must be submitted or cancelled");
  }
  const base = {
    type: record.type,
    intentId: requiredString(record, "intentId"),
    responseNonce: requiredString(record, "responseNonce"),
    status: record.status,
    network: record.network,
    to: requiredString(record, "to"),
    lamports: requiredString(record, "lamports"),
  } as const;
  const from = optionalString(record, "from");
  const signature = optionalString(record, "signature");
  const reason = optionalString(record, "reason");
  if (record.status === "submitted") {
    if (from === undefined || signature === undefined) {
      throw new Error(
        "submitted clientResult requires from and signature",
      );
    }
    if (reason !== undefined) {
      throw new Error("submitted clientResult cannot include reason");
    }
    return { ...base, status: "submitted", from, signature };
  }
  if (signature !== undefined) {
    throw new Error("cancelled clientResult cannot include signature");
  }
  if (reason === undefined || !LEDGER_CANCELLATION_REASON.test(reason)) {
    throw new Error(
      "cancelled clientResult.reason must match [a-z0-9_]{1,80}",
    );
  }
  return {
    ...base,
    status: "cancelled",
    ...(from !== undefined ? { from } : {}),
    reason,
  };
}

export function normalizeRequestUserInputResponse(
  value: unknown,
): RequestUserInputResponse | null {
  const record = asRecord(value);
  if (record?.action === "cancel") {
    return null;
  }
  const clientResult = record?.clientResult === undefined
    ? undefined
    : normalizeLedgerClientResult(record.clientResult);
  const answers = record?.answers === undefined
    ? null
    : asRecord(record.answers);
  if (answers === null && clientResult === undefined) {
    throw new Error("request_user_input response requires answers");
  }
  const normalized: Record<string, RequestUserInputAnswer> = {};
  for (const [id, answer] of Object.entries(answers ?? {})) {
    normalized[id] = normalizeUserInputAnswer(answer, `answers.${id}`);
  }
  return {
    answers: normalized,
    ...(clientResult !== undefined ? { clientResult } : {}),
  };
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
