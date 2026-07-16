import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  permissionsCommand,
  formatRuleList,
  exportRules,
  parseRuleArgs,
} from "./permissions.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import {
  applyPermissionUpdate,
} from "../permissions/rules.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from "../permissions/types.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────

interface StubSession {
  services: { permissionModeRegistry: PermissionModeRegistry | null };
  emit: ReturnType<typeof vi.fn>;
  nextInternalSubId: () => string;
}

function stubSession(registry: PermissionModeRegistry | null): Session {
  const s: StubSession = {
    services: { permissionModeRegistry: registry },
    emit: vi.fn(),
    nextInternalSubId: () => "sub-1",
  };
  return s as unknown as Session;
}

function stubCtx(
  overrides: Partial<SlashCommandContext> & { registry?: PermissionModeRegistry | null } = {},
): SlashCommandContext {
  const registry =
    overrides.registry !== undefined
      ? overrides.registry
      : new PermissionModeRegistry(createEmptyToolPermissionContext());
  return {
    session: overrides.session ?? stubSession(registry),
    argsRaw: overrides.argsRaw ?? "",
    cwd: overrides.cwd ?? "/tmp",
    home: overrides.home ?? "/home/test",
    configStore: overrides.configStore,
    ...(overrides.appState ? { appState: overrides.appState } : {}),
  };
}

