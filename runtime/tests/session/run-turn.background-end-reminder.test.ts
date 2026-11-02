import { afterEach, describe, expect, test } from "vitest";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

// A background session that ends while no exec-family result follows (the
// model ended its turn, or kept to other tools) is reported once at the start
// of the next turn of its conversation, as a runtime-only reminder.

const managers: UnifiedExecProcessManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll("test_cleanup")));
});

function exercise() {
  const requests: LLMMessage[][] = [];
  const provider = mkProvider();
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    requests.push(messages.map((message) => ({ ...message })));
    return {
      content: "Done.",
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
      model: "test-model",
      finishReason: "stop",
    };
  };
  const registry = {
    tools: [],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  } as unknown as ToolRegistry;
  const manager = new UnifiedExecProcessManager();
  managers.push(manager);
  const runtimeOptions = resolveAgentRuntimeOptions({}, { nonInteractive: true });
  const { session, state } = mkSession({ provider, registry, services: { runtimeOptions, unifiedExecManager: manager } });
  return { session, state, manager, requests };
}

async function turn(session: ReturnType<typeof mkSession>["session"], prompt: string): Promise<void> {
  for await (const _phase of runTurn(session, mkCtx(), prompt)) {
    // drain
  }
}

const text = (messages: readonly LLMMessage[]): string => JSON.stringify(messages);

describe("background session end at turn start", () => {
  test("reports a session that ended after the last exec result once, at the next turn start", async () => {
    const { session, state, manager, requests } = exercise();
    // A build the model left running in the background when its turn ended.
    const started = await manager.execCommand({
      cmd: "sleep 0.3; exit 4", yield_time_ms: 250, ownerId: session.conversationId,
    });
    expect(started.session_id).toEqual(expect.any(Number));
    await expect.poll(() => manager.listOwnedProcesses({ ownerId: session.conversationId })[0]?.status, { timeout: 10_000 })
      .toBe("failed");
    // Another conversation's session never reaches this one.
    const foreign = await manager.execCommand({ cmd: "sleep 0.3", yield_time_ms: 250, ownerId: "another-conversation" });
    expect(foreign.session_id).toEqual(expect.any(Number));
    await expect.poll(() => manager.listOwnedProcesses({ ownerId: "another-conversation" })[0]?.status, { timeout: 10_000 })
      .toBe("completed");

    await turn(session, "is the build done?");
    const first = text(requests[0]!);
    expect(first).toContain("<system-reminder>");
    expect(first).toMatch(new RegExp(
      `\\[session ${started.session_id} ended after \\d+s: exit 4 \\(\`sleep 0\\.3; exit 4\`\\)\\. write_stdin session_id=${started.session_id} returns its remaining output\\.\\]`,
    ));
    expect(first).not.toContain(`session ${foreign.session_id} ended`);
    // Runtime-only: the saved history never carries it.
    expect(text(state.history)).not.toContain("ended after");

    // Reported once: the next turn and the next exec result do not repeat it.
    await turn(session, "and now?");
    expect(text(requests.at(-1)!)).not.toContain("ended after");
    expect(manager.takeSessionEndNotices({ ownerId: session.conversationId })).toEqual([]);
    // The other conversation's notice is still waiting for its owner.
    expect(manager.takeSessionEndNotices({ ownerId: "another-conversation" })).toHaveLength(1);
  });
});
