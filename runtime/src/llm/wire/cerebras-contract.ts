/**
 * Cerebras API v2 request contracts that are stricter than the generic
 * OpenAI-compatible Chat Completions shape.
 *
 * @module
 */

import { Buffer } from "node:buffer";

import type {
  LLMMessage,
  LLMStructuredOutputRequest,
} from "../types.js";
import { buildStructuredOutputTextFormat } from "../structured-output.js";

const MAX_IMAGE_COUNT = 10;
const MAX_REQUEST_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_STRICT_SCHEMA_BYTES = 5_000;
const MAX_STRICT_SCHEMA_DEPTH = 10;
const MAX_STRICT_SCHEMA_PROPERTIES = 500;
const MAX_STRICT_SCHEMA_ENUM_VALUES = 500;
const MAX_LARGE_ENUM_STRING_BYTES = 7_500;

const STRICT_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "enum",
  "anyOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

const STRICT_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

interface StrictSchemaStats {
  propertyCount: number;
  enumValueCount: number;
  enumStringBytes: number;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function primitiveMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function strictSchemaNodeIsSupported(
  value: unknown,
  depth: number,
  root: boolean,
  stats: StrictSchemaStats,
): boolean {
  if (!isJsonObject(value) || depth > MAX_STRICT_SCHEMA_DEPTH) return false;
  if (Object.keys(value).some((key) => !STRICT_SCHEMA_KEYS.has(key))) {
    return false;
  }

  const type = value.type;
  const anyOf = value.anyOf;
  if (
    type !== undefined &&
    (typeof type !== "string" || !STRICT_SCHEMA_TYPES.has(type))
  ) {
    // Type arrays are intentionally conservative here. Cerebras documents
    // nullable values through non-root anyOf unions, not OpenAI-style arrays.
    return false;
  }
  if (type === undefined && anyOf === undefined) return false;
  if (root && (type !== "object" || anyOf !== undefined)) return false;

  if (anyOf !== undefined) {
    if (
      root ||
      type !== undefined ||
      !Array.isArray(anyOf) ||
      anyOf.length === 0 ||
      !anyOf.every((entry) =>
        strictSchemaNodeIsSupported(entry, depth + 1, false, stats)
      )
    ) {
      return false;
    }
  }

  if (type === "object") {
    const properties = value.properties;
    if (
      !isJsonObject(properties) ||
      value.additionalProperties !== false
    ) {
      return false;
    }
    const propertyEntries = Object.entries(properties);
    stats.propertyCount += propertyEntries.length;
    if (stats.propertyCount > MAX_STRICT_SCHEMA_PROPERTIES) return false;
    if (
      !propertyEntries.every(([, entry]) =>
        strictSchemaNodeIsSupported(entry, depth + 1, false, stats)
      )
    ) {
      return false;
    }
    const required = value.required;
    if (!Array.isArray(required)) return false;
    if (
      required.some((entry) => typeof entry !== "string") ||
      new Set(required).size !== required.length ||
      required.some((entry) => !(entry in properties))
    ) {
      return false;
    }
  } else if (
    value.properties !== undefined ||
    value.required !== undefined ||
    value.additionalProperties !== undefined
  ) {
    return false;
  }

  const prefixItems = value.prefixItems;
  if (type === "array") {
    if (prefixItems !== undefined) {
      if (
        !Array.isArray(prefixItems) ||
        prefixItems.length === 0 ||
        value.items !== false ||
        !prefixItems.every((entry) =>
          strictSchemaNodeIsSupported(entry, depth + 1, false, stats)
        )
      ) {
        return false;
      }
    } else if (
      !isJsonObject(value.items) ||
      !strictSchemaNodeIsSupported(value.items, depth + 1, false, stats)
    ) {
      return false;
    }
  } else if (value.items !== undefined || prefixItems !== undefined) {
    return false;
  }

  if (value.enum !== undefined) {
    if (
      typeof type !== "string" ||
      !Array.isArray(value.enum) ||
      value.enum.length === 0 ||
      !value.enum.every(
        (entry) => isJsonPrimitive(entry) && primitiveMatchesType(entry, type),
      )
    ) {
      return false;
    }
    stats.enumValueCount += value.enum.length;
    stats.enumStringBytes += value.enum.reduce(
      (total, entry) =>
        total +
        (typeof entry === "string" ? Buffer.byteLength(entry, "utf8") : 0),
      0,
    );
    if (stats.enumValueCount > MAX_STRICT_SCHEMA_ENUM_VALUES) return false;
  }
  const numericConstraints = [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ] as const;
  if (
    numericConstraints.some((constraint) => value[constraint] !== undefined) &&
    type !== "number" &&
    type !== "integer"
  ) {
    return false;
  }
  for (const constraint of numericConstraints) {
    if (
      value[constraint] !== undefined &&
      (typeof value[constraint] !== "number" ||
        !Number.isFinite(value[constraint]) ||
        (constraint === "multipleOf" && value[constraint] <= 0))
    ) {
      return false;
    }
  }
  return true;
}

function strictSchemaIsSupported(schema: unknown): boolean {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return false;
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAX_STRICT_SCHEMA_BYTES
  ) {
    return false;
  }
  const stats: StrictSchemaStats = {
    propertyCount: 0,
    enumValueCount: 0,
    enumStringBytes: 0,
  };
  if (!strictSchemaNodeIsSupported(schema, 1, true, stats)) return false;
  return (
    stats.enumValueCount <= 250 ||
    stats.enumStringBytes <= MAX_LARGE_ENUM_STRING_BYTES
  );
}

