import { describe, expect, it } from "vitest";

import { stripAgenCInternalArgsForValidation } from "../../src/tools/argument-validation.js";
import { validateToolPreflight } from "../../src/tools/execution.js";
import type { Tool } from "../../src/tools/types.js";

const STRICT_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

function toolWithSchema(schema: Record<string, unknown>): Tool {
  return {
    name: "Probe",
    description: "schema fixture",
    inputSchema: schema,
    execute: async () => ({ content: "ok" }),
  };
}

describe("stripAgenCInternalArgsForValidation", () => {
  it("returns the same object when no internal keys are present", () => {
    const input = { path: "/tmp/file" };
    expect(stripAgenCInternalArgsForValidation(input)).toBe(input);
  });

  it("strips only the __agenc prefix and keeps caller arguments", () => {
    const input = {
      path: "/tmp/file",
      __agencSessionId: "sess-1",
      __agencRuntime: { invocation: {} },
      __agenc: true,
    };
    expect(stripAgenCInternalArgsForValidation(input)).toEqual({
      path: "/tmp/file",
    });
    expect(input.__agencSessionId).toBe("sess-1");
  });

  it.each([
    "agencSessionId",
    "_agencSessionId",
    "__AGENCSessionId",
    "foo__agenc",
  ])("does not treat %s as an internal bookkeeping key", (key) => {
    const input = { path: "/tmp/file", [key]: "keep" };
    expect(stripAgenCInternalArgsForValidation(input)).toEqual(input);
  });

  it("lets preflight ignore injected session keys on a closed schema", () => {
    const args = { path: "/tmp/file", __agencSessionId: "sess-1" };
    expect(validateToolPreflight(toolWithSchema(STRICT_SCHEMA), args)).toBeNull();
    expect(validateToolPreflight(toolWithSchema(STRICT_SCHEMA), {
      path: "/tmp/file",
      extra: true,
    })?.isError).toBe(true);
  });
});
