import { describe, expect, test } from "vitest";

import { dispatchSlashCommand, parseSlashCommand } from "../../src/commands/dispatcher.js";
import { CommandRegistry } from "../../src/commands/registry.js";
import { swarmCommand } from "../../src/commands/swarm.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import type { TaskState } from "../../src/tasks/types.js";
import { syncCollabAgentEventToAppState } from "../../src/tui/state/collabAgentTaskSync.js";

function fixture() {
  let state: { swarmMode: boolean; tasks: Record<string, TaskState> } = {
    swarmMode: true,
    tasks: {},
  };
  const registry = new CommandRegistry();
  registry.register(swarmCommand);
  const ctx = {
    appState: { getAppState: () => state },
  } as SlashCommandContext;
  const emit = (event: unknown) => syncCollabAgentEventToAppState(
    event,
    (update) => { state = update(state) as typeof state; },
  );
  const spawn = (id: string) => emit({
    type: "collab_agent_spawn_end",
    payload: { newThreadId: id, status: { status: "pending_init" } },
  });
  const status = (id: string, value: string) => emit({
    type: "collab_agent_status",
    payload: { threadId: id, status: { status: value } },
  });
  const report = async (command = "/swarm status") => {
    const outcome = await dispatchSlashCommand(parseSlashCommand(command)!, ctx, registry);
    expect(outcome.immediate).toBe(true);
    expect(outcome.result.kind).toBe("text");
    if (outcome.result.kind !== "text") throw new Error("Expected swarm status text");
    return outcome.result.text;
  };
  return { emit, spawn, status, report };
}

describe("swarm status from daemon collaboration events", () => {
  test.each(["/swarm", "/swarm status"])("%s counts completed workers from the real task projection", async (command) => {
    const f = fixture();
    for (const id of ["backend", "frontend", "tests_docs"]) f.spawn(id);
    expect(await f.report(command)).toContain("agents: 3 active,");
    for (const id of ["backend", "frontend", "tests_docs"]) f.status(id, "idle");
    expect(await f.report(command)).toContain("agents: 0 active, 3 completed, 0 failed, 0 killed");
  });

  test("keeps completed results separate from worker reuse eligibility after shutdown", async () => {
    const f = fixture();
    f.spawn("finished");
    f.status("finished", "idle");
    f.status("finished", "shutdown");
    f.spawn("failed");
    f.status("failed", "errored");
    f.spawn("stopped");
    f.status("stopped", "shutdown");
    const report = await f.report();
    expect(report).toContain("agents: 0 active, 1 completed, 1 failed, 1 killed");
    expect(report).not.toContain("idle/reusable");
  });

  test("counts a reused worker as active and returns it to completed after its next task", async () => {
    const f = fixture();
    f.spawn("tests_docs");
    f.status("tests_docs", "idle");
    f.emit({ type: "collab_agent_interaction_begin", payload: { receiverThreadId: "tests_docs" } });
    expect(await f.report()).toContain("agents: 1 active, 0 completed, 0 failed, 0 killed");
    f.emit({
      type: "collab_waiting_end",
      payload: { agentStatuses: [{ threadId: "tests_docs", status: { status: "completed" } }] },
    });
    expect(await f.report()).toContain("agents: 0 active, 1 completed, 0 failed, 0 killed");
  });
});