/** Build a Cerebras response format, falling back before v2 rejects it. */
export function buildCerebrasStructuredOutputTextFormat(
  request: LLMStructuredOutputRequest | undefined,
): Record<string, unknown> | undefined {
  const format = buildStructuredOutputTextFormat(request);
  if (
    format?.strict !== true ||
    strictSchemaIsSupported(format.schema)
  ) {
    return format;
  }

  // Keep the author's original schema as a non-strict model hint, then rely
  // on AgenC's existing post-response validation. Projecting away constraints
  // such as maxItems would silently weaken the application contract.
  const schema = request?.schema;
  return schema === undefined
    ? format
    : buildStructuredOutputTextFormat(
        { ...request, schema: { ...schema, strict: false } },
        false,
      );
}

function imageWirePayloadBytes(url: string): number | undefined {
  const match = /^data:(image\/(?:png|jpeg));base64,([a-z0-9+/]*={0,2})$/iu
    .exec(url);
  if (!match) return undefined;
  const mimeType = match[1]?.toLowerCase();
  const payload = match[2] ?? "";
  if (payload.length === 0 || payload.length % 4 === 1) return undefined;
  const paddingIndex = payload.indexOf("=");
  if (paddingIndex !== -1 && payload.length % 4 !== 0) return undefined;
  // The documented 10 MiB ceiling applies to the encoded HTTP request, not
  // the decoded source files. Bail out before allocating another attacker-
  // sized buffer when this one data URI already exceeds that ceiling.
  const wireBytes = Buffer.byteLength(url, "utf8");
  if (wireBytes > MAX_REQUEST_PAYLOAD_BYTES) return wireBytes;

  const decoded = Buffer.from(payload, "base64");
  if (
    decoded.length === 0 ||
    decoded.toString("base64").replace(/=+$/u, "") !==
      payload.replace(/=+$/u, "")
  ) {
    return undefined;
  }
  const isPng =
    mimeType === "image/png" &&
    decoded.length >= 8 &&
    decoded[0] === 0x89 &&
    decoded[1] === 0x50 &&
    decoded[2] === 0x4e &&
    decoded[3] === 0x47 &&
    decoded[4] === 0x0d &&
    decoded[5] === 0x0a &&
    decoded[6] === 0x1a &&
    decoded[7] === 0x0a;
  const isJpeg =
    mimeType === "image/jpeg" &&
    decoded.length >= 3 &&
    decoded[0] === 0xff &&
    decoded[1] === 0xd8 &&
    decoded[2] === 0xff;
  return isPng || isJpeg ? wireBytes : undefined;
}

/** Fail before HTTP when the final encoded Cerebras body exceeds 10 MiB. */
export function assertCerebrasRequestPayloadSize(
  request: Record<string, unknown>,
): void {
  if (
    Buffer.byteLength(JSON.stringify(request), "utf8") >
    MAX_REQUEST_PAYLOAD_BYTES
  ) {
    throw new TypeError(
      "Cerebras requests must not exceed the 10 MiB total payload limit",
    );
  }
}

/** Validate user images and best-effort filter tool images for Cerebras v2. */
export function applyCerebrasImageInputContract(
  messages: readonly LLMMessage[],
  acceptsDirectImageInput: boolean,
): readonly LLMMessage[] {
  let imageCount = 0;
  let totalImageWireBytes = 0;

  // Direct history is authoritative: reject an invalid request rather than
  // silently changing what the user asked the model to inspect. Tool-result
  // images are best-effort and use the remaining shared budget below.
  for (const message of messages) {
    if (message.role === "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "image_url") continue;
      if (message.role !== "user") {
        throw new TypeError(
          "Cerebras image input is supported only in user messages",
        );
      }
      if (!acceptsDirectImageInput) {
        throw new TypeError(
          "The selected Cerebras model does not support image input",
        );
      }
      const wireBytes = imageWirePayloadBytes(part.image_url.url);
      if (wireBytes === undefined) {
        throw new TypeError(
          "Cerebras image input must be a base64 PNG or JPEG data URI; " +
            "remote URLs, WebP, and GIF are not supported",
        );
      }
      imageCount += 1;
      totalImageWireBytes += wireBytes;
      if (imageCount > MAX_IMAGE_COUNT) {
        throw new TypeError(
          `Cerebras image input supports at most ${MAX_IMAGE_COUNT} images per request`,
        );
      }
      if (totalImageWireBytes > MAX_REQUEST_PAYLOAD_BYTES) {
        throw new TypeError(
          "Cerebras image input exceeds the 10 MiB total request payload limit",
        );
      }
    }
  }

  return messages.map((message): LLMMessage => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }
    let changed = false;
    const content = message.content.filter((part) => {
      if (part.type !== "image_url") return true;
      const wireBytes = imageWirePayloadBytes(part.image_url.url);
      if (
        wireBytes === undefined ||
        imageCount >= MAX_IMAGE_COUNT ||
        totalImageWireBytes + wireBytes > MAX_REQUEST_PAYLOAD_BYTES
      ) {
        changed = true;
        return false;
      }
      imageCount += 1;
      totalImageWireBytes += wireBytes;
      return true;
    });
    return changed ? { ...message, content } : message;
  });
}
