import { describe, expect, test } from "vitest";

import { swarmCommand } from "../../src/commands/swarm.js";
import {
  claimRequiredSwarmToolChoice,
  swarmModeProducer,
} from "../../src/prompts/attachments/swarm-mode.js";
import { routeSwarmTask } from "../../src/agents/swarm-routing.js";
import { getDefaultAppState } from "../../src/tui/state/AppStateStore.js";
import {
  getSettingsForSource,
  updateSettingsForSource,
} from "../../src/utils/settings/settings.js";

function makeCtx(argsRaw: string) {
  const appState = {
    state: { swarmMode: false as boolean | undefined },
    getAppState() {
      return this.state;
    },
    setAppState(updater: (prev: unknown) => unknown) {
      this.state = updater(this.state) as typeof this.state;
    },
  };
  return { argsRaw, appState } as never;
}

function makeProducerOpts(
  turnId: string,
  rootHumanInput: string | null,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    subagentDepth: 0,
    userInput: rootHumanInput,
    loadedTools: [],
    permissionContext: { mode: "default" },
    turnProvenance: {
      turnId,
      rootHumanTurn:
        rootHumanInput === null
          ? null
          : { turnId, text: rootHumanInput },
    },
    ...overrides,
  } as never;
}

describe("/swarm command", () => {
  test("status reports the current mode and usage hint", async () => {
    updateSettingsForSource("userSettings", { swarmMode: undefined });
    const result = (await swarmCommand.execute(makeCtx("status"))) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(result.text).toContain("swarm mode: off");
    expect(result.text).toContain("/swarm on");
  });

  test("on enables swarm mode in settings and AppState", async () => {
    const ctx = makeCtx("on") as {
      appState: { state: { swarmMode?: boolean } };
    };
    const result = (await swarmCommand.execute(ctx as never)) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(ctx.appState.state.swarmMode).toBe(true);
    expect(getSettingsForSource("userSettings")?.swarmMode).toBe(true);
  });

  test("a fresh TUI restores persisted swarm mode immediately", () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    expect(getDefaultAppState().swarmMode).toBe(true);
  });

  test("off disables swarm mode again", async () => {
    const ctx = makeCtx("off") as {
      appState: { state: { swarmMode?: boolean } };
    };
    const result = (await swarmCommand.execute(ctx as never)) as {
      kind: string;
      text: string;
    };
    expect(result.kind).toBe("text");
    expect(ctx.appState.state.swarmMode).toBe(false);
    expect(getSettingsForSource("userSettings")?.swarmMode).toBe(false);
  });

  test("rejects unknown arguments", async () => {
    const result = (await swarmCommand.execute(makeCtx("maybe"))) as {
      kind: string;
      message: string;
    };
    expect(result.kind).toBe("error");
    expect(result.message).toContain("Usage");
  });
});

