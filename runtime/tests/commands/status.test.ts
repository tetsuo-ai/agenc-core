import { describe, expect, it, vi } from "vitest";
import {
  statusCommand,
  collectStatus,
  formatStatus,
  summarizeGitStatus,
  zeroDataRetentionStatusLine,
} from "./status.js";
import { createStatusDashboardSnapshot } from "./status-menu.js";
import type { Session } from "../session/session.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";

interface StubBudget {
  emitted: number;
  remaining: number | null;
  resetSamplingGate?: () => void;
}

function stubSession(opts: {
  id?: string;
  history?: unknown[];
  model?: string;
  provider?: string;
  approval?: string;
  budget?: StubBudget | null;
  createdAtMs?: number;
  permissionModeRegistry?: PermissionModeRegistry | null;
  costSummary?: string;
} = {}): Session {
  const state = {
    sessionConfiguration: {
      cwd: "/ws",
      collaborationMode: { model: opts.model ?? "grok-4" },
      provider: { slug: opts.provider ?? "xai" },
      approvalPolicy: { value: opts.approval ?? "on_failure" },
    },
    history: opts.history ?? [],
  };
  return {
    conversationId: opts.id ?? "sess-1",
    state: { unsafePeek: () => state },
    budgetTracker: opts.budget ?? null,
    createdAtMs: opts.createdAtMs ?? 1000,
    services:
      opts.permissionModeRegistry === null
        ? opts.costSummary !== undefined
          ? { costSidecar: { formatSummary: () => opts.costSummary! } }
          : {}
        : {
            permissionModeRegistry: opts.permissionModeRegistry ?? null,
            ...(opts.costSummary !== undefined
              ? { costSidecar: { formatSummary: () => opts.costSummary } }
              : {}),
          },
  } as unknown as Session;
}

