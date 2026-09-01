/**
 * Native Google Gemini provider module.
 *
 * @module
 */

import { Buffer } from "node:buffer";
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
              mimeType:
                nonEmptyString(source.media_type) ??
                nonEmptyString(source.mediaType) ??
                "application/pdf",
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

function geminiResponseJsonSchemaSurface(
  endpointPlan: GeminiEndpointPlan,
): GeminiResponseJsonSchemaCapabilities["surface"] {
  switch (endpointPlan.kind) {
    case "developer":
      return "developer-v1beta";
    case "vertex":
      return "vertex-v1";
    case "custom":
      return "custom-native";
  }
}

function geminiResponseJsonSchemaCapabilities(
  endpointPlan: GeminiEndpointPlan,
  model: string,
): GeminiResponseJsonSchemaCapabilities {
  const modelFamily = canonicalGeminiModelName(model)
    .toLowerCase()
    .startsWith("gemini-")
    ? "gemini"
    : "unknown";
  return {
    surface: geminiResponseJsonSchemaSurface(endpointPlan),
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

interface GeminiSchemaResource {
  readonly uri: string;
  readonly root: Record<string, unknown>;
  readonly path: string;
}

interface GeminiResolvedSchemaReference {
  readonly schema: Record<string, unknown>;
  readonly resource: GeminiSchemaResource;
}

interface GeminiSchemaReference {
  readonly source: Record<string, unknown>;
  readonly path: string;
  readonly value: string;
  readonly propertyContext: GeminiSchemaPropertyContext;
  target?: Record<string, unknown>;
}

interface GeminiSchemaValidationState {
  readonly capabilities: GeminiResponseJsonSchemaCapabilities;
  readonly ancestors: Set<Record<string, unknown>>;
  readonly nodes: Set<Record<string, unknown>>;
  readonly edges: Map<Record<string, unknown>, GeminiSchemaGraphEdge[]>;
  readonly references: GeminiSchemaReference[];
  readonly nodePaths: Map<Record<string, unknown>, string>;
  readonly nodeResources: Map<Record<string, unknown>, GeminiSchemaResource>;
  readonly resources: Map<string, GeminiSchemaResource>;
  readonly anchors: Map<
    string,
    Readonly<{ schema: Record<string, unknown>; path: string }>
  >;
  analysisWork: number;
  analysisDepth: number;
}

const GEMINI_NO_PROPERTY_CONTEXT: GeminiSchemaPropertyContext = {
  kind: "none",
};
const GEMINI_INTERNAL_SCHEMA_BASE =
  "https://schema.invalid/.well-known/agenc/gemini/";
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

const GEMINI_SCHEMA_VALIDATION_MAX_VALUES = 100_000;
const GEMINI_SCHEMA_VALIDATION_MAX_UTF8_BYTES = 1_048_576;
const GEMINI_SCHEMA_VALIDATION_MAX_DEPTH = 256;
const GEMINI_SCHEMA_ANALYSIS_MAX_WORK = 10_000;
const GEMINI_SCHEMA_ANALYSIS_MAX_DEPTH = 256;

interface GeminiSchemaCloneState {
  values: number;
  utf8Bytes: number;
  readonly ancestors: Set<object>;
}

function chargeGeminiSchemaValue(
  state: GeminiSchemaCloneState,
  path: string,
): void {
  state.values += 1;
  if (state.values > GEMINI_SCHEMA_VALIDATION_MAX_VALUES) {
    geminiSchemaError(
      path,
      `schema exceeds the ${GEMINI_SCHEMA_VALIDATION_MAX_VALUES}-value validation limit`,
    );
  }
}

function preflightGeminiSchemaChildValues(
  count: number,
  state: GeminiSchemaCloneState,
  path: string,
): void {
  if (count > GEMINI_SCHEMA_VALIDATION_MAX_VALUES - state.values) {
    geminiSchemaError(
      path,
      `schema exceeds the ${GEMINI_SCHEMA_VALIDATION_MAX_VALUES}-value validation limit`,
    );
  }
}

function chargeGeminiSchemaUtf8(
  value: string,
  state: GeminiSchemaCloneState,
  path: string,
): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > GEMINI_SCHEMA_VALIDATION_MAX_UTF8_BYTES - state.utf8Bytes) {
    geminiSchemaError(
      path,
      `schema exceeds the ${GEMINI_SCHEMA_VALIDATION_MAX_UTF8_BYTES}-byte UTF-8 validation limit`,
    );
  }
  state.utf8Bytes += bytes;
}

function isGeminiSchemaJsonPrimitive(
  value: unknown,
): value is null | string | number | boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function cloneGeminiSchemaValueForValidation(
  value: unknown,
  path: string,
  depth: number,
  state: GeminiSchemaCloneState,
): unknown {
  if (depth > GEMINI_SCHEMA_VALIDATION_MAX_DEPTH) {
    geminiSchemaError(
      path,
      `schema exceeds the ${GEMINI_SCHEMA_VALIDATION_MAX_DEPTH}-level validation depth limit`,
    );
  }
  chargeGeminiSchemaValue(state, path);
  if (isGeminiSchemaJsonPrimitive(value)) {
    if (typeof value === "string") {
      chargeGeminiSchemaUtf8(value, state, path);
    }
    return value;
  }
  if (typeof value !== "object") {
    geminiSchemaError(path, "expected a JSON-compatible schema value");
  }
  if (state.ancestors.has(value)) {
    geminiSchemaError(path, "the JavaScript schema value is circular");
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      preflightGeminiSchemaChildValues(value.length, state, path);
      const snapshot: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const entryPath = `${path}[${index}]`;
        if (!Object.hasOwn(value, index)) {
          geminiSchemaError(
            entryPath,
            "sparse schema arrays are not supported",
          );
        }
        const entry = value[index];
        snapshot.push(
          cloneGeminiSchemaValueForValidation(
            entry,
            entryPath,
            depth + 1,
            state,
          ),
        );
      }
      return snapshot;
    }
    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue);
    preflightGeminiSchemaChildValues(keys.length, state, path);
    for (const key of keys) {
      chargeGeminiSchemaUtf8(key, state, path);
    }
    const entries: [string, unknown][] = [];
    for (const key of keys) {
      const entry = objectValue[key];
      entries.push([
        key,
        cloneGeminiSchemaValueForValidation(
          entry,
          geminiSchemaChildPath(path, key),
          depth + 1,
          state,
        ),
      ]);
    }
    return Object.fromEntries(entries);
  } finally {
    state.ancestors.delete(value);
  }
}