describe("swarmModeProducer", () => {
  const spawnTool = {
    type: "function",
    function: {
      name: "spawn_agent",
      description: "Spawn a bounded worker",
      parameters: { type: "object" },
    },
  };
  const opts = makeProducerOpts(
    "turn-parallel",
    "Parallelize these independent checks:\n- API\n- TUI",
  );
  const childOpts = makeProducerOpts("turn-child", "Parallelize this", {
    subagentDepth: 1,
  });

  test("emits the parallel fan-out nudge while swarm mode is on", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    const attachments = await swarmModeProducer(
      makeProducerOpts(
        "turn-parallel",
        "Parallelize these independent checks:\n- API\n- TUI",
        { loadedTools: [spawnTool] },
      ),
      {} as never,
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: "critical_system_reminder",
    });
    expect((attachments[0] as { content?: string }).content ?? "").toContain(
      "Swarm mode is active",
    );
    expect((attachments[0] as { content?: string }).content ?? "").toContain(
      "Call `spawn_agent` now",
    );
    expect((attachments[0] as { content?: string }).content ?? "").toContain(
      "Do not merely describe or promise fan-out",
    );
  });

  test("emits nothing when swarm mode is off", async () => {
    updateSettingsForSource("userSettings", { swarmMode: false });
    expect(await swarmModeProducer(opts, {} as never)).toEqual([]);
  });

  test("emits nothing on swarm children (no recursive fan-out)", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    expect(await swarmModeProducer(childOpts, {} as never)).toEqual([]);
  });

  test("renders an adaptive routing receipt without copying prompt content", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    const tracking = { swarmRoutingDecisionCount: 0 } as never;
    const attachments = await swarmModeProducer(
      makeProducerOpts(
        "turn-receipt",
        "Implement these independent items:\n1. API parser\n2. TUI panel\n3. docs\n4. regression tests",
      ),
      tracking,
    );
    const content = (attachments[0] as { content: string }).content;
    expect(content).toContain('"policy_version":"agenc.swarm.route.v2"');
    expect(content).toContain('"mode":"parallel"');
    expect(content).toContain(
      '"delegation_enforcement":"require_initial_spawn"',
    );
    expect(content).toContain('"recommended_max_agents":4');
    expect(content).toContain('"recommended_isolation":"worktree"');
    expect(content).toMatch(/"input_fingerprint":"sha256:[a-f0-9]{64}"/u);
    expect(content).not.toContain("API parser");
    expect(
      (tracking as { swarmRoutingDecisionCount: number })
        .swarmRoutingDecisionCount,
    ).toBe(1);
  });

  test("routes synthetic and stale-turn follow-ups as coordination", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    const staleParallelPrompt =
      "Parallelize these independent checks:\n- API\n- TUI";

    const synthetic = await swarmModeProducer(
      makeProducerOpts("turn-internal", null, {
        userInput: staleParallelPrompt,
      }),
      { swarmRoutingDecisionCount: 0 } as never,
    );
    const syntheticContent = (synthetic[0] as { content: string }).content;
    expect(syntheticContent).toContain('"mode":"coordinate"');
    expect(syntheticContent).toContain('"recommended_max_agents":0');

    const stale = await swarmModeProducer(
      {
        subagentDepth: 0,
        userInput: staleParallelPrompt,
        loadedTools: [],
        permissionContext: { mode: "default" },
        turnProvenance: {
          turnId: "turn-current",
          rootHumanTurn: {
            turnId: "turn-prior",
            text: staleParallelPrompt,
          },
        },
      } as never,
      { swarmRoutingDecisionCount: 0 } as never,
    );
    expect((stale[0] as { content: string }).content).toContain(
      '"mode":"coordinate"',
    );
  });

  test("emits at most once per exact turn but emits again for a new turn", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    const tracking = { swarmRoutingDecisionCount: 0 } as never;
    const sameTask =
      "Parallelize these independent checks:\n- API\n- TUI";

    expect(
      await swarmModeProducer(
        makeProducerOpts("turn-first", sameTask),
        tracking,
      ),
    ).toHaveLength(1);
    expect(
      await swarmModeProducer(
        makeProducerOpts("turn-first", sameTask),
        tracking,
      ),
    ).toEqual([]);
    expect(
      await swarmModeProducer(
        makeProducerOpts("turn-second", sameTask),
        tracking,
      ),
    ).toHaveLength(1);
    expect(
      (tracking as { swarmRoutingDecisionCount: number })
        .swarmRoutingDecisionCount,
    ).toBe(2);
  });

  test("records the exact routing decision used by provider enforcement", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    const tracking = { swarmRoutingDecisionCount: 0 } as never;
    await swarmModeProducer(
      makeProducerOpts(
        "turn-enforced",
        "Review these areas:\n- API behavior\n- TUI behavior",
        { loadedTools: [spawnTool] },
      ),
      tracking,
    );

    expect(tracking).toMatchObject({
      lastSwarmRoutingTurnId: "turn-enforced",
      lastSwarmRoutingDecision: {
        mode: "parallel",
        delegationEnforcement: "require_initial_spawn",
      },
    });
  });

  test("reports a missing spawn tool instead of pretending fan-out happened", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    const attachments = await swarmModeProducer(opts, {
      swarmRoutingDecisionCount: 0,
    } as never);
    const content = (attachments[0] as { content: string }).content;
    expect(content).toContain("`spawn_agent` is not available");
    expect(content).toContain("Do not claim that workers were launched");
  });

  test("keeps plan mode non-mutating while preserving the parallel decision", async () => {
    updateSettingsForSource("userSettings", { swarmMode: true });
    const attachments = await swarmModeProducer(
      makeProducerOpts(
        "turn-plan",
        "Review these areas:\n- API behavior\n- TUI behavior",
        {
          loadedTools: [spawnTool],
          permissionContext: { mode: "plan" },
        },
      ),
      { swarmRoutingDecisionCount: 0 } as never,
    );
    const content = (attachments[0] as { content: string }).content;
    expect(content).toContain('"mode":"parallel"');
    expect(content).toContain("do not spawn workers until execution mode resumes");
  });
});

