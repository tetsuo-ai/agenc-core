import { expect, test } from "vitest";
import { lightPresentation, standardPresentation } from "../../src/tools/light-presentation.js";
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
  // Selecting exec_command loads its full schema; the lean default is covered separately below.
  registry.discoverToolNames?.(["Edit", "Write", "Grep", "Glob", "write_stdin", "exec_command"]);
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
  // The advanced fields load through system.searchTools (select:exec_command).
  registry.discoverToolNames?.(["exec_command"]);
  const shell = registry.toLLMTools().find(t => t.function.name === "exec_command")!;
  const fields = shell.function.parameters.properties as Record<string, { description: string }>;
  for (const text of ["required for persistent shells/write_stdin input", "Unavailable in contained operations",
    "tty=false and non-interactive flags", "ask the user", "Run button"]) expect(fields.tty!.description).toContain(text);
  for (const text of ["own session", "stdout/stderr logged", "AgenC never stops it", "survives command/session end",
    "yield_time_ms (default 2000)", "early exit", "pid/log path", "Only outside the sandbox",
    "approved require_escalated launch", "never tty"]) expect(fields.detach!.description).toContain(text);
  expect(fields.additional_permissions!.description).toContain('sandbox_permissions="with_additional_permissions"');
  expect(fields.justification!.description).toContain("Why elevated execution");
  expect(fields.prefix_rule!.description).toContain("approval caching");
  expect(registry.tools.find(t => t.name === "exec_command")?.requiresApproval).toBe(true);
});

test("the Light yield hint names the 30 s Light default once the full exec_command schema is loaded", () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true });
  registry.discoverToolNames?.(["exec_command"]);
  const shell = registry.toLLMTools().find(t => t.function.name === "exec_command")!;
  const yieldField = (shell.function.parameters.properties as Record<string, { description?: string }>).yield_time_ms;
  expect(yieldField?.description).toContain("Default 30000 (tty 10000).");
});

test("the lean exec_command leaves yield_time_ms to its default and names it as an advanced field", () => {
  const lean = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true }).toLLMTools()
    .find(t => t.function.name === "exec_command")!;
  expect(lean.function.parameters.properties).not.toHaveProperty("yield_time_ms");
  expect(lean.function.description).toContain("Advanced fields (yield_time_ms, tty, login, shell, detach");
});

function providerRegistry(provider: string | undefined) {
  return buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true,
    ...(provider === undefined ? {} : { getSession: () => ({ services: { provider: { name: provider } } }) as never }),
  });
}

test("GPT-family Light sessions start with apply_patch instead of Edit and Write", () => {
  const names = providerRegistry("openai").toLLMTools().map(t => t.function.name).sort();
  expect(names).toEqual(["FileRead", "apply_patch", "exec_command", "system.searchTools"]);
  const shell = providerRegistry("openai").toLLMTools().find(t => t.function.name === "exec_command")!;
  // Editing must refer to this session's available catalog, which starts with
  // apply_patch and has not discovered the Edit/Write aliases.
  expect(shell.function.description).toContain("use a listed editing tool for source changes");
  expect(shell.function.description).not.toContain("require Edit/Write");
  // The shell retains the same execution contract across providers.
  expect(shell).toEqual(providerRegistry("deepseek").toLLMTools().find(t => t.function.name === "exec_command"));
});

test("other providers keep Edit and Write, and Edit stays discoverable for GPT sessions", () => {
  for (const provider of ["deepseek", "zai", "grok", undefined]) {
    const names = providerRegistry(provider).toLLMTools().map(t => t.function.name);
    expect(names, String(provider)).toEqual(expect.arrayContaining(["Edit", "Write"]));
    expect(names, String(provider)).not.toContain("apply_patch");
  }
  const gpt = providerRegistry("openai");
  gpt.discoverToolNames?.(["Edit"]);
  expect(gpt.toLLMTools().map(t => t.function.name)).toContain("Edit");
});

test("Light presents a lean exec_command until system.searchTools selects it", () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true });
  const lean = registry.toLLMTools().find(t => t.function.name === "exec_command")!;
  expect(Object.keys(lean.function.parameters.properties as object).sort()).toEqual(["cmd", "timeoutMs", "workdir"]);
  expect(lean.function.parameters.required).toEqual(["cmd"]);
  expect(lean.function.description).toContain("select:exec_command loads their schema");
  registry.discoverToolNames?.(["exec_command"]);
  const full = registry.toLLMTools().find(t => t.function.name === "exec_command")!;
  const canonical = registry.tools.find(t => t.name === "exec_command")!;
  expect(withoutDescriptions(full.function.parameters)).toEqual(withoutDescriptions(canonical.inputSchema));
  expect(full.function.description).not.toContain("select:exec_command");
});

test("Standard sessions keep the canonical exec_command", () => {
  const standard = buildToolRegistry({ workspaceRoot: "/tmp" });
  const shell = standard.toLLMTools().find(t => t.function.name === "exec_command")!;
  expect(shell.function.parameters).toEqual(standard.tools.find(t => t.name === "exec_command")!.inputSchema);
});

function withoutVendorKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVendorKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("x-agenc-"))
    .map(([key, child]) => [key, withoutVendorKeys(child)]));
}

