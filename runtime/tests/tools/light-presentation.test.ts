import { expect, test } from "vitest";
import { lightPresentation } from "../../src/tools/light-presentation.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import type { LLMTool } from "../../src/llm/types.js";

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
    .map(([key, child]) => [key, withoutDescriptions(child)]));
}

test("all eight Light schemas retain the canonical contract and source schema", () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true });
  registry.discoverToolNames?.(["Edit", "Write", "Grep", "Glob", "write_stdin"]);
  const wire = registry.toLLMTools();
  expect(wire.map(t => t.function.name).sort()).toEqual([
    "Edit", "FileRead", "Glob", "Grep", "Write", "exec_command", "system.searchTools", "write_stdin",
  ]);
  for (const item of wire) {
    const canonical = registry.tools.find(t => t.name === item.function.name)!;
    expect(withoutDescriptions(item.function.parameters)).toEqual(withoutDescriptions(canonical.inputSchema));
  }
  const before = JSON.stringify(registry.tools.map(t => t.inputSchema));
  registry.toLLMTools();
  expect(JSON.stringify(registry.tools.map(t => t.inputSchema))).toBe(before);
  const shell = wire.find(t => t.function.name === "exec_command")!;
  const canonicalShell = registry.tools.find(t => t.name === "exec_command")!;
  for (const name of ["tty", "detach", "sandbox_permissions", "additional_permissions", "justification", "prefix_rule"]) {
    expect((shell.function.parameters.properties as Record<string, unknown>)[name]).toEqual((canonicalShell.inputSchema.properties as Record<string, unknown>)[name]);
  }
});

test("normal sessions and external tool descriptions stay canonical", () => {
  const standard = buildToolRegistry({ workspaceRoot: "/tmp" });
  for (const tool of standard.toLLMTools()) {
    const original = standard.tools.find(t => t.name === tool.function.name)!;
    expect(tool.function.description).toBe(original.description);
    expect(tool.function.parameters).toEqual(original.inputSchema);
  }
  const custom = { name: "Grep", description: "EXTERNAL CONTRACT", metadata: { source: "plugin" as const },
    inputSchema: { type: "object" as const, properties: { plugin_field: { type: "string" } } },
    execute: async () => ({ content: "plugin result" }) };
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, extraTools: [custom] });
  registry.discoverToolNames?.(["Grep"]);
  const wire = registry.toLLMTools().find(t => t.function.name === "Grep")!;
  expect(wire.function.description).toBe(custom.description);
  expect(wire.function.parameters).toEqual(custom.inputSchema);
});

test("descriptions do not rewrite data values or hide advanced arguments", () => {
  const input: LLMTool = { type: "function", function: { name: "FileRead", description: "before", parameters: {
    type: "object", required: ["file_path"], additionalProperties: false,
    properties: { file_path: { type: "string", description: "long" },
      advanced: { type: "object", properties: { description: { enum: ["must remain"] } }, default: { description: "literal" } },
      offset: { anyOf: [{ type: "number" }, { type: "string", pattern: "^[1-9]\\d*$" }] } },
  } } };
  const before = JSON.stringify(input);
  const output = lightPresentation(input);
  expect(withoutDescriptions(output.function.parameters)).toEqual(withoutDescriptions(input.function.parameters));
  expect((output.function.parameters.properties as Record<string, unknown>).advanced).toBe((input.function.parameters.properties as Record<string, unknown>).advanced);
  expect(JSON.stringify(input)).toBe(before);
});

test("compact descriptions retain retrieval, mutation and process lifecycle constraints", () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true });
  registry.discoverToolNames?.(["Edit", "Write", "Grep", "Glob", "write_stdin"]);
  const description = (name: string) => registry.toLLMTools().find(t => t.function.name === name)!.function.description;
  expect(description("FileRead")).toMatch(/2000 lines.*25000 tokens/);
  expect(description("FileRead")).toMatch(/PDFs >10 pages require pages, maximum 20/);
  expect(description("Edit")).toContain("Requires FileRead first");
  expect(description("Write")).toContain("existing files require FileRead first");
  expect(description("exec_command")).toContain("leftovers stop on return, yielded processes at session end");
  expect(description("exec_command")).toContain("danger-full-access, no tty");
  expect(description("write_stdin")).toContain("input requires initial tty=true");
  expect(description("Grep")).toContain("no fallback");
  const grep = registry.toLLMTools().find(t => t.function.name === "Grep")!;
  const limit = (grep.function.parameters.properties as Record<string, { description: string }>).head_limit;
  expect(limit.description).toContain("preserving safety ceilings");
});
