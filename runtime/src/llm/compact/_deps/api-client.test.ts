import { describe, expect, it } from "vitest";

import { adaptCompactToolsForProvider } from "./api-client.js";
import { collectRequestMetrics } from "../../wire/shared.js";
import type { LLMTool } from "../../types.js";

describe("adaptCompactToolsForProvider", () => {
  it("preserves provider-native LLMTool entries", () => {
    const tool: LLMTool = {
      type: "function",
      function: {
        name: "FileRead",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
      },
    };

    expect(adaptCompactToolsForProvider([tool])).toEqual([tool]);
  });

  it("converts upstream compact API schemas to provider LLMTool shape", () => {
    const tools = adaptCompactToolsForProvider([
      {
        name: "FileRead",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
      },
    ]);

    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "FileRead",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string" },
            },
            required: ["file_path"],
          },
        },
      },
    ]);
  });

  it("converts compact placeholders instead of forwarding malformed tools", () => {
    const tools = adaptCompactToolsForProvider([{ name: "FileRead" }]);

    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "FileRead",
          description: "",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("produces tools that provider request metrics can serialize", () => {
    const tools = adaptCompactToolsForProvider([{ name: "FileRead" }]);

    expect(() => collectRequestMetrics([], tools)).not.toThrow();
    expect(collectRequestMetrics([], tools).toolNames).toEqual(["FileRead"]);
  });

  it("drops nameless entries", () => {
    expect(
      adaptCompactToolsForProvider([undefined, {}, { name: "   " }]),
    ).toEqual([]);
  });
});
