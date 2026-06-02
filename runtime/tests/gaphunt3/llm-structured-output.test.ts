import { describe, expect, it } from "vitest";

import {
  enforceStrictStructuredOutputSchema,
  parseStructuredOutputValue,
} from "src/llm/structured-output";

describe("gaphunt3 #8: structured-output validator enforces union combinators", () => {
  // parseStructuredOutputValue runs validateStructuredValue internally against the
  // (original) schema and throws when the returned value violates it.
  const anyOfSchema = {
    type: "object",
    properties: {
      x: { anyOf: [{ type: "string" }, { type: "boolean" }] },
    },
    required: ["x"],
  };

  it("rejects a value matching no anyOf branch", () => {
    // x is a number: matches neither string nor boolean.
    expect(() => parseStructuredOutputValue({ x: 123 }, "s", anyOfSchema)).toThrow(
      /anyOf/,
    );
  });

  it("accepts a value matching an anyOf branch", () => {
    expect(() =>
      parseStructuredOutputValue({ x: "hello" }, "s", anyOfSchema),
    ).not.toThrow();
    expect(() =>
      parseStructuredOutputValue({ x: true }, "s", anyOfSchema),
    ).not.toThrow();
  });

  it("requires exactly one oneOf branch to match", () => {
    const oneOfSchema = {
      type: "object",
      properties: {
        v: { oneOf: [{ type: "string" }, { type: "boolean" }] },
      },
      required: ["v"],
    };
    // number matches neither -> must throw.
    expect(() => parseStructuredOutputValue({ v: 7 }, "s", oneOfSchema)).toThrow(
      /oneOf/,
    );
    expect(() =>
      parseStructuredOutputValue({ v: "ok" }, "s", oneOfSchema),
    ).not.toThrow();
  });

  it("requires every allOf branch to validate", () => {
    const allOfSchema = {
      type: "object",
      properties: {
        a: {
          allOf: [
            { type: "object", properties: { p: { type: "string" } }, required: ["p"] },
            { type: "object", properties: { q: { type: "number" } }, required: ["q"] },
          ],
        },
      },
      required: ["a"],
    };
    // missing q -> violates the second allOf branch.
    expect(() =>
      parseStructuredOutputValue({ a: { p: "x" } }, "s", allOfSchema),
    ).toThrow();
    expect(() =>
      parseStructuredOutputValue({ a: { p: "x", q: 1 } }, "s", allOfSchema),
    ).not.toThrow();
  });
});

describe("gaphunt3 #11: strict transform makes originally-optional fields nullable", () => {
  it("forces all keys required and widens optional field types with null", () => {
    const result = enforceStrictStructuredOutputSchema({
      type: "object",
      properties: {
        id: { type: "string" },
        note: { type: "string" },
      },
      required: ["id"],
    });

    expect(result.required).toEqual(["id", "note"]);
    const properties = result.properties as Record<string, Record<string, unknown>>;
    // Originally-required field keeps its scalar type.
    expect(properties.id.type).toBe("string");
    // Originally-optional field must be expressed as nullable.
    expect(properties.note.type).toEqual(["string", "null"]);
  });

  it("does not widen a required field", () => {
    const result = enforceStrictStructuredOutputSchema({
      type: "object",
      properties: {
        keep: { type: "string" },
      },
      required: ["keep"],
    });
    const properties = result.properties as Record<string, Record<string, unknown>>;
    expect(properties.keep.type).toBe("string");
  });

  it("adds a null branch to an optional anyOf field", () => {
    const result = enforceStrictStructuredOutputSchema({
      type: "object",
      properties: {
        opt: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
      required: [],
    });
    const properties = result.properties as Record<string, Record<string, unknown>>;
    const anyOf = properties.opt.anyOf as Array<Record<string, unknown>>;
    expect(anyOf.some((branch) => branch.type === "null")).toBe(true);
  });
});
