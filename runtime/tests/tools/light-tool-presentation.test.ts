import { describe, expect, test } from "vitest";
import type { LLMTool } from "../../src/llm/types.js";
import { lightToolPresentation } from "../../src/tools/light-tool-presentation.js";

describe("Light schema presentation", () => {
  test("changes only descriptions and leaves all constraints and permission fields intact", () => {
    const canonical: LLMTool = {
      type: "function",
      function: {
        name: "exec_command",
        description: "Full shell documentation",
        parameters: {
          type: "object",
          required: ["cmd"],
          additionalProperties: false,
          properties: {
            cmd: { type: "string", minLength: 1, description: "Long command documentation" },
            sandbox_permissions: { type: "string", enum: ["default", "require_escalated", "with_additional_permissions"], description: "Permission authority" },
            additional_permissions: { type: "object", properties: { network: { type: "boolean" } }, additionalProperties: false },
          },
          "x-agenc-extension": { description: "Extension data is not prose to strip", value: 1 },
        },
      },
    };
    const before = structuredClone(canonical);
    const presented = lightToolPresentation(canonical);
    const properties = presented.function.parameters.properties as Record<string, unknown>;
    const originalProperties = canonical.function.parameters.properties as Record<string, unknown>;
    expect(canonical).toEqual(before);
    expect(presented.function.parameters).toEqual({
      ...canonical.function.parameters,
      properties: { ...originalProperties,
        cmd: { type: "string", minLength: 1 },
        sandbox_permissions: { type: "string", enum: ["default", "require_escalated", "with_additional_permissions"] },
      },
    });
    expect(properties.additional_permissions).toEqual(originalProperties.additional_permissions);
    expect(presented.function.description).toContain("Child processes stop");
  });

  test("does not rewrite specialist or MCP tool contracts", () => {
    const tool: LLMTool = { type: "function", function: { name: "mcp.example.run", description: "Provider-specific instructions", parameters: { type: "object", properties: {} } } };
    expect(lightToolPresentation(tool)).toBe(tool);
  });

  test("preserves read indexing and edit freshness conventions", () => {
    const present = (name: string) => lightToolPresentation({ type: "function", function: { name, description: "Full documentation", parameters: { type: "object", properties: { offset: { anyOf: [{ type: "number" }, { type: "string", pattern: "^[1-9]\\d*$" }] } } } } });
    expect(present("FileRead").function.description).toContain("PDFs over 10 pages");
    expect(present("FileRead").function.parameters).toMatchObject({ properties: { offset: { anyOf: [{ type: "number" }, { type: "string", pattern: "^[1-9]\\d*$" }] } } });
    expect(present("Edit").function.description).toContain("Fails if the file changed since read");
  });
});
