import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner.js";
import { parseRolloutLine, type RolloutItem } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

/**
 * A reopened session must still say what the user denied. The transcript
 * rebuilt from the durable journal carries an approval_denied notice naming
 * the call and the bounded input that identifies it, never the full input.
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

describe("session.transcript.v2 approval denial", () => {
  it("names the denied call and its target from the durable journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agenc-v2-denied-"));
    const execute = vi.fn(async () => ({ content: "must not run" }));
    const tool = { name: "Write", description: "Write a file", inputSchema: { type: "object" }, requiresApproval: true, execute } as unknown as Tool;
    const args = { file_path: "/work/outside/notes.txt", content: "x".repeat(5_000) };
    const provider = mkProvider({
      content: "Writing the notes.",
      toolCalls: [{ id: "denied-write", name: "Write", arguments: JSON.stringify(args) }],
      finishReason: "tool_calls",
    });
    const { session } = mkSession({
      cwd: directory, provider, registry: registryFor(tool),
      services: { approvalResolver: { request: async () => ({ kind: "denied" as const, decidedBy: "user" as const }) } },
    });
    const store = new RolloutStore({
      cwd: directory, sessionId: session.conversationId, agencHome: join(directory, "home"),
      sessionTempRoot: join(directory, "scratch"), agencVersion: "0.17.0", autoStartScheduler: false,
    });
    store.open({ sessionId: session.conversationId, timestamp: new Date().toISOString(), cwd: directory, originator: "v2-denied-test", agencVersion: "0.17.0", model: "test-model", modelProvider: "test" });
    session.mountRolloutStore(store);
    try {
      await drain(runTurn(session, mkCtx({ subId: "turn-denied", approvalPolicy: { value: "on_request" }, sandboxPolicy: { value: "workspace_write" } }), "Write the notes."));
      const items: RolloutItem[] = readFileSync(store.rolloutPath, "utf8").trim().split("\n").map((line) => parseRolloutLine(line)!).filter(Boolean);

      const snapshot = sessionTranscriptV2FromRollout(items, session.conversationId, session.conversationId);

      const denials = (snapshot.events ?? []).filter((event) => event.type === "approval_denied");
      expect(denials).toEqual([expect.objectContaining({
        type: "approval_denied",
        payload: {
          turnId: "turn-denied",
          callId: "denied-write",
          toolName: "Write",
          input: { file_path: "/work/outside/notes.txt" },
          stage: "before_execution",
        },
      })]);
      expect(denials[0]!.committedSequence).toBeGreaterThan(0);
      expect(JSON.stringify(denials)).not.toContain("xxxxx");
      expect(snapshot.turnResults).toEqual([expect.objectContaining({ turnId: "turn-denied", outcome: "aborted" })]);
    } finally {
      session.mountRolloutStore(null);
      store.close();
      await session.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
