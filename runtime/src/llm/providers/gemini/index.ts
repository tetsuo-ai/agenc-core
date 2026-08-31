/**
 * Native Google Gemini provider module.
 *
 * @module
 */

import { ProviderHttpClient } from "../../client.js";
import {
  ProviderHttpError,
  type ProviderHttpStreamResponse,
} from "../../client-session.js";
import { parseSSEFrames } from "../../_deps/sse.js";
import { LLMProviderError } from "../../errors.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMProviderConfig,
  LLMRequestMetrics,
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
  LLMUsage,
  StreamProgressCallback,
} from "../../types.js";
import { validateToolCallDetailed } from "../../types.js";
import { coerceUsage } from "../../wire/shared.js";
import { isFallbackTriggeredError } from "../../../recovery/api-errors.js";
import {
  geminiCredentialHeaders,
  materializeGeminiCredentialPlan,
  type GeminiCredentialPlan,
} from "../../../utils/geminiAuth.js";
import {
  createTokenAccountingConfigurationRevision,
  type ProviderNativeTokenCountResult,
  type ProviderTokenCountCapability,
  type TokenAccountingRequest,
} from "../../token-accounting.js";
import { validateAgentInvocationMessageSequence } from "../../../contracts/agent-invocation-envelope.js";
import { providerApiKeyEnvironmentLabel } from "../../registry/provider-info.js";
import {
  canonicalGeminiModelName,
  geminiEndpointFor,
  type GeminiEndpointPlan,
} from "./endpoint-plan.js";

export interface GeminiProviderConfig extends Omit<LLMProviderConfig, "baseURL"> {
  readonly credentialPlan: GeminiCredentialPlan;
  readonly endpointPlan: GeminiEndpointPlan;
  readonly contextWindowTokens?: number;
  readonly cachedContent?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_GEMINI_MAX_OUTPUT_TOKENS = 4096;
const GEMINI_INVALID_FUNCTION_CALL_MESSAGE =
  "Gemini response emitted invalid functionCall";

type GeminiPart = Record<string, unknown>;
type GeminiThinkingBlock = NonNullable<LLMResponse["thinking"]>[number];

interface GeminiParsedResponse {
  readonly content: string;
  readonly toolCalls: readonly LLMToolCall[];
  readonly usage: LLMUsage;
  readonly model: string;
  readonly thinking?: LLMResponse["thinking"];
  readonly finishReason: LLMResponse["finishReason"];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function modelPath(
  model: string,
  operation: "generateContent" | "streamGenerateContent" | "countTokens",
): string {
  const encodedModel = encodeURIComponent(canonicalGeminiModelName(model));
  return `/models/${encodedModel}:${operation}`;
}

function geminiCountModelResource(model: string): string {
  return `models/${canonicalGeminiModelName(model)}`;
}

async function resolveGeminiAuthHeaders(
  config: GeminiProviderConfig,
): Promise<Record<string, string>> {
  const resolved = await materializeGeminiCredentialPlan(config.credentialPlan);
  const headers = geminiCredentialHeaders(resolved);
  if (headers) return headers;
  if (resolved.kind !== "none") {
    throw new Error(
      "Gemini credential materialization produced no auth headers",
    );
  }

  const expectation =
    resolved.expected === "api-key"
      ? `set ${providerApiKeyEnvironmentLabel("gemini") ?? "a Gemini API key"}`
      : resolved.expected === "access-token"
        ? "set GEMINI_ACCESS_TOKEN"
        : resolved.expected === "adc"
          ? resolved.configuredPath === undefined
            ? "configure Google Application Default Credentials"
            : `provide the configured Google ADC file at ${resolved.configuredPath}`
          : `set ${providerApiKeyEnvironmentLabel("gemini") ?? "a Gemini API key"}, GEMINI_ACCESS_TOKEN, or Google Application Default Credentials`;
  throw new LLMProviderError(
    "gemini",
    `Gemini provider requires credentials: ${expectation}`,
    401,
  );
}

function assertNoGeminiAuthDefaultHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): void {
  const conflicting = Object.keys(headers ?? {}).filter((name) => {
    const normalized = name.trim().toLowerCase();
    return (
      normalized === "authorization" ||
      normalized === "x-api-key" ||
      normalized === "api-key" ||
      normalized === "x-goog-api-key" ||
      normalized === "x-goog-user-project"
    );
  });
  if (conflicting.length > 0) {
    throw new Error(
      `Gemini defaultHeaders cannot override canonical authentication headers: ${conflicting.sort().join(", ")}`,
    );
  }
}

function finiteInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestUsageFromGemini(usage: unknown): LLMUsage {
  const record = isRecord(usage) ? usage : {};
  return coerceUsage({
    promptTokens: record.promptTokenCount,
    completionTokens: record.candidatesTokenCount,
    totalTokens: record.totalTokenCount,
    cachedInputTokens: record.cachedContentTokenCount,
    reasoningOutputTokens: record.thoughtsTokenCount,
  });
}

function geminiFinishReason(
  rawReason: unknown,
  toolCalls: readonly LLMToolCall[],
): LLMResponse["finishReason"] {
  if (toolCalls.length > 0) return "tool_calls";
  switch (String(rawReason ?? "").toUpperCase()) {
    case "STOP":
    case "":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
    case "OTHER":
    default:
      return "error";
  }
}

function parseJsonObjectText(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function functionResponsePayload(content: string): Record<string, unknown> {
  return parseJsonObjectText(content) ?? { result: content };
}

function parseDataUrl(
  url: string,
  expectedPrefix: "image" | "application",
): { readonly mimeType: string; readonly data: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/iu.exec(
    url.trim(),
  );
  if (!match) return null;
  const mimeType = (match[1] ?? "").trim().toLowerCase();
  if (!mimeType.startsWith(`${expectedPrefix}/`)) return null;
  const data = (match[2] ?? "").replace(/\s+/gu, "");
  if (!mimeType || !data) return null;
  return { mimeType, data };
}

function inferMimeTypeFromUrl(url: string): string {
  const lower = url.split("?")[0]?.toLowerCase() ?? "";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function geminiPartsFromContent(
  content: LLMMessage["content"],
): readonly GeminiPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ text: content }] : [];
  }

  const parts: GeminiPart[] = [];
  for (const part of content as readonly unknown[]) {
    if (!isRecord(part)) continue;
    switch (part.type) {
      case "text": {
        if (typeof part.text === "string" && part.text.length > 0) {
          parts.push({ text: part.text });
        }
        break;
      }
      case "image_url": {
        const imageUrl = isRecord(part.image_url)
          ? nonEmptyString(part.image_url.url)
          : undefined;
        if (!imageUrl) break;
        const inline = parseDataUrl(imageUrl, "image");
        if (inline) {
          parts.push({
            inlineData: {
              mimeType: inline.mimeType,
              data: inline.data,
            },
          });
        } else {
          parts.push({
            fileData: {
              mimeType: inferMimeTypeFromUrl(imageUrl),
              fileUri: imageUrl,
            },
          });
        }
        break;
      }
      case "document": {
        const source = isRecord(part.source) ? part.source : undefined;
        if (
          source?.type === "base64" &&
          typeof source.data === "string" &&
          source.data.trim().length > 0
        ) {
          parts.push({
            inlineData: {
              mimeType: String(
                source.media_type ?? source.mediaType ?? "application/pdf",
              ),
              data: source.data.replace(/\s+/gu, ""),
            },
          });
        } else if (typeof part.fallbackText === "string") {
          parts.push({ text: part.fallbackText });
        }
        break;
      }
      case "thinking":
      case "redacted_thinking": {
        const text =
          typeof part.thinking === "string"
            ? part.thinking
            : typeof part.data === "string"
              ? part.data
              : "";
        const signature = nonEmptyString(part.signature);
        if (text.length > 0 || signature) {
          parts.push({
            ...(text.length > 0 ? { text } : {}),
            thought: true,
            ...(signature ? { thoughtSignature: signature } : {}),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

function geminiFunctionCallPart(toolCall: LLMToolCall): GeminiPart {
  const args = parseJsonObjectText(toolCall.arguments) ?? {};
  return {
    functionCall: {
      name: toolCall.name,
      args,
    },
  };
}

function buildGeminiContents(messages: readonly LLMMessage[]): {
  readonly contents: readonly Record<string, unknown>[];
  readonly systemInstruction?: Record<string, unknown>;
} {
  const contents: Record<string, unknown>[] = [];
  const systemParts: GeminiPart[] = [];
  const toolCallNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const parts = geminiPartsFromContent(message.content);
      systemParts.push(
        ...parts.filter((part) => typeof part.text === "string"),
      );
      continue;
    }

    if (message.role === "tool") {
      const name =
        nonEmptyString(message.toolName) ??
        (message.toolCallId
          ? toolCallNames.get(message.toolCallId)
          : undefined) ??
        "tool";
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name,
              response: functionResponsePayload(
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              ),
            },
          },
        ],
      });
      continue;
    }

    const parts = [...geminiPartsFromContent(message.content)];
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        toolCallNames.set(toolCall.id, toolCall.name);
        parts.push(geminiFunctionCallPart(toolCall));
      }
    }
    if (parts.length === 0) continue;
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return {
    contents,
    ...(systemParts.length > 0
      ? { systemInstruction: { parts: systemParts } }
      : {}),
  };
}

