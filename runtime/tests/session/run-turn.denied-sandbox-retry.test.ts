import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { SandboxDeniedError } from "../../src/permissions/sandbox.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { parseRolloutLine } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

/**
 * Under on_failure the sandboxed attempt runs first and approval is asked
 * only for the unsandboxed retry. Denying that retry is still the user's
 * decision, but the call did run once: its effect records stay, and nothing
 * may claim the denied call never ran.
 */

function registryFor(tool: Tool): ToolRegistry {
  return {
    tools: [tool],
    toLLMTools: () => [{
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }],
    dispatch: async () => ({ content: "unexpected legacy dispatch", isError: true }),
  } as ToolRegistry;
}

describe("a denied unsandboxed retry", () => {
  test("keeps the sandboxed attempt's effect records and says the call already ran once", async () => {
    const execute = vi.fn(async () => {
      throw new SandboxDeniedError("sandbox workspace_write blocked write outside workspace: /outside/notes.txt", {
        denial: "filesystem",
        target: "/outside/notes.txt",
        policy: { kind: "workspace_write", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
      });
    });
    const tool = {
      name: "write_notes",
      description: "Write the notes",
      inputSchema: { type: "object" },
      recoveryCategory: "side-effecting",
      defaultPermissionMode: "on-failure",
      execute,
    } as unknown as Tool;
    const provider = mkProvider({
      content: "Writing the notes.",
      toolCalls: [{ id: "retry-call", name: "write_notes", arguments: JSON.stringify({ file_path: "/tmp/notes.txt" }) }],
      finishReason: "tool_calls",
    });
    const request = vi.fn(async () => ({ kind: "denied" as const, decidedBy: "user" as const }));
    // The permission mode already allows the call, so on_failure runs it in
    // the sandbox first and asks only when the sandbox blocks it.
    const permissionModeRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ alwaysAllowRules: { session: ["write_notes"] } }),
    );
    const directory = mkdtempSync(join(tmpdir(), "agenc-denied-retry-"));
    const { session, events } = mkSession({ cwd: directory, provider, registry: registryFor(tool), services: { approvalResolver: { request }, permissionModeRegistry } });
    const store = new RolloutStore({
      cwd: directory, sessionId: session.conversationId, agencHome: join(directory, "home"),
      sessionTempRoot: join(directory, "scratch"), agencVersion: "0.17.0", autoStartScheduler: false,
    });
    store.open({ sessionId: session.conversationId, timestamp: new Date().toISOString(), cwd: directory, originator: "denied-retry-test", agencVersion: "0.17.0", model: "test-model", modelProvider: "test" });
    session.mountRolloutStore(store);
    const journal = () => readFileSync(store.rolloutPath, "utf8").trim().split("\n").map((line) => parseRolloutLine(line)!).filter(Boolean)
      .flatMap((item) => item.type === "event_msg" ? [item.payload.msg] : []);
    try {

    await drain(runTurn(session, mkCtx({ approvalPolicy: { value: "on_failure" }, sandboxPolicy: { value: "workspace_write" } }), "Write the notes."));

    // The sandboxed attempt ran; only the unsandboxed retry was asked for.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    // The sandboxed attempt's effect records survive the denied retry, and
    // nothing records the call as having had no effect.
    const effects = journal().filter((msg) => /^effect_/u.test(msg.type));
    const attemptEffects = effects.filter((msg) => JSON.stringify(msg.payload).includes("retry-call"));
    expect(attemptEffects.map((msg) => msg.type)).toEqual(expect.arrayContaining(["effect_intent", "effect_result"]));
    expect(JSON.stringify(effects)).not.toContain("confirmed_no_effect");

    const closure = events.find((event) => event.msg.type === "tool_call_completed" && event.msg.payload.callId === "retry-call");
    expect(closure?.msg).toMatchObject({ payload: { isError: true, metadata: { approvalDenied: true, approvalDeniedStage: "sandbox_escalation" } } });
    expect(events.flatMap((event) => {
      const terminal = classifyTurnTerminal(event.msg);
      return terminal === undefined ? [] : [terminal];
    })).toEqual([expect.objectContaining({ outcome: "aborted", message: "approval_denied" })]);
    const explanation = String(session.snapshotHistoryMessages().at(-1)?.content);
    expect(explanation).toMatch(/already ran once inside the sandbox/u);
    expect(explanation).not.toMatch(/without running/u);
    } finally {
      session.mountRolloutStore(null);
      store.close();
      await session.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
