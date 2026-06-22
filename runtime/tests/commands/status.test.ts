import { describe, expect, it, vi } from "vitest";
import {
  statusCommand,
  collectStatus,
  formatStatus,
  summarizeGitStatus,
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
  it("collects sessionId, cwd, model, provider, turn count, uptime, permission mode", () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "acceptEdits" }),
    );
    const lines = collectStatus(
      stubSession({
        id: "abc",
        history: [{}, {}, {}],
        model: "grok-4.3",
        provider: "xai",
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
    expect(flat["Provider"]).toBe("xai");
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

  it("detects non-git directories", () => {
    expect(
      summarizeGitStatus({
        insideWorkTree: { stdout: "", stderr: "fatal", code: 128 },
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
});