test("standard sessions with deferral send compact core tools with the canonical contract", () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", deferRareTools: true });
  const lean = registry.toLLMTools().find(t => t.function.name === "exec_command")!;
  expect(Object.keys(lean.function.parameters.properties as object).sort()).toEqual(["cmd", "timeoutMs", "workdir"]);
  expect(lean.function.description).toContain("select:exec_command loads their schema");
  registry.discoverToolNames?.(["exec_command", "Grep"]);
  const wire = registry.toLLMTools();
  for (const item of wire) {
    const canonical = registry.tools.find(t => t.name === item.function.name)!;
    if (canonical.metadata?.source !== "builtin") continue;
    // Same fields, alternatives, defaults and standard validation keywords; only AgenC's own
    // x-agenc-* keys stay off the wire.
    expect(withoutDescriptions(item.function.parameters)).toEqual(withoutVendorKeys(withoutDescriptions(canonical.inputSchema)));
    expect(JSON.stringify(item.function.parameters)).not.toContain("x-agenc-");
  }
  const read = wire.find(t => t.function.name === "FileRead")!;
  expect(read.function.description).toContain("numbered from 1 (cat -n)");
  expect(read.function.description).toContain("A read over 25000 tokens fails");
  const multi = wire.find(t => t.function.name === "MultiEdit")!;
  expect(multi.function.description).toContain("The file is written only if every edit succeeds");
  // The canonical tools are untouched.
  expect(registry.tools.find(t => t.name === "Grep")!.inputSchema).toHaveProperty("properties.pattern.x-agenc-maxUtf8Bytes");
});

test("standard sessions send the lean Grep until system.searchTools selects it", async () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", deferRareTools: true, requireAdmission: false });
  const grep = () => registry.toLLMTools().find(t => t.function.name === "Grep")!;
  const canonical = registry.tools.find(t => t.name === "Grep")!;
  expect(Object.keys(grep().function.parameters.properties as object).sort()).toEqual(["-i", "glob", "output_mode", "path", "pattern"]);
  expect(grep().function.parameters.required).toEqual(["pattern"]);
  expect(grep().function.description).toContain("select:Grep loads their schema");
  const result = await registry.dispatch({ id: "load-grep", name: "system.searchTools", arguments: JSON.stringify({ select: "Grep" }) });
  expect(result.isError).not.toBe(true);
  expect(Object.keys(grep().function.parameters.properties as object).sort())
    .toEqual(Object.keys(canonical.inputSchema.properties!).sort());
  expect(grep().function.description).not.toContain("select:Grep");
});

test("Light presentation keeps every Grep field", () => {
  const canonical = buildToolRegistry({ workspaceRoot: "/tmp" }).tools.find(t => t.name === "Grep")!;
  const tool: LLMTool = { type: "function", function: { name: "Grep", description: canonical.description, parameters: canonical.inputSchema } };
  expect(Object.keys(lightPresentation(tool, { leanExec: true }).function.parameters.properties as object).sort())
    .toEqual(Object.keys(canonical.inputSchema.properties!).sort());
});

test("standard sessions describe Skill in a few words with the same schema", () => {
  const parameters = {
    type: "object",
    properties: {
      skill: { type: "string", description: "Skill name only. Do not pass MCP tool names such as mcp.server.tool." },
      args: { type: "string", description: "Optional arguments for the skill." },
    },
    required: ["skill"],
    additionalProperties: false,
  };
  const tool: LLMTool = { type: "function", function: { name: "Skill", description: "Execute a skill within the main conversation.", parameters } };
  const presented = standardPresentation(tool);
  expect(presented.function.description).toContain("Run a skill listed in the system reminders");
  expect(presented.function.description).toContain("Skill names only");
  expect(withoutDescriptions(presented.function.parameters)).toEqual(withoutDescriptions(parameters));
  expect((presented.function.parameters.properties as Record<string, { description?: string }>).skill.description).toBe("A listed skill name.");
  expect((presented.function.parameters.properties as Record<string, { description?: string }>).args.description).toBeUndefined();
});

test("the registry reports compact presentation for standard deferral only", () => {
  expect(buildToolRegistry({ workspaceRoot: "/tmp", deferRareTools: true }).compactPresentation).toBe(true);
  expect(buildToolRegistry({ workspaceRoot: "/tmp", deferRareTools: false }).compactPresentation).toBe(false);
  expect(buildToolRegistry({ workspaceRoot: "/tmp", deferRareTools: true, lightMode: true }).compactPresentation).toBe(false);
});


test("initial Light shell summaries remain byte-identical to the pre-server-fix contract", () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true });
  const shell = registry.toLLMTools().find(t => t.function.name === "exec_command")!;
  expect(shell.function.description).toBe("Workspace inspection/tests/builds; use a listed editing tool for source changes, delete/rename use rm/mv. Call tools directly, not printed placeholders/commentary. Batch bounded independent reads. Yielded session_id exposes write_stdin; kill_process stops it. No trailing &: leftovers stop on return, yielded processes at session end. Lasting services need detach. Advanced fields (yield_time_ms, tty, login, shell, detach, max_output_tokens, sandbox escalation) are accepted; system.searchTools select:exec_command loads their schema.");
  registry.discoverToolNames?.(["write_stdin", "exec_command"]);
  const tools = registry.toLLMTools();
  expect(tools.find(t => t.function.name === "write_stdin")!.function.description).toBe("Continue exec_command's session_id. Empty chars polls; input requires initial tty=true. Include command newlines; match the session's sandbox_permissions.");
  const advanced = tools.find(t => t.function.name === "exec_command")!;
  expect(advanced.function.description).not.toContain("allowLocalBinding");
  expect(advanced.function.description).not.toContain("PID namespace");
  expect((advanced.function.parameters.properties as Record<string, { description: string }>).detach!.description).toContain("approved require_escalated launch");
});
