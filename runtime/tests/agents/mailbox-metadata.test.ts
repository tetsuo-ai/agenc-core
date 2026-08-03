import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAILBOX_METADATA_REJECTION_REASONS,
  MAX_MAILBOX_METADATA_DEPTH,
  MAX_MAILBOX_METADATA_NODES,
  MAX_MAILBOX_METADATA_UTF8_BYTES,
  MailboxMetadataAbortedError,
  MailboxMetadataBuilder,
  MailboxMetadataDecoder,
  authenticateMailboxMetadata,
  decodeMailboxMetadata,
  getMailboxMetadataBytes,
  getMailboxMetadataMetrics,
  getMailboxMetadataValue,
  isValidatedMailboxMetadata,
  type MailboxMetadataAccepted,
  type MailboxMetadataArray,
  type MailboxMetadataObject,
  type MailboxMetadataResult,
  type MailboxMetadataValue,
  type ValidatedMailboxMetadata,
} from "../../src/agents/mailbox-metadata.js";
import { createSeededRng, type SeededRng } from "../helpers/seeded-rng.js";

const TEST_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const MAILBOX_FIXTURE_DIRECTORY = join(
  TEST_DIRECTORY,
  "..",
  "fnd",
  "fixtures",
  "mailbox",
);
const MODULE_PATH = join(
  TEST_DIRECTORY,
  "..",
  "..",
  "src",
  "agents",
  "mailbox-metadata.ts",
);
const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const BYTE_BOUNDARY_CASES = Object.freeze([
  {
    key: "control",
    label: "control escape expansion",
    prefix: "\u0000\b\f\n\r\t",
  },
  { key: "cjk", label: "CJK UTF-8", prefix: "郵箱" },
  { key: "emoji", label: "emoji surrogate pairs", prefix: "😀" },
  {
    key: `long_${"鍵".repeat(512)}`,
    label: "long multibyte keys",
    prefix: "value",
  },
] as const);

function accepted(result: MailboxMetadataResult): MailboxMetadataAccepted {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok)
    throw new Error(`expected metadata, received ${result.reason}`);
  return result;
}

function canonicalText(metadata: ValidatedMailboxMetadata): string {
  return UTF8_DECODER.decode(getMailboxMetadataBytes(metadata));
}

function fixtureBytes(name: string): Uint8Array {
  return readFileSync(join(MAILBOX_FIXTURE_DIRECTORY, name));
}

function buildWideObject(properties: number): MailboxMetadataResult {
  const builder = new MailboxMetadataBuilder();
  expect(builder.beginObject()).toEqual({ ok: true });
  for (let index = 0; index < properties; index += 1) {
    expect(builder.key(`key_${index}`)).toEqual({ ok: true });
    const result = builder.scalar(index);
    if (!result.ok) return result;
  }
  const ended = builder.endObject();
  if (!ended.ok) return ended;
  return builder.finish();
}

function buildWideArray(elements: number): MailboxMetadataResult {
  const builder = new MailboxMetadataBuilder();
  expect(builder.beginObject()).toEqual({ ok: true });
  expect(builder.key("items")).toEqual({ ok: true });
  expect(builder.beginArray()).toEqual({ ok: true });
  for (let index = 0; index < elements; index += 1) {
    const result = builder.scalar(index);
    if (!result.ok) return result;
  }
  const arrayEnd = builder.endArray();
  if (!arrayEnd.ok) return arrayEnd;
  const objectEnd = builder.endObject();
  if (!objectEnd.ok) return objectEnd;
  return builder.finish();
}

function wideObjectJson(properties: number): Uint8Array {
  const parts = ["{"];
  for (let index = 0; index < properties; index += 1) {
    if (index > 0) parts.push(",");
    parts.push(`"key_${index}":${index}`);
  }
  parts.push("}");
  return UTF8.encode(parts.join(""));
}

function wideArrayJson(elements: number): Uint8Array {
  const parts = ['{"items":['];
  for (let index = 0; index < elements; index += 1) {
    if (index > 0) parts.push(",");
    parts.push(String(index));
  }
  parts.push("]}");
  return UTF8.encode(parts.join(""));
}