function geminiSchemaError(path: string, detail: string): never {
  throw new LLMProviderError(
    "gemini",
    `Gemini cannot preserve schema at ${path}: ${detail}`,
  );
}

function geminiSchemaChildPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function isPlainSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type GeminiResponseJsonSchemaModelFamily = "gemini" | "unknown";

interface GeminiResponseJsonSchemaCapabilities {
  readonly surface: "developer-v1beta" | "vertex-v1" | "custom-native";
  readonly modelFamily: GeminiResponseJsonSchemaModelFamily;
  readonly supportedKeywords: ReadonlySet<string>;
  readonly supportsRemoteReferences: boolean;
  readonly preservesOneOfSemantics: boolean;
  readonly supportsRequiredReferenceCycles: boolean;
}

const GEMINI_RESPONSE_JSON_SCHEMA_SUPPORTED_KEYWORDS: ReadonlySet<string> =
  new Set([
    "$id",
    "$defs",
    "$ref",
    "$anchor",
    "type",
    "format",
    "title",
    "description",
    "enum",
    "items",
    "prefixItems",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "anyOf",
    "oneOf",
    "properties",
    "additionalProperties",
    "required",
    "propertyOrdering",
  ]);

function geminiResponseJsonSchemaCapabilities(
  endpointPlan: GeminiEndpointPlan,
  model: string,
): GeminiResponseJsonSchemaCapabilities {
  const modelFamily = canonicalGeminiModelName(model)
    .toLowerCase()
    .startsWith("gemini-")
    ? "gemini"
    : "unknown";
  const surface =
    endpointPlan.kind === "developer"
      ? "developer-v1beta"
      : endpointPlan.kind === "vertex"
        ? "vertex-v1"
        : "custom-native";
  return {
    surface,
    modelFamily,
    supportedKeywords: GEMINI_RESPONSE_JSON_SCHEMA_SUPPORTED_KEYWORDS,
    supportsRemoteReferences: false,
    preservesOneOfSemantics: false,
    supportsRequiredReferenceCycles: false,
  };
}

