import { normalizeModelToolArgs } from "../../src/tools/argument-validation.js";
import { describe, expect, test, vi } from "vitest";
import { runToolUse, validateToolArgs as validateStrictToolArgs, validateToolPreflight } from "../../src/tools/execution.js";
import { formatSchemaValidationError } from "../../src/tools/schema-errors.js";
import { createPlanningTools } from "../../src/tools/system/planning.js";
import { partitionToolCalls } from "../../src/tools/orchestration.js";
import { ToolRouter } from "../../src/tools/router.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { llmMessageToDurableResponseItem, responseItemToLlmMessage } from "../../src/session/message-history-conversion.js";
import { buildXaiResponsesRequest, extractXaiReasoningReplay } from "../../src/llm/wire/responses-xai.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import type { Tool } from "../../src/tools/types.js";
import type { LLMMessage } from "../../src/llm/types.js";

const todoTool = createPlanningTools().find((tool) => tool.name === "TodoWrite")!;
const todos = [{ content: "Verify fix", activeForm: "Verifying fix", status: "in_progress" }];
const schemaFor = (value: Record<string, unknown>) => ({ type: "object", properties: { value }, required: ["value"] });

function invocation(raw: string, eventLog: EventLog): ToolInvocation {
  return {
    session: { eventLog, services: { admissionRequired: false, runtimeOptions: resolveAgentRuntimeOptions({}) } } as never,
    turn: {} as never,
    tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    callId: "c1", toolName: { name: "TodoWrite" },
    payload: { kind: "function", arguments: raw }, source: "direct",
  };
}