function seedCtx(mode: PermissionMode = "default"): ToolPermissionContext {
  let ctx = createEmptyToolPermissionContext({ mode });
  ctx = applyPermissionUpdate(ctx, {
    type: "addRules",
    destination: "userSettings",
    rules: [{ toolName: "Bash", ruleContent: "git commit:*" }, { toolName: "Read" }],
    behavior: "allow",
  });
  ctx = applyPermissionUpdate(ctx, {
    type: "addRules",
    destination: "projectSettings",
    rules: [{ toolName: "Bash", ruleContent: "npm run:*" }],
    behavior: "allow",
  });
  ctx = applyPermissionUpdate(ctx, {
    type: "addRules",
    destination: "userSettings",
    rules: [{ toolName: "Bash", ruleContent: "rm -rf:*" }],
    behavior: "deny",
  });
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────
// formatRuleList / exportRules
// ─────────────────────────────────────────────────────────────────────

describe("permissionsCommand — formatRuleList", () => {
  it("formats rules grouped by behavior and source", () => {
    const ctx = seedCtx("acceptEdits");
    const out = formatRuleList(ctx);
    expect(out).toContain("Mode: acceptEdits");
    expect(out).toContain("ALLOW (userSettings):");
    expect(out).toContain("  Bash(git commit:*)");
    expect(out).toContain("  Read");
    expect(out).toContain("ALLOW (projectSettings):");
    expect(out).toContain("  Bash(npm run:*)");
    expect(out).toContain("DENY (userSettings):");
    expect(out).toContain("  Bash(rm -rf:*)");
  });

  it("emits an '(no permission rules configured)' placeholder when empty", () => {
    const out = formatRuleList(createEmptyToolPermissionContext());
    expect(out).toContain("Mode: default");
    expect(out).toContain("(no permission rules configured)");
  });
});

describe("permissionsCommand — exportRules", () => {
  it("emits JSON with all three buckets and defaultMode", () => {
    const ctx = seedCtx();
    const out = exportRules(ctx);
    const parsed = JSON.parse(out);
    expect(parsed.permissions.defaultMode).toBe("default");
    expect(parsed.permissions.allow).toEqual(
      expect.arrayContaining(["Bash(git commit:*)", "Bash(npm run:*)", "Read"]),
    );
    expect(parsed.permissions.deny).toContain("Bash(rm -rf:*)");
    expect(Array.isArray(parsed.permissions.ask)).toBe(true);
  });

  it("export output round-trips through JSON parse", () => {
    const out = exportRules(seedCtx());
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// parseRuleArgs
// ─────────────────────────────────────────────────────────────────────

describe("parseRuleArgs", () => {
  it("parses 'allow Bash(ls)'", () => {
    const r = parseRuleArgs("allow Bash(ls)");
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.behavior).toBe("allow");
    expect(r.value.ruleValue.toolName).toBe("Bash");
    expect(r.value.ruleValue.ruleContent).toBe("ls");
  });

  it("parses 'deny WebFetch'", () => {
    const r = parseRuleArgs("deny WebFetch");
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.behavior).toBe("deny");
    expect(r.value.ruleValue.toolName).toBe("WebFetch");
    expect(r.value.ruleValue.ruleContent).toBeUndefined();
  });

  it("errors on unknown behavior", () => {
    const r = parseRuleArgs("whoknows Bash(ls)");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Unknown behavior/);
  });

  it("errors on missing rule token", () => {
    const r = parseRuleArgs("allow");
    expect(r.ok).toBe(false);
  });

  it("errors on invalid rule syntax with unbalanced parens", () => {
    const r = parseRuleArgs("deny invalidsyntax[");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Invalid rule/);
  });

  it("parses '--persist user' token form", () => {
    const r = parseRuleArgs("allow Bash(ls) --persist user");
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.persistTo).toBe("userSettings");
  });

  it("parses '--persist=project' equals form", () => {
    const r = parseRuleArgs("allow Read --persist=project");
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.persistTo).toBe("projectSettings");
  });

  it("errors on unknown --persist target", () => {
    const r = parseRuleArgs("allow Read --persist=global");
    expect(r.ok).toBe(false);
  });

  it("errors when --persist has no value", () => {
    const r = parseRuleArgs("allow Read --persist");
    expect(r.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// execute — list / add / remove / export / mode
// ─────────────────────────────────────────────────────────────────────

describe("permissionsCommand — execute list", () => {
  it("defaults to list when no args given", async () => {
    const registry = new PermissionModeRegistry(seedCtx());
    const ctx = stubCtx({ registry });
    const r = await permissionsCommand.execute(ctx);
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.text).toContain("ALLOW (userSettings):");
  });

  it("'list' subcommand is explicit alias", async () => {
    const registry = new PermissionModeRegistry(seedCtx());
    const r = await permissionsCommand.execute(
      stubCtx({ registry, argsRaw: "list" }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toContain("Mode:");
  });

  it("opens the local permissions menu in the TUI", async () => {
    const registry = new PermissionModeRegistry(seedCtx());
    const setToolJSX = vi.fn();
    const r = await permissionsCommand.execute(
      stubCtx({ registry, appState: { setToolJSX } }),
    );
    expect(r.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledTimes(1);
    expect(setToolJSX.mock.calls[0]?.[0]).toMatchObject({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
    });
  });

  it("returns an error when no permission registry is configured", async () => {
    const r = await permissionsCommand.execute(stubCtx({ registry: null }));
    expect(r.kind).toBe("error");
  });

  it("returns an error for unknown subcommand", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const r = await permissionsCommand.execute(
      stubCtx({ registry, argsRaw: "frobnicate" }),
    );
    expect(r.kind).toBe("error");
  });
});

describe("permissionsCommand — add", () => {
  it("'add allow Bash(ls)' applies a session-source rule", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const ctx = stubCtx({ registry, argsRaw: "add allow Bash(ls)" });
    const r = await permissionsCommand.execute(ctx);
    if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
    expect(r.text).toContain("Added ALLOW Bash(ls)");
    const cur = registry.current();
    expect(cur.alwaysAllowRules.session).toContain("Bash(ls)");
    // Not persisted to any settings file by default.
    expect(r.text).not.toMatch(/persisted/);
  });

  it("'add deny invalidsyntax[' returns parse error without mutating registry", async () => {
    const initial = createEmptyToolPermissionContext();
    const registry = new PermissionModeRegistry(initial);
    const r = await permissionsCommand.execute(
      stubCtx({ registry, argsRaw: "add deny invalidsyntax[" }),
    );
    expect(r.kind).toBe("error");
    expect(registry.current()).toBe(initial);
  });

  it("'add allow Read --persist user' writes to disk settings.json", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-perms-"));
    try {
      const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
      const ctx = stubCtx({
        registry,
        argsRaw: "add allow Read --persist user",
        home: tmp,
      });
      const r = await permissionsCommand.execute(ctx);
      if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
      expect(r.text).toMatch(/persisted to userSettings/);
      const file = join(tmp, ".agenc", "settings.json");
      expect(existsSync(file)).toBe(true);
      const on_disk = JSON.parse(readFileSync(file, "utf8")) as {
        permissions: { allow: string[] };
      };
      expect(on_disk.permissions.allow).toContain("Read");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps repository-targeted allow approval in the session only", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-perms-boundary-"));
    try {
      const registry = new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      );
      const r = await permissionsCommand.execute(
        stubCtx({
          registry,
          argsRaw: "add allow Read --persist project",
          home: tmp,
          cwd: tmp,
        }),
      );
      if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
      expect(r.text).toContain("session only");
      expect(r.text).toContain(
        "repository files cannot store permission approvals",
      );
      expect(registry.current().alwaysAllowRules.session).toContain("Read");
      expect(existsSync(join(tmp, ".agenc", "settings.json"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("permissionsCommand — remove", () => {
  it("removes only the matching session rule", async () => {
    let initial = createEmptyToolPermissionContext();
    initial = applyPermissionUpdate(initial, {
      type: "addRules",
      destination: "session",
      rules: [{ toolName: "Bash", ruleContent: "ls" }, { toolName: "Read" }],
      behavior: "allow",
    });
    const registry = new PermissionModeRegistry(initial);
    const r = await permissionsCommand.execute(
      stubCtx({ registry, argsRaw: "remove allow Bash(ls)" }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    const cur = registry.current();
    expect(cur.alwaysAllowRules.session).not.toContain("Bash(ls)");
    expect(cur.alwaysAllowRules.session).toContain("Read");
  });

  it("--persist user removes from userSettings JSON on disk", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-perms-"));
    try {
      // Seed the settings file first.
      const file = join(tmp, ".agenc", "settings.json");
      mkdirSync(join(tmp, ".agenc"), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ permissions: { allow: ["Read", "Bash(ls)"] } }, null, 2),
      );
      const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
      const r = await permissionsCommand.execute(
        stubCtx({
          registry,
          argsRaw: "remove allow Read --persist user",
          home: tmp,
        }),
      );
      if (r.kind !== "text") throw new Error("expected text");
      const on_disk = JSON.parse(readFileSync(file, "utf8")) as {
        permissions: { allow: string[] };
      };
      expect(on_disk.permissions.allow).not.toContain("Read");
      expect(on_disk.permissions.allow).toContain("Bash(ls)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("permissionsCommand — export", () => {
  it("returns a JSON string round-trippable through JSON.parse", async () => {
    const registry = new PermissionModeRegistry(seedCtx());
    const r = await permissionsCommand.execute(
      stubCtx({ registry, argsRaw: "export" }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(() => JSON.parse(r.text)).not.toThrow();
    const parsed = JSON.parse(r.text);
    expect(parsed.permissions).toBeDefined();
    expect(parsed.permissions.defaultMode).toBe("default");
  });
});

describe("permissionsCommand — mode", () => {
  it("'/permissions mode' prints current mode", async () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan" }),
    );
    const r = await permissionsCommand.execute(
      stubCtx({ registry, argsRaw: "mode" }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toContain("Current mode: plan");
  });

  it("'/permissions mode plan' transitions to plan and emits warning", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const session = stubSession(registry);
    const ctx = stubCtx({ registry, argsRaw: "mode plan", session });
    const r = await permissionsCommand.execute(ctx);
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toContain("default → plan");
    expect(registry.current().mode).toBe("plan");
    const emitFn = (session as unknown as { emit: ReturnType<typeof vi.fn> }).emit;
    expect(emitFn).toHaveBeenCalledTimes(1);
    const payload = emitFn.mock.calls[0]![0].msg.payload;
    expect(payload.cause).toBe("mode_changed");
  });

  it("'/permissions mode invalidMode' returns an error", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const r = await permissionsCommand.execute(
      stubCtx({ registry, argsRaw: "mode floobar" }),
    );
    expect(r.kind).toBe("error");
    expect(registry.current().mode).toBe("default");
  });

  it("'/permissions mode <internal>' rejects internal-only modes", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    for (const mode of ["unattended", "bubble"]) {
      const r = await permissionsCommand.execute(
        stubCtx({ registry, argsRaw: `mode ${mode}` }),
      );
      expect(r.kind).toBe("error");
    }
  });

  it("'/permissions mode default' when already default is a no-op with confirmation", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const r = await permissionsCommand.execute(
      stubCtx({ registry, argsRaw: "mode default" }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toMatch(/already/);
  });

  it("'/permissions mode plan' routes to the daemon registry on a bridge session", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const setDaemonPermissionMode = vi.fn(async (mode: string) => ({
      applied: true,
      previousMode: "default",
      mode,
    }));
    // A daemon bridge session exposes setDaemonPermissionMode; the local
    // registry is only a client-side shim, so the command must forward.
    const session = {
      services: { permissionModeRegistry: registry },
      emit: vi.fn(),
      nextInternalSubId: () => "sub-1",
      setDaemonPermissionMode,
    } as unknown as Session;
    const ctx = stubCtx({ registry, argsRaw: "mode plan", session });
    const r = await permissionsCommand.execute(ctx);
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toContain("default → plan");
    expect(setDaemonPermissionMode).toHaveBeenCalledWith("plan");
    // Local registry is kept in sync for subsequent /permissions reads.
    expect(registry.current().mode).toBe("plan");
  });

  it("'/permissions mode plan' surfaces a daemon RPC failure as an error", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const setDaemonPermissionMode = vi.fn(async () => {
      throw new Error("daemon refused");
    });
    const session = {
      services: { permissionModeRegistry: registry },
      emit: vi.fn(),
      nextInternalSubId: () => "sub-1",
      setDaemonPermissionMode,
    } as unknown as Session;
    const ctx = stubCtx({ registry, argsRaw: "mode plan", session });
    const r = await permissionsCommand.execute(ctx);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("expected error");
    expect(r.message).toContain("daemon refused");
    // Local registry untouched when the daemon switch fails.
    expect(registry.current().mode).toBe("default");
  });

  it("'/permissions mode bypassPermissions' on a bridge session gates consent BEFORE hitting the daemon", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const setDaemonPermissionMode = vi.fn(async (mode: string) => ({
      applied: true,
      previousMode: "default",
      mode,
    }));
    const session = {
      services: { permissionModeRegistry: registry },
      emit: vi.fn(),
      nextInternalSubId: () => "sub-1",
      setDaemonPermissionMode,
    } as unknown as Session;
    const ctx = stubCtx({
      registry,
      argsRaw: "mode bypassPermissions",
      session,
      cwd: "/workspace/untrusted",
    });
    const r = await permissionsCommand.execute(ctx);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("expected error");
    expect(r.message).toMatch(/\/permissions accept-bypass/);
    // Consent gate fires before the RPC — the daemon is never told to switch.
    expect(setDaemonPermissionMode).not.toHaveBeenCalled();
    expect(registry.current().mode).toBe("default");
  });

  it("'/permissions mode bypassPermissions' forwards to the daemon AFTER consent is recorded", async () => {
    // Pre-populate consent for this workspace (equivalent to accept-bypass).
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({
        bypassPermissionsAcceptedIn: ["/workspace/trusted"],
      }),
    );
    const setDaemonPermissionMode = vi.fn(async (mode: string) => ({
      applied: true,
      previousMode: "default",
      mode,
    }));
    const session = {
      services: { permissionModeRegistry: registry },
      emit: vi.fn(),
      nextInternalSubId: () => "sub-1",
      setDaemonPermissionMode,
    } as unknown as Session;
    const ctx = stubCtx({
      registry,
      argsRaw: "mode bypassPermissions",
      session,
      cwd: "/workspace/trusted",
    });
    const r = await permissionsCommand.execute(ctx);
    if (r.kind !== "text") {
      throw new Error(
        `expected text, got ${r.kind}: ${
          r.kind === "error" ? r.message : ""
        }`,
      );
    }
    expect(r.text).toContain("default → bypassPermissions");
    expect(setDaemonPermissionMode).toHaveBeenCalledWith("bypassPermissions");
    // Local shim synced so subsequent /permissions reads reflect bypass.
    expect(registry.current().mode).toBe("bypassPermissions");
  });

  it("'/permissions mode bypassPermissions' surfaces a daemon RPC failure as an error after consent", async () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({
        bypassPermissionsAcceptedIn: ["/workspace/trusted"],
      }),
    );
    const setDaemonPermissionMode = vi.fn(async () => {
      throw new Error("daemon refused");
    });
    const session = {
      services: { permissionModeRegistry: registry },
      emit: vi.fn(),
      nextInternalSubId: () => "sub-1",
      setDaemonPermissionMode,
    } as unknown as Session;
    const ctx = stubCtx({
      registry,
      argsRaw: "mode bypassPermissions",
      session,
      cwd: "/workspace/trusted",
    });
    const r = await permissionsCommand.execute(ctx);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("expected error");
    expect(r.message).toContain("daemon refused");
    // Local registry untouched when the daemon switch fails.
    expect(registry.current().mode).toBe("default");
  });
});

// ─────────────────────────────────────────────────────────────────────
// bypassPermissions consent gate
// ─────────────────────────────────────────────────────────────────────

describe("permissionsCommand — bypassPermissions consent gate", () => {
  it("'/permissions mode bypassPermissions' prompts for consent on first activation", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const ctx = stubCtx({
      registry,
      argsRaw: "mode bypassPermissions",
      cwd: "/workspace/new",
    });
    const r = await permissionsCommand.execute(ctx);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toMatch(/\/permissions accept-bypass/);
    // Mode must not have changed — consent is required first.
    expect(registry.current().mode).toBe("default");
  });

  it("'/permissions accept-bypass' sets the session and persisted flag", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-"));
    try {
      const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
      const ctx = stubCtx({
        registry,
        argsRaw: "accept-bypass",
        home: tmp,
        cwd: "/workspace/trusted",
      });
      const r = await permissionsCommand.execute(ctx);
      if (r.kind !== "text") {
        throw new Error(
          `expected text, got ${r.kind}: ${
            r.kind === "error" ? r.message : ""
          }`,
        );
      }
      expect(r.text).toContain("/workspace/trusted");
      // Session-level list updated.
      expect(registry.current().bypassPermissionsAcceptedIn).toContain(
        "/workspace/trusted",
      );
      // Persisted to user settings file.
      const file = join(tmp, ".agenc", "settings.json");
      expect(existsSync(file)).toBe(true);
      const on_disk = JSON.parse(readFileSync(file, "utf8")) as {
        bypassPermissionsModeAcceptedIn?: string[];
      };
      expect(on_disk.bypassPermissionsModeAcceptedIn).toContain(
        "/workspace/trusted",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("second '/permissions mode bypassPermissions' succeeds after accept-bypass", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-"));
    try {
      const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
      // Step 1: accept-bypass.
      const acceptRes = await permissionsCommand.execute(
        stubCtx({
          registry,
          argsRaw: "accept-bypass",
          home: tmp,
          cwd: "/workspace/trusted",
        }),
      );
      expect(acceptRes.kind).toBe("text");

      // Step 2: switch to bypassPermissions — should now succeed.
      const modeRes = await permissionsCommand.execute(
        stubCtx({
          registry,
          argsRaw: "mode bypassPermissions",
          home: tmp,
          cwd: "/workspace/trusted",
        }),
      );
      if (modeRes.kind !== "text") {
        throw new Error(
          `expected text, got ${modeRes.kind}: ${
            modeRes.kind === "error" ? modeRes.message : ""
          }`,
        );
      }
      expect(modeRes.text).toContain("bypassPermissions");
      expect(registry.current().mode).toBe("bypassPermissions");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
