import { describe, expect, test } from "vitest";
import type { LLMTool } from "../types.js";
import {
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
});