function cloneGeminiSchemaForValidation(
  value: unknown,
  path: string,
): Record<string, unknown> {
  return geminiSchemaObject(
    cloneGeminiSchemaValueForValidation(value, path, 0, {
      values: 0,
      utf8Bytes: 0,
      ancestors: new Set(),
    }),
    path,
  );
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

function validateGeminiSchemaAnchorName(value: string, path: string): void {
  if (!/^[A-Za-z_][-A-Za-z0-9._]*$/u.test(value)) {
    geminiSchemaError(path, "expected a valid JSON Schema anchor name");
  }
}

function validateGeminiResponseSchemaOneOf(
  schema: Record<string, unknown>,
  path: string,
  state: GeminiSchemaValidationState,
): void {
  if (
    Object.hasOwn(schema, "oneOf") &&
    !state.capabilities.preservesOneOfSemantics
  ) {
    geminiSchemaError(
      geminiSchemaChildPath(path, "oneOf"),
      "Gemini interprets oneOf as anyOf, which would weaken validation",
    );
  }
}

function registerGeminiResponseSchemaReference(
  schema: Record<string, unknown>,
  path: string,
  propertyContext: GeminiSchemaPropertyContext,
  state: GeminiSchemaValidationState,
): void {
  if (!Object.hasOwn(schema, "$ref")) return;
  const referencePath = geminiSchemaChildPath(path, "$ref");
  if (typeof schema.$ref !== "string" || schema.$ref.trim() === "") {
    geminiSchemaError(referencePath, "expected a non-empty string");
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
    path: referencePath,
    value: schema.$ref,
    propertyContext,
  });
}

function validateGeminiResponseSchemaKeywords(
  schema: Record<string, unknown>,
  path: string,
  state: GeminiSchemaValidationState,
): void {
  const unsupportedKeyword = Object.keys(schema).find(
    (key) => !state.capabilities.supportedKeywords.has(key),
  );
  if (unsupportedKeyword !== undefined) {
    geminiSchemaError(
      geminiSchemaChildPath(path, unsupportedKeyword),
      `keyword ${JSON.stringify(unsupportedKeyword)} is not supported by Gemini responseJsonSchema`,
    );
  }
}

function geminiResponseRequiredProperties(
  schema: Record<string, unknown>,
  path: string,
): ReadonlySet<string> {
  if (!Object.hasOwn(schema, "required")) return new Set();
  return new Set(
    geminiSchemaStringArray(
      schema.required,
      geminiSchemaChildPath(path, "required"),
      { unique: true },
    ),
  );
}

function visitGeminiResponseSchemaMap(
  schema: Record<string, unknown>,
  entry: unknown,
  key: "$defs" | "properties",
  path: string,
  required: ReadonlySet<string>,
  state: GeminiSchemaValidationState,
): void {
  const childPath = geminiSchemaChildPath(path, key);
  if (!isPlainSchemaObject(entry)) {
    geminiSchemaError(childPath, "expected a schema map");
  }
  for (const [name, child] of Object.entries(entry)) {
    const itemPath = geminiSchemaChildPath(childPath, name);
    const childSchema = geminiSchemaObject(child, itemPath);
    addGeminiSchemaEdge(state, schema, childSchema);
    const childContext =
      key === "properties"
        ? ({
            kind: required.has(name) ? "required" : "optional",
            name,
          } as const)
        : GEMINI_NO_PROPERTY_CONTEXT;
    validateGeminiJsonSchemaAt(childSchema, itemPath, childContext, state);
  }
}

function visitGeminiResponseSchemaArray(
  schema: Record<string, unknown>,
  entry: unknown,
  key: "anyOf" | "prefixItems",
  path: string,
  propertyContext: GeminiSchemaPropertyContext,
  state: GeminiSchemaValidationState,
): void {
  const childPath = geminiSchemaChildPath(path, key);
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
    validateGeminiJsonSchemaAt(childSchema, itemPath, propertyContext, state);
  });
}

function visitGeminiResponseSchemaChild(
  schema: Record<string, unknown>,
  entry: unknown,
  key: "items" | "additionalProperties",
  path: string,
  propertyContext: GeminiSchemaPropertyContext,
  state: GeminiSchemaValidationState,
): void {
  if (key === "additionalProperties" && typeof entry === "boolean") return;
  const childPath = geminiSchemaChildPath(path, key);
  const childSchema = geminiSchemaObject(entry, childPath);
  addGeminiSchemaEdge(state, schema, childSchema);
  validateGeminiJsonSchemaAt(childSchema, childPath, propertyContext, state);
}

