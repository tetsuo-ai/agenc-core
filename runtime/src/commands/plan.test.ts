/**
 * Tests for `/plan` slash command + AgenC-style AgenC plan files.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import planCommand, {
  clearAllPlanSlugs,
  formatPlanText,
  getPermissionModeRegistry,
  getPlan,
  getPlanFilePath,
  openInEditor,
  setPlanSlug,
  writePlan,
} from "./plan.js";
import type { SlashCommandContext } from "./types.js";
import type { Session } from "../session/session.js";
import type { Event } from "../session/event-log.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";

interface Harness {
  readonly ctx: SlashCommandContext;
  readonly registry: PermissionModeRegistry;
  readonly events: Event[];
  readonly cwd: string;
  readonly agencHome: string;
}

function mkHarness(opts: {
  readonly initialMode?: "default" | "plan" | "acceptEdits";
  readonly cwd?: string;
  readonly argsRaw?: string;
  readonly withoutRegistry?: boolean;
} = {}): Harness {
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "agenc-plan-cwd-"));
  const agencHome = mkdtempSync(join(tmpdir(), "agenc-plan-home-"));
  const registry = new PermissionModeRegistry(
    createEmptyToolPermissionContext({
      mode: opts.initialMode ?? "default",
    }),
  );

  const events: Event[] = [];
  let subId = 0;
  const services: Record<string, unknown> = opts.withoutRegistry
    ? {}
    : { permissionModeRegistry: registry };

  const session = {
    conversationId: "conv-plan-test",
    services,
    nextInternalSubId: () => `s-${++subId}`,
    emit: (event: Event) => {
      events.push(event);
    },
  } as unknown as Session;

  const ctx: SlashCommandContext = {
    session,
    argsRaw: opts.argsRaw ?? "",
    cwd,
    home: "/home/test-plan",
    agencHome,
  };
  return { ctx, registry, events, cwd, agencHome };
}

function planCtx(h: Harness) {
  return {
    agencHome: h.agencHome,
    sessionId: h.ctx.session.conversationId,
  };
}

beforeEach(() => {
  clearAllPlanSlugs();
});

describe("getPermissionModeRegistry", () => {
  it("returns the registry when present on services", () => {
    const { ctx, registry } = mkHarness();
    expect(getPermissionModeRegistry(ctx.session)).toBe(registry);
  });

  it("returns null when the registry is missing", () => {
    const { ctx } = mkHarness({ withoutRegistry: true });
    expect(getPermissionModeRegistry(ctx.session)).toBeNull();
  });
});

describe("plan-file helpers", () => {
  it("getPlanFilePath resolves to <AGENC_HOME>/plans/<slug>.md", () => {
    const h = mkHarness();
    const slug = setPlanSlug(planCtx(h), "steady-bridge");
    const filePath = getPlanFilePath(planCtx(h));
    expect(slug).toBe("steady-bridge");
    expect(filePath).toBe(join(h.agencHome, "plans", "steady-bridge.md"));
  });

  it("uses agent-specific plan file suffixes for subagents", () => {
    const h = mkHarness();
    setPlanSlug(planCtx(h), "steady-bridge");
    expect(
      getPlanFilePath({
        ...planCtx(h),
        agentId: "agent/one",
      }),
    ).toBe(join(h.agencHome, "plans", "steady-bridge-agent-agent-one.md"));
  });

  it("getPlan returns null when the file is absent", () => {
    const h = mkHarness();
    setPlanSlug(planCtx(h), "missing-plan");
    expect(getPlan(planCtx(h))).toBeNull();
  });

  it("writePlan persists markdown and getPlan round-trips it", async () => {
    const h = mkHarness();
    setPlanSlug(planCtx(h), "round-trip");
    const content = "## Context\n\nShip the thing.\n";
    const filePath = await writePlan(planCtx(h), content);
    expect(filePath).toBe(join(h.agencHome, "plans", "round-trip.md"));
    expect(getPlan(planCtx(h))).toBe(content);
    expect(existsSync(filePath)).toBe(true);
  });

  it("formatPlanText renders headers, path, and raw markdown", () => {
    const out = formatPlanText("## Plan\n\nDo it.", "/tmp/agenc/plans/p.md");
    expect(out).toContain("Current Plan");
    expect(out).toContain("/tmp/agenc/plans/p.md");
    expect(out).toContain("## Plan");
    expect(out).toContain('/plan open');
  });

  it("generates stable markdown slugs per session", () => {
    const h = mkHarness();
    const first = getPlanFilePath(planCtx(h));
    const second = getPlanFilePath(planCtx(h));
    expect(first).toBe(second);
    expect(first).toContain(join(h.agencHome, "plans"));
    expect(basename(first)).toMatch(/\.md$/);
  });

  it("persists session slug mappings across in-memory cache clears", () => {
    const h = mkHarness();
    setPlanSlug(planCtx(h), "persisted-slug");
    clearAllPlanSlugs();
    expect(getPlanFilePath(planCtx(h))).toBe(
      join(h.agencHome, "plans", "persisted-slug.md"),
    );
  });
});

describe("openInEditor", () => {
  it("returns error when no $EDITOR/$VISUAL is set", async () => {
    const res = await openInEditor("/tmp/foo", {});
    expect(res).toEqual({ error: "no $EDITOR or $VISUAL configured" });
  });

  it("spawns /usr/bin/true happy path and resolves ok", async () => {
    const res = await openInEditor("/dev/null", { EDITOR: "true" });
    expect(res).toEqual({ ok: true });
  });

  it("returns error when editor binary is missing", async () => {
    const res = await openInEditor("/dev/null", {
      EDITOR: "/definitely/not/a/real/binary",
    });
    expect(res).toHaveProperty("error");
  });
});

describe("planCommand.execute", () => {
  it("errors out when the permission-mode registry is not wired", async () => {
    const { ctx } = mkHarness({ withoutRegistry: true });
    const res = await planCommand.execute(ctx);
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/registry/i);
    }
  });

  it("transitions default -> plan and returns AgenC confirmation text", async () => {
    const h = mkHarness({ initialMode: "default" });
    const res = await planCommand.execute(h.ctx);
    expect(h.registry.current().mode).toBe("plan");
    expect(h.registry.current().prePlanMode).toBe("default");
    expect(res).toEqual({ kind: "text", text: "Enabled plan mode" });
    const warn = h.events.find((e) => e.msg.type === "warning");
    expect(warn).toBeDefined();
    if (warn && warn.msg.type === "warning") {
      expect(warn.msg.payload.cause).toBe("mode_changed_to_plan");
    }
  });

  it("forwards non-empty args as a user prompt when entering plan mode", async () => {
    const h = mkHarness({
      initialMode: "default",
      argsRaw: "design the caching layer",
    });
    const res = await planCommand.execute(h.ctx);
    expect(h.registry.current().mode).toBe("plan");
    expect(res).toEqual({ kind: "prompt", content: "design the caching layer" });
  });

  it("treats `/plan open` in non-plan mode as a transition", async () => {
    const h = mkHarness({ initialMode: "default", argsRaw: "open" });
    const res = await planCommand.execute(h.ctx);
    expect(h.registry.current().mode).toBe("plan");
    expect(res).toEqual({ kind: "text", text: "Enabled plan mode" });
  });

  it("`/plan` while already in plan mode with no plan returns hint", async () => {
    const h = mkHarness({ initialMode: "plan" });
    const res = await planCommand.execute(h.ctx);
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toBe("Already in plan mode. No plan written yet.");
    }
    const warn = h.events.find(
      (e) =>
        e.msg.type === "warning" &&
        e.msg.payload.cause === "mode_changed_to_plan",
    );
    expect(warn).toBeUndefined();
  });

  it("`/plan` while in plan mode with a persisted plan renders it", async () => {
    const h = mkHarness({ initialMode: "plan" });
    setPlanSlug(planCtx(h), "render-plan");
    await writePlan(planCtx(h), "## Context\n\nDo things.\n");
    const res = await planCommand.execute(h.ctx);
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain("## Context");
      expect(res.text).toContain("Do things.");
      expect(res.text).toContain(getPlanFilePath(planCtx(h)));
    }
  });

  it("`/plan open` in plan mode falls back gracefully when no $EDITOR", async () => {
    const h = mkHarness({ initialMode: "plan", argsRaw: "open" });
    setPlanSlug(planCtx(h), "open-plan");
    await writePlan(planCtx(h), "open me");
    const prevEditor = process.env.EDITOR;
    const prevVisual = process.env.VISUAL;
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    try {
      const res = await planCommand.execute(h.ctx);
      expect(res.kind).toBe("text");
      if (res.kind === "text") {
        expect(res.text).toMatch(/Failed to open plan in editor/);
      }
    } finally {
      if (prevEditor !== undefined) process.env.EDITOR = prevEditor;
      if (prevVisual !== undefined) process.env.VISUAL = prevVisual;
    }
  });

  it("`/plan open` with working $EDITOR returns opened text", async () => {
    const h = mkHarness({ initialMode: "plan", argsRaw: "open" });
    setPlanSlug(planCtx(h), "open-plan");
    await writePlan(planCtx(h), "open me");
    const prevEditor = process.env.EDITOR;
    process.env.EDITOR = "true";
    try {
      const res = await planCommand.execute(h.ctx);
      expect(res.kind).toBe("text");
      if (res.kind === "text") {
        expect(res.text).toBe(`Opened plan in editor: ${getPlanFilePath(planCtx(h))}`);
      }
    } finally {
      if (prevEditor !== undefined) process.env.EDITOR = prevEditor;
      else delete process.env.EDITOR;
    }
  });

  it("entering plan from acceptEdits stashes acceptEdits as prePlanMode", async () => {
    const h = mkHarness({ initialMode: "acceptEdits" });
    await planCommand.execute(h.ctx);
    expect(h.registry.current().mode).toBe("plan");
    expect(h.registry.current().prePlanMode).toBe("acceptEdits");
  });
});