describe("statusCommand", () => {
  it("uses durable session usage after reconnect instead of reset daemon counters", () => {
    const usage = { runId: "run", sequence: 10, costUsd: 0.0208, heldCostUsd: 0,
      inputTokens: 12000, outputTokens: 345, totalTokens: 12345, modelCalls: 2,
      hasUnknownCost: false, models: [], agents: [] };
    const lines = collectStatus(stubSession({ costSummary: "$0.00 stale" }), "/ws", 2000,
      { tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } }, usage);
    expect(lines.filter(line => line.key.startsWith("Cost"))).toEqual([{ key: "Cost (USD)", value: "$0.0208" }]);
    expect(lines).toContainEqual({ key: "Tokens emitted", value: "12345 (in: 12000, out: 345)" });
    expect(createStatusDashboardSnapshot({ lines, git: { state: "clean", branch: "main", changedFiles: 0 } }).sessionCost).toBe("$0.0208");
  });

  it("retains unknown and estimated pricing markers from durable usage", () => {
    const usage = { runId: "run", sequence: 1, costUsd: 0.0208, heldCostUsd: 0,
      inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1,
      hasUnknownCost: true, costEstimated: true, models: [], agents: [] };
    expect(collectStatus(stubSession(), "/ws", 2000, undefined, usage)).toContainEqual({
      key: "Cost (USD)", value: "≥$0.0208 est.",
    });
  });
  it("shows an unavailable task budget for a view without session config", () => {
    expect(collectStatus(stubSession(), "/ws", 5000)).toContainEqual({ key: "Task budget", value: "unavailable" });
  });
  it("shows the active named task allocation", () => {
    const session = Object.assign(stubSession(), { config: { taskTokenBudget: 2_400_000 } });
    expect(collectStatus(session, "/ws", 5000)).toContainEqual({ key: "Task budget", value: "balanced (2,400,000 tokens)" });
  });
  it("shows saved max from a cold canonical config before materialization", () => {
    const session = Object.assign(stubSession(), { config: { task_token_budget: 0, budget_level: "max" } });
    expect(collectStatus(session as never, "/ws", 5000)).toContainEqual({ key: "Task budget", value: "max (no token cap)" });
  });
  it("collects sessionId, cwd, model, provider, turn count, uptime, permission mode", () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "acceptEdits" }),
    );
    const lines = collectStatus(
      stubSession({
        id: "abc",
        history: [{}, {}, {}],
        model: "grok-4.3",
        provider: "grok",
        approval: "on_request",
        permissionModeRegistry: registry,
      }),
      "/ws",
      5000, // nowMs, createdAtMs=1000 → uptime=4000
    );
    const flat = Object.fromEntries(lines.map((l) => [l.key, l.value]));
    expect(flat["Session ID"]).toBe("abc");
    expect(flat["CWD"]).toBe("/ws");
    expect(flat["Model"]).toBe("grok-4.3");
    expect(flat["Provider"]).toBe("grok");
    expect(flat["Turn count"]).toBe("3");
    expect(flat["Uptime (ms)"]).toBe("4000");
    expect(flat["Permission mode"]).toBe("acceptEdits");
  });

  it("renders permission mode from PermissionModeRegistry, not approvalPolicy.value", () => {
    // approvalPolicy is "never" but the registry says "plan" — the
    // Permission mode line MUST reflect the registry (T11 permission
    // mode) and ignore the AgenC-side approvalPolicy field.
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan" }),
    );
    const lines = collectStatus(
      stubSession({
        approval: "never",
        permissionModeRegistry: registry,
      }),
      "/ws",
      2000,
    );
    const flat = Object.fromEntries(lines.map((l) => [l.key, l.value]));
    expect(flat["Permission mode"]).toBe("plan");
    expect(flat["Permission mode"]).not.toBe("never");
  });

  it("shows 'n/a (budget disabled)' when budget tracker is absent", () => {
    const lines = collectStatus(stubSession({ budget: null }), "/ws", 2000);
    const flat = Object.fromEntries(lines.map((l) => [l.key, l.value]));
    expect(flat["Tokens emitted"]).toMatch(/budget disabled/);
  });

  it("shows 'unlimited' remaining when budget tracker returns infinite remaining", () => {
    const lines = collectStatus(
      stubSession({
        budget: { emitted: 1_234, remaining: Number.POSITIVE_INFINITY },
      }),
      "/ws",
      2000,
    );
    const flat = Object.fromEntries(lines.map((l) => [l.key, l.value]));
    expect(flat["Tokens emitted"]).toBe("1234");
    expect(flat["Tokens remaining"]).toBe("unlimited");
  });

  it("includes cost summary when CostSidecar is registered", () => {
    const summary = "$0.010 \u2022 in=1.0K out=500 \u2022 turns=1 \u2022 1.0s";
    const lines = collectStatus(
      stubSession({ costSummary: summary }),
      "/ws",
      2000,
    );
    const flat = Object.fromEntries(lines.map((l) => [l.key, l.value]));
    expect(flat["Cost"]).toBe(summary);
  });

  it("ignores array-shaped service status surfaces", () => {
    const spoofedMode = Object.assign(["spoof"], {
      mode: "bypassPermissions",
    });
    const spoofedCostSidecar = Object.assign(["spoof"], {
      formatSummary: () => "unsafe-cost",
    });
    const session = {
      ...stubSession(),
      services: {
        costSidecar: spoofedCostSidecar,
        permissionModeRegistry: {
          current: () => spoofedMode,
        },
      },
    } as unknown as Session;

    const lines = collectStatus(session, "/ws", 2000);
    const flat = Object.fromEntries(lines.map((l) => [l.key, l.value]));

    expect(flat["Cost"]).toBeUndefined();
    expect(flat["Permission mode"]).toBe("default");
  });

  it("formatStatus aligns keys with a colon separator", () => {
    const out = formatStatus([
      { key: "a", value: "1" },
      { key: "longer", value: "2" },
    ]);
    expect(out).toBe("a      : 1\nlonger : 2");
  });

  it("execute returns a text result", async () => {
    const res = await statusCommand.execute({
      session: stubSession(),
      argsRaw: "",
      cwd: "/ws",
      home: "/home/test",
    });
    expect(res.kind).toBe("text");
  });

  it("execute explains the status line's ZDR badge right after the provider", async () => {
    const text = async (provider: string, model: string) => {
      const res = await statusCommand.execute({
        session: stubSession({ provider, model }),
        argsRaw: "",
        cwd: "/ws",
        home: "/home/test",
      });
      expect(res.kind).toBe("text");
      return (res as { text: string }).text.split("\n");
    };
    const grok = await text("grok", "grok-4.6");
    const provider = grok.findIndex(line => line.startsWith("Provider"));
    expect(grok[provider + 1]).toMatch(/^Zero data retention\s+: data may be kept \(red ZDR\)$/u);
    expect((await text("cerebras", "gpt-oss-120b")).find(line => line.startsWith("Zero data retention")))
      .toMatch(/: on \(green ZDR\)$/u);
  });

  it("gives the dashboard the badge's reason as the row detail", () => {
    const line = zeroDataRetentionStatusLine({
      provider: "grok",
      state: "retained",
      reason: "xAI keeps every API request and response for 30 days. ZDR is a team setting in the xAI Console.",
    });
    expect(line).toEqual({
      key: "Zero data retention",
      value: "data may be kept (red ZDR)",
      detail: "xAI keeps every API request and response for 30 days. ZDR is a team setting in the xAI Console.",
      state: "warn",
    });
    const row = createStatusDashboardSnapshot({ lines: [line], git: { state: "clean", branch: "main", changedFiles: 0 } })
      .rows.find(candidate => candidate.key === "Zero data retention");
    expect(row).toMatchObject({ section: "privacy", state: "warn", detail: line.detail });
    expect(zeroDataRetentionStatusLine({ provider: "ollama", state: "zdr", reason: "Runs on this computer, so nothing leaves it." }))
      .toMatchObject({ value: "on (green ZDR)", state: "ok" });
    expect(zeroDataRetentionStatusLine({ provider: "openai-compatible", state: "unknown", reason: "r" }))
      .toMatchObject({ value: "unknown (dim ZDR?)", state: "info" });
  });

  it("execute opens a persistent v2 dashboard when TUI app state is wired", async () => {
    const setToolJSX = vi.fn();
    const res = await statusCommand.execute({
      session: stubSession(),
      argsRaw: "",
      cwd: "/ws",
      home: "/home/test",
      appState: {
        setToolJSX,
        getAppState: () => ({
          mainLoopModel: "grok-4.3",
          mcp: { clients: [], tools: [1], commands: [], resources: {} },
          tasks: {
            task1: { status: "running" },
          },
        }),
      },
    });
    expect(res.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      }),
    );
  });
});

