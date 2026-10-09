import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { canonicalizeHomePath } from "../src/config/home.js";
import { buildToolRegistry } from "../src/tool-registry.js";
import { withOneShotFastMode } from "../src/one-shot-fast-mode.js";

test("canonical home follows a directory relocation with a compatibility symlink", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rv-cm-home-")));
  try {
    const before = join(root, "before");
    const after = join(root, "after");
    mkdirSync(before);
    expect(canonicalizeHomePath(before)).toBe(realpathSync(before));
    renameSync(before, after);
    symlinkSync(after, before);
    expect(canonicalizeHomePath(before)).toBe(realpathSync(before));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dynamic tool catalog observes an updated disabled-tools list", () => {
  const disabled: string[] = [];
  const tool = { name: "review.echo", description: "review fixture", inputSchema: { type: "object" as const }, execute: async () => ({ content: "fixture" }) };
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", requireAdmission: false,
    dynamicTools: [tool], toolsConfig: { disabled_tools: disabled } });
  expect(registry.tools.some(item => item.name === tool.name)).toBe(true);
  disabled.push(tool.name);
  expect(registry.tools.some(item => item.name === tool.name)).toBe(false);
  disabled.pop();
  expect(registry.tools.some(item => item.name === tool.name)).toBe(true);
});

test("dynamic tool catalog observes an updated enabled-tools list", () => {
  const enabled = ["review.echo"];
  const tool = { name: "review.echo", description: "review fixture", inputSchema: { type: "object" as const }, execute: async () => ({ content: "fixture" }) };
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", requireAdmission: false,
    dynamicTools: [tool], toolsConfig: { enabled_tools: enabled } });
  expect(registry.tools.some(item => item.name === tool.name)).toBe(true);
  enabled[0] = "review.other";
  expect(registry.tools.some(item => item.name === tool.name)).toBe(false);
});

test("dynamic tool catalog observes an updated per-tool permission default", () => {
  const config = { default_permission_mode: "never" };
  const tool = { name: "review.echo", description: "review fixture", inputSchema: { type: "object" as const }, execute: async () => ({ content: "fixture" }) };
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", requireAdmission: false,
    dynamicTools: [tool], toolsConfig: { [tool.name]: config } });
  expect(registry.tools.find(item => item.name === tool.name)?.defaultPermissionMode).toBe("never");
  config.default_permission_mode = "untrusted";
  expect(registry.tools.find(item => item.name === tool.name)?.defaultPermissionMode).toBe("untrusted");
});

test("fast presentation and dispatch both observe a tool disabled after its first advertisement", async () => {
  const disabled: string[] = [];
  const tool = { name: "review.echo", description: "review fixture", inputSchema: { type: "object" as const }, execute: async () => ({ content: "fixture" }) };
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", requireAdmission: false,
    dynamicTools: [tool], toolsConfig: { disabled_tools: disabled } });
  await withOneShotFastMode(async () => {
    expect(registry.toLLMTools().some(item => item.function.name === tool.name)).toBe(true);
    disabled.push(tool.name);
    expect(registry.toLLMTools().some(item => item.function.name === tool.name)).toBe(false);
    expect((await registry.dispatch({ id: "denied", name: tool.name, arguments: "{}" })).isError).toBe(true);
    disabled.pop();
    expect(registry.toLLMTools().some(item => item.function.name === tool.name)).toBe(true);
    expect((await registry.dispatch({ id: "allowed", name: tool.name, arguments: "{}" })).content).toBe("fixture");
  });
});