function boundaryObject(
  key: string,
  prefix: string,
  targetBytes: number,
): { readonly text: string; readonly value: string } {
  const source = Object.create(null) as Record<string, string>;
  source[key] = prefix;
  const base = JSON.stringify(source);
  const fillerBytes = targetBytes - UTF8.encode(base).byteLength;
  if (fillerBytes < 0) throw new Error("boundary fixture exceeds its target");
  const value = `${prefix}${"a".repeat(fillerBytes)}`;
  source[key] = value;
  const text = JSON.stringify(source);
  if (UTF8.encode(text).byteLength !== targetBytes) {
    throw new Error("boundary fixture byte accounting drifted");
  }
  return { text, value };
}

describe("mailbox metadata limits and authentication", () => {
  it("freezes the compatibility limits and exact rejection vocabulary", () => {
    expect(MAX_MAILBOX_METADATA_DEPTH).toBe(64);
    expect(MAX_MAILBOX_METADATA_NODES).toBe(10_000);
    expect(MAX_MAILBOX_METADATA_UTF8_BYTES).toBe(1_048_576);
    expect(MAILBOX_METADATA_REJECTION_REASONS).toEqual([
      "unbranded",
      "syntax",
      "utf8",
      "duplicate_key",
      "depth",
      "nodes",
      "bytes",
      "non_json",
    ]);
  });

  it("authenticates only private handles in O(1) without touching traps", () => {
    const builder = new MailboxMetadataBuilder();
    builder.beginObject();
    builder.key("safe");
    builder.scalar(true);
    builder.endObject();
    const metadata = accepted(builder.finish()).metadata;
    expect(isValidatedMailboxMetadata(metadata)).toBe(true);
    expect(authenticateMailboxMetadata(metadata)).toEqual({
      ok: true,
      metadata,
    });

    let traps = 0;
    const hostile = new Proxy(Object.create(null) as object, {
      get: () => {
        traps += 1;
        throw new Error("get trap must remain untouched");
      },
      getOwnPropertyDescriptor: () => {
        traps += 1;
        throw new Error("descriptor trap must remain untouched");
      },
      getPrototypeOf: () => {
        traps += 1;
        throw new Error("prototype trap must remain untouched");
      },
      ownKeys: () => {
        traps += 1;
        throw new Error("ten-million-key trap must remain untouched");
      },
    });
    expect(isValidatedMailboxMetadata(hostile)).toBe(false);
    expect(authenticateMailboxMetadata(hostile)).toEqual({
      ok: false,
      reason: "unbranded",
    });
    expect(traps).toBe(0);

    const copied = Object.assign(Object.create(null) as object, metadata);
    expect(isValidatedMailboxMetadata(copied)).toBe(false);
    expect(
      authenticateMailboxMetadata(
        Object.freeze(Object.create(null)) as ValidatedMailboxMetadata,
      ),
    ).toEqual({ ok: false, reason: "unbranded" });
  });

  it("returns defensive bytes and a deeply frozen null-prototype graph", () => {
    const result = accepted(
      decodeMailboxMetadata(
        UTF8.encode('{"nested":[{"value":1}],"label":"safe"}'),
      ),
    );
    const root = getMailboxMetadataValue(result.metadata);
    const nested = root.nested;
    expect(Object.getPrototypeOf(root)).toBeNull();
    expect(Object.isFrozen(root)).toBe(true);
    expect(Array.isArray(nested)).toBe(true);
    if (!Array.isArray(nested)) throw new Error("expected owned array");
    const typedNested: MailboxMetadataArray = nested;
    const mapIsExcluded: "map" extends keyof MailboxMetadataArray
      ? false
      : true = true;
    const iteratorIsExcluded: typeof Symbol.iterator extends keyof MailboxMetadataArray
      ? false
      : true = true;
    const valueUnionExcludesArrayMethods: Extract<
      MailboxMetadataValue,
      readonly unknown[]
    > extends never
      ? true
      : false = true;
    expect(typedNested.length).toBe(1);
    expect(typedNested[0]).toBe(nested[0]);
    expect(mapIsExcluded).toBe(true);
    expect(iteratorIsExcluded).toBe(true);
    expect(valueUnionExcludesArrayMethods).toBe(true);
    expect("map" in typedNested).toBe(false);
    expect(Symbol.iterator in typedNested).toBe(false);
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.isFrozen(nested)).toBe(true);
    const child = nested[0];
    expect(typeof child).toBe("object");
    if (child === null || Array.isArray(child))
      throw new Error("expected object");
    expect(Object.getPrototypeOf(child)).toBeNull();
    expect(Object.isFrozen(child)).toBe(true);

    const first = getMailboxMetadataBytes(result.metadata);
    first[0] = 0;
    expect(canonicalText(result.metadata)).toBe(
      '{"nested":[{"value":1}],"label":"safe"}',
    );
  });
});

