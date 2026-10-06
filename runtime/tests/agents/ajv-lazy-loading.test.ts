import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../src/utils/loadAjv.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/loadAjv.js")>();
  state.load.mockImplementation(actual.loadAjv);
  return { loadAjv: state.load };
});
beforeEach(() => { vi.resetModules(); state.load.mockClear(); });
afterEach(() => { vi.resetModules(); });

const imports = [
  () => import("../../src/agents/jobs/csv-schema.js"),
  () => import("../../src/agents/workflow-manifest-schema.js"),
  () => import("../../src/agents/workflow-invocation.js"),
  () => import("../../src/agents/workflow-handoff-schema.js"),
  () => import("../../src/eval-contract/validation.js"),
  () => import("../../src/bin/structured-output-tool.js"),
  () => import("../../src/llm/structured-output.js"),
  () => import("../../src/llm/providers/ollama/salvage-tool-calls.js"),
  () => import("../../src/llm/providers/ollama/text-tool-call-recovery.js"),
  () => import("../../src/tools/MCPTool/MCPTool.js"),
  () => import("../../src/tools/SyntheticOutputTool/SyntheticOutputTool.js"),
];

describe("daemon validators load Ajv only at first use", () => {
  it("imports every startup validation surface without loading Ajv", async () => {
    for (const load of imports) await load();
    expect(state.load).not.toHaveBeenCalled();
  });

  it("keeps CSV metadata creation lazy and caches the real synchronous validator", async () => {
    const csv = await import("../../src/agents/jobs/csv-schema.js");
    const compiled = csv.compileCsvOutputSchema({ type: "object", properties: { value: { type: "number" } }, required: ["value"] })!;
    expect(state.load).not.toHaveBeenCalled();
    expect(compiled.validate({ value: 1 })).toBeNull();
    expect(compiled.validate({})).toMatch(/value/);
    expect(state.load).toHaveBeenCalledTimes(1);
  });

  it("fails closed on CSV validation and migration when Ajv cannot load", async () => {
    const csv = await import("../../src/agents/jobs/csv-schema.js");
    const compiled = csv.compileCsvOutputSchema({ type: "object" })!;
    const error = new Error("Ajv package unavailable");
    state.load.mockImplementationOnce(() => { throw error; });
    expect(() => compiled.validate({})).toThrow(error);
    state.load.mockImplementationOnce(() => { throw error; });
    expect(() => csv.assertCsvOutputSchemaMigrationCompatible(compiled)).toThrow(error);
    expect(compiled.validate({})).toBeNull();
  });

  it("rejects structured output, workflow input and MCP input on deferred load failure", async () => {
    const structured = await import("../../src/llm/structured-output.js");
    const workflow = await import("../../src/agents/workflow-invocation.js");
    const { MCPTool } = await import("../../src/tools/MCPTool/MCPTool.js");
    const error = new Error("Ajv package unavailable");
    state.load.mockImplementationOnce(() => { throw error; });
    expect(() => structured.parseStructuredOutputValue({}, "result", { type: "object" })).toThrow("Ajv package unavailable");
    state.load.mockImplementationOnce(() => { throw error; });
    expect(() => workflow.validateWorkflowInvocationValue({ name: "work" })).toThrow(error);
    state.load.mockImplementationOnce(() => { throw error; });
    const tool = { ...MCPTool, inputJSONSchema: { type: "object" as const } };
    expect(await tool.validateInput!({}, {} as never)).toMatchObject({ result: false, errorCode: 500 });
  });

  it("never recovers an executable Ollama call when Ajv cannot load", async () => {
    const { salvageTextToolCalls } = await import("../../src/llm/providers/ollama/salvage-tool-calls.js");
    const error = new Error("Ajv package unavailable");
    state.load.mockImplementationOnce(() => { throw error; });
    expect(() => salvageTextToolCalls('{"name":"read","arguments":{}}', [{
      type: "function", function: { name: "read", description: "read", parameters: { type: "object" } },
    }])).toThrow(error);
  });
});
