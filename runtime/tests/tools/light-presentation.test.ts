import { expect, test } from "vitest";
import { compactLightSchema } from "../../src/tools/light-presentation.js";

test("schema compaction preserves a property named description and literal data", () => {
  const schema = { type: "object", description: "schema prose", required: ["description"], properties: {
    description: { type: "string", description: "field prose", const: "required value" },
    value: { default: { description: "literal data" }, enum: [{ description: "literal choice" }] },
  } };
  const compact = compactLightSchema(schema) as typeof schema;
  expect(compact.required).toEqual(["description"]);
  expect(compact.properties.description).toEqual({ type: "string", const: "required value" });
  expect(compact.properties.value).toEqual(schema.properties.value);
  expect(schema.description).toBe("schema prose");
});

test("equivalent schema key orders produce identical serialization", () => {
  const a = { type: "object", properties: { b: { type: "number", minimum: 1 }, a: { type: "string" } } };
  const b = { properties: { a: { type: "string" }, b: { minimum: 1, type: "number" } }, type: "object" };
  expect(JSON.stringify(compactLightSchema(a))).toBe(JSON.stringify(compactLightSchema(b)));
});

test("required argument order is stable across declaration order and keeps edit anchors first", () => {
  const a = { type: "object", required: ["old_string", "new_string"], properties: {
    new_string: { type: "string" }, replace_all: { type: "boolean" }, old_string: { type: "string" },
  } };
  const b = { ...a, properties: { old_string: a.properties.old_string, new_string: a.properties.new_string, replace_all: a.properties.replace_all } };
  const compact = compactLightSchema(a) as typeof a;
  expect(Object.keys(compact.properties)).toEqual(["old_string", "new_string", "replace_all"]);
  expect(JSON.stringify(compact)).toBe(JSON.stringify(compactLightSchema(b)));
  expect(compact.properties).toEqual(a.properties);
});
