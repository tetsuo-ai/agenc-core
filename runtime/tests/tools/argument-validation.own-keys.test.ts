/**
 * Schema presence checks count own keys only.
 *
 * `validateObject` tested presence with `key in obj`, which walks the
 * prototype chain. A plain object inherits `__proto__` and `constructor` from
 * `Object.prototype`, so an empty object satisfied a schema that requires
 * either one when that property's schema is unconstrained, and an absent
 * optional one was validated against the inherited value instead of skipped.
 */
import { describe, expect, test } from "vitest";
import { validateToolArgs } from "../../src/tools/argument-validation.js";
import { validateToolPreflight } from "../../src/tools/execution.js";
import type { Tool } from "../../src/tools/types.js";

/** A schema whose only property is required and unconstrained. */
function requiring(key: string): Record<string, unknown> {
  return { type: "object", properties: { [key]: {} }, required: [key] };
}

const missing = (key: string) => ({
  path: key,
  message: "missing required field",
  category: "missing",
});

describe("schema presence checks count own keys only", () => {
  test.each(["__proto__", "constructor"])(
    "an empty model object does not satisfy a required %s",
    (key) => {
      expect(validateToolArgs(requiring(key), JSON.parse("{}"))).toEqual({
        valid: false,
        errors: [missing(key)],
      });
    },
  );

  test.each(["__proto__", "constructor", "prototype"])(
    "an inherited %s never counts as present",
    (key) => {
      const args = Object.create({ [key]: "inherited" }) as Record<string, unknown>;
      expect(validateToolArgs(requiring(key), args)).toEqual({
        valid: false,
        errors: [missing(key)],
      });
    },
  );

  test.each(["__proto__", "constructor", "prototype"])(
    "an absent optional %s is skipped, not validated against an inherited value",
    (key) => {
      const schema = { type: "object", properties: { [key]: { type: "string" } } };
      const args = Object.create({ [key]: 42 }) as Record<string, unknown>;
      expect(validateToolArgs(schema, args)).toMatchObject({ valid: true, errors: [] });
    },
  );

  test("a call that omits a required constructor fails preflight", () => {
    const tool: Tool = {
      name: "Dynamic",
      description: "a dynamic tool whose schema requires constructor",
      inputSchema: requiring("constructor"),
      execute: async () => ({ content: "must not run" }),
    };
    expect(validateToolPreflight(tool, JSON.parse("{}"))?.content).toBe(
      "<tool_use_error>InputValidationError: Dynamic failed due to the following issue:\n" +
        "The required parameter `constructor` is missing</tool_use_error>",
    );
  });
});