type GeminiSchemaPropertyContext =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "required" | "optional"; name: string }>;

interface GeminiSchemaGraphEdge {
  readonly target: Record<string, unknown>;
}

interface GeminiSchemaReference {
  readonly source: Record<string, unknown>;
  readonly path: string;
  readonly value: string;
  readonly propertyContext: GeminiSchemaPropertyContext;
  target?: Record<string, unknown>;
}

interface GeminiSchemaValidationState {
  readonly root: Record<string, unknown>;
  readonly capabilities: GeminiResponseJsonSchemaCapabilities;
  readonly ancestors: Set<Record<string, unknown>>;
  readonly nodes: Set<Record<string, unknown>>;
  readonly edges: Map<Record<string, unknown>, GeminiSchemaGraphEdge[]>;
  readonly references: GeminiSchemaReference[];
  readonly anchors: Map<
    string,
    Readonly<{ schema: Record<string, unknown>; path: string }>
  >;
}

const GEMINI_NO_PROPERTY_CONTEXT: GeminiSchemaPropertyContext = {
  kind: "none",
};
const GEMINI_JSON_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function addGeminiSchemaEdge(
  state: GeminiSchemaValidationState,
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  const edges = state.edges.get(source) ?? [];
  edges.push({ target });
  state.edges.set(source, edges);
}

function geminiSchemaObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!isPlainSchemaObject(value)) {
    geminiSchemaError(path, "expected a schema object");
  }
  return value;
}

function geminiSchemaStringArray(
  value: unknown,
  path: string,
  options: Readonly<{ nonEmpty?: boolean; unique?: boolean }> = {},
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    geminiSchemaError(path, "expected an array of strings");
  }
  const strings = value as string[];
  if (options.nonEmpty === true && strings.length === 0) {
    geminiSchemaError(path, "expected at least one string");
  }
  if (options.unique === true && new Set(strings).size !== strings.length) {
    geminiSchemaError(path, "expected unique strings");
  }
  return strings;
}

function validateGeminiSchemaType(value: unknown, path: string): void {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length === 0) {
    geminiSchemaError(
      path,
      "expected a JSON Schema type or non-empty type array",
    );
  }
  const types = values as unknown[];
  if (
    types.some(
      (entry) =>
        typeof entry !== "string" || !GEMINI_JSON_SCHEMA_TYPES.has(entry),
    )
  ) {
    geminiSchemaError(path, "contains an unsupported JSON Schema type");
  }
  if (new Set(types).size !== types.length) {
    geminiSchemaError(path, "expected unique JSON Schema types");
  }
}

function validateGeminiSchemaScalarKeyword(
  key: string,
  value: unknown,
  path: string,
): void {
  switch (key) {
    case "$id":
    case "$anchor":
      if (typeof value !== "string" || value.length === 0) {
        geminiSchemaError(path, "expected a non-empty string");
      }
      return;
    case "type":
      validateGeminiSchemaType(value, path);
      return;
    case "format":
    case "title":
    case "description":
      if (typeof value !== "string") {
        geminiSchemaError(path, "expected a string");
      }
      return;
    case "enum":
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some(
          (entry) =>
            (typeof entry !== "string" && typeof entry !== "number") ||
            (typeof entry === "number" && !Number.isFinite(entry)),
        )
      ) {
        geminiSchemaError(path, "expected a non-empty string or number enum");
      }
      return;
    case "minItems":
    case "maxItems":
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        geminiSchemaError(path, "expected a non-negative integer");
      }
      return;
    case "minimum":
    case "maximum":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        geminiSchemaError(path, "expected a finite number");
      }
      return;
    default:
      return;
  }
}

function validateGeminiSchemaBounds(
  schema: Record<string, unknown>,
  path: string,
): void {
  if (
    typeof schema.minItems === "number" &&
    typeof schema.maxItems === "number" &&
    schema.minItems > schema.maxItems
  ) {
    geminiSchemaError(
      geminiSchemaChildPath(path, "maxItems"),
      "must be greater than or equal to minItems",
    );
  }
  if (
    typeof schema.minimum === "number" &&
    typeof schema.maximum === "number" &&
    schema.minimum > schema.maximum
  ) {
    geminiSchemaError(
      geminiSchemaChildPath(path, "maximum"),
      "must be greater than or equal to minimum",
    );
  }
}

function registerGeminiSchemaAnchor(
  state: GeminiSchemaValidationState,
  schema: Record<string, unknown>,
  path: string,
): void {
  if (typeof schema.$anchor !== "string") return;
  if (!/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(schema.$anchor)) {
    geminiSchemaError(
      geminiSchemaChildPath(path, "$anchor"),
      "expected a valid JSON Schema anchor name",
    );
  }
  const existing = state.anchors.get(schema.$anchor);
  if (existing !== undefined && existing.schema !== schema) {
    geminiSchemaError(
      geminiSchemaChildPath(path, "$anchor"),
      `duplicates the anchor declared at ${existing.path}`,
    );
  }
  state.anchors.set(schema.$anchor, {
    schema,
    path: geminiSchemaChildPath(path, "$anchor"),
  });
}