describe("routeSwarmTask", () => {
  test("keeps a coupled single issue sequential", () => {
    expect(
      routeSwarmTask(
        "Parallelize the investigation, but fix this single tightly coupled parser issue in one file",
      ),
    ).toMatchObject({
      mode: "sequential",
      maxAgents: 1,
      isolation: "none",
      signals: expect.arrayContaining([
        "explicit_parallelism",
        "shared_state_coupling",
      ]),
    });
  });

  test("recommends two isolated workers for high-risk parallel changes", () => {
    expect(
      routeSwarmTask(
        "Parallelize these independent security changes:\n- authentication audit\n- wallet signing audit\n- release configuration audit\n- database schema audit",
      ),
    ).toMatchObject({
      mode: "parallel",
      maxAgents: 2,
      isolation: "worktree",
      integration: "verify_then_integrate",
    });
  });

  test("uses completion turns for coordination rather than recursive fan-out", () => {
    expect(routeSwarmTask(null)).toMatchObject({
      mode: "coordinate",
      maxAgents: 0,
      integration: "continue_coordination",
    });
  });

  test("explicit no-delegation language overrides parallel evidence", () => {
    const decision = routeSwarmTask(
      "Parallelize these independent items but do not use sub-agents:\n- API audit\n- TUI audit\n- docs audit\n- test audit",
    );
    expect(decision).toMatchObject({
      mode: "sequential",
      maxAgents: 1,
      isolation: "none",
      signals: expect.arrayContaining([
        "explicit_no_delegation",
        "explicit_parallelism",
        "explicit_independence",
        "independent_list",
      ]),
    });
  });

  test.each([
    "Do not parallelize this and do not use multiple agents",
    "Do not use agents for this task",
    "Use no sub-agents",
    "Work alone; never delegate",
    "Handle this yourself without sub-agents",
  ])("keeps explicit user opt-out sequential: %s", (prompt) => {
    expect(routeSwarmTask(prompt)).toMatchObject({
      mode: "sequential",
      maxAgents: 1,
      isolation: "none",
      signals: expect.arrayContaining(["explicit_no_delegation"]),
    });
  });

  test.each([
    "No agents are running yet. Parallelize these independent checks:\n- API behavior\n- TUI behavior",
    "Do not delegate trivial lookups; parallelize these independent tasks:\n- API behavior\n- TUI behavior",
  ])(
    "does not mistake descriptive or scoped constraints for a task-wide opt-out: %s",
    (prompt) => {
      const decision = routeSwarmTask(prompt);
      expect(decision).toMatchObject({
        mode: "parallel",
        maxAgents: 2,
        signals: expect.arrayContaining([
          "explicit_parallelism",
          "explicit_independence",
          "independent_list",
        ]),
      });
      expect(decision.signals).not.toContain("explicit_no_delegation");
    },
  );

  test.each(["not independent", "not disjoint", "not decomposable"])(
    "does not treat '%s' as positive independence evidence",
    (negatedDescription) => {
      const decision = routeSwarmTask(
        `These tasks are ${negatedDescription}:\n` +
          "- reproduce the parser bug\n" +
          "- implement the fix\n" +
          "- run its regression test",
      );
      expect(decision).toMatchObject({
        mode: "sequential",
        maxAgents: 1,
        signals: expect.arrayContaining(["independent_list"]),
      });
      expect(decision.signals).not.toContain("explicit_independence");
    },
  );

  test("preserves an explicit parallel instruction when independence is negated", () => {
    const decision = routeSwarmTask(
      "Parallelize these checks even though they are not independent:\n- API behavior\n- TUI behavior",
    );
    expect(decision).toMatchObject({
      mode: "parallel",
      maxAgents: 2,
      signals: expect.arrayContaining([
        "explicit_parallelism",
        "independent_list",
      ]),
    });
    expect(decision.signals).not.toContain("explicit_independence");
    expect(decision.signals).not.toContain("explicit_no_delegation");
  });

  test.each([
    "Explain how swarm mode works",
    "Document parallelism behavior",
    "Review the multiple agents section of the manual",
  ])("does not treat a descriptive parallelism noun as fan-out intent: %s", (prompt) => {
    const decision = routeSwarmTask(prompt);
    expect(decision).toMatchObject({
      mode: "sequential",
      maxAgents: 1,
    });
    expect(decision.signals).not.toContain("explicit_parallelism");
  });

  test.each([
    "Use a swarm to investigate API behavior",
    "Concurrently investigate API and TUI behavior",
    "Do these API and TUI investigations in parallel",
  ])("retains intent-bearing parallel language: %s", (prompt) => {
    expect(routeSwarmTask(prompt)).toMatchObject({
      mode: "parallel",
      maxAgents: 2,
      signals: expect.arrayContaining(["explicit_parallelism"]),
    });
  });

  test("does not mistake an ordered implementation checklist for independent work", () => {
    expect(
      routeSwarmTask(
        "Fix the parser:\n1. Reproduce the failure\n2. Implement the fix\n3. Run the regression tests",
      ),
    ).toMatchObject({
      mode: "sequential",
      maxAgents: 1,
      signals: expect.arrayContaining(["independent_list"]),
    });
  });

  test("routes a multi-domain review list in parallel without magic wording", () => {
    expect(
      routeSwarmTask(
        "Review these areas:\n- API behavior\n- TUI behavior",
      ),
    ).toMatchObject({
      policyVersion: "agenc.swarm.route.v2",
      mode: "parallel",
      delegationEnforcement: "require_initial_spawn",
      maxAgents: 2,
      signals: expect.arrayContaining([
        "independent_list",
        "multi_domain_analysis",
      ]),
    });
  });

  test("fingerprints exact policy-relevant layout rather than collapsed text", () => {
    const listed = routeSwarmTask(
      "Research these independent items:\n- API behavior\n- TUI behavior",
    );
    const inline = routeSwarmTask(
      "Research these independent items: - API behavior - TUI behavior",
    );

    expect(listed.mode).toBe("parallel");
    expect(inline.mode).toBe("sequential");
    expect(listed.inputFingerprint).not.toBe(inline.inputFingerprint);
  });
});