describe("mailbox metadata structural boundaries", () => {
  it("accepts depth 64, rejects depth 65, and stops a huge depth iteratively", () => {
    const atLimit = accepted(
      decodeMailboxMetadata(fixtureBytes("depth-64-v1.json")),
    );
    expect(getMailboxMetadataMetrics(atLimit.metadata).depth).toBe(
      MAX_MAILBOX_METADATA_DEPTH,
    );
    expect(decodeMailboxMetadata(fixtureBytes("depth-65-v1.json"))).toEqual({
      ok: false,
      reason: "depth",
    });

    const hostileDepth = 8_000;
    const hostile = `${'{"next":'.repeat(hostileDepth)}null${"}".repeat(
      hostileDepth,
    )}`;
    expect(() => decodeMailboxMetadata(UTF8.encode(hostile))).not.toThrow();
    expect(decodeMailboxMetadata(UTF8.encode(hostile))).toEqual({
      ok: false,
      reason: "depth",
    });
  });

  it("rejects the overflowing builder container before depth 65 is accepted", () => {
    const builder = new MailboxMetadataBuilder();
    expect(builder.beginObject()).toEqual({ ok: true });
    for (let depth = 2; depth <= MAX_MAILBOX_METADATA_DEPTH; depth += 1) {
      expect(builder.key("next")).toEqual({ ok: true });
      expect(builder.beginObject()).toEqual({ ok: true });
    }
    expect(builder.key("overflow")).toEqual({ ok: true });
    const overflow = builder.beginObject();
    expect(overflow).toEqual({ ok: false, reason: "depth" });
    expect(builder.endObject()).toBe(overflow);
    expect(builder.finish()).toBe(overflow);
  });

  it("accepts node 10,000 and rejects 10,001 for wide objects and arrays", () => {
    const objectAtLimit = accepted(
      buildWideObject(MAX_MAILBOX_METADATA_NODES - 1),
    );
    expect(getMailboxMetadataMetrics(objectAtLimit.metadata).nodes).toBe(
      MAX_MAILBOX_METADATA_NODES,
    );
    expect(buildWideObject(MAX_MAILBOX_METADATA_NODES)).toEqual({
      ok: false,
      reason: "nodes",
    });

    const arrayAtLimit = accepted(
      buildWideArray(MAX_MAILBOX_METADATA_NODES - 2),
    );
    expect(getMailboxMetadataMetrics(arrayAtLimit.metadata).nodes).toBe(
      MAX_MAILBOX_METADATA_NODES,
    );
    expect(buildWideArray(MAX_MAILBOX_METADATA_NODES - 1)).toEqual({
      ok: false,
      reason: "nodes",
    });

    const decodedObject = accepted(
      decodeMailboxMetadata(wideObjectJson(MAX_MAILBOX_METADATA_NODES - 1)),
    );
    expect(getMailboxMetadataMetrics(decodedObject.metadata).nodes).toBe(
      MAX_MAILBOX_METADATA_NODES,
    );
    expect(
      decodeMailboxMetadata(wideObjectJson(MAX_MAILBOX_METADATA_NODES)),
    ).toEqual({ ok: false, reason: "nodes" });

    const decodedArray = accepted(
      decodeMailboxMetadata(wideArrayJson(MAX_MAILBOX_METADATA_NODES - 2)),
    );
    expect(getMailboxMetadataMetrics(decodedArray.metadata).nodes).toBe(
      MAX_MAILBOX_METADATA_NODES,
    );
    expect(
      decodeMailboxMetadata(wideArrayJson(MAX_MAILBOX_METADATA_NODES - 1)),
    ).toEqual({ ok: false, reason: "nodes" });
  });

  it("accepts the exact canonical byte limit and rejects limit plus one", () => {
    const envelopeBytes = UTF8.encode('{"x":""}').byteLength;
    const builder = new MailboxMetadataBuilder();
    builder.beginObject();
    builder.key("x");
    builder.scalar("a".repeat(MAX_MAILBOX_METADATA_UTF8_BYTES - envelopeBytes));
    expect(builder.endObject()).toEqual({ ok: true });
    const atLimit = accepted(builder.finish());
    expect(getMailboxMetadataMetrics(atLimit.metadata).utf8Bytes).toBe(
      MAX_MAILBOX_METADATA_UTF8_BYTES,
    );

    const overflow = new MailboxMetadataBuilder();
    overflow.beginObject();
    overflow.key("x");
    overflow.scalar(
      "a".repeat(MAX_MAILBOX_METADATA_UTF8_BYTES - envelopeBytes + 1),
    );
    expect(overflow.endObject()).toEqual({ ok: false, reason: "bytes" });
    expect(overflow.finish()).toEqual({ ok: false, reason: "bytes" });
  });

  it.each(BYTE_BOUNDARY_CASES)(
    "counts $label at the exact byte ceiling and ceiling plus one",
    ({ key, prefix }) => {
      const atLimit = boundaryObject(
        key,
        prefix,
        MAX_MAILBOX_METADATA_UTF8_BYTES,
      );
      const decoded = accepted(
        decodeMailboxMetadata(UTF8.encode(atLimit.text)),
      );
      expect(getMailboxMetadataMetrics(decoded.metadata).utf8Bytes).toBe(
        MAX_MAILBOX_METADATA_UTF8_BYTES,
      );

      const builder = new MailboxMetadataBuilder();
      expect(builder.beginObject()).toEqual({ ok: true });
      expect(builder.key(key)).toEqual({ ok: true });
      expect(builder.scalar(atLimit.value)).toEqual({ ok: true });
      expect(builder.endObject()).toEqual({ ok: true });
      const built = accepted(builder.finish());
      expect(getMailboxMetadataMetrics(built.metadata).utf8Bytes).toBe(
        MAX_MAILBOX_METADATA_UTF8_BYTES,
      );
      expect(canonicalText(built.metadata)).toBe(atLimit.text);

      const overLimit = boundaryObject(
        key,
        prefix,
        MAX_MAILBOX_METADATA_UTF8_BYTES + 1,
      );
      expect(decodeMailboxMetadata(UTF8.encode(overLimit.text))).toEqual({
        ok: false,
        reason: "bytes",
      });
      const overflowingBuilder = new MailboxMetadataBuilder();
      expect(overflowingBuilder.beginObject()).toEqual({ ok: true });
      expect(overflowingBuilder.key(key)).toEqual({ ok: true });
      expect(overflowingBuilder.scalar(overLimit.value)).toEqual({ ok: true });
      expect(overflowingBuilder.endObject()).toEqual({
        ok: false,
        reason: "bytes",
      });
    },
  );

  it("enforces the raw byte ceiling before parsing an overflowing chunk", () => {
    const body = UTF8.encode('{"x":null}');
    const atLimit = new Uint8Array(MAX_MAILBOX_METADATA_UTF8_BYTES);
    atLimit.fill(0x20);
    atLimit.set(body, atLimit.byteLength - body.byteLength);
    expect(decodeMailboxMetadata(atLimit)).toMatchObject({ ok: true });

    const overLimit = new Uint8Array(MAX_MAILBOX_METADATA_UTF8_BYTES + 1);
    overLimit.fill(0x20);
    overLimit.set(body, overLimit.byteLength - body.byteLength);
    const decoder = new MailboxMetadataDecoder();
    expect(decoder.write(overLimit)).toEqual({ ok: false, reason: "bytes" });
    expect(decoder.finish()).toEqual({ ok: false, reason: "bytes" });
  });

  it("accounts for controls, long keys, CJK, emoji, and canonical number text", () => {
    const source = Object.create(null) as Record<string, unknown>;
    const longKey = `long_${"鍵".repeat(128)}`;
    source[longKey] = "\u0000\b\f\n\r\t";
    source.emoji = "😀";
    source.cjk = "郵箱";
    source.negativeZero = -0;
    const reference = JSON.stringify(source);

    const decoded = accepted(decodeMailboxMetadata(UTF8.encode(reference)));
    expect(canonicalText(decoded.metadata)).toBe(reference);
    expect(getMailboxMetadataMetrics(decoded.metadata).utf8Bytes).toBe(
      UTF8.encode(reference).byteLength,
    );
  });

  it("matches ECMA own-key order for index boundaries at every depth", () => {
    const nestedEntries = [
      ["4294967295", "nested max"],
      ["2", "nested two"],
      ["1", "nested one"],
      ["01", "nested leading"],
      ["4294967294", "nested last index"],
      ["-0", "nested negative zero"],
      ["00", "nested double zero"],
      ["1e0", "nested exponent"],
      ["0", "nested zero"],
    ] as const;
    const topEntries = [
      ["2", "two"],
      ["1", "one"],
      ["01", "leading"],
      ["4294967294", "last index"],
      ["4294967295", "max is named"],
      ["00", "double zero"],
      ["-0", "negative zero"],
      ["1e0", "exponent"],
      ["0", "zero"],
    ] as const;
    const input = `{"2":"two","1":"one","01":"leading","4294967294":"last index","4294967295":"max is named","00":"double zero","-0":"negative zero","1e0":"exponent","0":"zero","nested":{"4294967295":"nested max","2":"nested two","1":"nested one","01":"nested leading","4294967294":"nested last index","-0":"nested negative zero","00":"nested double zero","1e0":"nested exponent","0":"nested zero"}}`;
    const expected = JSON.stringify(JSON.parse(input));
    const decoded = accepted(decodeMailboxMetadata(UTF8.encode(input)));

    const builder = new MailboxMetadataBuilder();
    expect(builder.beginObject()).toEqual({ ok: true });
    for (const [key, value] of topEntries) {
      expect(builder.key(key)).toEqual({ ok: true });
      expect(builder.scalar(value)).toEqual({ ok: true });
    }
    expect(builder.key("nested")).toEqual({ ok: true });
    expect(builder.beginObject()).toEqual({ ok: true });
    for (const [key, value] of nestedEntries) {
      expect(builder.key(key)).toEqual({ ok: true });
      expect(builder.scalar(value)).toEqual({ ok: true });
    }
    expect(builder.endObject()).toEqual({ ok: true });
    expect(builder.endObject()).toEqual({ ok: true });
    const built = accepted(builder.finish());

    expect(canonicalText(decoded.metadata)).toBe(expected);
    expect(canonicalText(built.metadata)).toBe(expected);
    expect(JSON.stringify(getMailboxMetadataValue(decoded.metadata))).toBe(
      expected,
    );
    expect(JSON.stringify(getMailboxMetadataValue(built.metadata))).toBe(
      expected,
    );
  });

  it("canonicalizes lone surrogates safely", () => {
    const builder = new MailboxMetadataBuilder();
    builder.beginObject();
    builder.key("high");
    builder.scalar("\ud800");
    builder.key("low");
    builder.scalar("\udc00");
    builder.key("pair");
    builder.scalar("😀");
    builder.endObject();
    const built = accepted(builder.finish());
    expect(canonicalText(built.metadata)).toBe(
      JSON.stringify({ high: "\ud800", low: "\udc00", pair: "😀" }),
    );
  });
});