function validateGeminiJsonSchemaAt(
  value: unknown,
  path: string,
  propertyContext: GeminiSchemaPropertyContext,
  state: GeminiSchemaValidationState,
): void {
  const schema = geminiSchemaObject(value, path);
  if (state.ancestors.has(schema)) {
    geminiSchemaError(path, "the JavaScript schema object is circular");
  }
  state.ancestors.add(schema);
  state.nodes.add(schema);
  try {
    if (
      Object.hasOwn(schema, "oneOf") &&
      !state.capabilities.preservesOneOfSemantics
    ) {
      geminiSchemaError(
        geminiSchemaChildPath(path, "oneOf"),
        "Gemini interprets oneOf as anyOf, which would weaken validation",
      );
    }

    if (Object.hasOwn(schema, "$ref")) {
      if (typeof schema.$ref !== "string" || schema.$ref.trim() === "") {
        geminiSchemaError(
          geminiSchemaChildPath(path, "$ref"),
          "expected a non-empty string",
        );
      }
      const unsupportedSibling = Object.keys(schema).find(
        (key) => key !== "$ref" && !key.startsWith("$"),
      );
      if (unsupportedSibling !== undefined) {
        geminiSchemaError(
          geminiSchemaChildPath(path, unsupportedSibling),
          "Gemini does not allow non-$ siblings beside $ref",
        );
      }
      state.references.push({
        source: schema,
        path: geminiSchemaChildPath(path, "$ref"),
        value: schema.$ref,
        propertyContext,
      });
    }

    const unsupportedKeyword = Object.keys(schema).find(
      (key) => !state.capabilities.supportedKeywords.has(key),
    );
    if (unsupportedKeyword !== undefined) {
      geminiSchemaError(
        geminiSchemaChildPath(path, unsupportedKeyword),
        `keyword ${JSON.stringify(unsupportedKeyword)} is not supported by Gemini responseJsonSchema`,
      );
    }

    const required = Object.hasOwn(schema, "required")
      ? new Set(
          geminiSchemaStringArray(
            schema.required,
            geminiSchemaChildPath(path, "required"),
            { unique: true },
          ),
        )
      : new Set<string>();

    registerGeminiSchemaAnchor(state, schema, path);

    for (const [key, entry] of Object.entries(schema)) {
      const childPath = geminiSchemaChildPath(path, key);
      if (key === "$defs" || key === "properties") {
        if (!isPlainSchemaObject(entry)) {
          geminiSchemaError(childPath, "expected a schema map");
        }
        for (const [name, child] of Object.entries(entry)) {
          const itemPath = geminiSchemaChildPath(childPath, name);
          const childSchema = geminiSchemaObject(child, itemPath);
          addGeminiSchemaEdge(state, schema, childSchema);
          validateGeminiJsonSchemaAt(
            childSchema,
            itemPath,
            key === "properties"
              ? {
                  kind: required.has(name) ? "required" : "optional",
                  name,
                }
              : GEMINI_NO_PROPERTY_CONTEXT,
            state,
          );
        }
        continue;
      }
      if (key === "anyOf" || key === "prefixItems") {
        if (!Array.isArray(entry)) {
          geminiSchemaError(childPath, "expected a schema array");
        }
        if (key === "anyOf" && entry.length === 0) {
          geminiSchemaError(childPath, "expected at least one schema");
        }
        entry.forEach((child, index) => {
          const itemPath = `${childPath}[${index}]`;
          const childSchema = geminiSchemaObject(child, itemPath);
          addGeminiSchemaEdge(state, schema, childSchema);
          validateGeminiJsonSchemaAt(
            childSchema,
            itemPath,
            propertyContext,
            state,
          );
        });
        continue;
      }
      if (key === "items" || key === "additionalProperties") {
        if (key === "additionalProperties" && typeof entry === "boolean") {
          continue;
        }
        const childSchema = geminiSchemaObject(entry, childPath);
        addGeminiSchemaEdge(state, schema, childSchema);
        validateGeminiJsonSchemaAt(
          childSchema,
          childPath,
          propertyContext,
          state,
        );
        continue;
      }
      if (key === "propertyOrdering") {
        geminiSchemaStringArray(entry, childPath, { unique: true });
        continue;
      }
      if (key === "required" || key === "$ref" || key === "oneOf") continue;
      validateGeminiSchemaScalarKeyword(key, entry, childPath);
    }
    validateGeminiSchemaBounds(schema, path);
  } finally {
    state.ancestors.delete(schema);
  }
}

function decodeGeminiJsonPointerToken(token: string, path: string): string {
  if (/~(?:[^01]|$)/u.test(token)) {
    geminiSchemaError(path, "contains an invalid RFC 6901 escape");
  }
  return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function resolveGeminiLocalSchemaReference(
  reference: GeminiSchemaReference,
  state: GeminiSchemaValidationState,
): Record<string, unknown> | undefined {
  if (!reference.value.startsWith("#")) {
    if (!state.capabilities.supportsRemoteReferences) {
      geminiSchemaError(
        reference.path,
        `remote references are not supported by the ${state.capabilities.surface}/${state.capabilities.modelFamily} responseJsonSchema contract`,
      );
    }
    return undefined;
  }

  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.value.slice(1));
  } catch {
    geminiSchemaError(reference.path, "contains invalid URI-fragment encoding");
  }
  if (fragment === "") return state.root;
  if (!fragment.startsWith("/")) {
    const anchored = state.anchors.get(fragment);
    if (anchored === undefined) {
      geminiSchemaError(
        reference.path,
        `does not resolve local anchor #${fragment}`,
      );
    }
    return anchored.schema;
  }

  let target: unknown = state.root;
  for (const rawToken of fragment.slice(1).split("/")) {
    const token = decodeGeminiJsonPointerToken(rawToken, reference.path);
    if (Array.isArray(target)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
        geminiSchemaError(
          reference.path,
          `does not resolve JSON Pointer ${reference.value}`,
        );
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= target.length) {
        geminiSchemaError(
          reference.path,
          `does not resolve JSON Pointer ${reference.value}`,
        );
      }
      target = target[index];
      continue;
    }
    if (!isPlainSchemaObject(target) || !Object.hasOwn(target, token)) {
      geminiSchemaError(
        reference.path,
        `does not resolve JSON Pointer ${reference.value}`,
      );
    }
    target = target[token];
  }
  if (!isPlainSchemaObject(target)) {
    geminiSchemaError(
      reference.path,
      `JSON Pointer ${reference.value} does not identify a schema object`,
    );
  }
  if (!state.nodes.has(target)) {
    geminiSchemaError(
      reference.path,
      `JSON Pointer ${reference.value} identifies a schema container, not a schema object`,
    );
  }
  return target;
}

