import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { originalSchemas } from "./fixtures/canonical-input-schemas-combo3.js";

vi.mock("../../src/tools/canonical-input-schemas.js", async (original) => {
  const factories = await original<typeof import("../../src/tools/canonical-input-schemas.js")>();
  return Object.fromEntries(Object.entries(factories).map(([name, create]) => [name, vi.fn(create)]));
});

import * as factories from "../../src/tools/canonical-input-schemas.js";
import {
  CanonicalBashTool, CanonicalFileReadTool, CanonicalFileEditTool,
  CanonicalFileWriteTool, CanonicalGrepTool, CanonicalGlobTool,
  CanonicalNotebookEditTool,
} from "../../src/tools/canonicalToolSurface.js";

const cases = [
  [CanonicalBashTool, factories.createBashInputSchema, originalSchemas.bash, { command: "pwd", args: [], timeoutMs: 5 }],
  [CanonicalFileReadTool, factories.createFileReadInputSchema, originalSchemas.fileRead, { file_path: "/tmp/a", offset: "12", limit: 3 }],
  [CanonicalFileEditTool, factories.createFileEditInputSchema, originalSchemas.fileEdit, { file_path: "a", old_string: "", new_string: "x", replace_all: true }],
  [CanonicalFileWriteTool, factories.createFileWriteInputSchema, originalSchemas.fileWrite, { file_path: "a", content: "x" }],
  [CanonicalGrepTool, factories.createGrepInputSchema, originalSchemas.grep, { pattern: "x", output_mode: "count", "-n": true, multiline: false }],
  [CanonicalGlobTool, factories.createGlobInputSchema, originalSchemas.glob, { pattern: "**/*.ts", path: "." }],
  [CanonicalNotebookEditTool, factories.createNotebookEditInputSchema, originalSchemas.notebookEdit, { notebook_path: "a.ipynb", edit_mode: "replace", cell_type: "code" }],
] as const;

describe("canonical adapter schema first use", () => {
  it("keeps import, metadata and result formatting free of schema construction", () => {
    for (const [tool, create] of cases) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.renderToolResultMessage?.("result", [], {} as never)).toBe("result");
      expect(tool.extractSearchText?.("result")).toBe("result");
      expect(Object.keys(tool)).toContain("inputSchema");
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("constructs each schema once and preserves original JSON and validation results", () => {
    for (const [tool, create, original, valid] of cases) {
      const schema = tool.inputSchema;
      expect(tool.inputSchema).toBe(schema);
      expect(create).toHaveBeenCalledTimes(1);
      expect(z.toJSONSchema(schema)).toEqual(z.toJSONSchema(original));
      for (const input of [valid, { ...valid, unexpected: true }, {}, null, [], "x",
        { ...valid, file_path: 3 }, { ...valid, offset: "0" }, { ...valid, limit: "-1" },
        { ...valid, edit_mode: "invalid", output_mode: "invalid", command: 1 }]) {
        const oldResult = original.safeParse(input);
        const newResult = schema.safeParse(input);
        expect(newResult.success).toBe(oldResult.success);
        if (oldResult.success && newResult.success) expect(newResult.data).toEqual(oldResult.data);
        else if (!oldResult.success && !newResult.success) {
          expect(newResult.error.issues).toEqual(oldResult.error.issues);
          expect(newResult.error.message).toBe(oldResult.error.message);
        }
      }
    }
  });
});