describe("mailbox metadata decoder rejection and safety", () => {
  it("rejects duplicate keys before construction and preserves inert special keys", () => {
    expect(
      decodeMailboxMetadata(fixtureBytes("duplicate-key-v1.json")),
    ).toEqual({
      ok: false,
      reason: "duplicate_key",
    });
    expect(
      decodeMailboxMetadata(UTF8.encode('{"nested":{"same":1,"same":2}}')),
    ).toEqual({ ok: false, reason: "duplicate_key" });

    delete (Object.prototype as { polluted?: boolean }).polluted;
    const inert = accepted(
      decodeMailboxMetadata(fixtureBytes("inert-keys-v1.json")),
    );
    const value = getMailboxMetadataValue(inert.metadata);
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value.constructor).toBe("inert constructor metadata");
    expect(value.prototype).toBe("inert prototype metadata");
    expect(value.__proto__).toEqual(
      expect.objectContaining({ polluted: true }),
    );
    expect(
      (Object.prototype as { polluted?: boolean }).polluted,
    ).toBeUndefined();
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      expect(descriptor).toMatchObject({
        configurable: false,
        enumerable: true,
        writable: false,
      });
      expect(descriptor?.get).toBeUndefined();
      expect(descriptor?.set).toBeUndefined();
    }
  });

  it.each([
    ['{"x":1} trailing', "syntax"],
    ['{"x":01}', "syntax"],
    ['{"x":1.}', "syntax"],
    ['{"x":1e}', "syntax"],
    ['{"x":1e999}', "syntax"],
    ['{"x":NaN}', "syntax"],
    ['{"x":Infinity}', "syntax"],
    ['{"x":+1}', "syntax"],
    ['{"x":"raw\u0000control"}', "syntax"],
    ['{"x":}', "syntax"],
    ['{"x":1,}', "syntax"],
    ["[1,2,3]", "non_json"],
  ] as const)("rejects invalid JSON %j as %s", (text, reason) => {
    expect(decodeMailboxMetadata(UTF8.encode(text))).toEqual({
      ok: false,
      reason,
    });
  });

  it("rejects invalid and incomplete UTF-8 independently of JSON syntax", () => {
    expect(
      decodeMailboxMetadata(Uint8Array.of(0x7b, 0xc3, 0x28, 0x7d)),
    ).toEqual({
      ok: false,
      reason: "utf8",
    });
    const decoder = new MailboxMetadataDecoder();
    expect(decoder.write(Uint8Array.of(0x7b, 0xc3))).toEqual({ ok: true });
    expect(decoder.finish()).toEqual({ ok: false, reason: "utf8" });
  });

  it("decodes byte-split multibyte characters and escape tokens incrementally", () => {
    const expected = '{"emoji":"😀","nul":"\\u0000","n":1.25e+3}';
    const bytes = UTF8.encode(expected);
    const decoder = new MailboxMetadataDecoder();
    for (const byte of bytes) {
      expect(decoder.write(Uint8Array.of(byte))).toEqual({ ok: true });
    }
    const result = accepted(decoder.finish());
    expect(canonicalText(result.metadata)).toBe(
      '{"emoji":"😀","nul":"\\u0000","n":1250}',
    );
    expect(getMailboxMetadataValue(result.metadata).nul).toBe("\u0000");
  });

  it("aborts deterministically between chunks without changing reason vocabulary", () => {
    const controller = new AbortController();
    const decoder = new MailboxMetadataDecoder({ signal: controller.signal });
    expect(decoder.write(UTF8.encode('{"value":'))).toEqual({ ok: true });
    controller.abort(new Error("untrusted abort reason"));
    for (const operation of [
      () => decoder.write(UTF8.encode("1}")),
      () => decoder.finish(),
    ]) {
      expect(operation).toThrowError(MailboxMetadataAbortedError);
      try {
        operation();
      } catch (error) {
        expect(error).toMatchObject({
          code: "MAILBOX_METADATA_ABORTED",
          message: "mailbox metadata construction was aborted",
          name: "MailboxMetadataAbortedError",
        });
      }
    }
    expect(MAILBOX_METADATA_REJECTION_REASONS).not.toContain("aborted");
  });
});

