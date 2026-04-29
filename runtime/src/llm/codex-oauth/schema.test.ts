import { describe, expect, it } from "vitest";
import { sanitizeCodexJsonSchema } from "./schema.js";

describe("sanitizeCodexJsonSchema", () => {
  it("recursively adds missing items to array schemas without mutating input", () => {
    const original = {
      type: "object",
      properties: {
        constraints: {
          anyOf: [
            { type: "object" },
            { type: "array" },
            { type: "string" },
          ],
        },
        nullableArray: {
          type: ["array", "null"],
        },
        stringList: {
          type: "array",
          items: { type: "string" },
        },
        nestedArray: {
          type: "array",
          items: { type: "array" },
        },
        nonArrayUnion: {
          type: ["string", "null"],
        },
        literalChoice: {
          enum: ["fast", "safe"],
        },
      },
    };

    const sanitized = sanitizeCodexJsonSchema(original);

    expect(sanitized).toEqual({
      type: "object",
      properties: {
        constraints: {
          anyOf: [
            { type: "object" },
            { type: "array", items: {} },
            { type: "string" },
          ],
        },
        nullableArray: {
          type: ["array", "null"],
          items: {},
        },
        stringList: {
          type: "array",
          items: { type: "string" },
        },
        nestedArray: {
          type: "array",
          items: { type: "array", items: {} },
        },
        nonArrayUnion: {
          type: ["string", "null"],
        },
        literalChoice: {
          enum: ["fast", "safe"],
        },
      },
    });
    expect(original.properties.constraints.anyOf[1]).toEqual({ type: "array" });
    expect(original.properties.nullableArray).toEqual({
      type: ["array", "null"],
    });
    expect(original.properties.nestedArray).toEqual({
      type: "array",
      items: { type: "array" },
    });
  });

  it("handles primitive, null, and top-level array values", () => {
    expect(sanitizeCodexJsonSchema(null)).toBeNull();
    expect(sanitizeCodexJsonSchema("literal")).toBe("literal");
    expect(sanitizeCodexJsonSchema([{ type: "array" }, 42])).toEqual([
      { type: "array", items: {} },
      42,
    ]);
  });
});
