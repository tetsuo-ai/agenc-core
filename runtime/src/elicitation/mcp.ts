/**
 * Ports the donor runtime's MCP elicitation callback handling onto the
 * AgenC MCP client and session boundary.
 *
 * Why this lives here / shape difference from upstream:
 *   - The donor keeps the pending responder map inside its MCP service.
 *     AgenC keeps pending responders on `ActiveTurnState`, so this file
 *     translates SDK requests and delegates waiting to `Session`.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Realtime audio pause plumbing beyond the session's existing
 *     `outOfBandElicitationPaused` subject.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { ApprovalPolicy } from "../session/turn-context.js";
import type { MCPElicitationHandlers } from "../mcp-client/types.js";
import { asRecord } from "../utils/record.js";
import {
  type McpElicitationCompleteEvent,
  type McpElicitationFormRequest,
  type McpElicitationRequest,
  type McpElicitationResponse,
  type McpElicitationUrlRequest,
  type McpPrimitiveSchemaDefinition,
  type McpRequestId,
} from "./types.js";

const MCP_PROGRESS_TOKEN_META_KEY = "progressToken";
const MAX_MCP_ELICITATION_MESSAGE_BYTES = 4096;
const MAX_MCP_ELICITATION_URL_BYTES = 4096;
const MAX_MCP_ELICITATION_ID_BYTES = 256;
const MAX_MCP_ELICITATION_META_BYTES = 8192;
const MAX_MCP_ELICITATION_META_ENTRIES = 32;
const MAX_MCP_ELICITATION_PROPERTIES = 32;
const MAX_MCP_ELICITATION_REQUIRED_FIELDS = 32;
const MAX_MCP_ELICITATION_KEY_BYTES = 128;
const MAX_MCP_ELICITATION_SCHEMA_TEXT_BYTES = 1024;
const MAX_MCP_ELICITATION_ENUM_VALUES = 64;
const MCP_PRIMITIVE_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
]);

export interface McpGranularElicitationPolicy {
  allowsMcpElicitations(): boolean;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`MCP elicitation request requires ${field}`);
  }
  return value;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertMaxBytes(value: string, field: string, maxBytes: number): void {
  if (byteLength(value) > maxBytes) {
    throw new Error(
      `MCP elicitation request ${field} exceeds ${maxBytes} bytes`,
    );
  }
}

function requiredBoundedString(
  value: unknown,
  field: string,
  maxBytes: number,
): string {
  const text = requiredString(value, field);
  assertMaxBytes(text, field, maxBytes);
  return text;
}

function validateOptionalBoundedString(
  value: unknown,
  field: string,
  maxBytes = MAX_MCP_ELICITATION_SCHEMA_TEXT_BYTES,
): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new Error(`MCP elicitation request requires ${field} to be a string`);
  }
  assertMaxBytes(value, field, maxBytes);
}

function validateOptionalStringArray(
  value: unknown,
  field: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`MCP elicitation request requires ${field} to be an array`);
  }
  if (value.length > MAX_MCP_ELICITATION_ENUM_VALUES) {
    throw new Error(
      `MCP elicitation request ${field} exceeds ${MAX_MCP_ELICITATION_ENUM_VALUES} entries`,
    );
  }
  for (const [index, item] of value.entries()) {
    requiredBoundedString(
      item,
      `${field}.${index}`,
      MAX_MCP_ELICITATION_SCHEMA_TEXT_BYTES,
    );
  }
}

function boundedHttpUrl(value: unknown, field: string): string {
  const urlText = requiredBoundedString(
    value,
    field,
    MAX_MCP_ELICITATION_URL_BYTES,
  );
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    throw new Error(`MCP elicitation request requires ${field} to be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`MCP elicitation request requires ${field} to use http or https`);
  }
  return urlText;
}

function validateMetaBounds(meta: Record<string, unknown>): void {
  const entries = Object.entries(meta);
  if (entries.length > MAX_MCP_ELICITATION_META_ENTRIES) {
    throw new Error(
      `MCP elicitation request _meta exceeds ${MAX_MCP_ELICITATION_META_ENTRIES} entries`,
    );
  }
  for (const [key] of entries) {
    assertMaxBytes(key, `_meta.${key}`, MAX_MCP_ELICITATION_KEY_BYTES);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(meta) ?? "{}";
  } catch {
    throw new Error("MCP elicitation request requires _meta to be JSON serializable");
  }
  assertMaxBytes(serialized, "_meta", MAX_MCP_ELICITATION_META_BYTES);
}

function filteredContextMeta(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const filtered: Record<string, unknown> = {};
  for (const [key, metaValue] of Object.entries(record)) {
    if (key !== MCP_PROGRESS_TOKEN_META_KEY) {
      filtered[key] = metaValue;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

function mergeMeta(
  rawMeta: unknown,
  contextMeta: unknown,
): Record<string, unknown> | undefined {
  const direct = asRecord(rawMeta);
  const context = filteredContextMeta(contextMeta);
  if (direct === null && context === null) return undefined;
  const meta = {
    ...(direct ?? {}),
    ...(context ?? {}),
  };
  validateMetaBounds(meta);
  return meta;
}

function normalizePrimitiveSchema(
  value: unknown,
  field = "requestedSchema.properties",
): McpPrimitiveSchemaDefinition {
  const record = asRecord(value);
  if (record === null) {
    throw new Error(`MCP elicitation request requires ${field} entries to be objects`);
  }
  if (
    typeof record.type !== "string" ||
    !MCP_PRIMITIVE_SCHEMA_TYPES.has(record.type)
  ) {
    throw new Error(`MCP elicitation request requires ${field}.type to be valid`);
  }
  validateOptionalBoundedString(record.title, `${field}.title`);
  validateOptionalBoundedString(record.description, `${field}.description`);
  if (record.type === "array") {
    const items = asRecord(record.items);
    if (items === null) {
      throw new Error(
        `MCP elicitation request requires ${field}.items to be an object`,
      );
    }
    if (
      items.type !== undefined &&
      items.type !== "string"
    ) {
      throw new Error(
        `MCP elicitation request requires ${field}.items.type to be string`,
      );
    }
    if (items.type !== "string" && items.anyOf === undefined) {
      throw new Error(
        `MCP elicitation request requires ${field}.items.type or ${field}.items.anyOf`,
      );
    }
    validateOptionalStringArray(items.enum, `${field}.items.enum`);
    validateOptionalStringArray(items.enumNames, `${field}.items.enumNames`);
    validateTitledEnum(items.anyOf, `${field}.items.anyOf`);
  } else {
    if (record.type === "string") {
      validateOptionalBoundedString(record.format, `${field}.format`);
      validateOptionalStringArray(record.enum, `${field}.enum`);
      validateOptionalStringArray(record.enumNames, `${field}.enumNames`);
    }
    validateTitledEnum(record.oneOf, `${field}.oneOf`);
    validateTitledEnum(record.anyOf, `${field}.anyOf`);
  }
  return record as unknown as McpPrimitiveSchemaDefinition;
}

function validateTitledEnum(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`MCP elicitation request requires ${field} to be an array`);
  }
  if (value.length > MAX_MCP_ELICITATION_ENUM_VALUES) {
    throw new Error(
      `MCP elicitation request ${field} exceeds ${MAX_MCP_ELICITATION_ENUM_VALUES} entries`,
    );
  }
  for (const [index, raw] of value.entries()) {
    const option = asRecord(raw);
    if (option === null || typeof option.const !== "string") {
      throw new Error(`MCP elicitation request requires ${field}.${index}.const`);
    }
    assertMaxBytes(
      option.const,
      `${field}.${index}.const`,
      MAX_MCP_ELICITATION_SCHEMA_TEXT_BYTES,
    );
    validateOptionalBoundedString(option.title, `${field}.${index}.title`);
    validateOptionalBoundedString(
      option.description,
      `${field}.${index}.description`,
    );
  }
}

function normalizeRequestedSchema(value: unknown): McpElicitationFormRequest["requestedSchema"] {
  const record = asRecord(value);
  if (record === null || record.type !== "object") {
    throw new Error("MCP elicitation request requires requestedSchema.type object");
  }
  const rawProperties = asRecord(record.properties);
  if (rawProperties === null) {
    throw new Error("MCP elicitation request requires requestedSchema.properties");
  }
  const propertyEntries = Object.entries(rawProperties);
  if (propertyEntries.length > MAX_MCP_ELICITATION_PROPERTIES) {
    throw new Error(
      `MCP elicitation request requestedSchema.properties exceeds ${MAX_MCP_ELICITATION_PROPERTIES} entries`,
    );
  }
  const properties: Record<string, McpPrimitiveSchemaDefinition> = {};
  for (const [key, rawSchema] of propertyEntries) {
    if (key.length === 0) {
      throw new Error("MCP elicitation request requires requestedSchema.properties keys to be non-empty");
    }
    assertMaxBytes(
      key,
      `requestedSchema.properties.${key}`,
      MAX_MCP_ELICITATION_KEY_BYTES,
    );
    properties[key] = normalizePrimitiveSchema(
      rawSchema,
      `requestedSchema.properties.${key}`,
    );
  }
  if (
    record.required !== undefined &&
    (
      !Array.isArray(record.required) ||
      !record.required.every((item) => typeof item === "string")
    )
  ) {
    throw new Error("MCP elicitation request requires requestedSchema.required to be strings");
  }
  if (
    Array.isArray(record.required) &&
    record.required.length > MAX_MCP_ELICITATION_REQUIRED_FIELDS
  ) {
    throw new Error(
      `MCP elicitation request requestedSchema.required exceeds ${MAX_MCP_ELICITATION_REQUIRED_FIELDS} entries`,
    );
  }
  const required = Array.isArray(record.required)
    ? record.required.map((item, index) => {
        assertMaxBytes(
          item,
          `requestedSchema.required.${index}`,
          MAX_MCP_ELICITATION_KEY_BYTES,
        );
        return item;
      })
    : undefined;
  return {
    type: "object",
    properties,
    ...(required !== undefined ? { required } : {}),
  };
}

export function normalizeMcpElicitationRequestParams(
  raw: unknown,
  contextMeta?: unknown,
): McpElicitationRequest {
  const record = asRecord(raw);
  if (record === null) {
    throw new Error("MCP elicitation request params must be an object");
  }
  if (
    record.mode !== undefined &&
    record.mode !== "form" &&
    record.mode !== "url"
  ) {
    throw new Error("MCP elicitation request mode must be form or url");
  }
  const meta = mergeMeta(record._meta, contextMeta);
  if (record.mode === "url") {
    const request: McpElicitationUrlRequest = {
      mode: "url",
      message: requiredBoundedString(
        record.message,
        "message",
        MAX_MCP_ELICITATION_MESSAGE_BYTES,
      ),
      elicitationId: requiredBoundedString(
        record.elicitationId,
        "elicitationId",
        MAX_MCP_ELICITATION_ID_BYTES,
      ),
      url: boundedHttpUrl(record.url, "url"),
      ...(meta !== undefined ? { meta } : {}),
    };
    return request;
  }
  const requestedSchema = normalizeRequestedSchema(record.requestedSchema);
  const request: McpElicitationFormRequest = {
    mode: "form",
    message: requiredBoundedString(
      record.message,
      "message",
      MAX_MCP_ELICITATION_MESSAGE_BYTES,
    ),
    requestedSchema,
    ...(meta !== undefined ? { meta } : {}),
  };
  return request;
}

export function restoreMcpElicitationContextMeta(
  request: McpElicitationRequest,
  contextMeta: unknown,
): McpElicitationRequest {
  const meta = mergeMeta(request.meta, contextMeta);
  if (meta === undefined) return request;
  return {
    ...request,
    meta,
  };
}

export function serializeMcpElicitationResponse(
  response: McpElicitationResponse,
): Record<string, unknown> {
  return {
    action: response.action,
    ...(response.content !== undefined ? { content: response.content } : {}),
    ...(response.meta !== undefined ? { _meta: response.meta } : {}),
  };
}

export function canAutoAcceptMcpElicitation(
  request: McpElicitationRequest,
): boolean {
  return request.mode === "form" &&
    Object.keys(request.requestedSchema.properties).length === 0;
}

export function mcpElicitationAutoAcceptedByPolicy(
  request: McpElicitationRequest,
  policy: ApprovalPolicy,
  granularConfig?: McpGranularElicitationPolicy,
): boolean {
  return canAutoAcceptMcpElicitation(request) &&
    policy === "granular" &&
    granularConfig?.allowsMcpElicitations() === true;
}

export function mcpElicitationRejectedByPolicy(
  policy: ApprovalPolicy,
  granularConfig?: McpGranularElicitationPolicy,
): boolean {
  switch (policy) {
    case "never":
      return true;
    case "granular":
      return granularConfig?.allowsMcpElicitations() !== true;
    case "on_failure":
    case "on_request":
    case "untrusted":
      return false;
  }
}

function requestIdFromParams(
  params: Record<string, unknown> | null,
  fallback: unknown,
): McpRequestId {
  const urlId = params?.mode === "url" ? params.elicitationId : undefined;
  if (typeof urlId === "string" && urlId.length > 0) return urlId;
  if (typeof fallback === "string" || typeof fallback === "number") {
    return fallback;
  }
  return `elicitation-${Date.now().toString(36)}`;
}

function completeEventFromNotification(
  serverName: string,
  notification: unknown,
): McpElicitationCompleteEvent | null {
  const record = asRecord(notification);
  const params = asRecord(record?.params);
  const elicitationId = params?.elicitationId;
  if (typeof elicitationId !== "string" || elicitationId.length === 0) {
    return null;
  }
  return { serverName, elicitationId };
}

export async function configureMcpElicitationClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  serverName: string,
  handlers: MCPElicitationHandlers | undefined,
): Promise<void> {
  if (handlers === undefined) return;
  if (
    typeof client?.setRequestHandler !== "function" ||
    typeof client?.setNotificationHandler !== "function"
  ) {
    return;
  }
  const {
    ElicitRequestSchema,
    ElicitationCompleteNotificationSchema,
  } = await import("@modelcontextprotocol/sdk/types.js");
  client.setRequestHandler(
    ElicitRequestSchema,
    async (request: unknown, extra: unknown) => {
      const requestRecord = asRecord(request);
      const params = asRecord(requestRecord?.params);
      const extraRecord = asRecord(extra);
      return handlers.handleRequest({
        serverName,
        requestId: requestIdFromParams(params, extraRecord?.requestId),
        request: requestRecord?.params,
        contextMeta: extraRecord?._meta,
        signal: extraRecord?.signal instanceof AbortSignal
          ? extraRecord.signal
          : undefined,
      });
    },
  );
  client.setNotificationHandler(
    ElicitationCompleteNotificationSchema,
    async (notification: unknown) => {
      const event = completeEventFromNotification(serverName, notification);
      if (event === null) return;
      await handlers.handleComplete?.({
        serverName: event.serverName,
        elicitationId: event.elicitationId,
        notification,
      });
    },
  );
}

function approvalPolicyForSession(session: Session): ApprovalPolicy {
  return session.sessionConfiguration.approvalPolicy.value;
}

export function createSessionMcpElicitationHandlers(
  session: Session,
  granularConfig?: McpGranularElicitationPolicy,
): MCPElicitationHandlers {
  return {
    async handleRequest(params) {
      const request = normalizeMcpElicitationRequestParams(
        params.request,
        params.contextMeta,
      );
      const policy = approvalPolicyForSession(session);
      if (mcpElicitationRejectedByPolicy(policy, granularConfig)) {
        return serializeMcpElicitationResponse({ action: "decline" });
      }
      if (
        mcpElicitationAutoAcceptedByPolicy(request, policy, granularConfig)
      ) {
        return serializeMcpElicitationResponse({
          action: "accept",
          content: {},
        });
      }
      const pendingRequestId = request.mode === "url"
        ? request.elicitationId
        : params.requestId;
      const response = await session.requestMcpElicitation(
        params.serverName,
        pendingRequestId,
        request,
        params.signal,
      );
      return serializeMcpElicitationResponse(
        response ?? { action: "cancel" },
      );
    },
    async handleComplete(params) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "mcp_elicitation_complete",
          payload: {
            serverName: params.serverName,
            elicitationId: params.elicitationId,
          },
        },
      });
      await session.notifyMcpElicitationResponse(
        params.serverName,
        params.elicitationId,
        { action: "accept" },
      );
    },
  };
}
