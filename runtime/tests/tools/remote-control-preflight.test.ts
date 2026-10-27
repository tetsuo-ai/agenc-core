import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ToolRouter } from "../../src/tools/router.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Tool } from "../../src/tools/types.js";
import type { ToolInvocation } from "../../src/tools/context.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(["read_only", "workspace_write", "danger_full_access", "external_sandbox"] as const)("refuses owner config before any approvable path in %s", async sandboxMode => {
  const root = mkdtempSync(join(tmpdir(), "remote-preflight-")); roots.push(root);
  const home = join(root, "home"), managed = join(root, "managed");
  mkdirSync(home); mkdirSync(managed);
  for (const target of [join(home, "config.toml"), join(managed, "config.toml"), join(managed, "config.d", "enable.toml")]) {
  for (const route of ["model", "direct"] as const) {
    const execute = vi.fn(async () => ({ content: "must never execute" }));
    const preflight = vi.fn(() => null);
    const hook = vi.fn(async () => ({ kind: "continue" as const }));
    const canUseTool = vi.fn(async () => ({ behavior: "ask" as const, message: "ask owner" }));
    const resolver = { request: vi.fn(async () => ({ kind: "approved" as const })) };
    const tool: Tool = { name: "Write", description: "fixture", requiresApproval: true, inputSchema: {}, metadata: { mutating: true }, execute, preflight };
    const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
    const session = { eventLog: new EventLog(), services: {
      admissionRequired: false, runtimeOptions: resolveAgentRuntimeOptions({}),
      configStore: { homeContext: { path: home }, managedPaths: { root: managed } },
    } } as unknown as ToolInvocation["session"];
    const args = { file_path: target, content: "[remote_control]\nenabled = true\n" };
    const options = { session, turn: { cwd: root } as ToolInvocation["turn"], tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
      approvalPolicy: "granular" as const, sandboxMode, approvalResolver: resolver, canUseTool, permissionContext: {} as never, preHooks: [hook] };
    const result = route === "model"
      ? await router.dispatchModelToolCall({ id: "owner-config", name: "Write", arguments: JSON.stringify(args) }, options)
      : await router.dispatchToolCall({ ...options, callId: "owner-config", toolName: { name: "Write" }, payload: { kind: "function", arguments: JSON.stringify(args) }, source: "direct" }, args, options);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("owner-only");
    expect(hook).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(resolver.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({ preflightCode: "remote_control_owner_only" });
  }
  }
});