function validateGeminiResponseSchemaEntry(
  schema: Record<string, unknown>,
  key: string,
  entry: unknown,
  path: string,
  propertyContext: GeminiSchemaPropertyContext,
  required: ReadonlySet<string>,
  state: GeminiSchemaValidationState,
): void {
  if (key === "$defs" || key === "properties") {
    visitGeminiResponseSchemaMap(schema, entry, key, path, required, state);
    return;
  }
  if (key === "anyOf" || key === "prefixItems") {
    visitGeminiResponseSchemaArray(
      schema,
      entry,
      key,
      path,
      propertyContext,
      state,
    );
    return;
  }
  if (key === "items" || key === "additionalProperties") {
    visitGeminiResponseSchemaChild(
      schema,
      entry,
      key,
      path,
      propertyContext,
      state,
    );
    return;
  }
  const childPath = geminiSchemaChildPath(path, key);
  if (key === "propertyOrdering") {
    geminiSchemaStringArray(entry, childPath, { unique: true });
    return;
  }
  if (key === "$anchor" && typeof entry === "string") {
    validateGeminiSchemaAnchorName(entry, childPath);
  }
  if (key !== "required" && key !== "$ref" && key !== "oneOf") {
    validateGeminiSchemaScalarKeyword(key, entry, childPath);
  }
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
    validateGeminiResponseSchemaOneOf(schema, path, state);
    registerGeminiResponseSchemaReference(schema, path, propertyContext, state);
    validateGeminiResponseSchemaKeywords(schema, path, state);
    const required = geminiResponseRequiredProperties(schema, path);
    for (const [key, entry] of Object.entries(schema)) {
      validateGeminiResponseSchemaEntry(
        schema,
        key,
        entry,
        path,
        propertyContext,
        required,
        state,
      );
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
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

const GEMINI_SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const GEMINI_SCHEMA_ARRAY_KEYWORDS: ReadonlySet<string> = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
const GEMINI_SINGLE_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

interface GeminiSchemaChild {
  readonly schema: Record<string, unknown>;
  readonly path: string;
}

function geminiSchemaMapChildren(
  value: unknown,
  path: string,
): readonly GeminiSchemaChild[] {
  if (!isPlainSchemaObject(value)) return [];
  return Object.entries(value).flatMap(([name, child]) =>
    isPlainSchemaObject(child)
      ? [{ schema: child, path: geminiSchemaChildPath(path, name) }]
      : [],
  );
}

function geminiSchemaArrayChildren(
  value: unknown,
  path: string,
): readonly GeminiSchemaChild[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((child, index) =>
    isPlainSchemaObject(child)
      ? [{ schema: child, path: `${path}[${index}]` }]
      : [],
  );
}

function geminiSchemaChildren(
  schema: Record<string, unknown>,
  path: string,
): readonly GeminiSchemaChild[] {
  const children: GeminiSchemaChild[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const childPath = geminiSchemaChildPath(path, key);
    if (GEMINI_SCHEMA_MAP_KEYWORDS.has(key)) {
      children.push(...geminiSchemaMapChildren(value, childPath));
      continue;
    }
    if (GEMINI_SCHEMA_ARRAY_KEYWORDS.has(key)) {
      children.push(...geminiSchemaArrayChildren(value, childPath));
      continue;
    }
    if (GEMINI_SINGLE_SCHEMA_KEYWORDS.has(key) && isPlainSchemaObject(value)) {
      children.push({ schema: value, path: childPath });
      continue;
    }
    if (key === "dependencies" && isPlainSchemaObject(value)) {
      children.push(...geminiSchemaMapChildren(value, childPath));
    }
  }
  return children;
}

function geminiSchemaUri(value: string, baseUri: string, path: string): URL {
  try {
    return new URL(value, baseUri);
  } catch {
    geminiSchemaError(path, "expected a valid URI-reference");
  }
}

function geminiSchemaResourceUri(url: URL): string {
  const hashIndex = url.href.indexOf("#");
  return hashIndex === -1 ? url.href : url.href.slice(0, hashIndex);
}

function geminiSchemaFragment(url: URL, path: string): string {
  const hashIndex = url.href.indexOf("#");
  if (hashIndex === -1) return "";
  try {
    return decodeURIComponent(url.href.slice(hashIndex + 1));
  } catch {
    geminiSchemaError(path, "contains invalid URI-fragment encoding");
  }
}

function geminiSchemaResourceForNode(
  schema: Record<string, unknown>,
  path: string,
  parent: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
): GeminiSchemaResource {
  if (!Object.hasOwn(schema, "$id")) return parent;
  const idPath = geminiSchemaChildPath(path, "$id");
  if (typeof schema.$id !== "string" || schema.$id.length === 0) {
    geminiSchemaError(idPath, "expected a non-empty string");
  }
  const resolved = geminiSchemaUri(schema.$id, parent.uri, idPath);
  if (geminiSchemaFragment(resolved, idPath) !== "") {
    geminiSchemaError(idPath, "must not contain a non-empty fragment");
  }
  const uri = geminiSchemaResourceUri(resolved);
  const existing = state.resources.get(uri);
  if (existing !== undefined && existing.root !== schema) {
    geminiSchemaError(
      idPath,
      `duplicates the schema resource declared at ${existing.path}`,
    );
  }
  const resource = { uri, root: schema, path };
  state.resources.set(uri, resource);
  return resource;
}

function registerGeminiSchemaResourceAnchor(
  schema: Record<string, unknown>,
  path: string,
  resource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
): void {
  if (!Object.hasOwn(schema, "$anchor")) return;
  const anchorPath = geminiSchemaChildPath(path, "$anchor");
  if (typeof schema.$anchor !== "string") {
    geminiSchemaError(anchorPath, "expected a non-empty string");
  }
  validateGeminiSchemaAnchorName(schema.$anchor, anchorPath);
  const key = `${resource.uri}#${schema.$anchor}`;
  const existing = state.anchors.get(key);
  if (existing !== undefined && existing.schema !== schema) {
    geminiSchemaError(
      anchorPath,
      `duplicates the anchor declared at ${existing.path}`,
    );
  }
  state.anchors.set(key, { schema, path: anchorPath });
}

function indexGeminiSchemaResourcesAt(
  schema: Record<string, unknown>,
  path: string,
  parentResource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
): void {
  if (state.ancestors.has(schema)) {
    geminiSchemaError(path, "the JavaScript schema object is circular");
  }
  state.ancestors.add(schema);
  try {
    const resource = geminiSchemaResourceForNode(
      schema,
      path,
      parentResource,
      state,
    );
    state.nodes.add(schema);
    state.nodePaths.set(schema, path);
    state.nodeResources.set(schema, resource);
    registerGeminiSchemaResourceAnchor(schema, path, resource, state);
    for (const child of geminiSchemaChildren(schema, path)) {
      indexGeminiSchemaResourcesAt(child.schema, child.path, resource, state);
    }
  } finally {
    state.ancestors.delete(schema);
  }
}

function indexGeminiSchemaResources(
  root: Record<string, unknown>,
  path: string,
  state: GeminiSchemaValidationState,
): void {
  const initialResource = {
    uri: new URL(encodeURIComponent(path), GEMINI_INTERNAL_SCHEMA_BASE).href,
    root,
    path,
  };
  state.resources.set(initialResource.uri, initialResource);
  indexGeminiSchemaResourcesAt(root, path, initialResource, state);
}

function geminiJsonPointerArrayEntry(
  target: readonly unknown[],
  token: string,
  referencePath: string,
  referenceValue: string,
): unknown {
  if (!/^(?:0|[1-9]\d*)$/u.test(token)) {
    geminiSchemaError(
      referencePath,
      `does not resolve JSON Pointer ${referenceValue}`,
    );
  }
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index >= target.length) {
    geminiSchemaError(
      referencePath,
      `does not resolve JSON Pointer ${referenceValue}`,
    );
  }
  return target[index];
}

function geminiJsonPointerObjectEntry(
  target: Record<string, unknown>,
  token: string,
  referencePath: string,
  referenceValue: string,
): unknown {
  if (!Object.hasOwn(target, token)) {
    geminiSchemaError(
      referencePath,
      `does not resolve JSON Pointer ${referenceValue}`,
    );
  }
  return target[token];
}

function geminiJsonPointerTarget(
  resource: GeminiSchemaResource,
  fragment: string,
  referencePath: string,
  referenceValue: string,
): unknown {
  let target: unknown = resource.root;
  for (const rawToken of fragment.slice(1).split("/")) {
    const token = decodeGeminiJsonPointerToken(rawToken, referencePath);
    if (Array.isArray(target)) {
      target = geminiJsonPointerArrayEntry(
        target,
        token,
        referencePath,
        referenceValue,
      );
      continue;
    }
    if (!isPlainSchemaObject(target)) {
      geminiSchemaError(
        referencePath,
        `does not resolve JSON Pointer ${referenceValue}`,
      );
    }
    target = geminiJsonPointerObjectEntry(
      target,
      token,
      referencePath,
      referenceValue,
    );
  }
  return target;
}

function geminiReferencedResource(
  resolved: URL,
  referencePath: string,
  state: GeminiSchemaValidationState,
  contract: "response" | "tool-root",
): GeminiSchemaResource | undefined {
  const resource = state.resources.get(geminiSchemaResourceUri(resolved));
  if (resource !== undefined) return resource;
  if (!state.capabilities.supportsRemoteReferences) {
    const detail =
      contract === "response"
        ? `remote references are not supported by the ${state.capabilities.surface}/${state.capabilities.modelFamily} responseJsonSchema contract`
        : "tool root references must resolve within parametersJsonSchema";
    geminiSchemaError(referencePath, detail);
  }
  return undefined;
}

function resolveGeminiSchemaReference(
  value: string,
  path: string,
  sourceResource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
  contract: "response" | "tool-root" = "response",
): GeminiResolvedSchemaReference | undefined {
  const resolved = geminiSchemaUri(value, sourceResource.uri, path);
  const resource = geminiReferencedResource(resolved, path, state, contract);
  if (resource === undefined) return undefined;
  const fragment = geminiSchemaFragment(resolved, path);
  if (fragment === "") return { schema: resource.root, resource };
  if (!fragment.startsWith("/")) {
    const anchored = state.anchors.get(`${resource.uri}#${fragment}`);
    if (anchored === undefined) {
      geminiSchemaError(path, `does not resolve local anchor #${fragment}`);
    }
    return {
      schema: anchored.schema,
      resource: state.nodeResources.get(anchored.schema) ?? resource,
    };
  }
  const target = geminiJsonPointerTarget(resource, fragment, path, value);
  if (!isPlainSchemaObject(target)) {
    geminiSchemaError(
      path,
      `JSON Pointer ${value} does not identify a schema object`,
    );
  }
  if (!state.nodes.has(target)) {
    geminiSchemaError(
      path,
      `JSON Pointer ${value} identifies a schema container, not a schema object`,
    );
  }
  return {
    schema: target,
    resource: state.nodeResources.get(target) ?? resource,
  };
}

function consumeGeminiSchemaAnalysisWork(
  state: GeminiSchemaValidationState,
  path: string,
): void {
  state.analysisWork += 1;
  if (state.analysisWork > GEMINI_SCHEMA_ANALYSIS_MAX_WORK) {
    geminiSchemaError(
      path,
      `schema analysis exceeds the ${GEMINI_SCHEMA_ANALYSIS_MAX_WORK}-step work limit`,
    );
  }
}

function enterGeminiSchemaAnalysis(
  state: GeminiSchemaValidationState,
  path: string,
): () => void {
  consumeGeminiSchemaAnalysisWork(state, path);
  if (state.analysisDepth >= GEMINI_SCHEMA_ANALYSIS_MAX_DEPTH) {
    geminiSchemaError(
      path,
      `schema analysis exceeds the ${GEMINI_SCHEMA_ANALYSIS_MAX_DEPTH}-level reference and combinator depth limit`,
    );
  }
  state.analysisDepth += 1;
  return () => {
    state.analysisDepth -= 1;
  };
}

interface GeminiSchemaTraversalFrame {
  readonly node: Record<string, unknown>;
  readonly edges: readonly GeminiSchemaGraphEdge[];
  readonly parent?: Record<string, unknown>;
  nextEdge: number;
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
  const graphNodes = new Set<Record<string, unknown>>();
  for (const [source, edges] of state.edges) {
    graphNodes.add(source);
    for (const edge of edges) graphNodes.add(edge.target);
  }

  const enter = (
    node: Record<string, unknown>,
    parent?: Record<string, unknown>,
  ): GeminiSchemaTraversalFrame => {
    consumeGeminiSchemaAnalysisWork(
      state,
      state.nodePaths.get(node) ?? "schema",
    );
    const index = nextIndex++;
    indexes.set(node, index);
    lowLinks.set(node, index);
    stack.push(node);
    onStack.add(node);
    return {
      node,
      edges: state.edges.get(node) ?? [],
      ...(parent === undefined ? {} : { parent }),
      nextEdge: 0,
    };
  };

  for (const start of graphNodes) {
    if (indexes.has(start)) continue;
    const traversal: GeminiSchemaTraversalFrame[] = [enter(start)];
    while (traversal.length > 0) {
      const frame = traversal.at(-1)!;
      if (frame.nextEdge < frame.edges.length) {
        const edge = frame.edges[frame.nextEdge]!;
        frame.nextEdge += 1;
        consumeGeminiSchemaAnalysisWork(
          state,
          state.nodePaths.get(frame.node) ?? "schema",
        );
        if (!indexes.has(edge.target)) {
          traversal.push(enter(edge.target, frame.node));
          continue;
        }
        if (onStack.has(edge.target)) {
          lowLinks.set(
            frame.node,
            Math.min(
              lowLinks.get(frame.node)!,
              indexes.get(edge.target)!,
            ),
          );
        }
        continue;
      }

      traversal.pop();
      if (frame.parent !== undefined) {
        lowLinks.set(
          frame.parent,
          Math.min(
            lowLinks.get(frame.parent)!,
            lowLinks.get(frame.node)!,
          ),
        );
      }
      if (lowLinks.get(frame.node) !== indexes.get(frame.node)) continue;
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        components.set(member, nextComponent);
        if (member === frame.node) break;
      }
      nextComponent += 1;
    }
  }
  return components;
}

