import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { runTurn } from "../../src/session/run-turn.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

test("fast shell receives the same bypass context for loops and workspace removal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fast-shell-context-"));
  try {
    const run = async (fast: boolean) => {
      await writeFile(join(cwd, "disposable.txt"), "owned test fixture");
      const registry = buildToolRegistry({ workspaceRoot: cwd, lightMode: true, requireAdmission: false,
        sandboxExecutionBroker: explicitDangerBroker });
      const provider = mkProvider();
      const commands = ["for x in one two; do printf '%s\\n' \"$x\"; done", "rm disposable.txt"];
      let count = 0;
      const results: string[] = [];
      provider.chatStream = async messages => {
        if (count > 0) results.push(String(messages.find(message => message.toolCallId === String(count))?.content));
        const cmd = commands[count++];
        return { content: cmd ? "" : "done", toolCalls: cmd ? [{ id: String(count), name: "exec_command",
          arguments: JSON.stringify({ cmd, workdir: cwd }) }] : [], model: "test-model",
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }, finishReason: cmd ? "tool_calls" : "stop" };
      };
      const { session, events } = mkSession({ cwd, provider, registry, services: {
        sandboxExecutionBroker: explicitDangerBroker,
        runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
          dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }),
      } });
      Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
        ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
      }) });
      const ctx = mkCtx({ cwd, permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
        config: { ...mkCtx().config, bypassFastMode: fast } });
      await drain(runTurn(session, ctx, "Run a loop and remove the disposable test file.", { exactOutput: true }));
      expect(events.filter(event => event.msg.type === "tool_call_completed").map(event => event.msg))
        .not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ isError: true }) }));
      await expect(readFile(join(cwd, "disposable.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(results[0]).toContain("one\ntwo");
      return results;
    };
    const normal = await run(false);
    expect(await run(true)).toEqual(normal);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
