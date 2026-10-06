import { describe, expect, test, vi } from "vitest";
import { buildToolRegistry } from "../src/tool-registry.js";
import type { BuildToolRegistryOptions } from "../src/tool-registry.js";
import type { ExecCommandToolOutput, UnifiedExecProcessManagerLike } from "../src/unified-exec/types.js";
import { explicitDangerBroker, withExplicitDangerBoundary } from "./helpers/explicit-danger-boundary.js";
import { buildFilteredRegistry, TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH } from "../src/agents/run-agent.js";

const finished: ExecCommandToolOutput = {
  stdout: "done", stderr: "", output: "done", exitCode: 0, exit_code: 0,
  timedOut: false, truncated: false, durationMs: 1, wall_time_seconds: 0.001,
  original_token_count: 1,
};

function fixture(output: ExecCommandToolOutput, options: Partial<BuildToolRegistryOptions> = {}) {
  const manager: UnifiedExecProcessManagerLike = {
    maxTimeoutMs: Infinity,
    execCommand: vi.fn(async () => output),
    startDetachedProcess: vi.fn(async () => output),
    writeStdin: vi.fn(async () => finished),
    closeAll: vi.fn(async () => {}),
  };
  const registry = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker,
    unifiedExecManager: manager, ...options,
  });
  const visible = () => registry.toLLMTools().map(tool => tool.function.name);
  return { registry, manager, visible };
}