describe("claimRequiredSwarmToolChoice", () => {
  function parallelTracking() {
    return {
      swarmRoutingDecisionCount: 1,
      lastSwarmRoutingTurnId: "turn-parallel",
      lastSwarmRoutingDecision: routeSwarmTask(
        "Review these areas:\n- API behavior\n- TUI behavior",
      ),
    };
  }

  test("force-selects spawn_agent exactly once for an exact parallel root turn", () => {
    const trackingState = parallelTracking();
    const options = {
      trackingState,
      turnId: "turn-parallel",
      subagentDepth: 0,
      planMode: false,
      toolNames: ["FileRead", "spawn_agent"],
    };

    expect(claimRequiredSwarmToolChoice(options)).toEqual({
      type: "function",
      name: "spawn_agent",
    });
    expect(claimRequiredSwarmToolChoice(options)).toBeUndefined();
    expect(trackingState.lastSwarmSpawnToolChoiceTurnId).toBe(
      "turn-parallel",
    );
  });

  test.each([
    {
      label: "sequential route",
      mutate: (tracking: ReturnType<typeof parallelTracking>) => {
        tracking.lastSwarmRoutingDecision = routeSwarmTask("Fix this one file");
      },
      overrides: {},
    },
    {
      label: "different turn",
      mutate: () => {},
      overrides: { turnId: "turn-other" },
    },
    {
      label: "child agent",
      mutate: () => {},
      overrides: { subagentDepth: 1 },
    },
    {
      label: "plan mode",
      mutate: () => {},
      overrides: { planMode: true },
    },
    {
      label: "missing tool",
      mutate: () => {},
      overrides: { toolNames: ["FileRead"] },
    },
  ])("does not force a spawn for $label", ({ mutate, overrides }) => {
    const trackingState = parallelTracking();
    mutate(trackingState);
    expect(
      claimRequiredSwarmToolChoice({
        trackingState,
        turnId: "turn-parallel",
        subagentDepth: 0,
        planMode: false,
        toolNames: ["spawn_agent"],
        ...overrides,
      }),
    ).toBeUndefined();
    expect(trackingState.lastSwarmSpawnToolChoiceTurnId).toBeUndefined();
  });

  test("plan mode does not consume the later execution-mode claim", () => {
    const trackingState = parallelTracking();
    expect(
      claimRequiredSwarmToolChoice({
        trackingState,
        turnId: "turn-parallel",
        subagentDepth: 0,
        planMode: true,
        toolNames: ["spawn_agent"],
      }),
    ).toBeUndefined();
    expect(
      claimRequiredSwarmToolChoice({
        trackingState,
        turnId: "turn-parallel",
        subagentDepth: 0,
        planMode: false,
        toolNames: ["spawn_agent"],
      }),
    ).toEqual({ type: "function", name: "spawn_agent" });
  });
});
