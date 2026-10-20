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
 * decision. The turn-stop text says what the sandbox did first: refused the
 * call before it ran (the runtime gate; nothing changed), or blocked it
 * from inside a call that had started (its effect records stay, and nothing
 * may claim the denied call never ran).
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

/**
 * One turn that calls `write_notes` with `filePath`; the permission mode
 * allows the call, so on_failure runs it in the sandbox first and asks only
 * when the sandbox blocks it. The person denies running it without the
 * sandbox.
 */
async function deniedRetry(filePath: string, execute: Tool["execute"]) {
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
    toolCalls: [{ id: "retry-call", name: "write_notes", arguments: JSON.stringify({ file_path: filePath }) }],
    finishReason: "tool_calls",
  });
  const request = vi.fn(async () => ({ kind: "denied" as const, decidedBy: "user" as const }));
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
  try {
    await drain(runTurn(session, mkCtx({ approvalPolicy: { value: "on_failure" }, sandboxPolicy: { value: "workspace_write" } }), "Write the notes."));
    const journal = readFileSync(store.rolloutPath, "utf8").trim().split("\n").map((line) => parseRolloutLine(line)!).filter(Boolean)
      .flatMap((item) => item.type === "event_msg" ? [item.payload.msg] : []);
    const effects = journal.filter((msg) => /^effect_/u.test(msg.type) && JSON.stringify(msg.payload).includes("retry-call"));
    const closure = events.find((event) => event.msg.type === "tool_call_completed" && event.msg.payload.callId === "retry-call");
    const terminals = events.flatMap((event) => {
      const terminal = classifyTurnTerminal(event.msg);
      return terminal === undefined ? [] : [terminal];
    });
    const explanation = String(session.snapshotHistoryMessages().at(-1)?.content);
    return { request, effects, closure, terminals, explanation };
  } finally {
    session.mountRolloutStore(null);
    store.close();
    await session.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
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
    // The runtime sandbox admits /tmp, so the call starts and is blocked from
    // inside, the way an OS sandbox refusal reaches a running tool.
    const { request, effects, closure, terminals, explanation } = await deniedRetry("/tmp/notes.txt", execute);

    // The sandboxed attempt ran; only the unsandboxed retry was asked for.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    // The sandboxed attempt's effect records survive the denied retry, and
    // nothing records the call as having had no effect.
    expect(effects.map((msg) => msg.type)).toEqual(expect.arrayContaining(["effect_intent", "effect_result"]));
    expect(JSON.stringify(effects)).not.toContain("confirmed_no_effect");

    expect(closure?.msg).toMatchObject({ payload: { isError: true, metadata: {
      approvalDenied: true, approvalDeniedStage: "sandbox_escalation", approvalDeniedSandboxRefusal: "while_running",
    } } });
    expect(terminals).toEqual([expect.objectContaining({ outcome: "aborted", message: "approval_denied" })]);
    expect(explanation).toMatch(/already ran once inside the sandbox/u);
    expect(explanation).not.toMatch(/without running/u);
    expect(explanation).not.toMatch(/before it ran/u);
  });

  test("says the sandbox refused the call before it ran when the runtime sandbox refused it", async () => {
    const execute = vi.fn(async () => ({ content: "unexpected run" }));
    // Outside the workspace, the session temp root and /tmp: the runtime
    // sandbox refuses the write before the tool starts.
    const outside = join("/", `agenc-denied-retry-outside-${process.pid}`, "notes.txt");
    const { request, effects, closure, terminals, explanation } = await deniedRetry(outside, execute);

    // Nothing ran; only the run without the sandbox was asked for.
    expect(execute).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      runsWithoutSandbox: true,
      retryReason: expect.stringContaining(`blocked write outside workspace: ${outside}`),
    }));
    // The refused attempt is recorded as not having crossed the effect boundary.
    expect(effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "effect_result", payload: expect.objectContaining({ effectBoundary: "not_crossed" }) }),
    ]));

    expect(closure?.msg).toMatchObject({ payload: { isError: true, metadata: {
      approvalDenied: true, approvalDeniedStage: "sandbox_escalation", approvalDeniedSandboxRefusal: "before_running",
    } } });
    expect(terminals).toEqual([expect.objectContaining({ outcome: "aborted", message: "approval_denied" })]);
    expect(explanation).toMatch(
      /^Approval was denied to run write_notes without the sandbox\. The sandbox refused write_notes before it ran, so it changed nothing, and the turn stopped without running it outside the sandbox\./u,
    );
    expect(explanation).not.toMatch(/already ran once/u);
    expect(explanation).not.toMatch(/again without the sandbox/u);
  });
});
