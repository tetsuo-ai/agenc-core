import { describe, expect, test } from "vitest";
import type { LLMTool } from "../types.js";
import {
  sanitizeToolSchemaForGrammar,
  toAnthropicTools,
  toChatCompletionsTools,
  toOpenAIResponsesTools,
  toXaiResponsesTools,
} from "./tools.js";

const TOOL: LLMTool = {
  type: "function",
  function: {
    name: "system.inspect",
    description:
      "Inspect the current project state and return a concise structured summary.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to inspect.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

// Providers enforce `^[a-zA-Z0-9_-]{1,64}$` on function names, so the wire
// layer bijectively encodes the dotted internal name (mcp-tool-naming.ts).
// The literal is hardcoded on purpose: these tests pin the wire contract
// rather than round-tripping through the encoder.
const TOOL_WIRE_NAME = "tool2__system_x2einspect";

describe("wire tool conversion", () => {
  test("preserves prompt-derived descriptions for chat completions tools", () => {
    expect(toChatCompletionsTools([TOOL])).toEqual([
      {
        type: "function",
        function: {
          name: TOOL_WIRE_NAME,
          description:
            "Inspect the current project state and return a concise structured summary.",
          parameters: TOOL.function.parameters,
        },
      },
    ]);
  });

  test("flattens tools for Responses-family providers", () => {
    const expected = [
      {
        type: "function",
        name: TOOL_WIRE_NAME,
        description:
          "Inspect the current project state and return a concise structured summary.",
        parameters: TOOL.function.parameters,
      },
    ];

    expect(toOpenAIResponsesTools([TOOL])).toEqual(expected);
    expect(toXaiResponsesTools([TOOL])).toEqual(expected);
  });

  test("maps tools to the Messages input_schema envelope", () => {
    expect(toAnthropicTools([TOOL])).toEqual([
      {
        name: TOOL_WIRE_NAME,
        description:
          "Inspect the current project state and return a concise structured summary.",
        input_schema: TOOL.function.parameters,
      },
    ]);
  });

  test("removes unsupported grammar keywords recursively without mutating the source", () => {
    const schema = {
      type: "object",
      title: "unsafe title",
      properties: {
        path: {
          type: ["string", "null"],
          description: "Path to inspect.",
          minLength: 1,
          pattern: "^src/",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 5,
        },
        nested: {
          type: "array",
          items: {
            type: "object",
            properties: {
              enabled: { type: "boolean", readOnly: true },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["path"],
      additionalProperties: false,
      $defs: { unused: { type: "string" } },
    };
    const before = structuredClone(schema);

    expect(sanitizeToolSchemaForGrammar(schema)).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to inspect.",
        },
        limit: { type: "integer" },
        nested: {
          type: "array",
          items: {
            type: "object",
            properties: { enabled: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      },
      required: ["path"],
      additionalProperties: false,
    });
    expect(schema).toEqual(before);
  });

  test("preserves every concrete member of multi-type unions", () => {
    expect(
      sanitizeToolSchemaForGrammar({
        type: ["string", "number", "null"],
        description: "A string, number, or null.",
      }),
    ).toEqual({
      description: "A string, number, or null.",
      anyOf: [{ type: "string" }, { type: "number" }, { const: null }],
    });
  });
});
