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
    expect(withoutDescriptions((shell.function.parameters.properties as Record<string, unknown>)[name]))
      .toEqual(withoutDescriptions((canonicalShell.inputSchema.properties as Record<string, unknown>)[name]));
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
      offset: { anyOf: [{ type: "number" }, { type: "string", pattern: "^[1-9]\\d*$" }],
        description: "Redundant field explanation", default: { description: "literal data remains" } } },
  } } };
  const before = JSON.stringify(input);
  const output = lightPresentation(input);
  expect(withoutDescriptions(output.function.parameters)).toEqual(withoutDescriptions(input.function.parameters));
  expect((output.function.parameters.properties as Record<string, unknown>).advanced).toBe((input.function.parameters.properties as Record<string, unknown>).advanced);
  const offset = (output.function.parameters.properties as Record<string, Record<string, unknown>>).offset!;
  expect(offset).not.toHaveProperty("description");
  expect(offset.default).toEqual({ description: "literal data remains" });
  expect(offset.anyOf).toEqual((input.function.parameters.properties as Record<string, Record<string, unknown>>).offset!.anyOf);
  expect(JSON.stringify(input)).toBe(before);
});

test("compact descriptions retain retrieval, mutation and process lifecycle constraints", () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true });
  registry.discoverToolNames?.(["Edit", "Write", "Grep", "Glob", "write_stdin"]);
  const description = (name: string) => registry.toLLMTools().find(t => t.function.name === name)!.function.description;
  expect(description("FileRead")).toMatch(/2000 lines.*25000 tokens/);
  expect(description("FileRead")).toMatch(/PDFs >10 pages require pages.*max 20/);
  expect(description("FileRead")).toContain("Display-only numbers are sparse unless dense_line_numbers");
  expect(description("Edit")).toContain("FileRead first");
  expect(description("Edit")).toContain("replace_all replaces every match (default false)");
  expect(description("Write")).toContain("existing files require FileRead first");
  expect(description("exec_command")).toContain("leftovers stop on return, yielded processes at session end");
  expect(description("write_stdin")).toContain("input requires initial tty=true");
  expect(description("Grep")).toContain("no fallback");
  const grep = registry.toLLMTools().find(t => t.function.name === "Grep")!;
  const limit = (grep.function.parameters.properties as Record<string, { description: string }>).head_limit;
  expect(limit.description).toContain("preserving safety ceilings");
});

test("compact shell fields keep permission and process-lifecycle conditions", () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true });
  const shell = registry.toLLMTools().find(t => t.function.name === "exec_command")!;
  const fields = shell.function.parameters.properties as Record<string, { description: string }>;
  for (const text of ["required for persistent shells/write_stdin input", "Unavailable in contained operations",
    "tty=false and non-interactive flags", "ask the user", "Run button"]) expect(fields.tty!.description).toContain(text);
  for (const text of ["own session", "stdout/stderr logged", "AgenC never stops it", "survives command/session end",
    "yield_time_ms (default 2000)", "early exit", "pid/log path", "Only danger-full-access",
    "--dangerously-bypass-approvals-and-sandbox", "never tty"]) expect(fields.detach!.description).toContain(text);
  expect(fields.additional_permissions!.description).toContain('sandbox_permissions="with_additional_permissions"');
  expect(fields.justification!.description).toContain("Why elevated execution");
  expect(fields.prefix_rule!.description).toContain("approval caching");
  expect(registry.tools.find(t => t.name === "exec_command")?.requiresApproval).toBe(true);
});

test("the Light yield hint names the 30 s Light default, so models that write every field copy it", () => {
  const shell = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true }).toLLMTools()
    .find(t => t.function.name === "exec_command")!;
  const yieldField = (shell.function.parameters.properties as Record<string, { description?: string }>).yield_time_ms;
  expect(yieldField?.description).toContain("Default 30000 (tty 10000).");
});
