/**
 * Tests for `/plan` slash command + plan-file helpers (T11 W2 Agent C).
 */

import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import planCommand, {
  formatPlanText,
  getPermissionModeRegistry,
  getPlan,
  getPlanFilePath,
  openInEditor,
  writePlan,
  type PlanRecord,
} from "./plan.js";
import type { SlashCommandContext } from "./types.js";
import type { Session } from "../session/session.js";
import type { Event } from "../session/event-log.js";
import {
  PermissionModeRegistry,
} from "../permissions/mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";

// ─────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────

interface Harness {
  readonly ctx: SlashCommandContext;
  readonly registry: PermissionModeRegistry;
  readonly events: Event[];
  readonly cwd: string;
}

function mkHarness(opts: {
  readonly initialMode?: "default" | "plan" | "acceptEdits";
  readonly cwd?: string;
  readonly argsRaw?: string;
  readonly withoutRegistry?: boolean;
} = {}): Harness {
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "agenc-plan-"));
  const initialCtx = createEmptyToolPermissionContext({
    mode: opts.initialMode ?? "default",
  });
  const registry = new PermissionModeRegistry(initialCtx);

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
  };
  return { ctx, registry, events, cwd };
}

let tempDirs: string[] = [];
beforeEach(() => {
  tempDirs = [];
});
afterEach(() => {
  // no cleanup needed; mkdtempSync in /tmp is auto-cleaned enough for tests
});

// ─────────────────────────────────────────────────────────────────────
// getPermissionModeRegistry
// ─────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────
// Plan file storage
// ─────────────────────────────────────────────────────────────────────

describe("plan-file helpers", () => {
  it("getPlanFilePath resolves to <cwd>/.agenc/plan.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-plan-path-"));
    expect(getPlanFilePath(dir)).toBe(join(dir, ".agenc", "plan.json"));
  });

  it("getPlan returns null when the file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-plan-none-"));
    expect(getPlan(dir)).toBeNull();
  });

  it("writePlan persists a plan and getPlan round-trips it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-plan-rw-"));
    const record: PlanRecord = {
      id: "plan-1",
      description: "ship the thing",
      content: "step 1: explore\nstep 2: implement",
      createdAt: "2026-04-20T00:00:00Z",
      updatedAt: "2026-04-20T00:00:00Z",
    };
    await writePlan(dir, record);
    const loaded = getPlan(dir);
    expect(loaded).toEqual(record);
    expect(existsSync(join(dir, ".agenc", "plan.json"))).toBe(true);
  });

  it("getPlan returns null for malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-plan-bad-"));
    mkdirSync(join(dir, ".agenc"));
    writeFileSync(join(dir, ".agenc", "plan.json"), "{ not json", "utf8");
    expect(getPlan(dir)).toBeNull();
  });

  it("getPlan returns null when required fields are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-plan-partial-"));
    mkdirSync(join(dir, ".agenc"));
    writeFileSync(
      join(dir, ".agenc", "plan.json"),
      JSON.stringify({ id: "x" }),
      "utf8",
    );
    expect(getPlan(dir)).toBeNull();
  });

  it("formatPlanText renders headers + path + content", () => {
    const record: PlanRecord = {
      id: "p",
      description: "desc",
      content: "body",
      createdAt: "t",
      updatedAt: "t",
    };
    const out = formatPlanText(record, "/tmp/.agenc/plan.json");
    expect(out).toContain("Current Plan");
    expect(out).toContain("/tmp/.agenc/plan.json");
    expect(out).toContain("desc");
    expect(out).toContain("body");
  });
});

// ─────────────────────────────────────────────────────────────────────
// openInEditor
// ─────────────────────────────────────────────────────────────────────

describe("openInEditor", () => {
  it("returns error when no $EDITOR/$VISUAL is set", async () => {
    const res = await openInEditor("/tmp/foo", {});
    expect(res).toEqual({ error: "no $EDITOR or $VISUAL configured" });
  });

  it("spawns /usr/bin/true happy path and resolves ok", async () => {
    // `true` is a POSIX no-op that always succeeds. Used as a lightweight
    // stand-in for $EDITOR so we don't open a real editor during tests.
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

// ─────────────────────────────────────────────────────────────────────
// /plan execute
// ─────────────────────────────────────────────────────────────────────

describe("planCommand.execute", () => {
  it("errors out when the permission-mode registry is not wired", async () => {
    const { ctx } = mkHarness({ withoutRegistry: true });
    const res = await planCommand.execute(ctx);
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/registry/i);
    }
  });

  it("transitions default → plan and returns confirmation text", async () => {
    const h = mkHarness({ initialMode: "default" });
    const res = await planCommand.execute(h.ctx);
    expect(h.registry.current().mode).toBe("plan");
    expect(h.registry.current().prePlanMode).toBe("default");
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/Entered plan mode/);
    }
    // warning event emitted
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
    expect(res.kind).toBe("prompt");
    if (res.kind === "prompt") {
      expect(res.content).toBe("design the caching layer");
    }
  });

  it("treats `/plan open` in non-plan mode as a transition (not an open)", async () => {
    // openclaude docs: "open" only has editor semantics when already in
    // plan mode. When transitioning in, we treat it as "no description".
    const h = mkHarness({ initialMode: "default", argsRaw: "open" });
    const res = await planCommand.execute(h.ctx);
    expect(h.registry.current().mode).toBe("plan");
    expect(res.kind).toBe("text");
  });

  it("`/plan` while already in plan mode with no plan returns hint", async () => {
    const h = mkHarness({ initialMode: "plan" });
    const res = await planCommand.execute(h.ctx);
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/No plan written yet/i);
    }
    // No mode-change event fires because we're already in plan.
    const warn = h.events.find(
      (e) => e.msg.type === "warning" && e.msg.payload.cause === "mode_changed_to_plan",
    );
    expect(warn).toBeUndefined();
  });

  it("`/plan` while in plan mode with a persisted plan renders it", async () => {
    const h = mkHarness({ initialMode: "plan" });
    const record: PlanRecord = {
      id: "p",
      description: "the goal",
      content: "do things",
      createdAt: "2026-04-20",
      updatedAt: "2026-04-20",
    };
    await writePlan(h.cwd, record);
    const res = await planCommand.execute(h.ctx);
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain("the goal");
      expect(res.text).toContain("do things");
      expect(res.text).toContain(getPlanFilePath(h.cwd));
    }
  });

  it("`/plan open` in plan mode falls back gracefully when no $EDITOR", async () => {
    const h = mkHarness({ initialMode: "plan", argsRaw: "open" });
    const prevEditor = process.env.EDITOR;
    const prevVisual = process.env.VISUAL;
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    try {
      const res = await planCommand.execute(h.ctx);
      expect(res.kind).toBe("text");
      if (res.kind === "text") {
        expect(res.text).toMatch(/Could not open plan/);
        expect(res.text).toContain(getPlanFilePath(h.cwd));
      }
    } finally {
      if (prevEditor !== undefined) process.env.EDITOR = prevEditor;
      if (prevVisual !== undefined) process.env.VISUAL = prevVisual;
    }
  });

  it("`/plan open` with working $EDITOR returns skip (no transcript)", async () => {
    const h = mkHarness({ initialMode: "plan", argsRaw: "open" });
    const prevEditor = process.env.EDITOR;
    process.env.EDITOR = "true";
    try {
      const res = await planCommand.execute(h.ctx);
      expect(res.kind).toBe("skip");
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