function geminiSchemaComponentIds(
  state: GeminiSchemaValidationState,
): Map<Record<string, unknown>, number> {
  let nextIndex = 0;
  let nextComponent = 0;
  const indexes = new Map<Record<string, unknown>, number>();
  const lowLinks = new Map<Record<string, unknown>, number>();
  const stack: Record<string, unknown>[] = [];
  const onStack = new Set<Record<string, unknown>>();
  const components = new Map<Record<string, unknown>, number>();

  const visit = (node: Record<string, unknown>): void => {
    const index = nextIndex++;
    indexes.set(node, index);
    lowLinks.set(node, index);
    stack.push(node);
    onStack.add(node);

    for (const edge of state.edges.get(node) ?? []) {
      if (!indexes.has(edge.target)) {
        visit(edge.target);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, lowLinks.get(edge.target)!),
        );
      } else if (onStack.has(edge.target)) {
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, indexes.get(edge.target)!),
        );
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      components.set(member, nextComponent);
      if (member === node) break;
    }
    nextComponent += 1;
  };

  for (const node of state.nodes) {
    if (!indexes.has(node)) visit(node);
  }
  return components;
}

function validateGeminiSchemaReferences(
  state: GeminiSchemaValidationState,
): void {
  for (const reference of state.references) {
    const target = resolveGeminiLocalSchemaReference(reference, state);
    if (target === undefined) continue;
    reference.target = target;
    state.nodes.add(target);
    addGeminiSchemaEdge(state, reference.source, target);
  }

  if (state.capabilities.supportsRequiredReferenceCycles) return;
  const components = geminiSchemaComponentIds(state);
  for (const reference of state.references) {
    if (
      reference.target === undefined ||
      components.get(reference.source) !== components.get(reference.target) ||
      reference.propertyContext.kind === "optional"
    ) {
      continue;
    }
    const detail =
      reference.propertyContext.kind === "required"
        ? `cyclic $ref is inside required property ${JSON.stringify(reference.propertyContext.name)}`
        : "cyclic $ref is not inside a non-required property";
    geminiSchemaError(
      reference.path,
      `${detail}; Gemini allows cycles only in non-required properties`,
    );
  }
}

/** Validate restrictions documented for Gemini response JSON Schema. */
function compileGeminiSchema(
  value: unknown,
  path: string,
  capabilities: GeminiResponseJsonSchemaCapabilities,
): Record<string, unknown> {
  const root = geminiSchemaObject(value, path);
  const state: GeminiSchemaValidationState = {
    root,
    capabilities,
    ancestors: new Set(),
    nodes: new Set(),
    edges: new Map(),
    references: [],
    anchors: new Map(),
  };
  validateGeminiJsonSchemaAt(root, path, GEMINI_NO_PROPERTY_CONTEXT, state);
  validateGeminiSchemaReferences(state);
  return root;
}

function geminiTools(
  tools: readonly LLMTool[],
): readonly Record<string, unknown>[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parametersJsonSchema: tool.function.parameters,
      })),
    },
  ];
}

function geminiToolConfig(
  options: LLMChatOptions | undefined,
): Record<string, unknown> | undefined {
  const choice = options?.toolChoice;
  if (choice === undefined || choice === "auto") return undefined;
  if (choice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (choice === "required") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [choice.name],
    },
  };
}

function geminiGenerationConfig(
  options: LLMChatOptions | undefined,
  defaultMaxTokens: number | undefined,
  schemaCapabilities: GeminiResponseJsonSchemaCapabilities,
): Record<string, unknown> {
  const maxOutputTokens =
    finiteInteger(options?.maxOutputTokens) ??
    finiteInteger(defaultMaxTokens) ??
    DEFAULT_GEMINI_MAX_OUTPUT_TOKENS;
  const config: Record<string, unknown> = { maxOutputTokens };
  if (
    typeof options?.temperature === "number" &&
    Number.isFinite(options.temperature)
  ) {
    config.temperature = options.temperature;
  }
  if (
    options?.stopSequences !== undefined &&
    options.stopSequences.length > 0
  ) {
    config.stopSequences = [...options.stopSequences];
  }
  // Thinking depth here is `thinking_level`, not a token budget: the
  // documented rungs are minimal/low/medium/high depending on the model.
  // Mapping the app's ladder onto them is what makes an effort choice
  // reach this provider at all — without it the setting was inert.
  const effort = options?.reasoningEffort;
  if (effort !== undefined) {
    // gemini-3.1-pro-preview, the curated model here, documents low/medium/high
    // only: minimal folds down, and xhigh/max fold up to its ceiling.
    const level =
      effort === "minimal" || effort === "low"
        ? "low"
        : effort === "medium"
          ? "medium"
          : "high";
    // Nested under thinkingConfig, camelCase: the flat snake_case field
    // is not part of this API's generation config and 400s the request.
    config.thinkingConfig = { thinkingLevel: level };
  }
  const structuredSchema = options?.structuredOutput?.schema;
  if (options?.structuredOutput?.enabled || structuredSchema) {
    config.responseMimeType = "application/json";
    if (structuredSchema) {
      config.responseJsonSchema = compileGeminiSchema(
        structuredSchema.schema,
        `structuredOutput[${JSON.stringify(structuredSchema.name)}].schema`,
        schemaCapabilities,
      );
    }
  }
  return config;
}