describe("mailbox metadata operation builder", () => {
  it("rejects non-JSON and prebuilt values without enumeration or user code", () => {
    class CustomValue {}
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const shared = { value: 1 };
    let getterCalls = 0;
    const getterValue = Object.create(null) as object;
    Object.defineProperty(getterValue, "danger", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("getter must remain untouched");
      },
    });
    const sparse: unknown[] = [];
    sparse.length = 1_000_001;
    sparse[0] = "first";
    sparse[1_000_000] = "last";
    const arrayWithAccessor: unknown[] = [];
    Object.defineProperty(arrayWithAccessor, "extra", {
      get: () => {
        getterCalls += 1;
        throw new Error("array getter must remain untouched");
      },
    });
    let proxyTraps = 0;
    const proxy = new Proxy(Object.create(null) as object, {
      getPrototypeOf: () => {
        proxyTraps += 1;
        throw new Error("proxy trap must remain untouched");
      },
      ownKeys: () => {
        proxyTraps += 1;
        throw new Error("proxy trap must remain untouched");
      },
    });

    const invalidValues: readonly unknown[] = [
      undefined,
      1n,
      Symbol("value"),
      () => undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new CustomValue(),
      new Date(),
      new Map(),
      new Set(),
      new Uint8Array(1),
      cyclic,
      shared,
      shared,
      getterValue,
      sparse,
      arrayWithAccessor,
      proxy,
      {},
      [],
    ];
    for (const value of invalidValues) {
      const builder = new MailboxMetadataBuilder();
      builder.beginObject();
      builder.key("value");
      const failure = builder.scalar(value);
      expect(failure).toEqual({ ok: false, reason: "non_json" });
      expect(builder.finish()).toBe(failure);
    }
    const symbolKey = new MailboxMetadataBuilder();
    symbolKey.beginObject();
    expect(symbolKey.key(Symbol("key"))).toEqual({
      ok: false,
      reason: "non_json",
    });
    expect(getterCalls).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it("rejects malformed operation ordering and duplicate builder keys", () => {
    const missingRoot = new MailboxMetadataBuilder();
    expect(missingRoot.scalar("value")).toEqual({
      ok: false,
      reason: "non_json",
    });

    const duplicate = new MailboxMetadataBuilder();
    duplicate.beginObject();
    duplicate.key("same");
    duplicate.scalar(1);
    expect(duplicate.key("same")).toEqual({
      ok: false,
      reason: "duplicate_key",
    });

    const missingValue = new MailboxMetadataBuilder();
    missingValue.beginObject();
    missingValue.key("value");
    expect(missingValue.endObject()).toEqual({
      ok: false,
      reason: "non_json",
    });
  });

  it("does not call poisoned Object or Array toJSON hooks", () => {
    const priorObjectToJson = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    const priorArrayToJson = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "toJSON",
    );
    let built: MailboxMetadataResult | undefined;
    let decoded: MailboxMetadataResult | undefined;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => {
          throw new Error("Object.prototype.toJSON must not run");
        },
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => {
          throw new Error("Array.prototype.toJSON must not run");
        },
      });

      const builder = new MailboxMetadataBuilder();
      builder.beginObject();
      builder.key("items");
      builder.beginArray();
      builder.beginObject();
      builder.key("safe");
      builder.scalar(true);
      builder.endObject();
      builder.endArray();
      builder.endObject();
      built = builder.finish();
      decoded = decodeMailboxMetadata(UTF8.encode('{"items":[{"safe":true}]}'));
    } finally {
      restoreProperty(Object.prototype, "toJSON", priorObjectToJson);
      restoreProperty(Array.prototype, "toJSON", priorArrayToJson);
    }

    const builtMetadata = accepted(built!);
    const decodedMetadata = accepted(decoded!);
    expect(canonicalText(builtMetadata.metadata)).toBe(
      '{"items":[{"safe":true}]}',
    );
    expect(canonicalText(decodedMetadata.metadata)).toBe(
      '{"items":[{"safe":true}]}',
    );
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "toJSON")).toEqual(
      priorObjectToJson,
    );
    expect(Object.getOwnPropertyDescriptor(Array.prototype, "toJSON")).toEqual(
      priorArrayToJson,
    );
  });

  it("contains no recursive/stringify/reflection shortcut in production", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    expect(source).not.toMatch(
      /\b(?:JSON\.stringify|Reflect\.ownKeys|Object\.keys)\s*\(/u,
    );
    expect(source).toMatch(
      /type MailboxMetadataValue\s*=\s*MailboxMetadataScalar\s*\|\s*MailboxMetadataObject\s*\|\s*MailboxMetadataArray/u,
    );
    expect(source).not.toMatch(
      /type MailboxMetadataValue\s*=[\s\S]{0,160}readonly MailboxMetadataValue\[\]/u,
    );
  });
});

