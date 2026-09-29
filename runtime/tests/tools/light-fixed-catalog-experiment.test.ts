import { expect, test } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";

test("measurement catalog includes eligible tools without discovery-driven changes", () => {
  const registry = buildToolRegistry({ workspaceRoot: process.cwd(), lightMode: true, requireAdmission: false });
  const initial = registry.toLLMTools();
  expect(initial.some(tool => tool.function.name === "TodoWrite")).toBe(true);
  registry.discoverToolNames?.(["TodoWrite"]);
  expect(registry.toLLMTools()).toEqual(initial);
  expect(registry.tools.find(tool => tool.name === "exec_command")?.requiresApproval).toBe(true);
});