function validateGeminiSchemaReferences(
  state: GeminiSchemaValidationState,
): void {
  for (const reference of state.references) {
    const sourceResource = state.nodeResources.get(reference.source);
    if (sourceResource === undefined) {
      geminiSchemaError(reference.path, "has no enclosing schema resource");
    }
    const resolved = resolveGeminiSchemaReference(
      reference.value,
      reference.path,
      sourceResource,
      state,
    );
    if (resolved === undefined) continue;
    reference.target = resolved.schema;
    state.nodes.add(resolved.schema);
    addGeminiSchemaEdge(state, reference.source, resolved.schema);
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

function createGeminiSchemaValidationState(
  capabilities: GeminiResponseJsonSchemaCapabilities,
): GeminiSchemaValidationState {
  return {
    capabilities,
    ancestors: new Set(),
    nodes: new Set(),
    edges: new Map(),
    references: [],
    nodePaths: new Map(),
    nodeResources: new Map(),
    resources: new Map(),
    anchors: new Map(),
    analysisWork: 0,
    analysisDepth: 0,
  };
}

/** Validate restrictions documented for Gemini response JSON Schema. */
function compileGeminiSchema(
  value: unknown,
  path: string,
  capabilities: GeminiResponseJsonSchemaCapabilities,
): Record<string, unknown> {
  const root = cloneGeminiSchemaForValidation(value, path);
  const state = createGeminiSchemaValidationState(capabilities);
  validateGeminiJsonSchemaAt(root, path, GEMINI_NO_PROPERTY_CONTEXT, state);
  indexGeminiSchemaResources(root, path, state);
  validateGeminiSchemaReferences(state);
  return root;
}

const GEMINI_TOOL_ROOT_TYPES: ReadonlySet<string> = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function intersectGeminiToolRootTypes(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): Set<string> {
  return new Set([...left].filter((type) => right.has(type)));
}

function unionGeminiToolRootTypes(
  domains: readonly ReadonlySet<string>[],
): Set<string> {
  return new Set(domains.flatMap((domain) => [...domain]));
}

function geminiToolExplicitTypeDomain(value: unknown): ReadonlySet<string> {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length === 0) return new Set();
  if (
    values.some(
      (entry) =>
        typeof entry !== "string" || !GEMINI_TOOL_ROOT_TYPES.has(entry),
    )
  ) {
    return new Set();
  }
  return new Set(
    (values as string[]).flatMap((type) =>
      type === "number" ? ["integer", "number"] : [type],
    ),
  );
}

function geminiToolLiteralTypeDomain(value: unknown): ReadonlySet<string> {
  if (value === null) return new Set(["null"]);
  if (Array.isArray(value)) return new Set(["array"]);
  switch (typeof value) {
    case "boolean":
      return new Set(["boolean"]);
    case "number":
      return Number.isFinite(value)
        ? new Set([Number.isInteger(value) ? "integer" : "number"])
        : new Set();
    case "object":
      return new Set(["object"]);
    case "string":
      return new Set(["string"]);
    default:
      return new Set();
  }
}

function geminiToolSchemaLiteralDomain(
  schema: Record<string, unknown>,
): ReadonlySet<string> | undefined {
  let domain: ReadonlySet<string> | undefined;
  if (Object.hasOwn(schema, "const")) {
    domain = geminiToolLiteralTypeDomain(schema.const);
  }
  if (Object.hasOwn(schema, "enum")) {
    const enumDomain = Array.isArray(schema.enum)
      ? unionGeminiToolRootTypes(
          schema.enum.map((entry) => geminiToolLiteralTypeDomain(entry)),
        )
      : new Set<string>();
    domain =
      domain === undefined
        ? enumDomain
        : intersectGeminiToolRootTypes(domain, enumDomain);
  }
  return domain;
}

const GEMINI_TOOL_LITERAL_DOMAIN_MAX_VALUES = 256;
const GEMINI_TOOL_LITERAL_EQUALITY_MAX_NODES =
  GEMINI_SCHEMA_VALIDATION_MAX_VALUES;

type GeminiToolLiteralConstraintDomain =
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "finite"; values: readonly unknown[] }>;

