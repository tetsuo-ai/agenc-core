import { describe, expect, test } from "vitest";

import {
  BoundedIJsonPreflightError,
  assertBoundedIJsonGraph,
} from "../../src/eval-power/ijson-preflight.js";

const MAXIMUM_DEPTH = 64;
const MAXIMUM_ARRAY_LENGTH = 100_000;
const MAXIMUM_SINGLE_STRING_BYTES = 1_000_000;

function nest(depth: number): unknown {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

function expectPreflightFailure(value: unknown, pattern: RegExp): void {
  expect(() => assertBoundedIJsonGraph(value, "$document")).toThrow(
    BoundedIJsonPreflightError,
  );
  expect(() => assertBoundedIJsonGraph(value, "$document")).toThrow(pattern);
}

describe("assertBoundedIJsonGraph", () => {
  test("accepts a small acyclic I-JSON document", () => {
    expect(() =>
      assertBoundedIJsonGraph(
        {
          ok: true,
          count: 2,
          nested: [{ label: "a" }, null],
        },
        "$document",
      ),
    ).not.toThrow();
  });

  test("rejects depth beyond the iterative budget", () => {
    expect(() => assertBoundedIJsonGraph(nest(MAXIMUM_DEPTH), "$document")).not.toThrow();
    expectPreflightFailure(
      nest(MAXIMUM_DEPTH + 1),
      /exceeds the maximum I-JSON depth 64/u,
    );
  });

  test("rejects cycles without following accessors", () => {
    const cyclic: Record<string, unknown> = { label: "root" };
    cyclic.self = cyclic;
    expectPreflightFailure(cyclic, /contains a cycle/u);
  });

  test("rejects numbers that I-JSON cannot represent unambiguously", () => {
    expectPreflightFailure(-0, /not a finite, unambiguous I-JSON number/u);
    expectPreflightFailure(Number.POSITIVE_INFINITY, /not a finite, unambiguous I-JSON number/u);
    expectPreflightFailure(Number.NaN, /not a finite, unambiguous I-JSON number/u);
    expectPreflightFailure(Number.MAX_SAFE_INTEGER + 1, /not a finite, unambiguous I-JSON number/u);
  });

  test("rejects non-plain objects, symbols, getters, and non-index array keys", () => {
    expectPreflightFailure(new Date(0), /must be a plain JSON object/u);

    const withSymbol = { ok: true, [Symbol("hidden")]: 1 };
    expectPreflightFailure(withSymbol, /contains a symbol property/u);

    const withGetter: Record<string, unknown> = {};
    Object.defineProperty(withGetter, "secret", {
      enumerable: true,
      get() {
        return "accessed";
      },
    });
    expectPreflightFailure(withGetter, /must be an own enumerable data property/u);

    const extraKey = [1];
    Object.defineProperty(extraKey, "extra", {
      value: true,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expectPreflightFailure(extraKey, /contains a non-JSON array property/u);
  });

  test("rejects arrays over the length budget before walking items", () => {
    const oversized: unknown[] = [];
    oversized.length = MAXIMUM_ARRAY_LENGTH + 1;
    expectPreflightFailure(
      oversized,
      /exceeds the maximum array length 100000/u,
    );
  });

  test("rejects a string over the single-string byte budget", () => {
    expectPreflightFailure(
      "x".repeat(MAXIMUM_SINGLE_STRING_BYTES + 1),
      /exceeds the single-string budget/u,
    );
  });
});