function cachedContentName(
  config: GeminiProviderConfig,
  options: LLMChatOptions | undefined,
): string | undefined {
  const requestKey = options?.promptCacheKey?.trim();
  if (requestKey?.startsWith("cachedContents/")) {
    return requestKey;
  }
  const configured = config.cachedContent?.trim();
  return configured?.startsWith("cachedContents/") ? configured : undefined;
}

function buildGeminiRequest(args: {
  readonly config: GeminiProviderConfig;
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
}): Record<string, unknown> {
  validateAgentInvocationMessageSequence(args.messages);
  const contents = buildGeminiContents([
    ...(args.options?.systemPrompt
      ? [{ role: "system" as const, content: args.options.systemPrompt }]
      : []),
    ...args.messages,
  ]);
  const tools = geminiTools(args.tools);
  const toolConfig = geminiToolConfig(args.options);
  const cachedContent = cachedContentName(args.config, args.options);
  return {
    contents: contents.contents,
    ...(contents.systemInstruction
      ? { systemInstruction: contents.systemInstruction }
      : {}),
    generationConfig: geminiGenerationConfig(
      args.options,
      args.config.maxTokens,
      geminiResponseJsonSchemaCapabilities(
        args.config.endpointPlan,
        args.model,
      ),
    ),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(cachedContent ? { cachedContent } : {}),
  };
}

function validateGeminiToolCall(raw: unknown): LLMToolCall {
  const result = validateToolCallDetailed(raw);
  if (result.toolCall) return result.toolCall;
  throw new LLMProviderError(
    "gemini",
    `${GEMINI_INVALID_FUNCTION_CALL_MESSAGE}: ${
      result.failure?.message ?? "invalid payload"
    }`,
  );
}

function toolCallFromGeminiFunctionCall(
  functionCall: Record<string, unknown>,
  index: number,
): LLMToolCall {
  return validateGeminiToolCall({
    id: `gemini_call_${index}`,
    name: String(functionCall.name ?? ""),
    arguments: JSON.stringify(
      isRecord(functionCall.args) ? functionCall.args : {},
    ),
  });
}

function readCandidateParts(
  response: Record<string, unknown>,
): readonly GeminiPart[] {
  const candidates = Array.isArray(response.candidates)
    ? (response.candidates as readonly unknown[])
    : [];
  const firstCandidate = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(firstCandidate.content)
    ? firstCandidate.content
    : {};
  return Array.isArray(content.parts)
    ? (content.parts.filter(isRecord) as readonly GeminiPart[])
    : [];
}

function readFirstCandidate(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const candidates = Array.isArray(response.candidates)
    ? (response.candidates as readonly unknown[])
    : [];
  return isRecord(candidates[0]) ? candidates[0] : {};
}

function parseGeminiResponse(
  model: string,
  response: Record<string, unknown>,
): GeminiParsedResponse {
  const parts = readCandidateParts(response);
  let content = "";
  const toolCalls: LLMToolCall[] = [];
  const thinking: GeminiThinkingBlock[] = [];

  for (const [index, part] of parts.entries()) {
    if (part.thought === true) {
      const text = typeof part.text === "string" ? part.text : "";
      const signature =
        nonEmptyString(part.thoughtSignature) ??
        nonEmptyString(part.thought_signature);
      if (text.length > 0 || signature) {
        thinking.push({
          text,
          redacted: text.length === 0,
          ...(signature ? { signature } : {}),
          kind: "thinking",
        });
      }
      continue;
    }
    if (typeof part.text === "string") {
      content += part.text;
      continue;
    }
    if (isRecord(part.functionCall)) {
      toolCalls.push(toolCallFromGeminiFunctionCall(part.functionCall, index));
    }
  }

  const candidate = readFirstCandidate(response);
  return {
    content,
    toolCalls,
    usage: requestUsageFromGemini(response.usageMetadata),
    model,
    ...(thinking.length > 0 ? { thinking } : {}),
    finishReason: geminiFinishReason(candidate.finishReason, toolCalls),
  };
}

function requestMetrics(args: {
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly body: Record<string, unknown>;
  readonly stream: boolean;
}): LLMRequestMetrics {
  const contentLengths = args.messages.map((message) =>
    typeof message.content === "string"
      ? message.content.length
      : JSON.stringify(message.content).length,
  );
  const totalContentChars = contentLengths.reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    messageCount: args.messages.length,
    systemMessages: args.messages.filter((message) => message.role === "system")
      .length,
    userMessages: args.messages.filter((message) => message.role === "user")
      .length,
    assistantMessages: args.messages.filter(
      (message) => message.role === "assistant",
    ).length,
    toolMessages: args.messages.filter((message) => message.role === "tool")
      .length,
    totalContentChars,
    maxMessageChars:
      contentLengths.length > 0 ? Math.max(...contentLengths) : 0,
    textParts: 0,
    imageParts: 0,
    toolCount: args.tools.length,
    toolNames: args.tools.map((tool) => tool.function.name),
    toolSchemaChars: JSON.stringify(args.tools).length,
    serializedChars: JSON.stringify(args.body).length,
    toolsAttached: args.tools.length > 0,
    stream: args.stream,
  };
}