type GeminiToolJsonEquality = "equal" | "different" | "unknown";

interface GeminiToolLiteralAnalysisState {
  equalityNodesRemaining: number;
  readonly visiting: Set<Record<string, unknown>>;
}

const GEMINI_TOOL_UNKNOWN_LITERAL_DOMAIN: GeminiToolLiteralConstraintDomain = {
  kind: "unknown",
};

function geminiToolJsonArraysEqual(
  left: readonly unknown[],
  right: readonly unknown[],
  analysis: GeminiToolLiteralAnalysisState,
): GeminiToolJsonEquality {
  if (left.length !== right.length) return "different";
  for (let index = 0; index < left.length; index += 1) {
    const equality = geminiToolJsonValuesEqual(
      left[index],
      right[index],
      analysis,
    );
    if (equality !== "equal") return equality;
  }
  return "equal";
}

function geminiToolJsonObjectsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  analysis: GeminiToolLiteralAnalysisState,
): GeminiToolJsonEquality {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return "different";
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return "different";
    const equality = geminiToolJsonValuesEqual(left[key], right[key], analysis);
    if (equality !== "equal") return equality;
  }
  return "equal";
}

function geminiToolJsonValuesEqual(
  left: unknown,
  right: unknown,
  analysis: GeminiToolLiteralAnalysisState,
): GeminiToolJsonEquality {
  if (analysis.equalityNodesRemaining === 0) return "unknown";
  analysis.equalityNodesRemaining -= 1;

  if (left === right) return "equal";
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return "different";
  }
  if (Array.isArray(left)) {
    return Array.isArray(right)
      ? geminiToolJsonArraysEqual(left, right, analysis)
      : "different";
  }
  if (Array.isArray(right)) return "different";
  return geminiToolJsonObjectsEqual(
    left as Record<string, unknown>,
    right as Record<string, unknown>,
    analysis,
  );
}

