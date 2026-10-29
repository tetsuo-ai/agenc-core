/**
 * OpenAI's platform Responses API converts a function tool sent without
 * `strict` to strict mode whenever it can, and that conversion makes every
 * property required. Live on 2026-10-28 (gpt-6.1-terra, gpt-6.1-sol,
 * gpt-6-luna, gpt-5.5) the response echoed every property as required with
 * `strict: true`, and the models then filled them on every call: a guessed
 * `timeoutMs: 10000`, a workdir, and a 200-line FileRead window, where the
 * tool's defaults apply when the field is left out. Tools with optional
 * fields therefore declare `strict: false`; tools strict mode accepts
 * unchanged keep their shape.
 */
import { describe, expect, test, vi } from "vitest";

import { OpenAIProvider } from "../../../src/llm/providers/openai/adapter.js";
import {
  buildOpenAIResponsesRequest,
  isStrictCompatibleToolSchema,
} from "../../../src/llm/wire/responses-openai.js";
import type { LLMTool } from "../../../src/llm/types.js";

function tool(name: string, parameters: Record<string, unknown>): LLMTool {
  return { type: "function", function: { name, description: `${name} tool`, parameters } };
}

const EXEC = tool("exec_command", {
  type: "object",
  properties: {
    cmd: { type: "string" },
    workdir: { type: "string", description: "Default: workspace root." },
    timeoutMs: { type: "number", description: "Hard timeout, ms." },
  },
  required: ["cmd"],
  additionalProperties: false,
});
const PATCH = tool("apply_patch", {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
  additionalProperties: false,
});
const MULTI_EDIT = tool("MultiEdit", {
  type: "object",
  properties: {
    file_path: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  required: ["file_path", "edits"],
  additionalProperties: false,
});

function strictOf(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries((body.tools as Array<Record<string, unknown>>)
    .map((entry) => [String(entry.name), entry.strict ?? "absent"]));
}

describe("isStrictCompatibleToolSchema", () => {
  test("accepts objects that require every property and allow no others", () => {
    expect(isStrictCompatibleToolSchema(PATCH.function.parameters)).toBe(true);
    expect(isStrictCompatibleToolSchema({ type: "object", properties: {}, additionalProperties: false })).toBe(true);
    expect(isStrictCompatibleToolSchema({
      type: "object",
      properties: { mode: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["mode"],
      additionalProperties: false,
    })).toBe(true);
  });

  test("rejects an optional property at the root, in array items, in unions and in definitions", () => {
    expect(isStrictCompatibleToolSchema(EXEC.function.parameters)).toBe(false);
    expect(isStrictCompatibleToolSchema(MULTI_EDIT.function.parameters)).toBe(false);
    const optionalInside = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"], additionalProperties: false };
    const wrap = (key: string, value: unknown) => ({ type: "object", properties: { x: { [key]: value } }, required: ["x"], additionalProperties: false });
    expect(isStrictCompatibleToolSchema(wrap("anyOf", [{ type: "string" }, optionalInside]))).toBe(false);
    expect(isStrictCompatibleToolSchema({ ...wrap("$ref", "#/$defs/inner"), $defs: { inner: optionalInside } })).toBe(false);
  });

  test("rejects objects that allow other properties or a property map", () => {
    expect(isStrictCompatibleToolSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toBe(false);
    expect(isStrictCompatibleToolSchema({ type: "object", additionalProperties: { type: "string" } })).toBe(false);
  });
});

describe("strict declarations on the OpenAI Responses wire", () => {
  test("declares strict false only on tools with optional fields", () => {
    const body = buildOpenAIResponsesRequest({
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: "hi" }],
      tools: [EXEC, PATCH, MULTI_EDIT],
      declareNonStrictTools: true,
    });
    expect(strictOf(body)).toEqual({ exec_command: false, apply_patch: "absent", MultiEdit: false });
    // The schema the model sees is the one the tool declares.
    expect((body.tools as Array<Record<string, unknown>>)[0]?.parameters).toEqual(EXEC.function.parameters);
  });

  test("leaves every tool unmarked for destinations that did not ask for it", () => {
    const body = buildOpenAIResponsesRequest({
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: "hi" }],
      tools: [EXEC, PATCH],
    });
    expect(strictOf(body)).toEqual({ exec_command: "absent", apply_patch: "absent" });
  });

  test("the OpenAI platform adapter sends the declarations; another Responses provider does not", async () => {
    const completed = () => new Response(JSON.stringify({ status: "completed", output: [] }),
      { status: 200, headers: { "content-type": "application/json" } });
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return completed();
    });

    await new OpenAIProvider({ apiKey: "sk-test", model: "gpt-6.1-sol", fetchImpl })
      .chat([{ role: "user", content: "hi" }], { tools: [EXEC, PATCH] });
    await new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-6.1-sol",
      providerName: "openai-compatible",
      baseURL: "https://gateway.example.invalid/v1",
      apiKeyEnvLabel: "OPENAI_COMPATIBLE_API_KEY",
      useResponsesApi: true,
      fetchImpl,
    }).chat([{ role: "user", content: "hi" }], { tools: [EXEC, PATCH] });

    expect(strictOf(bodies[0]!)).toEqual({ exec_command: false, apply_patch: "absent" });
    expect(strictOf(bodies[1]!)).toEqual({ exec_command: "absent", apply_patch: "absent" });
  });
});