describe("mailbox metadata differential construction", () => {
  it("matches the ECMA serializer for seeded accepted JSON and builder streams", () => {
    const rng = createSeededRng({
      domain: "mailbox-metadata-differential-v1",
      seed: "fixed-e3a-seed",
    });
    const cases = 256;
    for (let caseIndex = 0; caseIndex < cases; caseIndex += 1) {
      const reference = randomMetadataObject(rng, 0);
      const expected = JSON.stringify(reference);
      const decoded = accepted(decodeMailboxMetadata(UTF8.encode(expected)));

      const builder = new MailboxMetadataBuilder();
      emitBuilderObject(builder, reference);
      const built = accepted(builder.finish());
      expect(canonicalText(decoded.metadata), `decoder case ${caseIndex}`).toBe(
        expected,
      );
      expect(canonicalText(built.metadata), `builder case ${caseIndex}`).toBe(
        expected,
      );
      expect(
        normalizeOwnedValue(getMailboxMetadataValue(decoded.metadata)),
        `value case ${caseIndex}`,
      ).toEqual(
        normalizeOwnedValue(JSON.parse(expected) as MailboxMetadataObject),
      );
    }
  });

  it("rejects seeded duplicate/trailing mutations deterministically", () => {
    const rng = createSeededRng({
      domain: "mailbox-metadata-invalid-differential-v1",
      seed: "fixed-e3a-invalid-seed",
    });
    for (let caseIndex = 0; caseIndex < 128; caseIndex += 1) {
      const key = `key_${rng.nextInt(1_000_000)}`;
      const value = rng.nextInt(1_000_000);
      const duplicate = `{"${key}":${value},"${key}":${value + 1}}`;
      expect(decodeMailboxMetadata(UTF8.encode(duplicate))).toEqual({
        ok: false,
        reason: "duplicate_key",
      });
      expect(
        decodeMailboxMetadata(UTF8.encode(`{"${key}":${value}} trailing`)),
      ).toEqual({ ok: false, reason: "syntax" });
    }
  });
});

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, descriptor);
  }
}