function withMetrics(
  parsed: GeminiParsedResponse,
  metrics: LLMRequestMetrics,
): LLMResponse {
  return {
    content: parsed.content,
    toolCalls: [...parsed.toolCalls],
    usage: parsed.usage,
    model: parsed.model,
    requestMetrics: metrics,
    ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
    finishReason: parsed.finishReason,
  };
}

function mapProviderError(error: unknown): never {
  if (isFallbackTriggeredError(error)) {
    throw error;
  }
  if (error instanceof ProviderHttpError) {
    throw new LLMProviderError("gemini", error.message, error.status);
  }
  if (error instanceof LLMProviderError) {
    throw error;
  }
  throw new LLMProviderError(
    "gemini",
    error instanceof Error ? error.message : String(error),
  );
}

interface GeminiSseEvent {
  readonly data: Record<string, unknown>;
}

async function* readGeminiSseEvents(
  response: ProviderHttpStreamResponse,
): AsyncGenerator<GeminiSseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response) {
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseSSEFrames(buffer, "gemini");
    buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      if (!frame.data || frame.data === "[DONE]") {
        if (frame.data === "[DONE]") return;
        continue;
      }
      try {
        const data = JSON.parse(frame.data) as unknown;
        if (isRecord(data)) yield { data };
      } catch {
        continue;
      }
    }
  }
  buffer += decoder.decode();
  const parsed = parseSSEFrames(buffer, "gemini");
  for (const frame of parsed.frames) {
    if (!frame.data || frame.data === "[DONE]") {
      if (frame.data === "[DONE]") return;
      continue;
    }
    try {
      const data = JSON.parse(frame.data) as unknown;
      if (isRecord(data)) yield { data };
    } catch {
      continue;
    }
  }
}

class GeminiStreamState {
  content = "";
  usage: LLMUsage = coerceUsage({});
  model: string;
  finishReason: LLMResponse["finishReason"] = "stop";
  readonly toolCalls: LLMToolCall[] = [];
  readonly thinking: GeminiThinkingBlock[] = [];
  private thinkingOpen = new Set<number>();

  constructor(model: string) {
    this.model = model;
  }

  consumeResponse(
    response: Record<string, unknown>,
    onChunk: StreamProgressCallback,
  ): void {
    if (response.usageMetadata) {
      this.usage = requestUsageFromGemini(response.usageMetadata);
    }
    const candidate = readFirstCandidate(response);
    const parts = readCandidateParts(response);
    for (const [index, part] of parts.entries()) {
      this.consumePart(part, index, onChunk);
    }
    this.finishReason = geminiFinishReason(
      candidate.finishReason,
      this.toolCalls,
    );
  }

  finalize(onChunk: StreamProgressCallback): LLMResponse {
    for (const index of Array.from(this.thinkingOpen)) {
      onChunk({ content: "", done: false, thinkingBlockStop: { index } });
      this.thinkingOpen.delete(index);
    }
    onChunk({
      content: "",
      done: true,
      ...(this.toolCalls.length > 0 ? { toolCalls: this.toolCalls } : {}),
    });
    return {
      content: this.content,
      toolCalls: this.toolCalls,
      usage: this.usage,
      model: this.model,
      ...(this.thinking.length > 0 ? { thinking: this.thinking } : {}),
      finishReason: this.finishReason,
    };
  }

