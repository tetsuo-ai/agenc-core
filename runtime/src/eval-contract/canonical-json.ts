import { createHash } from "node:crypto";
import type { Sha256Digest } from "./types.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains a lone high surrogate`);
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains a lone low surrogate`);
    }
  }
}

/**
 * RFC 8785 JSON Canonicalization Scheme for already-parsed I-JSON values.
 *
 * JSON.parse has already removed duplicate property names. This function
 * additionally rejects non-I-JSON values, cycles, sparse arrays, exotic
 * objects, and lone surrogates before applying ECMAScript number/string
 * serialization and UTF-16 property ordering required by RFC 8785.
 */
export function canonicalizeJson(value: unknown): string {
  const ancestors = new Set<object>();

  const visit = (candidate: unknown, path: string): string => {
    if (candidate === null) return "null";
    if (typeof candidate === "boolean") return candidate ? "true" : "false";
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new TypeError(`${path} must be a finite I-JSON number`);
      }
      if (Number.isInteger(candidate) && !Number.isSafeInteger(candidate)) {
        throw new TypeError(`${path} must be a safe I-JSON integer`);
      }
      if (Object.is(candidate, -0)) {
        throw new TypeError(`${path} must not use ambiguous negative zero`);
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "string") {
      assertWellFormedUnicode(candidate, path);
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== "object") {
      throw new TypeError(`${path} is not an I-JSON value`);
    }

    if (ancestors.has(candidate)) {
      throw new TypeError(`${path} contains a cycle`);
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const ownKeys = Reflect.ownKeys(candidate);
        for (const key of ownKeys) {
          if (typeof key === "symbol") {
            throw new TypeError(`${path} contains a symbol property`);
          }
          if (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
            throw new TypeError(`${path} contains a non-JSON array property`);
          }
        }
        for (let index = 0; index < candidate.length; index += 1) {
          if (!(index in candidate)) {
            throw new TypeError(`${path} contains a sparse array`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError(`${path}[${index}] must be an enumerable data property`);
          }
        }
        return `[${candidate
          .map((entry, index) => visit(entry, `${path}[${index}]`))
          .join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} must be a plain JSON object`);
      }
      const record = candidate as Record<string, unknown>;
      const ownKeys = Reflect.ownKeys(record);
      if (ownKeys.some((key) => typeof key === "symbol")) {
        throw new TypeError(`${path} contains a symbol property`);
      }
      const keys = (ownKeys as string[]).sort();
      const members = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`${path}.${key} must be an enumerable data property`);
        }
        assertWellFormedUnicode(key, `${path} property name`);
        return `${JSON.stringify(key)}:${visit(descriptor.value, `${path}.${key}`)}`;
      });
      return `{${members.join(",")}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return visit(value, "$root");
}

export function sha256Digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestDomainSeparated(
  domain: string,
  value: string | Uint8Array,
): Sha256Digest {
  assertWellFormedUnicode(domain, "digest domain");
  if (!/^[a-z0-9.-]{1,128}$/u.test(domain)) {
    throw new TypeError("digest domain must use lowercase ASCII labels");
  }
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const header = Buffer.from(`${domain}\u0000${bytes.byteLength}\u0000`, "utf8");
  return `sha256:${createHash("sha256").update(header).update(bytes).digest("hex")}`;
}

export function digestCanonicalJson(domain: string, value: unknown): Sha256Digest {
  return digestDomainSeparated(domain, canonicalizeJson(value));
}

function copyPlainDataProperties(
  value: object,
  omittedKey?: string,
): Record<string, unknown> {
  // Validate before copying so spread/Object.assign can never turn an accessor
  // into an apparently safe data property while invoking user code.
  canonicalizeJson(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key === omittedKey) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`$root.${key} must be an enumerable data property`);
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

export function computeDocumentDigest(value: unknown): Sha256Digest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("contract document must be an object");
  }
  const copy = copyPlainDataProperties(value, "documentDigest");
  return digestCanonicalJson("agenc.eval.document.v1", copy);
}

export function withDocumentDigest<T extends object>(
  value: Omit<T, "documentDigest">,
): T {
  const copy = copyPlainDataProperties(value);
  const digest = computeDocumentDigest(copy);
  return { ...copy, documentDigest: digest } as T;
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalizeJson(value);
    return true;
  } catch {
    return false;
  }
}
