// Reviewer regressions and controls (rv, 2026-10-02) for the GPT-family apply_patch surface.

import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildToolRegistry } from "../../../src/tool-registry.js";
import { assembleSystemPromptSnapshot } from "../../../src/prompts/system-prompt.js";
import { createApplyPatchTool } from "../../../src/tools/apply-patch/tool.js";
import { createFileWriteTool } from "../../../src/tools/system/file-write.js";
import { createExecCommandTool } from "../../../src/tools/system/exec-command.js";
import { SESSION_ID_ARG, recordSessionRead } from "../../../src/tools/system/filesystem.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import type { Session } from "../../../src/session/session.js";
import type { TurnContext } from "../../../src/session/turn-context.js";
let root = "", sessionId = "";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rv-gpt-surface-")));
  sessionId = "rv-gpt-" + root;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function patch(lines: string[]) { return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"); }
async function shellRead(name: string, content: string) {
  const manager = { maxTimeoutMs: 30000, shellStartupHooksPresent: () => false, shellPath: "/bin/bash",
    execCommand: vi.fn(async () => ({ output: content, stdout: content, stderr: "", exitCode: 0, exit_code: 0,
      durationMs: 1, wall_time_seconds: .001, timedOut: false, truncated: false, original_token_count: 1 })),
    writeStdin: vi.fn(), closeAll: vi.fn() };
  const tool = bindExplicitDangerBoundary(createExecCommandTool({ cwd: root, allowedPaths: [root], lightMode: true, unifiedExecManager: manager }));
  const result = await tool.execute({ cmd: "cat " + name, [SESSION_ID_ARG]: sessionId });
  expect(result.isError).not.toBe(true);
}
function fakeCtx(overrides?: Partial<TurnContext>): TurnContext {
  const cfg = {
    model: "grok-4-fast",
    cwd: "/tmp/agenc-fake-cwd",
    features: {} as unknown,
    multiAgentV2: { usageHintEnabled: false, usageHintText: "", hideSpawnAgentMetadata: false },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
  return {
    subId: "sub-test-1",
    realtimeActive: false,
    config: cfg as unknown,
    configSnapshot: cfg as unknown,
    modelInfo: {
      slug: "grok-4-fast",
      effectiveContextWindowPercent: 100,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "head",
      usedFallbackModelMetadata: false,
    },
    provider: {} as unknown,
    reasoningSummary: "auto",
    sessionSource: "cli_main",
    cwd: "/tmp/agenc-fake-cwd",
    collaborationMode: { model: "grok-4-fast" },
    approvalPolicy: { value: "on_request" },
    sandboxPolicy: { value: "workspace_write" },
    fileSystemSandboxPolicy: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
    networkSandboxPolicy: { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
    windowsSandboxLevel: "none",
    shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
    toolsConfig: { allowLoginShell: false, hasEnvironment: false },
    features: {
    },
    ghostSnapshot: { enabled: false },
    toolCallGate: { isReady: () => true, signal: () => {}, wait: async () => {} } as unknown,
    truncationPolicy: "head",
    jsRepl: { id: "js-0" },
    dynamicTools: [],
    turnMetadataState: {} as unknown,
    turnSkills: {} as unknown,
    turnTimingState: {} as unknown,
    depth: 0,
    ...overrides,
  } as unknown as TurnContext;
}

test("current provider changes prompt and initial tools together; discovered editors stay available", async () => {
  let provider = "openai";
  const services = { runtimeOptions: { lightMode: true, nonInteractive: true },
    get provider() { return { name: provider }; } };
  const session = { services, providerService: { current: () => ({ provider, model: "fixture-model" }) } } as unknown as Session;
  const registry = buildToolRegistry({ workspaceRoot: root, lightMode: true, getSession: () => session });
  for (const selected of ["openai", "deepseek", "openai", "zai"]) {
    provider = selected;
    const names = registry.toLLMTools().map(t => t.function.name);
    const prompt = await assembleSystemPromptSnapshot({ profile: "light", ctx: fakeCtx({ cwd: root }), session, provider });
    const wantsPatch = selected === "openai";
    expect(names.includes("apply_patch")).toBe(wantsPatch);
    expect(names.includes("Edit")).toBe(!wantsPatch);
    expect(names.includes("Write")).toBe(!wantsPatch);
    expect(prompt.staticPrefix.includes("Edit and create files with apply_patch;")).toBe(wantsPatch);
    expect(prompt.staticPrefix.includes("Edit the shortest unique text; Write complete files.")).toBe(!wantsPatch);
  }
  provider = "openai";
  registry.discoverToolNames?.(["Edit", "Write"]);
  expect(registry.toLLMTools().map(t => t.function.name)).toEqual(expect.arrayContaining(["apply_patch", "Edit", "Write"]));
});

test("initial apply_patch preserves mutation authority metadata and every exec field", () => {
  const registry = buildToolRegistry({ workspaceRoot: root, lightMode: true,
    getSession: () => ({ services: { provider: { name: "openai" }, runtimeOptions: { nonInteractive: true } } }) as never });
  const tools = registry.toLLMTools();
  expect(tools.map(t => t.function.name)).toContain("apply_patch");
  const patchTool = registry.tools.find(t => t.name === "apply_patch")!;
  expect(patchTool.requiresApproval).toBe(true);
  expect(patchTool.metadata?.mutating).toBe(true);
  expect(patchTool.checkPermissions).toBeTypeOf("function");
  const canonical = registry.tools.find(t => t.name === "exec_command")!;
  // Lead adaptation (lean exec_command): every field stays reachable; the advanced ones load through
  // system.searchTools (select:exec_command), after which the presented schema has every canonical field.
  expect(tools.find(t => t.function.name === "exec_command")!.function.description).toContain("select:exec_command");
  registry.discoverToolNames?.(["exec_command"]);
  const presented = registry.toLLMTools().find(t => t.function.name === "exec_command")!;
  expect(Object.keys(presented.function.parameters.properties!)).toEqual(Object.keys(canonical.inputSchema.properties!));
});

test("patch update refuses unread and stale contents and accepts a current shell read", async () => {
  const file = join(root, "source.txt");
  await writeFile(file, "old\n");
  const tool = createApplyPatchTool({ cwd: root, allowedPaths: [root] });
  const args = { input: patch(["*** Update File: source.txt", "@@", "-old", "+new"]), [SESSION_ID_ARG]: sessionId };
  expect((await tool.execute(args)).isError).toBe(true);
  expect(await readFile(file, "utf8")).toBe("old\n");
  await shellRead("source.txt", "old\n");
  expect((await tool.execute(args)).isError).not.toBe(true);
  expect(await readFile(file, "utf8")).toBe("new\n");
  await writeFile(file, "new\nexternal\n");
  const later = new Date(Date.now() + 2000); await utimes(file, later, later);
  expect((await tool.execute({ ...args, input: patch(["*** Update File: source.txt", "@@", "-new", "+next"]) })).isError).toBe(true);
  expect(await readFile(file, "utf8")).toBe("new\nexternal\n");
});

test("regression: Add File must not overwrite an unread existing file that Write refuses", async () => {
  const file = join(root, "source.txt"); await writeFile(file, "unseen original\n");
  const write = createFileWriteTool({ allowedPaths: [root] });
  expect((await write.execute({ file_path: file, content: "replacement\n", cwd: root, [SESSION_ID_ARG]: sessionId })).isError).toBe(true);
  expect(await readFile(file, "utf8")).toBe("unseen original\n");
  const result = await createApplyPatchTool({ cwd: root, allowedPaths: [root] }).execute({
    input: patch(["*** Add File: source.txt", "+replacement"]), [SESSION_ID_ARG]: sessionId });
  expect({ refused: result.isError === true, content: await readFile(file, "utf8") }).toEqual({ refused: true, content: "unseen original\n" });
});

test("regression: Move to must not overwrite an unread existing destination", async () => {
  await writeFile(join(root, "source.txt"), "old\n");
  await writeFile(join(root, "destination.txt"), "unseen destination\n");
  await shellRead("source.txt", "old\n");
  const result = await createApplyPatchTool({ cwd: root, allowedPaths: [root] }).execute({
    input: patch(["*** Update File: source.txt", "*** Move to: destination.txt", "@@", "-old", "+new"]), [SESSION_ID_ARG]: sessionId });
  expect({ refused: result.isError === true, content: await readFile(join(root, "destination.txt"), "utf8") }).toEqual({
    refused: true, content: "unseen destination\n" });
});