function intersectGeminiToolLiteralDomains(
  left: GeminiToolLiteralConstraintDomain,
  right: GeminiToolLiteralConstraintDomain,
  analysis: GeminiToolLiteralAnalysisState,
): GeminiToolLiteralConstraintDomain {
  if (left.kind === "unknown") return right;
  if (right.kind === "unknown") return left;

  const values: unknown[] = [];
  for (const leftValue of left.values) {
    for (const rightValue of right.values) {
      const equality = geminiToolJsonValuesEqual(
        leftValue,
        rightValue,
        analysis,
      );
      if (equality === "unknown") return GEMINI_TOOL_UNKNOWN_LITERAL_DOMAIN;
      if (equality === "equal") {
        values.push(leftValue);
        break;
      }
    }
  }
  return { kind: "finite", values };
}

function geminiToolOwnLiteralDomain(
  schema: Record<string, unknown>,
  analysis: GeminiToolLiteralAnalysisState,
): GeminiToolLiteralConstraintDomain {
  let domain = GEMINI_TOOL_UNKNOWN_LITERAL_DOMAIN;
  if (Object.hasOwn(schema, "const")) {
    domain = { kind: "finite", values: [schema.const] };
  }
  if (Object.hasOwn(schema, "enum")) {
    let enumDomain: GeminiToolLiteralConstraintDomain;
    if (!Array.isArray(schema.enum)) {
      enumDomain = { kind: "finite", values: [] };
    } else if (schema.enum.length > GEMINI_TOOL_LITERAL_DOMAIN_MAX_VALUES) {
      enumDomain = GEMINI_TOOL_UNKNOWN_LITERAL_DOMAIN;
    } else {
      enumDomain = { kind: "finite", values: schema.enum };
    }
    domain = intersectGeminiToolLiteralDomains(domain, enumDomain, analysis);
  }
  return domain;
}

function geminiToolLiteralBranchDomain(
  branch: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  analysis: GeminiToolLiteralAnalysisState,
): GeminiToolLiteralConstraintDomain {
  if (branch === true) return GEMINI_TOOL_UNKNOWN_LITERAL_DOMAIN;
  if (branch === false || !isPlainSchemaObject(branch)) {
    return { kind: "finite", values: [] };
  }
  const resource = state.nodeResources.get(branch);
  return resource === undefined
    ? { kind: "finite", values: [] }
    : geminiToolSchemaFiniteLiteralDomain(
        branch,
        path,
        resource,
        state,
        analysis,
      );
}

function geminiToolLiteralReferenceDomain(
  schema: Record<string, unknown>,
  path: string,
  resource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
  analysis: GeminiToolLiteralAnalysisState,
): GeminiToolLiteralConstraintDomain {
  if (!Object.hasOwn(schema, "$ref")) {
    return GEMINI_TOOL_UNKNOWN_LITERAL_DOMAIN;
  }
  const referencePath = geminiSchemaChildPath(path, "$ref");
  if (typeof schema.$ref !== "string" || schema.$ref.trim() === "") {
    geminiSchemaError(referencePath, "expected a non-empty string");
  }
  const resolved = resolveGeminiSchemaReference(
    schema.$ref,
    referencePath,
    resource,
    state,
    "tool-root",
  );
  return resolved === undefined
    ? { kind: "finite", values: [] }
    : geminiToolSchemaFiniteLiteralDomain(
        resolved.schema,
        state.nodePaths.get(resolved.schema) ?? referencePath,
        resolved.resource,
        state,
        analysis,
      );
}

function geminiToolLiteralAllOfDomain(
  value: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  analysis: GeminiToolLiteralAnalysisState,
): GeminiToolLiteralConstraintDomain {
  if (value === undefined) return GEMINI_TOOL_UNKNOWN_LITERAL_DOMAIN;
  if (!Array.isArray(value) || value.length === 0) {
    return { kind: "finite", values: [] };
  }
  let domain = GEMINI_TOOL_UNKNOWN_LITERAL_DOMAIN;
  for (let index = 0; index < value.length; index += 1) {
    domain = intersectGeminiToolLiteralDomains(
      domain,
      geminiToolLiteralBranchDomain(
        value[index],
        `${path}[${index}]`,
        state,
        analysis,
      ),
      analysis,
    );
  }
  return domain;
}

function geminiToolSchemaFiniteLiteralDomain(
  schema: Record<string, unknown>,
  path: string,
  resource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
  analysis: GeminiToolLiteralAnalysisState,
): GeminiToolLiteralConstraintDomain {
  if (analysis.visiting.has(schema)) {
    return GEMINI_TOOL_UNKNOWN_LITERAL_DOMAIN;
  }
  const leaveAnalysis = enterGeminiSchemaAnalysis(state, path);
  analysis.visiting.add(schema);
  try {
    let domain = geminiToolOwnLiteralDomain(schema, analysis);
    domain = intersectGeminiToolLiteralDomains(
      domain,
      geminiToolLiteralReferenceDomain(schema, path, resource, state, analysis),
      analysis,
    );
    return intersectGeminiToolLiteralDomains(
      domain,
      geminiToolLiteralAllOfDomain(
        schema.allOf,
        geminiSchemaChildPath(path, "allOf"),
        state,
        analysis,
      ),
      analysis,
    );
  } finally {
    analysis.visiting.delete(schema);
    leaveAnalysis();
  }
}

const GEMINI_TOOL_NON_VALIDATING_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "propertyOrdering",
  "readOnly",
  "title",
  "writeOnly",
]);

function complementGeminiToolRootTypes(
  domain: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...GEMINI_TOOL_ROOT_TYPES].filter((type) => !domain.has(type)),
  );
}

