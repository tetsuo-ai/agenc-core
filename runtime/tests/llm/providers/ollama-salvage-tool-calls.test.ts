/**
 * Recovering a tool call a local model wrote as text.
 *
 * The observed-response fixtures below were captured from a live
 * ollama 0.12 serving qwen2.5-coder:7b or deepseek-r1:7b at temperature 0,
 * with `tool_calls: null` on the wire in every case. They are the reason this
 * module exists. Other fixtures are synthetic regression cases. These
 * individual responses do not establish a model's native tool capabilities.
 */
import { describe, expect, test } from "vitest";

import { salvageTextToolCalls, streamableLength } from "../../../src/llm/providers/ollama/salvage-tool-calls.js";
import type { LLMTool } from "../../../src/llm/types.js";

const tool = (name: string): LLMTool => ({
  type: "function",
  function: {
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
  },
});

const TOOLS = [tool("FileRead"), tool("Glob"), tool("Edit")];

const args = (call: { arguments: string }): unknown => JSON.parse(call.arguments);

describe("what the model actually sent", () => {
  test("a bare call object", () => {
    // Verbatim: prompt "Read the file note.txt."
    const said = '{"name": "FileRead", "arguments": {"file_path": "note.txt"}}';
    const { toolCalls, content } = salvageTextToolCalls(said, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe("FileRead");
    expect(args(toolCalls[0]!)).toEqual({ file_path: "note.txt" });
    // Nothing but the call, so nothing is left to show.
    expect(content).toBe("");
  });

  test("a fenced array of two calls, in order", () => {
    // Verbatim: prompt "List every file in this folder, then read note.txt."
    const said =
      '```json\n[\n    {"name": "Glob", "arguments": {"pattern": "*"}},\n' +
      '    {"name": "FileRead", "arguments": {"file_path": "note.txt"}}\n]\n```';
    const { toolCalls, content } = salvageTextToolCalls(said, TOOLS);
    expect(toolCalls.map((call) => call.name)).toEqual(["Glob", "FileRead"]);
    expect(args(toolCalls[0]!)).toEqual({ pattern: "*" });
    expect(args(toolCalls[1]!)).toEqual({ file_path: "note.txt" });
    expect(content).toBe("");
  });

  test("a pretty-printed call", () => {
    // Verbatim, with a system prompt present.
    const said =
      '{\n  "name": "FileRead",\n  "arguments": {\n    "file_path": "note.txt"\n  }\n}';
    const { toolCalls } = salvageTextToolCalls(said, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(args(toolCalls[0]!)).toEqual({ file_path: "note.txt" });
  });

  test("prose first, call at the tail, and the prose survives", () => {
    // Verbatim: prompt "Explain what you will do, then read note.txt."
    // The explanation is a real answer. Salvaging the call must not eat it.
    const said =
      "I will first provide an explanation of my actions and then proceed to read the file named `note.txt`.\n\n" +
      "Explanation:\n1. I will output a brief description of what I am about to do.\n" +
      "2. I will call the `FileRead` function with the path to the file `note.txt` as the argument.\n\n" +
      "Here is the JSON object for the function call:\n\n" +
      '```json\n{"name": "FileRead", "arguments": {"file_path": "note.txt"}}\n```';
    const { toolCalls, content } = salvageTextToolCalls(said, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(args(toolCalls[0]!)).toEqual({ file_path: "note.txt" });
    expect(content).toContain("I will first provide an explanation");
    // And the JSON itself is gone from what the user reads.
    expect(content).not.toContain('"name"');
    expect(content).not.toContain("```");
  });
});

describe("what must never be rewritten", () => {
  test("an ordinary greeting", () => {
    // Verbatim: prompt "Say hello. Do not use any tool."
    const said = "Hello! How can I assist you today?";
    const result = salvageTextToolCalls(said, TOOLS);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(said);
  });

  test("a model explaining it cannot read files", () => {
    // Verbatim from deepseek-r1:7b. Mentions the file and the word text, and
    // is emphatically not a tool call.
    const said =
      "\n\nI'm unable to read files directly, but I can help analyze or extract " +
      "information from text files if you provide the content! If you share the " +
      "text from `note.txt`, I'll be happy to assist with summarizing, explaining, " +
      "or answering questions about it.";
    const result = salvageTextToolCalls(said, TOOLS);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(said);
  });

  test("JSON that is data the user asked for, not a call", () => {
    // The dangerous false positive: a user asking about JSON gets an answer
    // containing JSON. It has no advertised tool name, so it is left alone.
    const said = '```json\n{"host": "localhost", "port": 5432}\n```';
    const result = salvageTextToolCalls(said, TOOLS);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(said);
  });

  test("a call to a tool that was never advertised", () => {
    // Inventing the tool would be worse than showing the text: there is
    // nothing to dispatch to, and the model may have hallucinated it whole.
    const said = '{"name": "DropDatabase", "arguments": {"name": "prod"}}';
    const result = salvageTextToolCalls(said, TOOLS);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(said);
  });

  test("nothing at all when the request advertised no tools", () => {
    const said = '{"name": "FileRead", "arguments": {"file_path": "note.txt"}}';
    expect(salvageTextToolCalls(said, []).toolCalls).toEqual([]);
    expect(salvageTextToolCalls(said, undefined).toolCalls).toEqual([]);
  });

  test("a list where one entry is not a call is not a list of calls", () => {
    // Half-executing a batch is worse than not executing it.
    const said =
      '[{"name": "FileRead", "arguments": {"file_path": "a.txt"}}, {"note": "and then some"}]';
    const result = salvageTextToolCalls(said, TOOLS);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(said);
  });
});

describe("shapes that are not the happy path", () => {
  test("braces inside a string argument do not end the call early", () => {
    const said = '{"name": "Glob", "arguments": {"pattern": "src/**/{a,b}.ts"}}';
    const { toolCalls } = salvageTextToolCalls(said, TOOLS);
    expect(args(toolCalls[0]!)).toEqual({ pattern: "src/**/{a,b}.ts" });
  });

  test("an escaped quote inside an argument", () => {
    const said = '{"name": "Edit", "arguments": {"text": "say \\"hi\\" now"}}';
    const { toolCalls } = salvageTextToolCalls(said, TOOLS);
    expect(args(toolCalls[0]!)).toEqual({ text: 'say "hi" now' });
  });

  test("arguments the model stringified itself", () => {
    const said = '{"name": "FileRead", "arguments": "{\\"file_path\\": \\"note.txt\\"}"}';
    const { toolCalls } = salvageTextToolCalls(said, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(args(toolCalls[0]!)).toEqual({ file_path: "note.txt" });
  });

  test("`parameters` as the argument key, which is the word the schema used", () => {
    const said = '{"name": "FileRead", "parameters": {"file_path": "note.txt"}}';
    const { toolCalls } = salvageTextToolCalls(said, TOOLS);
    expect(args(toolCalls[0]!)).toEqual({ file_path: "note.txt" });
  });

  test("a call with no arguments at all", () => {
    const said = '{"name": "Glob"}';
    const { toolCalls } = salvageTextToolCalls(said, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(args(toolCalls[0]!)).toEqual({});
  });

  test("truncated JSON is left as text rather than half-parsed", () => {
    const said = '{"name": "FileRead", "arguments": {"file_path": "note.txt"';
    const result = salvageTextToolCalls(said, TOOLS);
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(said);
  });

  test("two separate fenced calls both come through", () => {
    const said =
      '```json\n{"name": "Glob", "arguments": {"pattern": "*"}}\n```\n' +
      "then read it\n" +
      '```json\n{"name": "FileRead", "arguments": {"file_path": "note.txt"}}\n```';
    const { toolCalls, content } = salvageTextToolCalls(said, TOOLS);
    expect(toolCalls.map((call) => call.name)).toEqual(["Glob", "FileRead"]);
    expect(content).toContain("then read it");
  });

  test("every recovered call gets its own id", () => {
    const said =
      '[{"name": "Glob", "arguments": {"pattern": "*"}}, {"name": "Glob", "arguments": {"pattern": "**"}}]';
    const { toolCalls } = salvageTextToolCalls(said, TOOLS);
    const ids = new Set(toolCalls.map((call) => call.id));
    expect(ids.size).toBe(2);
  });

  test("ids do not repeat across separate replies in one session", () => {
    // Found in the app, not here: an id counted per reply produced
    // `salvaged_0` again on the second turn, and the session refused the
    // history append with `assistant tool call repeats "salvaged_0"`. Ids
    // share a namespace with every earlier turn, so they have to be unique
    // across the session, not within one response.
    const said = '{"name": "FileRead", "arguments": {"file_path": "note.txt"}}';
    const first = salvageTextToolCalls(said, TOOLS).toolCalls[0]?.id;
    const second = salvageTextToolCalls(said, TOOLS).toolCalls[0]?.id;
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });

  test("the id source can be injected", () => {
    let n = 0;
    const { toolCalls } = salvageTextToolCalls(
      '[{"name": "Glob", "arguments": {"pattern": "*"}}, {"name": "FileRead", "arguments": {"file_path": "a"}}]',
      TOOLS,
      () => `fixed_${(n += 1)}`,
    );
    expect(toolCalls.map((call) => call.id)).toEqual(["fixed_1", "fixed_2"]);
  });

  test("empty and whitespace content", () => {
    expect(salvageTextToolCalls("", TOOLS).toolCalls).toEqual([]);
    expect(salvageTextToolCalls("   \n  ", TOOLS).content).toBe("   \n  ");
  });
});

describe("bounded recovery and actual advertised schemas", () => {
  const readTool: LLMTool = {
    type: "function",
    function: {
      name: "FileRead",
      description: "Read a file",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
  };
  const call = '{"name":"FileRead","arguments":{"file_path":"note.txt"}}';

  test.each([
    "invalid JSON", "null", "[]", "42", '"a string"',
  ])("rejects stringified non-object/invalid arguments: %s", (argumentsText) => {
    const text = JSON.stringify({ name: "FileRead", arguments: argumentsText });
    expect(salvageTextToolCalls(text, TOOLS)).toEqual({ content: text, toolCalls: [] });
  });

  test.each([
    {}, { file_path: 7 }, { file_path: "" }, { file_path: "a", limit: "2" },
    { file_path: "a", limit: 101 }, { file_path: "a", extra: true },
  ])("does not invent, coerce or drop arguments to fit the schema: %j", (value) => {
    const text = JSON.stringify({ name: "FileRead", arguments: value });
    expect(salvageTextToolCalls(text, [readTool])).toEqual({ content: text, toolCalls: [] });
  });

  test("accepts arguments matching the request schema", () => {
    expect(salvageTextToolCalls(call, [readTool]).toolCalls).toHaveLength(1);
  });

  test("fails closed for an invalid schema", () => {
    const invalid: LLMTool = {
      ...readTool,
      function: { ...readTool.function, parameters: { type: "not-a-json-schema-type" } },
    };
    expect(salvageTextToolCalls(call, [invalid])).toEqual({ content: call, toolCalls: [] });
  });

  test.each([
    (value: string) => `For example: ${value}`,
    (value: string) => `\`${value}\``,
    (value: string) => `> ${value}`,
    (value: string) => `\`\`\`typescript\n${value}\n\`\`\``,
    (value: string) => `{"example":${value}}`,
    (value: string) => `[\n${value}`,
    (value: string) => `${value} is an example`,
  ])("does not extract a nested, quoted or inline example", (wrap) => {
    const text = wrap(call);
    expect(salvageTextToolCalls(text, [readTool])).toEqual({ content: text, toolCalls: [] });
  });

  test("extra envelope fields or conflicting aliases are data, not calls", () => {
    for (const extra of [{ description: "example" }, { parameters: {} }]) {
      const text = JSON.stringify({ name: "FileRead", arguments: { file_path: "a" }, ...extra });
      expect(salvageTextToolCalls(text, [readTool])).toEqual({ content: text, toolCalls: [] });
    }
  });

  test("preserves all whitespace in prose surrounding an indented fence", () => {
    const prefix = "  I will read it.\n\n  ";
    const suffix = "\n\n  Afterwards I will explain.  ";
    const text = prefix + "\`\`\`json\n" + call + "\n\`\`\`" + suffix;
    expect(salvageTextToolCalls(text, [readTool]).content).toBe(prefix + suffix);
  });

  test("accepts tilde JSON fences, holding their partial prefixes", () => {
    expect(salvageTextToolCalls("~~~json\n" + call + "\n~~~", [readTool]).toolCalls).toHaveLength(1);
    expect(streamableLength("Reading.\n~")).toBe("Reading.\n".length);
    expect(streamableLength("Reading.\n\`")).toBe("Reading.\n".length);
  });

  test("rejects oversized content and batches without partially executing", () => {
    for (const text of [
      " ".repeat(1_048_577) + call,
      "[" + Array(65).fill(call).join(",") + "]",
      Array(65).fill(call).join("\n"),
      "[".repeat(65) + call + "]".repeat(65),
    ]) {
      expect(salvageTextToolCalls(text, [readTool])).toEqual({ content: text, toolCalls: [] });
    }
  });

  test("bounds nesting inside stringified arguments too", () => {
    const value = '{"nested":' + "[".repeat(65) + "0" + "]".repeat(65) + "}";
    const text = JSON.stringify({ name: "Glob", arguments: value });
    expect(salvageTextToolCalls(text, TOOLS)).toEqual({ content: text, toolCalls: [] });
  });

  test("never changes overflowing numeric arguments into null", () => {
    const text = '{"name":"Glob","arguments":{"count":1e999}}';
    expect(salvageTextToolCalls(text, TOOLS)).toEqual({ content: text, toolCalls: [] });
  });
});