describe("Light terminal companion exposure", () => {
  test.each(["registry", "tool executor"])("exposes stdin after a real yield through %s, keeping its canonical contract", async route => {
    const { registry, manager, visible } = fixture({ ...finished, exitCode: null, process_id: 71 });
    const other = fixture(finished);
    expect(visible()).not.toContain("write_stdin");
    expect(registry.tools.some(tool => tool.name === "write_stdin")).toBe(true);
    const result = route === "registry"
      ? await registry.dispatch({ id: "yield-1", name: "exec_command", arguments: '{"cmd":"pwd"}' })
      : await registry.tools.find(tool => tool.name === "exec_command")!.execute(withExplicitDangerBoundary({ cmd: "pwd" }));
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("session_id=71");
    expect(visible()).toContain("write_stdin");
    expect(other.visible()).not.toContain("write_stdin");
    const tool = registry.tools.find(tool => tool.name === "write_stdin")!;
    expect(tool.requiresApproval).toBe(true);
    const shown = registry.toLLMTools().find(tool => tool.function.name === "write_stdin")!;
    for (const field of ["sandbox_permissions", "additional_permissions", "justification"]) {
      expect((shown.function.parameters.properties as Record<string, unknown>)[field])
        .toEqual((tool.inputSchema.properties as Record<string, unknown>)[field]);
    }
    await registry.dispatch({ id: "poll-1", name: "write_stdin", arguments: '{"session_id":71,"chars":""}' });
    expect(manager.writeStdin).toHaveBeenCalledOnce();
    expect(visible()).toContain("write_stdin");
  });

  test.each([
    finished,
    { ...finished, exitCode: 1 },
    { ...finished, exitCode: null, timedOut: true },
    { ...finished, exitCode: null, detached: true, pid: 42 },
  ])("does not expand for finished, failed, killed or detached output %#", async output => {
    const { registry, visible } = fixture(output);
    await registry.dispatch({ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' });
    expect(visible()).not.toContain("write_stdin");
  });

  test("does not expand when preflight refuses a shell mutation", async () => {
    const { registry, manager, visible } = fixture({ ...finished, exitCode: null, process_id: 71 });
    const result = await registry.dispatch({ id: "denied", name: "exec_command", arguments: '{"cmd":"echo bad > source.ts"}' });
    expect(result.isError).toBe(true);
    expect(manager.execCommand).not.toHaveBeenCalled();
    expect(visible()).not.toContain("write_stdin");
  });

  test("keeps manual discovery and discovery-disabled fallback usable", async () => {
    const { registry, visible } = fixture(finished);
    await registry.dispatch({ id: "discover", name: "system.searchTools", arguments: '{"select":"write_stdin"}' });
    expect(visible()).toContain("write_stdin");
    const withoutDiscovery = fixture(finished, { toolsConfig: { disabled_tools: ["system.searchTools"] } });
    expect(withoutDiscovery.visible()).toContain("write_stdin");
  });

  test.each([
    { toolsConfig: { disabled_tools: ["write_stdin"] } },
    { unavailableCalledTools: ["write_stdin"] },
  ])("automatic discovery cannot re-enable an unavailable tool %#", async options => {
    const { registry, visible } = fixture({ ...finished, exitCode: null, process_id: 71 }, options);
    await registry.dispatch({ id: "yield", name: "exec_command", arguments: '{"cmd":"pwd"}' });
    expect(visible()).not.toContain("write_stdin");
  });

  test("normal sessions still expose stdin initially", () => {
    expect(fixture(finished, { lightMode: false }).visible()).toContain("write_stdin");
  });

  test("also exposes stdin for a manager using the session_id output alias", async () => {
    const { registry, visible } = fixture({ ...finished, session_id: 71 });
    const result = await registry.dispatch({ id: "alias", name: "exec_command", arguments: '{"cmd":"pwd"}' });
    expect(result.content).toContain("session_id=71");
    expect(visible()).toContain("write_stdin");
  });
});

const childOptions = (id: string) => ({
  childConversationId: id, lightMode: true,
  sandboxExecutionBroker: explicitDangerBroker,
  unadmittedDispatchOverride: TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
});
const hasStdin = (registry: ReturnType<typeof buildToolRegistry>) =>
  registry.toLLMTools().some(tool => tool.function.name === "write_stdin");

describe("Light child terminal continuation ownership", () => {
  test.each(["registry", "tool executor"])("exposes only the yielding child through %s", async route => {
    const { registry: parent, manager } = fixture({ ...finished, exitCode: null, process_id: 71 });
    const child = buildFilteredRegistry(parent, childOptions("child"));
    const sibling = buildFilteredRegistry(parent, childOptions("sibling"));
    const result = route === "registry"
      ? await child.dispatch({ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' })
      : await child.tools.find(tool => tool.name === "exec_command")!.execute({ cmd: "pwd" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("session_id=71");
    expect([hasStdin(parent), hasStdin(child), hasStdin(sibling)]).toEqual([false, true, false]);
    await child.dispatch({ id: "poll", name: "write_stdin", arguments: '{"session_id":71}' });
    expect(manager.writeStdin).toHaveBeenCalledOnce();
  });

  test("nested children retain their own continuation and ancestor policies", async () => {
    const { registry: parent, manager } = fixture({ ...finished, exitCode: null, process_id: 71 });
    const policy = vi.fn(async (_tool, args) => ({ behavior: "allow" as const, updatedInput: { ...args } }));
    const child = buildFilteredRegistry(parent, { ...childOptions("child"), childToolPolicy: policy });
    const nested = buildFilteredRegistry(child, childOptions("nested"));
    const result = await nested.dispatch({ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' });
    expect(result.isError).not.toBe(true);
    expect(policy).toHaveBeenCalled();
    expect(manager.execCommand).toHaveBeenCalledOnce();
    expect([hasStdin(parent), hasStdin(child), hasStdin(nested)]).toEqual([false, false, true]);
  });

  test.each([
    { disabledTools: new Set(["write_stdin"]) },
    { allowlist: ["exec_command", "system.searchTools"] },
  ])("cannot expose a restricted child tool %#", async restrictions => {
    const { registry: parent } = fixture({ ...finished, exitCode: null, process_id: 71 });
    const child = buildFilteredRegistry(parent, { ...childOptions("child"), ...restrictions });
    await child.dispatch({ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' });
    expect(hasStdin(child)).toBe(false);
    expect(hasStdin(parent)).toBe(false);
  });

  test("preserves the read-only catalog's allowed polling tool", async () => {
    const { registry: parent } = fixture({ ...finished, exitCode: null, process_id: 71 });
    const child = buildFilteredRegistry(parent, {
      ...childOptions("reader"), executionConstraint: { kind: "read-only", ownerThreadId: "parent" },
    });
    expect(child.tools.some(tool => tool.name === "write_stdin")).toBe(true);
    expect(child.tools.some(tool => tool.name === "Write" || tool.name === "Edit")).toBe(false);
    expect((await child.dispatch({ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' })).isError).not.toBe(true);
    expect([hasStdin(parent), hasStdin(child)]).toEqual([false, true]);
    expect(child.tools.some(tool => tool.name === "Write" || tool.name === "Edit")).toBe(false);
  });

  test("keeps the parent's unavailable catalog restriction", async () => {
    const { registry: parent } = fixture({ ...finished, exitCode: null, process_id: 71 }, { unavailableCalledTools: ["write_stdin"] });
    const child = buildFilteredRegistry(parent, childOptions("child"));
    expect((await child.dispatch({ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' })).isError).not.toBe(true);
    expect(hasStdin(child)).toBe(false);
    expect(hasStdin(parent)).toBe(false);
  });

  test("keeps discovery local for a non-Light child of a Light registry", async () => {
    const { registry: parent } = fixture({ ...finished, exitCode: null, process_id: 71 });
    const child = buildFilteredRegistry(parent, { ...childOptions("standard"), lightMode: false });
    expect((await child.dispatch({ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' })).isError).not.toBe(true);
    expect([hasStdin(parent), hasStdin(child)]).toEqual([false, true]);
  });

  test("denied child policy never runs or exposes a continuation", async () => {
    const { registry: parent, manager } = fixture({ ...finished, exitCode: null, process_id: 71 });
    const child = buildFilteredRegistry(parent, {
      ...childOptions("child"), childToolPolicy: async () => ({ behavior: "deny", message: "role restriction" }),
    });
    expect((await child.dispatch({ id: "run", name: "exec_command", arguments: '{"cmd":"pwd"}' })).isError).toBe(true);
    expect(manager.execCommand).not.toHaveBeenCalled();
    expect([hasStdin(parent), hasStdin(child)]).toEqual([false, false]);
  });
});
