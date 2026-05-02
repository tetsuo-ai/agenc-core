import { describe, expect, it } from "vitest";
import statusCommand, { collectStatus, formatStatus } from "./status.js";
import type { Session } from "../session/session.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
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
        model: "grok-4-fast",
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
    expect(flat["Model"]).toBe("grok-4-fast");
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
});