describe("schema validation of stringified JSON tool input", () => {
  test.each([["array", [1, 2]], ["object", { hello: "world" }]] as const)("accepts exactly %s", (type, value) => {
    const input = { value: JSON.stringify(value) };
    const result = normalizeModelToolArgs(schemaFor({ type }), input);
    expect(result.valid).toBe(true);
    expect(result.args).toEqual({ value });
    expect(input.value).toBe(JSON.stringify(value));
  });
  test("concurrency checks receive normalized input while history keeps the original", () => {
    const input = { todos: JSON.stringify(todos) };
    const isConcurrencySafe = vi.fn((args: Record<string, unknown>) => Array.isArray(args.todos));
    const block = { type: "tool_use" as const, id: "c1", name: "TodoWrite", input };
    const batches = partitionToolCalls([block], { tools: [{ ...todoTool, isConcurrencySafe }] });
    expect(batches[0]?.isConcurrencySafe).toBe(true);
    expect(isConcurrencySafe).toHaveBeenCalledWith({ todos });
    expect(batches[0]?.blocks[0]).toBe(block);
    expect(input.todos).toBe(JSON.stringify(todos));
  });
  test("accepts the actual TodoWrite shape", () => {
    expect(normalizeModelToolArgs(todoTool.inputSchema, { todos: JSON.stringify(todos) }).args).toEqual({ todos });
  });
  test.each([
    { type: ["string", "array"] },
    { anyOf: [{ type: "string" }, { type: "array" }] },
    { oneOf: [{ type: "string" }, { type: "array" }] },
    { anyOf: [{ type: "string", minLength: 20 }, { type: "array" }] },
  ])("never coerces a schema admitting strings: %j", (valueSchema) => {
    const input = { value: "[]" };
    const result = normalizeModelToolArgs(schemaFor(valueSchema), input);
    expect(result.coercedPaths).toBeUndefined();
    expect(result.args ?? input).toBe(input);
  });
  test.each(["[", "[1,]", "[] trailing", "not JSON", "{}", "null", "true", "1", '"[]"', '["bad"]'])("retains original array error for %s", (value) => {
    const result = normalizeModelToolArgs(schemaFor({ type: "array", items: { type: "number" } }), { value });
    expect(result).toEqual({ valid: false, errors: [{ path: "value", message: "expected array, got string", category: "type", expected: "array", received: "string" }] });
    expect(formatSchemaValidationError("Example", result.errors)).toBe("Example failed due to the following issue:\nThe parameter `value` type is expected as `array` but provided as `string`");
  });
  test.each(["[]", "null", "true", "1", "hello"])("rejects wrong object input %s", (value) => {
    expect(normalizeModelToolArgs(schemaFor({ type: "object" }), { value }).errors[0]?.message).toBe("expected object, got string");
  });
  test.each([["number", "1"], ["boolean", "true"]])("does not guess %s", (type, value) => {
    expect(normalizeModelToolArgs(schemaFor({ type }), { value }).valid).toBe(false);
  });
  test("preserves already valid values and nested identities", () => {
    const input = { todos };
    expect(normalizeModelToolArgs(todoTool.inputSchema, input).args).toBe(input);
    expect(input.todos).toBe(todos);
  });
  test("walks properties, items, additionalProperties and refs without mutating history", () => {
    const schema = schemaFor({ type: "object", additionalProperties: { type: "array", items: { $ref: "#/$defs/item" } } });
    const full = { ...schema, $defs: { item: { type: "object", properties: { child: { type: "array" } } } } };
    const input = { value: { key: [JSON.stringify({ child: "[]" })] } };
    const before = JSON.stringify(input);
    expect(normalizeModelToolArgs(full, input).args).toEqual({ value: { key: [{ child: [] }] } });
    expect(JSON.stringify(input)).toBe(before);
  });
  test.each([
    { anyOf: [{ type: "array" }, { type: "null" }] },
    { oneOf: [{ type: "array" }, { type: "object" }] },
    { allOf: [{ type: "array" }, { minItems: 1 }] },
  ])("validates composition after parsing: %j", (valueSchema) => {
    expect(normalizeModelToolArgs(schemaFor(valueSchema), { value: "[1]" }).args).toEqual({ value: [1] });
  });
  test("strict validation and preflight never repair supplied arguments", () => {
    const input = { todos: JSON.stringify(todos) };
    expect(validateStrictToolArgs(todoTool.inputSchema, input).valid).toBe(false);
    expect(validateToolPreflight(todoTool, input)?.isError).toBe(true);
    expect(input.todos).toBe(JSON.stringify(todos));
  });
  test("does not commit a partial repair or replace the original error", () => {
    const input = { todos: JSON.stringify([{ content: "missing fields" }]) };
    expect(validateToolPreflight(todoTool, input)?.content).toBe("<tool_use_error>InputValidationError: TodoWrite failed due to the following issue:\nThe parameter `todos` type is expected as `array` but provided as `string`</tool_use_error>");
    expect(normalizeModelToolArgs(todoTool.inputSchema, input)).toEqual(validateStrictToolArgs(todoTool.inputSchema, input));
    expect(typeof input.todos).toBe("string");
  });
  test.each([
    ["execution", false], ["router", false],
    ["execution", true], ["router", true],
  ] as const)("%s executes a copy and preserves durable Grok 4.7 replay (nested=%s)", async (boundary, nested) => {
    const parsedArgs = { todos: nested ? todos.map((todo) => JSON.stringify(todo)) : JSON.stringify(todos) };
    const raw = JSON.stringify(parsedArgs);
    const encrypted = { type: "reasoning", id: "r1", encrypted_content: Buffer.from("opaque reasoning replay").toString("base64"), summary: [] };
    const history: LLMMessage = { role: "assistant", content: "", ...extractXaiReasoningReplay([encrypted], "grok-4.7"), providerReasoningProvenance: { provider: "grok", model: "grok-4.7" }, toolCalls: [{ id: "c1", name: "TodoWrite", arguments: raw }] };
    const durableBefore = llmMessageToDurableResponseItem(history);
    const eventLog = new EventLog();
    const warnings: unknown[] = [];
    eventLog.subscribe((event) => { if (event.msg.type === "warning") warnings.push(event.msg.payload); });
    const call = invocation(raw, eventLog);
    const execute = vi.fn<Tool["execute"]>(async () => ({ content: "ok" }));
    const preflight = vi.fn<NonNullable<Tool["preflight"]>>(() => null);
    const tool: Tool = { ...todoTool, execute, preflight };
    if (boundary === "execution") {
      const result = await runToolUse(raw, { tool, invocation: call, currentTurnId: "t1", eventLog });
      expect(result.isError).toBe(false);
    } else {
      const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
      const result = await router.dispatchToolCall(call, parsedArgs);
      expect(result.isError).not.toBe(true);
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ todos });
    expect(preflight.mock.calls[0]?.[0]).toMatchObject({ todos });
    expect(warnings).toContainEqual({ cause: "tool_input_json_coercion", message: JSON.stringify({ tool: "TodoWrite", paths: [nested ? "todos.0" : "todos"] }) });
    expect(JSON.stringify(parsedArgs)).toBe(raw);
    expect(call.payload).toEqual({ kind: "function", arguments: raw });
    expect(llmMessageToDurableResponseItem(history)).toEqual(durableBefore);
    const restored = responseItemToLlmMessage(JSON.parse(JSON.stringify(durableBefore)));
    const request = buildXaiResponsesRequest({ model: "grok-4.7", messages: [restored] });
    expect(request.input).toContainEqual(encrypted);
    expect(request.input).toContainEqual({ type: "function_call", call_id: "c1", name: "TodoWrite", arguments: raw });
  });
});