function geminiToolSchemaAlwaysAcceptedBranchDomain(
  branch: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> {
  if (branch === true) return GEMINI_TOOL_ROOT_TYPES;
  if (branch === false || !isPlainSchemaObject(branch)) return new Set();
  const resource = state.nodeResources.get(branch);
  return resource === undefined
    ? new Set()
    : geminiToolSchemaAlwaysAcceptedDomain(
        branch,
        path,
        resource,
        state,
        visiting,
      );
}

function geminiToolSchemaAlwaysAcceptedReferenceDomain(
  schema: Record<string, unknown>,
  path: string,
  resource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> | undefined {
  if (!Object.hasOwn(schema, "$ref")) return undefined;
  const referencePath = geminiSchemaChildPath(path, "$ref");
  if (typeof schema.$ref !== "string" || schema.$ref.trim() === "") {
    return new Set();
  }
  const resolved = resolveGeminiSchemaReference(
    schema.$ref,
    referencePath,
    resource,
    state,
    "tool-root",
  );
  return resolved === undefined
    ? new Set()
    : geminiToolSchemaAlwaysAcceptedDomain(
        resolved.schema,
        state.nodePaths.get(resolved.schema) ?? referencePath,
        resolved.resource,
        state,
        visiting,
      );
}

function geminiToolSchemaAlwaysAcceptedAllOfDomain(
  value: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return new Set();
  return value.reduce<ReadonlySet<string>>(
    (domain, branch, index) =>
      intersectGeminiToolRootTypes(
        domain,
        geminiToolSchemaAlwaysAcceptedBranchDomain(
          branch,
          `${path}[${index}]`,
          state,
          visiting,
        ),
      ),
    GEMINI_TOOL_ROOT_TYPES,
  );
}

function geminiToolSchemaAlwaysAcceptedAnyOfDomain(
  value: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return new Set();
  return unionGeminiToolRootTypes(
    value.map((branch, index) =>
      geminiToolSchemaAlwaysAcceptedBranchDomain(
        branch,
        `${path}[${index}]`,
        state,
        visiting,
      ),
    ),
  );
}

interface GeminiToolOneOfBranchDomains {
  readonly always: ReadonlySet<string>;
  readonly possible: ReadonlySet<string>;
}

function geminiToolSchemaOneOfBranchDomains(
  branch: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): GeminiToolOneOfBranchDomains {
  const always = geminiToolSchemaAlwaysAcceptedBranchDomain(
    branch,
    path,
    state,
    visiting,
  );
  if (branch === true) {
    return { always, possible: GEMINI_TOOL_ROOT_TYPES };
  }
  if (branch === false || !isPlainSchemaObject(branch)) {
    return { always, possible: new Set() };
  }
  const resource = state.nodeResources.get(branch);
  return {
    always,
    possible:
      resource === undefined
        ? new Set()
        : geminiToolSchemaRootDomain(branch, path, resource, state, visiting),
  };
}

function geminiToolOneOfAlwaysAcceptsType(
  branches: readonly GeminiToolOneOfBranchDomains[],
  type: string,
): boolean {
  const alwaysIndex = branches.findIndex((branch) => branch.always.has(type));
  if (alwaysIndex === -1) return false;
  if (
    branches.some(
      (branch, index) => index > alwaysIndex && branch.always.has(type),
    )
  ) {
    return false;
  }
  return branches.every(
    (branch, index) => index === alwaysIndex || !branch.possible.has(type),
  );
}

function geminiToolSchemaOneOfDomainMatching(
  value: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
  acceptsType: (
    branches: readonly GeminiToolOneOfBranchDomains[],
    type: string,
  ) => boolean,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return new Set();
  const branches = value.map((branch, index) =>
    geminiToolSchemaOneOfBranchDomains(
      branch,
      `${path}[${index}]`,
      state,
      visiting,
    ),
  );
  return new Set(
    [...GEMINI_TOOL_ROOT_TYPES].filter((type) => acceptsType(branches, type)),
  );
}

function geminiToolSchemaAlwaysAcceptedOneOfDomain(
  value: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> | undefined {
  return geminiToolSchemaOneOfDomainMatching(
    value,
    path,
    state,
    visiting,
    geminiToolOneOfAlwaysAcceptsType,
  );
}

function geminiToolOneOfCanAcceptType(
  branches: readonly GeminiToolOneOfBranchDomains[],
  type: string,
): boolean {
  if (!branches.some((branch) => branch.possible.has(type))) return false;
  return branches.filter((branch) => branch.always.has(type)).length < 2;
}

function geminiToolSchemaOneOfDomain(
  value: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> | undefined {
  return geminiToolSchemaOneOfDomainMatching(
    value,
    path,
    state,
    visiting,
    geminiToolOneOfCanAcceptType,
  );
}

function geminiToolSchemaAlwaysAcceptedDomain(
  schema: Record<string, unknown>,
  path: string,
  resource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> {
  if (visiting.has(schema)) return new Set();
  const leaveAnalysis = enterGeminiSchemaAnalysis(state, path);
  visiting.add(schema);
  try {
    const validatingKeys = Object.keys(schema).filter(
      (key) =>
        !GEMINI_TOOL_NON_VALIDATING_SCHEMA_KEYS.has(key) &&
        key !== "type" &&
        key !== "$ref" &&
        key !== "allOf" &&
        key !== "anyOf" &&
        key !== "oneOf",
    );
    if (validatingKeys.length > 0) return new Set();

    let domain: ReadonlySet<string> = GEMINI_TOOL_ROOT_TYPES;
    if (Object.hasOwn(schema, "type")) {
      domain = intersectGeminiToolRootTypes(
        domain,
        geminiToolExplicitTypeDomain(schema.type),
      );
    }
    domain = constrainGeminiToolRootDomain(
      domain,
      geminiToolSchemaAlwaysAcceptedReferenceDomain(
        schema,
        path,
        resource,
        state,
        visiting,
      ),
    );
    domain = constrainGeminiToolRootDomain(
      domain,
      geminiToolSchemaAlwaysAcceptedAllOfDomain(
        schema.allOf,
        geminiSchemaChildPath(path, "allOf"),
        state,
        visiting,
      ),
    );
    domain = constrainGeminiToolRootDomain(
      domain,
      geminiToolSchemaAlwaysAcceptedAnyOfDomain(
        schema.anyOf,
        geminiSchemaChildPath(path, "anyOf"),
        state,
        visiting,
      ),
    );
    return constrainGeminiToolRootDomain(
      domain,
      geminiToolSchemaAlwaysAcceptedOneOfDomain(
        schema.oneOf,
        geminiSchemaChildPath(path, "oneOf"),
        state,
        visiting,
      ),
    );
  } finally {
    visiting.delete(schema);
    leaveAnalysis();
  }
}

function geminiToolSchemaNotDomain(
  value: unknown,
  path: string,
  resource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (value === true) return new Set();
  if (value === false) return GEMINI_TOOL_ROOT_TYPES;
  if (!isPlainSchemaObject(value)) return new Set();
  const childResource = state.nodeResources.get(value) ?? resource;
  return complementGeminiToolRootTypes(
    geminiToolSchemaAlwaysAcceptedDomain(
      value,
      path,
      childResource,
      state,
      new Set(),
    ),
  );
}

function geminiToolSchemaReferenceDomain(
  schema: Record<string, unknown>,
  path: string,
  resource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> | undefined {
  if (!Object.hasOwn(schema, "$ref")) return undefined;
  const referencePath = geminiSchemaChildPath(path, "$ref");
  if (typeof schema.$ref !== "string" || schema.$ref.trim() === "") {
    geminiSchemaError(referencePath, "expected a non-empty string");
  }
  const resolved = resolveGeminiSchemaReference(
    schema.$ref,
    referencePath,
    resource,
    state,
    "tool-root",
  );
  if (resolved === undefined) return new Set();
  return geminiToolSchemaRootDomain(
    resolved.schema,
    state.nodePaths.get(resolved.schema) ?? referencePath,
    resolved.resource,
    state,
    visiting,
  );
}

function geminiToolSchemaUnionDomain(
  value: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return new Set();
  const domains = value.map((branch, index): ReadonlySet<string> => {
    if (branch === true) return GEMINI_TOOL_ROOT_TYPES;
    if (branch === false || !isPlainSchemaObject(branch)) return new Set();
    const resource = state.nodeResources.get(branch);
    if (resource === undefined) return new Set();
    return geminiToolSchemaRootDomain(
      branch,
      `${path}[${index}]`,
      resource,
      state,
      visiting,
    );
  });
  return unionGeminiToolRootTypes(domains);
}

function geminiToolSchemaAllOfDomain(
  value: unknown,
  path: string,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return new Set();
  let domain = new Set(GEMINI_TOOL_ROOT_TYPES);
  value.forEach((branch, index) => {
    if (branch === true) return;
    if (branch === false || !isPlainSchemaObject(branch)) {
      domain = new Set();
      return;
    }
    const resource = state.nodeResources.get(branch);
    const branchDomain =
      resource === undefined
        ? new Set<string>()
        : geminiToolSchemaRootDomain(
            branch,
            `${path}[${index}]`,
            resource,
            state,
            visiting,
          );
    domain = intersectGeminiToolRootTypes(domain, branchDomain);
  });
  return domain;
}

function constrainGeminiToolRootDomain(
  domain: ReadonlySet<string>,
  constraint: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  return constraint === undefined
    ? domain
    : intersectGeminiToolRootTypes(domain, constraint);
}

function geminiToolSchemaRootDomain(
  schema: Record<string, unknown>,
  path: string,
  resource: GeminiSchemaResource,
  state: GeminiSchemaValidationState,
  visiting: Set<Record<string, unknown>>,
): ReadonlySet<string> {
  if (visiting.has(schema)) return GEMINI_TOOL_ROOT_TYPES;
  const leaveAnalysis = enterGeminiSchemaAnalysis(state, path);
  visiting.add(schema);
  try {
    let domain: ReadonlySet<string> = GEMINI_TOOL_ROOT_TYPES;
    if (Object.hasOwn(schema, "type")) {
      domain = intersectGeminiToolRootTypes(
        domain,
        geminiToolExplicitTypeDomain(schema.type),
      );
    }
    domain = constrainGeminiToolRootDomain(
      domain,
      geminiToolSchemaLiteralDomain(schema),
    );
    const reference = geminiToolSchemaReferenceDomain(
      schema,
      path,
      resource,
      state,
      visiting,
    );
    domain = constrainGeminiToolRootDomain(domain, reference);
    const allOf = geminiToolSchemaAllOfDomain(
      schema.allOf,
      geminiSchemaChildPath(path, "allOf"),
      state,
      visiting,
    );
    domain = constrainGeminiToolRootDomain(domain, allOf);
    const anyOf = geminiToolSchemaUnionDomain(
      schema.anyOf,
      geminiSchemaChildPath(path, "anyOf"),
      state,
      visiting,
    );
    domain = constrainGeminiToolRootDomain(domain, anyOf);
    const oneOf = geminiToolSchemaOneOfDomain(
      schema.oneOf,
      geminiSchemaChildPath(path, "oneOf"),
      state,
      visiting,
    );
    domain = constrainGeminiToolRootDomain(domain, oneOf);
    return constrainGeminiToolRootDomain(
      domain,
      geminiToolSchemaNotDomain(
        schema.not,
        geminiSchemaChildPath(path, "not"),
        resource,
        state,
      ),
    );
  } finally {
    visiting.delete(schema);
    leaveAnalysis();
  }
}

function validateGeminiToolSchemaRoot(
  value: unknown,
  path: string,
  capabilities: GeminiResponseJsonSchemaCapabilities,
): Record<string, unknown> {
  const root = cloneGeminiSchemaForValidation(value, path);
  const state = createGeminiSchemaValidationState(capabilities);
  indexGeminiSchemaResources(root, path, state);
  const resource = state.nodeResources.get(root);
  const literalDomain =
    resource === undefined
      ? { kind: "finite" as const, values: [] }
      : geminiToolSchemaFiniteLiteralDomain(root, path, resource, state, {
          equalityNodesRemaining: GEMINI_TOOL_LITERAL_EQUALITY_MAX_NODES,
          visiting: new Set(),
        });
  if (literalDomain.kind === "finite" && literalDomain.values.length === 0) {
    geminiSchemaError(
      path,
      "tool parametersJsonSchema has contradictory finite const/enum constraints at the root",
    );
  }
  const rootDomain =
    resource === undefined
      ? new Set<string>()
      : geminiToolSchemaRootDomain(root, path, resource, state, new Set());
  if (rootDomain.size !== 1 || !rootDomain.has("object")) {
    geminiSchemaError(
      path,
      "tool parametersJsonSchema must describe an object at the root",
    );
  }
  return root;
}

function geminiTools(
  tools: readonly LLMTool[],
  capabilities: GeminiResponseJsonSchemaCapabilities,
): readonly Record<string, unknown>[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parametersJsonSchema: validateGeminiToolSchemaRoot(
          tool.function.parameters,
          `tools[${JSON.stringify(tool.function.name)}].parameters`,
          capabilities,
        ),
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
  const schemaCapabilities = geminiResponseJsonSchemaCapabilities(
    args.config.endpointPlan,
    args.model,
  );
  const tools = geminiTools(args.tools, schemaCapabilities);
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
      schemaCapabilities,
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
    toolSchemaChars: JSON.stringify(args.body.tools ?? []).length,
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