function randomMetadataObject(
  rng: SeededRng,
  depth: number,
): Record<string, unknown> {
  const object = Object.create(null) as Record<string, unknown>;
  const entries = rng.nextInt(4);
  for (let index = 0; index < entries; index += 1) {
    const key = `key_${depth}_${index}_${rng.nextInt(10_000)}`;
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      value: randomMetadataValue(rng, depth + 1),
      writable: true,
    });
  }
  if (depth === 0 && rng.nextInt(4) === 0) {
    Object.defineProperty(object, "__proto__", {
      configurable: true,
      enumerable: true,
      value: "inert",
      writable: true,
    });
  }
  return object;
}

function randomMetadataValue(rng: SeededRng, depth: number): unknown {
  const kind = depth >= 4 ? rng.nextInt(5) : rng.nextInt(7);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return rng.nextInt(2) === 0;
    case 2:
      return rng.nextInt(2) === 0 ? -0 : rng.nextInt(1_000_000) / 10;
    case 3:
      return ["plain", 'quote"', "slash\\", "nul\u0000", "emoji😀"][
        rng.nextInt(5)
      ];
    case 4:
      return `text_${rng.nextInt(1_000_000)}`;
    case 5: {
      const length = rng.nextInt(4);
      const array: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        array.push(randomMetadataValue(rng, depth + 1));
      }
      return array;
    }
    default:
      return randomMetadataObject(rng, depth);
  }
}

