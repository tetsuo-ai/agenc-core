/**
 * agent.create `toolPolicy` in the lifecycle: it reaches the runner, is
 * persisted with the run, is the one a resume keeps, and a frozen session
 * refuses every route to a wider permission mode.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AgenCDaemonAgentLifecycleError,
  AgenCDaemonAgentManager,
  resolveCreateToolPolicy,
} from "../../src/app-server/agent-lifecycle.js";
import type {
  AgenCBackgroundAgentRunner,
  AgenCBackgroundAgentStartParams,
} from "../../src/app-server/background-agent-runner.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCStateAgentRunRecord } from "../../src/state/agent-runs.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import {
  normalizeSessionToolPolicy,
  TOOL_POLICY_METADATA_KEY,
  TOOL_POLICY_MODE_CEILING_METADATA_KEY,
} from "../../src/permissions/session-tool-policy.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

const POLICY = normalizeSessionToolPolicy({
  enabledTools: ["FileRead", "mcp.desktop.read_file"],
  frozenPermissionMode: true,
  deferMcpTools: false,
});
const UNFROZEN = normalizeSessionToolPolicy({ enabledTools: ["FileRead"] });

interface Harness {
  readonly agents: AgenCDaemonAgentManager;
  readonly started: AgenCBackgroundAgentStartParams[];
  readonly runs: AgenCStateAgentRunRecord[];
  readonly setAgentPermissionMode: ReturnType<typeof vi.fn>;
  readonly mutateAgentPermissionRule: ReturnType<typeof vi.fn>;
  readonly resolveToolDecision: ReturnType<typeof vi.fn>;
}

function harness(ceiling: "default" | "acceptEdits" | null = "default"): Harness {
  const started: AgenCBackgroundAgentStartParams[] = [];
  const runs: AgenCStateAgentRunRecord[] = [];
  const setAgentPermissionMode = vi.fn(async (_id: string, params: { mode: string }) => ({
    applied: true,
    previousMode: "default",
    mode: params.mode,
  }));
  const mutateAgentPermissionRule = vi.fn(async () => ({
    applied: true,
    operation: "add" as const,
    behavior: "deny" as const,
    rule: "Write",
    sessionRules: { allow: [], deny: ["Write"], ask: [] },
  }));
  const resolveToolDecision = vi.fn(async () => true);
  const runner: AgenCBackgroundAgentRunner = {
    startAgent: async (params) => {
      started.push(params);
      return {
        agentId: "agent-policy",
        startedAt: "2026-10-01T00:00:00.000Z",
        status: "running",
        ...(params.toolPolicy?.frozenPermissionMode === true && ceiling !== null
          ? { toolPolicyModeCeiling: ceiling }
          : {}),
      };
    },
    stopAgent: async () => {},
    setAgentPermissionMode: setAgentPermissionMode as never,
    mutateAgentPermissionRule: mutateAgentPermissionRule as never,
    resolveToolDecision: resolveToolDecision as never,
  };
  const agents = new AgenCDaemonAgentManager({
    sessionManager: new AgenCDaemonSessionManager({
      createSessionId: () => "session-policy",
      now: () => "2026-10-01T00:00:00.000Z",
    }),
    runner,
    recordAgentRun: (run) => {
      runs.push(run);
    },
  });
  return { agents, started, runs, setAgentPermissionMode, mutateAgentPermissionRule, resolveToolDecision };
}

async function create(h: Harness, toolPolicy?: typeof POLICY) {
  return h.agents.createAgent({
    cwd: process.cwd(),
    objective: "marketplace task",
    runtimeOptions: resolveAgentRuntimeOptions({}),
    ...(toolPolicy !== undefined ? { toolPolicy } : {}),
  });
}

describe("agent.create toolPolicy", () => {
  it("hands the policy to the runner and persists it with the run", async () => {
    const h = harness();
    await create(h, POLICY);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.toolPolicy).toEqual(POLICY);
    const stored = h.runs.at(-1)!.metadata as JsonObject;
    expect(stored[TOOL_POLICY_METADATA_KEY]).toEqual({
      enabledTools: ["FileRead", "mcp.desktop.read_file"],
      frozenPermissionMode: true,
      deferMcpTools: false,
    });
    // The ceiling the runner froze the mode at is persisted so a restore keeps it.
    expect(stored[TOOL_POLICY_MODE_CEILING_METADATA_KEY]).toBe("default");
  });

  it("leaves a session without a policy exactly as before", async () => {
    const h = harness();
    await create(h);
    expect(h.started[0]!.toolPolicy).toBeUndefined();
    const stored = h.runs.at(-1)!.metadata as JsonObject;
    expect(TOOL_POLICY_METADATA_KEY in stored).toBe(false);
    expect(TOOL_POLICY_MODE_CEILING_METADATA_KEY in stored).toBe(false);
    expect(h.agents.getSessionToolPolicy("session-policy")).toBeUndefined();
  });

  it("reports the policy by session id or agent id", async () => {
    const h = harness();
    const created = await create(h, POLICY);
    expect(h.agents.getSessionToolPolicy(created.sessionId!)).toEqual(POLICY);
    expect(h.agents.getSessionToolPolicy(created.agentId)).toEqual(POLICY);
    expect(h.agents.getSessionToolPolicy("someone-else")).toBeUndefined();
  });
});

describe("a resume keeps the policy the session was created with", () => {
  const stored: JsonObject = {
    [TOOL_POLICY_METADATA_KEY]: {
      enabledTools: ["FileRead", "mcp.desktop.read_file"],
      frozenPermissionMode: true,
      deferMcpTools: false,
    },
  };

  it("restores the stored policy when the request names none", () => {
    expect(resolveCreateToolPolicy(undefined, stored)).toEqual(POLICY);
  });

  it("accepts the same policy again, in any order", () => {
    const reordered = normalizeSessionToolPolicy({
      enabledTools: ["mcp.desktop.read_file", "FileRead"],
      frozenPermissionMode: true,
      deferMcpTools: false,
    });
    expect(resolveCreateToolPolicy(reordered, stored)).toEqual(POLICY);
  });

  it("refuses a different policy for the same session", () => {
    expect(() => resolveCreateToolPolicy(UNFROZEN, stored)).toThrow(AgenCDaemonAgentLifecycleError);
    expect(() =>
      resolveCreateToolPolicy(
        normalizeSessionToolPolicy({ enabledTools: ["FileRead", "mcp.desktop.read_file", "system.bash"], frozenPermissionMode: true, deferMcpTools: false }),
        stored,
      ),
    ).toThrow("differs from the policy this session was created with");
  });

  it("lets a resume restrict a session that had no policy", () => {
    expect(resolveCreateToolPolicy(UNFROZEN, {})).toEqual(UNFROZEN);
    expect(resolveCreateToolPolicy(undefined, undefined)).toBeUndefined();
  });

  it("fails closed on a stored policy it cannot read", () => {
    expect(() =>
      resolveCreateToolPolicy(undefined, { [TOOL_POLICY_METADATA_KEY]: { enabledTools: [] } }),
    ).toThrow(/retained invalid toolPolicy/);
  });
});

describe("a frozen permission mode", () => {
  async function frozen(): Promise<{ h: Harness; sessionId: string }> {
    const h = harness();
    const created = await create(h, POLICY);
    return { h, sessionId: created.sessionId! };
  }

  it("refuses allowAllToolsForSession before touching the mode or the request", async () => {
    const { h, sessionId } = await frozen();
    await expect(
      h.agents.approveTool({ sessionId, requestId: "r1", scope: "session", allowAllToolsForSession: true }),
    ).rejects.toThrow(/frozen by its toolPolicy/);
    expect(h.setAgentPermissionMode).not.toHaveBeenCalled();
    expect(h.resolveToolDecision).not.toHaveBeenCalled();
    // A plain approval of the pending request is still fine.
    await expect(
      h.agents.approveTool({ sessionId, requestId: "r1", scope: "once" }),
    ).resolves.toMatchObject({ decision: "approved" });
  });

  it.each(["bypassPermissions", "acceptEdits", "auto"])("refuses session.setPermissionMode to %s", async (mode) => {
    const { h, sessionId } = await frozen();
    await expect(h.agents.setSessionPermissionMode({ sessionId, mode })).rejects.toThrow(
      /frozen by this session's toolPolicy/,
    );
    expect(h.setAgentPermissionMode).not.toHaveBeenCalled();
  });

  it.each(["plan", "default", "dontAsk"])("still allows narrowing or keeping %s", async (mode) => {
    const { h, sessionId } = await frozen();
    await expect(h.agents.setSessionPermissionMode({ sessionId, mode })).resolves.toMatchObject({ mode });
    expect(h.setAgentPermissionMode).toHaveBeenCalledTimes(1);
  });

  it("holds a frozen session with no recorded ceiling to plan", async () => {
    const h = harness(null);
    const created = await create(h, POLICY);
    await expect(
      h.agents.setSessionPermissionMode({ sessionId: created.sessionId!, mode: "default" }),
    ).rejects.toThrow(/frozen/);
    await expect(
      h.agents.setSessionPermissionMode({ sessionId: created.sessionId!, mode: "plan" }),
    ).resolves.toMatchObject({ mode: "plan" });
  });

  it.each([
    ["add", "allow"],
    ["remove", "deny"],
    ["remove", "ask"],
  ] as const)("refuses a rule mutation that could widen access (%s %s)", async (operation, behavior) => {
    const { h, sessionId } = await frozen();
    await expect(
      h.agents.mutateSessionPermissionRule({ sessionId, operation, behavior, rule: "Write" }),
    ).rejects.toThrow(/frozen by its toolPolicy/);
    expect(h.mutateAgentPermissionRule).not.toHaveBeenCalled();
  });

  it.each([
    ["add", "deny"],
    ["add", "ask"],
    ["remove", "allow"],
  ] as const)("allows a rule mutation that only narrows access (%s %s)", async (operation, behavior) => {
    const { h, sessionId } = await frozen();
    await h.agents.mutateSessionPermissionRule({ sessionId, operation, behavior, rule: "Write" });
    expect(h.mutateAgentPermissionRule).toHaveBeenCalledTimes(1);
  });

  it("leaves a session with an unfrozen policy, or none, unchanged", async () => {
    for (const toolPolicy of [UNFROZEN, undefined]) {
      const h = harness();
      const created = await create(h, toolPolicy);
      const sessionId = created.sessionId!;
      await h.agents.setSessionPermissionMode({ sessionId, mode: "bypassPermissions" });
      await h.agents.mutateSessionPermissionRule({ sessionId, operation: "add", behavior: "allow", rule: "Write" });
      await h.agents.approveTool({ sessionId, requestId: "r1", scope: "session", allowAllToolsForSession: true });
      expect(h.setAgentPermissionMode).toHaveBeenCalledTimes(2);
      expect(h.mutateAgentPermissionRule).toHaveBeenCalledTimes(1);
    }
  });
});


describe("noFsWriteTools persistence regression #3024", () => {
  it("restores the original grant and accepts the identical resume policy", async () => {
    const granted = normalizeSessionToolPolicy({ ...POLICY, noFsWriteTools: ["mcp.desktop.read_file"] });
    const h = harness();
    await create(h, granted);
    const stored = h.runs.at(-1)!.metadata as JsonObject;
    expect(stored[TOOL_POLICY_METADATA_KEY]).toEqual(granted);
    expect(resolveCreateToolPolicy(undefined, stored)).toEqual(granted);
    expect(resolveCreateToolPolicy(granted, stored)).toEqual(granted);
    expect(() => resolveCreateToolPolicy(POLICY, stored)).toThrow("differs from the policy");
  });
});