  private consumePart(
    part: GeminiPart,
    index: number,
    onChunk: StreamProgressCallback,
  ): void {
    if (part.thought === true) {
      const delta = typeof part.text === "string" ? part.text : "";
      const signature =
        nonEmptyString(part.thoughtSignature) ??
        nonEmptyString(part.thought_signature);
      if (!this.thinkingOpen.has(index)) {
        this.thinkingOpen.add(index);
        onChunk({
          content: "",
          done: false,
          thinkingBlockStart: { index, redacted: delta.length === 0 },
        });
      }
      if (delta.length > 0) {
        onChunk({
          content: "",
          done: false,
          thinkingDelta: { index, delta },
        });
      }
      if (delta.length > 0 || signature) {
        this.thinking.push({
          text: delta,
          redacted: delta.length === 0,
          ...(signature ? { signature } : {}),
          kind: "thinking",
        });
      }
      return;
    }
    if (typeof part.text === "string" && part.text.length > 0) {
      this.content += part.text;
      onChunk({ content: part.text, done: false });
      return;
    }
    if (isRecord(part.functionCall)) {
      const toolCall = toolCallFromGeminiFunctionCall(
        part.functionCall,
        this.toolCalls.length,
      );
      this.toolCalls.push(toolCall);
      const startChunk: LLMStreamChunk = {
        content: "",
        done: false,
        toolInputBlockStart: {
          callId: toolCall.id,
          index: this.toolCalls.length - 1,
          contentBlock: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: parseJsonObjectText(toolCall.arguments) ?? {},
          },
        },
      };
      onChunk(startChunk);
      onChunk({
        content: "",
        done: false,
        toolInputDelta: {
          callId: toolCall.id,
          index: this.toolCalls.length - 1,
          partialJson: toolCall.arguments,
        },
      });
    }
  }
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly tokenCountCapability: ProviderTokenCountCapability;

  private readonly config: GeminiProviderConfig;
  private readonly client: ProviderHttpClient;

  constructor(config: GeminiProviderConfig) {
    assertNoGeminiAuthDefaultHeaders(config.defaultHeaders);
    this.config = { ...config };
    this.client = new ProviderHttpClient({
      providerName: this.name,
      baseURL: geminiEndpointFor(this.config.endpointPlan),
      model: this.config.model,
      defaultHeaders: this.config.defaultHeaders,
      resolveAuthHeaders: () => resolveGeminiAuthHeaders(this.config),
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.config.fetchImpl,
      providerFallback: this.config.providerFallback,
      emitWarning: this.config.emitWarning,
      onCapabilityDrift: this.config.onCapabilityDrift,
      supportsStreaming: true,
    });
    this.tokenCountCapability = Object.freeze({
      capabilityVersion: "gemini-generate-content-count-tokens-v1",
      adapterRevision: "gemini-generate-content-wire-v1",
      configurationRevision: createTokenAccountingConfigurationRevision({
        cachedContent: this.config.cachedContent ?? null,
        defaultHeaders: this.config.defaultHeaders ?? {},
        systemPrompt: this.config.systemPrompt ?? "",
        tools: this.config.tools ?? [],
      }),
      countTokens: (request: TokenAccountingRequest, signal: AbortSignal) =>
        this.countRequestTokens(request, signal),
    });
  }

  private async countRequestTokens(
    accountingRequest: TokenAccountingRequest,
    signal: AbortSignal,
  ): Promise<ProviderNativeTokenCountResult> {
    const model =
      accountingRequest.options.model?.trim() ||
      accountingRequest.model ||
      this.config.model;
    const tools = accountingRequest.options.tools
      ? [...accountingRequest.options.tools]
      : (this.config.tools ?? []);
    const generateContentRequest = buildGeminiRequest({
      config: this.config,
      model,
      messages: accountingRequest.messages,
      tools,
      options: accountingRequest.options,
    });
    const vertexCount = this.config.endpointPlan.kind === "vertex";
    if (
      vertexCount &&
      (generateContentRequest.toolConfig !== undefined ||
        generateContentRequest.cachedContent !== undefined)
    ) {
      // Vertex's documented CountTokens request mirrors the prompt, tools,
      // system instruction, and generation config, but has no toolConfig or
      // cachedContent fields. Falling back preserves the fail-closed coverage
      // contract instead of claiming that an incomplete request was counted.
      throw new Error(
        "Vertex Gemini token counting cannot represent tool choice or cached content",
      );
    }
    const session = this.client.createTurnSession({ wireApi: "custom" });
    const response = await session.requestJson<Record<string, unknown>>({
      path: modelPath(model, "countTokens"),
      method: "POST",
      body: vertexCount
        ? generateContentRequest
        : {
            generateContentRequest: {
              model: geminiCountModelResource(model),
              ...generateContentRequest,
            },
          },
      signal,
      retryBudget: { maxRetries: 0 },
      singleWireAttempt: true,
    });
    const inputTokens = response.data.totalTokens;
    if (
      typeof inputTokens !== "number" ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0
    ) {
      throw new Error("Gemini token counter returned invalid totalTokens");
    }
    return {
      inputTokens,
      complete: true,
      confidence: "high",
      countedComponents: [
        "system",
        "messages",
        "tools",
        "tool_choice",
        "structured_output",
        "images",
        "documents",
        "provider_framing",
      ],
    };
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const model = options?.model?.trim() || this.config.model;
    const tools = options?.tools
      ? [...options.tools]
      : (this.config.tools ?? []);
    const body = buildGeminiRequest({
      config: this.config,
      model,
      messages,
      tools,
      options,
    });
    const metrics = requestMetrics({ messages, tools, body, stream: false });

    try {
      const session = this.client.createTurnSession({ wireApi: "custom" });
      const response = await session.requestJson<Record<string, unknown>>({
        path: modelPath(model, "generateContent"),
        method: "POST",
        body,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        providerFallback: this.config.providerFallback
          ? {
              ...this.config.providerFallback,
              ...(options?.singleWireAttempt ? { maxFailures: 1 } : {}),
            }
          : undefined,
        singleWireAttempt: options?.singleWireAttempt,
      });
      return withMetrics(parseGeminiResponse(model, response.data), metrics);
    } catch (error) {
      mapProviderError(error);
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const model = options?.model?.trim() || this.config.model;
    const tools = options?.tools
      ? [...options.tools]
      : (this.config.tools ?? []);
    const body = buildGeminiRequest({
      config: this.config,
      model,
      messages,
      tools,
      options,
    });
    const metrics = requestMetrics({ messages, tools, body, stream: true });

    try {
      const session = this.client.createTurnSession({ wireApi: "custom" });
      const response = await session.requestStream({
        path: modelPath(model, "streamGenerateContent"),
        method: "POST",
        headers: { accept: "text/event-stream" },
        query: { alt: "sse" },
        body,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        providerFallback: this.config.providerFallback
          ? {
              ...this.config.providerFallback,
              ...(options?.singleWireAttempt ? { maxFailures: 1 } : {}),
            }
          : undefined,
        singleWireAttempt: options?.singleWireAttempt,
        retryBudget: { maxRetries: 0 },
      });
      const state = new GeminiStreamState(model);
      for await (const event of readGeminiSseEvents(response)) {
        state.consumeResponse(event.data, onChunk);
      }
      return {
        ...state.finalize(onChunk),
        requestMetrics: metrics,
      };
    } catch (error) {
      mapProviderError(error);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const session = this.client.createTurnSession({ wireApi: "custom" });
      await session.requestJson<Record<string, unknown>>({
        path: "/models",
        method: "GET",
      });
      return true;
    } catch {
      return false;
    }
  }

  async getExecutionProfile() {
    return {
      provider: this.name,
      model: this.config.model,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
      ...(this.config.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.config.contextWindowTokens }
        : {}),
      ...(this.config.contextWindowTokens !== undefined
        ? { contextWindowSource: "explicit_config" as const }
        : {}),
      ...(this.config.maxTokens !== undefined
        ? { maxOutputTokens: this.config.maxTokens }
        : {}),
    };
  }
}