function emitBuilderObject(
  builder: MailboxMetadataBuilder,
  value: Record<string, unknown>,
): void {
  expect(builder.beginObject()).toEqual({ ok: true });
  for (const [key, entry] of Object.entries(value)) {
    expect(builder.key(key)).toEqual({ ok: true });
    emitBuilderValue(builder, entry);
  }
  expect(builder.endObject()).toEqual({ ok: true });
}

function emitBuilderValue(
  builder: MailboxMetadataBuilder,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    expect(builder.beginArray()).toEqual({ ok: true });
    for (const entry of value) emitBuilderValue(builder, entry);
    expect(builder.endArray()).toEqual({ ok: true });
    return;
  }
  if (value !== null && typeof value === "object") {
    emitBuilderObject(builder, value as Record<string, unknown>);
    return;
  }
  expect(builder.scalar(value)).toEqual({ ok: true });
}

function normalizeOwnedValue(value: MailboxMetadataValue): unknown {
  if (Array.isArray(value)) {
    const normalized: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      normalized.push(normalizeOwnedValue(value[index]!));
    }
    return normalized;
  }
  if (value !== null && typeof value === "object") {
    const normalized = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: normalizeOwnedValue(entry),
        writable: true,
      });
    }
    return normalized;
  }
  return value;
}
