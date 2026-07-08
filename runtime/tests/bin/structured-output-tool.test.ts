import { describe, expect, it } from "vitest";
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  createStructuredOutputTool,
  createStructuredOutputToolForSchema,
} from "./structured-output-tool.js";

describe("structured-output-tool", () => {
  it("registers the StructuredOutput tool name", () => {
    const tool = createStructuredOutputTool();
    expect(tool.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(tool.isReadOnly).toBe(true);
    expect(tool.metadata?.deferred).toBe(true);
  });

  it("registers a visible (non-deferred) tool when requested", () => {
    const tool = createStructuredOutputTool({ visible: true });
    expect(tool.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(tool.metadata?.deferred).toBe(false);
  });

  it("schema-bound tool is always visible (non-deferred)", () => {
    const built = createStructuredOutputToolForSchema({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    });
    if (!("tool" in built)) throw new Error("expected built tool");
    expect(built.tool.metadata?.deferred).toBe(false);
  });

  it("base tool echoes input as structured_output", async () => {
    const tool = createStructuredOutputTool();
    const result = await tool.execute({ kind: "bug", severity: "high" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content).structured_output).toEqual({
      kind: "bug",
      severity: "high",
    });
  });

  it("schema-bound tool accepts a payload that satisfies the schema", async () => {
    const schema = {
      type: "object",
      properties: {
        bugs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              severity: { enum: ["low", "med", "high"] },
            },
            required: ["title", "severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["bugs"],
    };
    const built = createStructuredOutputToolForSchema(schema);
    expect("tool" in built).toBe(true);
    if (!("tool" in built)) throw new Error("expected built tool");
    const result = await built.tool.execute({
      bugs: [{ title: "stack overflow", severity: "high" }],
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.structured_output.bugs[0].title).toBe("stack overflow");
  });

  it("schema-bound tool reports validation errors with paths", async () => {
    const schema = {
      type: "object",
      properties: {
        score: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["score"],
    };
    const built = createStructuredOutputToolForSchema(schema);
    if (!("tool" in built)) throw new Error("expected built tool");

    const wrong = await built.tool.execute({ score: 999 });
    expect(wrong.isError).toBe(true);
    const parsed = JSON.parse(wrong.content);
    expect(parsed.error).toBe("Output does not match required schema");
    expect(parsed.detail).toContain("/score");

    const missing = await built.tool.execute({});
    expect(missing.isError).toBe(true);
  });

  it("rejects an invalid JSON schema with the AJV diagnostic message", () => {
    const built = createStructuredOutputToolForSchema({
      type: "not-a-real-type",
    });
    expect("error" in built).toBe(true);
    if (!("error" in built)) throw new Error("expected error");
    expect(built.error.length).toBeGreaterThan(0);
  });

  it("caches the built tool by schema-object identity", () => {
    const schema = { type: "object" };
    const first = createStructuredOutputToolForSchema(schema);
    const second = createStructuredOutputToolForSchema(schema);
    expect(first).toBe(second);

    // A separate schema object — even with the same shape — must NOT
    // share the cache slot, since the cache is keyed on identity.
    const distinct = createStructuredOutputToolForSchema({ type: "object" });
    expect(distinct).not.toBe(first);
  });

  it("the built tool advertises the bound JSON schema as its inputSchema", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "number" } },
      required: ["x"],
    };
    const built = createStructuredOutputToolForSchema(schema);
    if (!("tool" in built)) throw new Error("expected built tool");
    expect(built.tool.inputSchema).toBe(schema);
  });
});
