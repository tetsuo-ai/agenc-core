import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  canonicalizeSourceJson,
  digestSourceWithDomain,
  digestWithDomain,
} from "../../../src/services/compact/summary-v1.js";
import {
  MAX_COMPACTION_OUTPUT_NODES_PER_CALL,
  MAX_COMPACTION_SOURCE_BYTES,
} from "../../../src/services/compact/transaction-types.js";

// #2520: our own compaction source was encoded through the encoder built for a
// single untrusted provider response, so a legal long history could not be
// digested at all. The source encoder must accept those histories while
// emitting byte-identical canonical JSON, or every persisted digest breaks.

const SHAPES: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["boolean", true],
  ["zero", 0],
  ["negative", -12.5],
  ["string", "plain"],
  ["escapes", 'quote " backslash \\ newline \n tab \t'],
  ["unicode", "ümlaut ünïcode 日本語 🎯"],
  ["empty object", {}],
  ["empty array", []],
  ["nested", { b: [1, 2, { c: "d" }], a: null }],
  ["key order", { z: 1, a: 2, m: 3, A: 4, "0": 5 }],
  ["array of objects", [{ x: 1 }, { x: 2 }, { x: 3 }]],
  ["deep", { a: { b: { c: { d: { e: [1, { f: "g" }] } } } } }],
];

describe("bounded source canonical encoding", () => {
  it.each(SHAPES)("emits bytes identical to the provider encoder: %s", (_label, value) => {
    expect(canonicalizeSourceJson(value)).toBe(canonicalizeJson(value));
  });

  it("produces identical digests, so persisted digests keep verifying", () => {
    for (const [, value] of SHAPES) {
      expect(digestSourceWithDomain("domain:", value)).toBe(digestWithDomain("domain:", value));
    }
  });

  it("accepts a history far past the provider-output node ceiling", () => {
    const refs = Array.from({ length: 4_000 }, (_, index) => ({
      kind: "rollout_span",
      ref_id: `ref-${index}`,
      first_sequence: index + 1,
      last_sequence: index + 1,
      sha256: "a".repeat(64),
      history_index: index,
      encoded_bytes: 128,
    }));
    expect(() => canonicalizeJson(refs)).toThrow("node limit");
    const encoded = canonicalizeSourceJson(refs);
    expect(encoded.startsWith("[{")).toBe(true);
    expect(JSON.parse(encoded)).toHaveLength(4_000);
    expect(refs.length * 7).toBeGreaterThan(MAX_COMPACTION_OUTPUT_NODES_PER_CALL);
  });

  it("keeps every structural rejection the provider encoder makes", () => {
    const withGetter = {} as Record<string, unknown>;
    Object.defineProperty(withGetter, "danger", { enumerable: true, get: () => 1 });
    expect(() => canonicalizeSourceJson(withGetter)).toThrow("getter or hidden property");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeSourceJson(cyclic)).toThrow("cycle");

    const sparse = [1, 2, 3];
    delete sparse[1];
    expect(() => canonicalizeSourceJson(sparse)).toThrow("sparse array");

    const named = [1, 2] as unknown as Record<string, unknown>;
    named.label = "x";
    expect(() => canonicalizeSourceJson(named)).toThrow("named property");

    // Parity with the provider path, which also refuses symbol keys outright.
    expect(() => canonicalizeSourceJson({ [Symbol("s")]: 1, ok: 2 })).toThrow("symbol key");
    expect(() => canonicalizeSourceJson({ n: Number.POSITIVE_INFINITY })).toThrow("non-JSON scalar");
    expect(() => canonicalizeSourceJson({ n: Number.NaN })).toThrow("non-JSON scalar");
    expect(() => canonicalizeSourceJson({ f: () => 1 })).toThrow("non-JSON scalar");
    expect(() => canonicalizeSourceJson({ u: undefined })).toThrow("non-JSON scalar");
    // Parity, with the reason stated correctly: this value is an object, so
    // the clone walk does reach clonePrimitive and does run
    // assertUnicodeScalarString. A high surrogate at end of string is accepted
    // by both encoders because the pairing check reads charCodeAt(index + 1),
    // which is NaN past the end, so both comparisons are false. Every other
    // unpaired form rejects in both; see "unpaired surrogate parity" below.
    expect(canonicalizeSourceJson({ s: "\ud800" })).toBe(canonicalizeJson({ s: "\ud800" }));
    expect(() => canonicalizeSourceJson(new Map())).toThrow("exotic object");
    // Both encoders reject proxies; only the label prefix differs.
    expect(() => canonicalizeSourceJson(new Proxy({}, {}))).toThrow("contains a proxy");
    expect(() => canonicalizeJson(new Proxy({}, {}))).toThrow("contains a proxy");
  });

  it("still enforces the depth ceiling", () => {
    let deep: unknown = 1;
    for (let index = 0; index < 80; index += 1) deep = { nested: deep };
    expect(() => canonicalizeSourceJson(deep)).toThrow("depth limit");
  });

  it("leaves the provider encoder's ceiling untouched", () => {
    const wide = Array.from({ length: MAX_COMPACTION_OUTPUT_NODES_PER_CALL }, () => 0);
    expect(() => canonicalizeJson(wide)).toThrow("node limit");
  });
});