describe("status git summary", () => {
  it("detects a clean work tree", () => {
    expect(
      summarizeGitStatus({
        insideWorkTree: { stdout: "true\n", stderr: "", code: 0 },
        branch: { stdout: "main\n", stderr: "", code: 0 },
        porcelain: { stdout: "", stderr: "", code: 0 },
      }),
    ).toEqual({ state: "clean", branch: "main", changedFiles: 0 });
  });

  it("detects a dirty work tree", () => {
    expect(
      summarizeGitStatus({
        insideWorkTree: { stdout: "true\n", stderr: "", code: 0 },
        branch: { stdout: "main\n", stderr: "", code: 0 },
        porcelain: { stdout: " M file.ts\n?? new.ts\n", stderr: "", code: 0 },
      }),
    ).toEqual({ state: "dirty", branch: "main", changedFiles: 2 });
  });

  it("reports a missing git as informational, not as a git failure", () => {
    // Windows without Git for Windows: the spawn fails before git can say anything.
    const summary = summarizeGitStatus({
      insideWorkTree: { stdout: "", stderr: "Error: spawn git ENOENT", code: -1 },
      branch: { stdout: "", stderr: "", code: 0 },
      porcelain: { stdout: "", stderr: "", code: 0 },
    });
    expect(summary).toEqual({ state: "no-git", message: "Install git to see branch state here." });
    const row = createStatusDashboardSnapshot({ lines: [], git: summary }).rows.find((entry) => entry.section === "git");
    expect(row).toMatchObject({ value: "git not installed", state: "info" });
    // Any other spawn failure is still an error.
    expect(summarizeGitStatus({
      insideWorkTree: { stdout: "", stderr: "Error: spawn git EMFILE", code: -1 },
      branch: { stdout: "", stderr: "", code: 0 },
      porcelain: { stdout: "", stderr: "", code: 0 },
    }).state).toBe("error");
  });

  it("detects non-git directories", () => {
    expect(
      summarizeGitStatus({
        insideWorkTree: { stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git", code: 128 },
        branch: { stdout: "", stderr: "", code: 0 },
        porcelain: { stdout: "", stderr: "", code: 0 },
      }).state,
    ).toBe("not-repo");
  });
});

describe("status dashboard snapshot", () => {
  it("adds git, mcp, and task rows", () => {
    const snapshot = createStatusDashboardSnapshot({
      lines: [
        { key: "Model", value: "grok-4.3" },
        { key: "Permission mode", value: "plan" },
      ],
      git: { state: "dirty", branch: "main", changedFiles: 2 },
      appState: {
        mcp: { clients: [1], tools: [1, 2], commands: [1], resources: {} },
        tasks: {
          a: { status: "running" },
          b: { status: "completed" },
        },
      },
    });

    expect(snapshot.rows.some(row => row.section === "git" && row.value === "dirty")).toBe(true);
    expect(snapshot.rows.some(row => row.section === "mcp" && row.value === "1")).toBe(true);
    expect(snapshot.rows.some(row => row.section === "tasks" && row.value === "2")).toBe(true);
    expect(snapshot.summary).toContain("attention");
  });

  it("does not duplicate the canonical session model from TUI app state", () => {
    const snapshot = createStatusDashboardSnapshot({
      lines: [
        { key: "Model", value: "grok-4.6" },
        { key: "Provider", value: "grok" },
      ],
      git: { state: "clean", branch: "main", changedFiles: 0 },
      appState: {
        mainLoopModel: "stale-model",
        mainLoopModelForSession: "another-stale-model",
        mcp: {},
        tasks: {},
      },
    });

    expect(snapshot.rows.filter(row => row.section === "model")).toEqual([
      expect.objectContaining({ key: "Model", value: "grok-4.6" }),
      expect.objectContaining({ key: "Provider", value: "grok" }),
    ]);
    expect(snapshot.rows.some(row => row.value.includes("stale-model"))).toBe(false);
  });
});
