import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { runMinimalTurn } from "../../src/session/minimal-turn.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

test("real discovery refreshes the advertised catalog and real FileRead remains executable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fast-discovery-"));
  try {
    await writeFile(join(cwd, "sample.txt"), "real file contents\n");
    const specialist = vi.fn(async () => ({ content: "specialist completed" }));
    const registry = buildToolRegistry({ workspaceRoot: cwd, lightMode: true, requireAdmission: false,
      sandboxExecutionBroker: explicitDangerBroker,
      extraTools: [{ name: "Specialist", description: "Specialist", recoveryCategory: "read-only",
        inputSchema: { type: "object", properties: {} }, execute: specialist }] });
    const provider = mkProvider();
    let calls = 0;
    provider.chatStream = async (messages, _delta, options) => {
      const visible = options?.tools?.map(tool => tool.function.name) ?? [];
      calls++;
      if (calls === 1) {
        expect(visible).toContain("system.searchTools");
        expect(visible).not.toContain("Specialist");
        return { usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }, content: "", model: "test-model", finishReason: "tool_calls", toolCalls: [
          { id: "discover", name: "system.searchTools", arguments: '{"select":"Specialist"}' },
        ] };
      }
      if (calls === 2) {
        expect(visible).toContain("Specialist");
        return { usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }, content: "", model: "test-model", finishReason: "tool_calls", toolCalls: [
          { id: "read", name: "FileRead", arguments: JSON.stringify({ file_path: join(cwd, "sample.txt") }) },
          { id: "special", name: "Specialist", arguments: "{}" },
        ] };
      }
      expect(messages.find(message => message.toolCallId === "read")?.content).toContain("real file contents");
      expect(messages.find(message => message.toolCallId === "special")?.content).toContain("specialist completed");
      return { usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }, content: "done", model: "test-model", finishReason: "stop", toolCalls: [] };
    };
    const { session } = mkSession({ provider, registry, services: {
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
        dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }),
    } });
    const base = mkCtx();
    const ctx = mkCtx({ cwd, permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
      modelInfo: { ...base.modelInfo, maxOutputTokens: 2048 } });
    const loop = runMinimalTurn(session, ctx, [{ role: "user", content: "discover and read" }], "", new AbortController().signal);
    for (;;) { const next = await withOneShotFastMode(() => loop.next()); if (next.done) { expect(next.value.reason).toBe("completed"); break; } }
    expect(calls).toBe(3);
    expect(specialist).toHaveBeenCalledOnce();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("argument projection receives the selected implementation and cannot run for unavailable tools", async () => {
  const execute = vi.fn(async (args: Record<string, unknown>) => ({ content: String(args.projected) }));
  const registry = buildToolRegistry({ workspaceRoot: tmpdir(), requireAdmission: false, extraTools: [{ name: "Selected",
    description: "Selected tool", inputSchema: { type: "object", properties: {} }, execute }] });
  const selected = registry.tools.find(tool => tool.name === "Selected");
  const prepareArguments = vi.fn((args, tool) => {
    expect(tool).toBe(selected);
    return { ...args, projected: tool.name };
  });
  const result = await registry.dispatch({ id: "chosen", name: "Selected", arguments: "{}" }, { prepareArguments });
  expect(result.content).toBe("Selected");
  expect(prepareArguments).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  await registry.dispatch({ id: "missing", name: "not-registered", arguments: "{}" }, { prepareArguments });
  expect(prepareArguments).toHaveBeenCalledOnce();
});