describe("bounded expansion", () => {
  it("refuses a small trailing hole that a dense prefix would hide", () => {
    const trailing: unknown[] = [1, 2];
    trailing.length = 5;
    expect(() => canonicalizeSourceJson(trailing)).toThrow(/sparse array/);
  });

  it("refuses a claimed length it would otherwise expand, quickly", () => {
    const sparse: unknown[] = [1, 2];
    sparse.length = 2 ** 32 - 1;
    const started = process.hrtime.bigint();
    expect(() => canonicalizeSourceJson(sparse)).toThrow(/node limit|sparse array/);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(500);
  });

  it("refuses an empty array claiming billions of children, quickly", () => {
    const claimed = new Array<unknown>(2 ** 32 - 1);
    const started = process.hrtime.bigint();
    expect(() => canonicalizeSourceJson(claimed)).toThrow(/node limit|sparse array/);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(500);
  });

  it("refuses an oversized string before rendering a JSON copy of it", () => {
    const huge = "a".repeat(MAX_COMPACTION_SOURCE_BYTES + 1);
    expect(() => canonicalizeSourceJson(huge)).toThrow(/byte limit/);
  });

  it("still renders a dense array whose length matches its elements", () => {
    expect(canonicalizeSourceJson([1, 2, 3])).toBe(canonicalizeJson([1, 2, 3]));
  });

  // Both encoders refuse a sparse array, so refusing it keeps parity rather
  // than breaking it. Only the message differs: the provider path fails its
  // clone walk, while the source path names the sparse array up front, before
  // a claimed length can be expanded into frames.
  it("refuses a sparse array in both encoders, with different messages", () => {
    const trailing: unknown[] = [1, 2];
    trailing.length = 5;
    expect(() => canonicalizeJson(trailing)).toThrow(/not canonical JSON/);
    expect(() => canonicalizeSourceJson(trailing)).toThrow(/sparse array/);
  });
});

describe("unpaired surrogate parity", () => {
  // A high surrogate at end-of-string is ACCEPTED by both encoders: the
  // pairing check reads charCodeAt(index + 1), which is NaN past the end, so
  // both comparisons are false. Every other unpaired form rejects in both.
  it("accepts a high surrogate at end of string in both encoders", () => {
    const text = "a\uD800";
    expect(canonicalizeSourceJson(text)).toBe(canonicalizeJson(text));
  });

  const REJECTED: ReadonlyArray<readonly [string, string]> = [
    ["a trailing low surrogate", "a\uDC00"],
    ["a leading lone low surrogate", "\uDC00a"],
    ["a high surrogate followed by a non-low unit", "\uD800a"],
  ];
  for (const [name, text] of REJECTED) {
    it(`rejects ${name} in both encoders`, () => {
      expect(() => canonicalizeJson(text)).toThrow(/unpaired surrogate/);
      expect(() => canonicalizeSourceJson(text)).toThrow(/unpaired surrogate/);
    });
  }
});
