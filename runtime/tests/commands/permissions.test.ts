import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  permissionsCommand,
  formatRuleList,
  exportRules,
  parseRuleArgs,
} from "./permissions.js";
import {
  __setAutoModeGateResolverForTesting,
  PermissionModeRegistry,
  transitionPermissionMode,
} from "../permissions/permission-mode.js";
import { applyPermissionUpdate } from "../permissions/permission-updates.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from "../permissions/types.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";
import { parseToml } from "../config/loader.js";
import { ConfigStore } from "../config/store.js";
import { RuntimeStateRepository } from "../config/runtime-state-repository.js";
import { resolveHomeContext } from "../config/home.js";
import {
  authorizeBypassPermissionsConsent,
  canonicalizeBypassPermissionsCwd,
  loadBypassPermissionsConsent,
} from "../permissions/bypass-consent-state.js";

function persistedBypassConsent(cwd: string) {
  const canonicalCwd = canonicalizeBypassPermissionsCwd(cwd);
  const identity = lstatSync(canonicalCwd, { bigint: true });
  return {
    version: 1,
    canonicalCwd,
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
  } as const;
}

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

function bypassAuthorizedContext(workspace: string): ToolPermissionContext {
  return authorizeBypassPermissionsConsent(
    createEmptyToolPermissionContext(),
    canonicalizeBypassPermissionsCwd(workspace),
  );
}

async function withInjectedDirectoryFsyncFailure<T>(
  directory: string,
  failure: NodeJS.ErrnoException,
  operation: () => Promise<T>,
): Promise<T> {
  const injectedDescriptor = 2_147_483_000;
  const nodeFs = createRequire(import.meta.url)("node:fs") as {
    openSync(path: string, flags: string | number, mode?: number): number;
    fsyncSync(descriptor: number): void;
    closeSync(descriptor: number): void;
  };
  const originalOpenSync = nodeFs.openSync;
  const originalFsyncSync = nodeFs.fsyncSync;
  const originalCloseSync = nodeFs.closeSync;
  nodeFs.openSync = (path, flags, mode) =>
    path === directory && flags === "r"
      ? injectedDescriptor
      : originalOpenSync(path, flags, mode);
  nodeFs.fsyncSync = (descriptor) => {
    if (descriptor === injectedDescriptor) throw failure;
    originalFsyncSync(descriptor);
  };
  nodeFs.closeSync = (descriptor) => {
    if (descriptor !== injectedDescriptor) originalCloseSync(descriptor);
  };
  syncBuiltinESMExports();

  try {
    return await operation();
  } finally {
    nodeFs.openSync = originalOpenSync;
    nodeFs.fsyncSync = originalFsyncSync;
    nodeFs.closeSync = originalCloseSync;
    syncBuiltinESMExports();
  }
}

async function applyCanonicalDaemonModeEvent(
  registry: PermissionModeRegistry,
  mode: PermissionMode,
  cwd = "/tmp",
): Promise<{
  readonly applied: boolean;
  readonly previousMode: PermissionMode;
  readonly mode: PermissionMode;
}> {
  const current = registry.current();
  const transitioned = transitionPermissionMode(
    current.mode,
    mode,
    current,
    { workspacePath: cwd },
  );
  if ("error" in transitioned) {
    throw new Error("canonical daemon settings event was refused");
  }
  await registry.update({ ...transitioned, mode });
  return {
    applied: current.mode !== mode,
    previousMode: current.mode,
    mode,
  };
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
    const ownedInitial = registry.current();
    const r = await permissionsCommand.execute(
      stubCtx({ registry, argsRaw: "add deny invalidsyntax[" }),
    );
    expect(r.kind).toBe("error");
    expect(registry.current()).toBe(ownedInitial);
  });

  it("'add allow FileRead --persist user' writes canonical user config.toml", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-perms-"));
    try {
      const configStore = await configStoreFor(tmp);
      const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
      const ctx = stubCtx({
        registry,
        argsRaw: "add allow FileRead --persist user",
        home: tmp,
        configStore,
      });
      const r = await permissionsCommand.execute(ctx);
      if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
      expect(r.text).toMatch(/persisted to userSettings/);
      const file = join(tmp, "config.toml");
      expect(existsSync(file)).toBe(true);
      const on_disk = parseToml(readFileSync(file, "utf8")) as {
        permissions: { allow: string[] };
      };
      expect(on_disk.permissions.allow).toContain("FileRead");
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
      expect(existsSync(join(tmp, ".agenc", "config.toml"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("mutates the daemon first and mirrors its complete canonical session buckets", async () => {
    let initial = createEmptyToolPermissionContext();
    initial = applyPermissionUpdate(initial, {
      type: "addRules",
      destination: "session",
      behavior: "deny",
      rules: [{ toolName: "OldRule" }],
    });
    const registry = new PermissionModeRegistry(initial);
    const ownedInitial = registry.current();
    const commandProjection = vi.spyOn(registry, "transact");
    const mutateDaemonPermissionRule = vi.fn(async () => {
      expect(registry.current()).toBe(ownedInitial);
      let projected = registry.current();
      for (const [behavior, rules] of [
        ["allow", [{ toolName: "system.bash", ruleContent: "ls" }]],
        ["deny", [{ toolName: "Write" }]],
        ["ask", [{ toolName: "FileRead" }]],
      ] as const) {
        projected = applyPermissionUpdate(projected, {
          type: "replaceRules",
          destination: "session",
          behavior,
          rules,
        });
      }
      await registry.update(projected);
      return {
        sessionId: "session_1",
        applied: true,
        operation: "add" as const,
        behavior: "allow" as const,
        rule: "system.bash(ls)",
        sessionRules: {
          allow: ["system.bash(ls)"],
          deny: ["Write"],
          ask: ["FileRead"],
        },
      };
    });
    const session = {
      services: { permissionModeRegistry: registry },
      mutateDaemonPermissionRule,
    } as unknown as Session;

    await expect(
      permissionsCommand.execute(
        stubCtx({
          registry,
          session,
          argsRaw: "add allow system.bash(ls)",
        }),
      ),
    ).resolves.toMatchObject({
      kind: "text",
      text: "Added ALLOW system.bash(ls)",
    });
    expect(mutateDaemonPermissionRule).toHaveBeenCalledWith({
      operation: "add",
      behavior: "allow",
      rule: "system.bash(ls)",
    });
    expect(commandProjection).not.toHaveBeenCalled();
    expect(registry.current().alwaysAllowRules.session).toEqual([
      "system.bash(ls)",
    ]);
    expect(registry.current().alwaysDenyRules.session).toEqual(["Write"]);
    expect(registry.current().alwaysAskRules.session).toEqual(["FileRead"]);
  });

  it("rejects conflicting ConfigStores before mutating a persisted rule", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-perms-store-conflict-"));
    try {
      const sessionHome = join(tmp, "session-home");
      const contextHome = join(tmp, "context-home");
      const sessionStore = await configStoreFor(sessionHome);
      const contextStore = await configStoreFor(contextHome);
      const registry = new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      );
      const ownedInitial = registry.current();
      const session = {
        services: {
          permissionModeRegistry: registry,
          configStore: sessionStore,
        },
        emit: vi.fn(),
        nextInternalSubId: () => "sub-conflict",
      } as unknown as Session;

      await expect(
        permissionsCommand.execute(
          stubCtx({
            registry,
            session,
            configStore: contextStore,
            argsRaw: "add allow FileRead --persist user",
          }),
        ),
      ).resolves.toMatchObject({
        kind: "error",
        message: "Slash command received conflicting ConfigStore authorities",
      });
      expect(registry.current()).toBe(ownedInitial);
      expect(existsSync(join(sessionHome, "config.toml"))).toBe(false);
      expect(existsSync(join(contextHome, "config.toml"))).toBe(false);
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

  it("--persist user removes from canonical user config.toml", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-perms-"));
    try {
      // Seed the settings file first.
      const file = join(tmp, "config.toml");
      mkdirSync(tmp, { recursive: true });
      writeFileSync(
        file,
        'config_version = 2\n[permissions]\nallow = ["FileRead", "system.bash(ls)"]\n',
      );
      const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
      const configStore = await configStoreFor(tmp);
      const r = await permissionsCommand.execute(
        stubCtx({
          registry,
          argsRaw: "remove allow FileRead --persist user",
          home: tmp,
          configStore,
        }),
      );
      if (r.kind !== "text") throw new Error("expected text");
      const on_disk = parseToml(readFileSync(file, "utf8")) as {
        permissions: { allow: string[] };
      };
      expect(on_disk.permissions.allow).not.toContain("FileRead");
      expect(on_disk.permissions.allow).toContain("system.bash(ls)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not mirror or persist a daemon-rejected removal", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-perms-daemon-reject-"));
    try {
      const file = join(tmp, "config.toml");
      writeFileSync(
        file,
        'config_version = 2\n[permissions]\nallow = ["FileRead"]\n',
      );
      let initial = createEmptyToolPermissionContext();
      initial = applyPermissionUpdate(initial, {
        type: "addRules",
        destination: "session",
        behavior: "allow",
        rules: [{ toolName: "FileRead" }],
      });
      const registry = new PermissionModeRegistry(initial);
      const ownedInitial = registry.current();
      const mutateDaemonPermissionRule = vi.fn(async () => {
        throw new Error("permission rules are managed by policy");
      });
      const session = {
        services: { permissionModeRegistry: registry },
        mutateDaemonPermissionRule,
      } as unknown as Session;
      const configStore = await configStoreFor(tmp);

      await expect(
        permissionsCommand.execute(
          stubCtx({
            registry,
            session,
            configStore,
            home: tmp,
            cwd: tmp,
            argsRaw: "remove allow FileRead --persist user",
          }),
        ),
      ).resolves.toMatchObject({
        kind: "error",
        message: "permission rules are managed by policy",
      });
      expect(mutateDaemonPermissionRule).toHaveBeenCalledWith({
        operation: "remove",
        behavior: "allow",
        rule: "FileRead",
      });
      expect(registry.current()).toBe(ownedInitial);
      expect(readFileSync(file, "utf8")).toContain('allow = ["FileRead"]');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

async function configStoreFor(home: string): Promise<ConfigStore> {
  const store = new ConfigStore({
    home,
    env: { AGENC_HOME: home },
    cwd: home,
    projectRoot: home,
    projectTrusted: true,
  });
  await store.reload();
  return store;
}

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

  it("'/permissions mode auto' obeys canonical disable policy when the live gate is open", async () => {
    const restoreGate = __setAutoModeGateResolverForTesting(() => true);
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ isAutoModeAvailable: false }),
    );
    try {
      const r = await permissionsCommand.execute(
        stubCtx({ registry, argsRaw: "mode auto" }),
      );
      expect(r.kind).toBe("error");
      if (r.kind !== "error") throw new Error("expected error");
      expect(r.message).toMatch(/disabled by canonical configuration/);
      expect(registry.current().mode).toBe("default");
    } finally {
      restoreGate();
    }
  });

  it("daemon-backed '/permissions mode auto' cannot bypass canonical disable policy", async () => {
    const restoreGate = __setAutoModeGateResolverForTesting(() => true);
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ isAutoModeAvailable: false }),
    );
    const setDaemonPermissionMode = vi.fn((mode: PermissionMode) =>
      applyCanonicalDaemonModeEvent(registry, mode),
    );
    const session = {
      services: { permissionModeRegistry: registry },
      emit: vi.fn(),
      nextInternalSubId: () => "sub-1",
      setDaemonPermissionMode,
    } as unknown as Session;
    try {
      const r = await permissionsCommand.execute(
        stubCtx({ registry, argsRaw: "mode auto", session }),
      );
      expect(r.kind).toBe("error");
      if (r.kind !== "error") throw new Error("expected error");
      expect(r.message).toMatch(/disabled by canonical configuration/);
      expect(setDaemonPermissionMode).toHaveBeenCalledWith("auto");
      expect(registry.current().mode).toBe("default");
    } finally {
      restoreGate();
    }
  });

  it("'/permissions mode plan' routes to the daemon registry on a bridge session", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const setDaemonPermissionMode = vi.fn((mode: PermissionMode) =>
      applyCanonicalDaemonModeEvent(registry, mode),
    );
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
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-daemon-"));
    try {
      // Pre-populate consent for this real workspace (equivalent to
      // accept-bypass) so canonicalization cannot be bypassed by a fixture.
      const workspace = join(tmp, "workspace");
      mkdirSync(workspace);
      const registry = new PermissionModeRegistry(
        bypassAuthorizedContext(workspace),
      );
      const setDaemonPermissionMode = vi.fn((mode: PermissionMode) =>
        applyCanonicalDaemonModeEvent(registry, mode, workspace),
      );
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
        cwd: workspace,
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
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("'/permissions mode bypassPermissions' surfaces a daemon RPC failure as an error after consent", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-daemon-"));
    try {
      const workspace = join(tmp, "workspace");
      mkdirSync(workspace);
      const registry = new PermissionModeRegistry(
        bypassAuthorizedContext(workspace),
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
        cwd: workspace,
      });
      const r = await permissionsCommand.execute(ctx);
      expect(r.kind).toBe("error");
      if (r.kind !== "error") throw new Error("expected error");
      expect(r.message).toContain("daemon refused");
      // Local registry untouched when the daemon switch fails.
      expect(registry.current().mode).toBe("default");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
      const workspace = join(tmp, "workspace");
      mkdirSync(workspace);
      const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
      const configStore = new ConfigStore({
        home: tmp,
        env: { AGENC_HOME: tmp },
        cwd: workspace,
      });
      const ctx = stubCtx({
        registry,
        argsRaw: "accept-bypass",
        home: tmp,
        cwd: workspace,
        configStore,
      });
      const r = await permissionsCommand.execute(ctx);
      if (r.kind !== "text") {
        throw new Error(
          `expected text, got ${r.kind}: ${
            r.kind === "error" ? r.message : ""
          }`,
        );
      }
      expect(r.text).toContain(workspace);
      // Session-level list updated.
      expect(registry.current().bypassPermissionsAcceptedIn).toContain(
        workspace,
      );
      expect(configStore.stateRepository.getNamespace("permissions")).toEqual({
        bypassPermissionsAcceptedByCwd: {
          [workspace]: persistedBypassConsent(workspace),
        },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not bind daemon-backed consent when persistence is unavailable", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-bypass-no-state-"));
    try {
      const registry = new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      );
      const session = {
        services: { permissionModeRegistry: registry },
        setDaemonPermissionMode: vi.fn(),
      } as unknown as Session;
      const result = await permissionsCommand.execute(
        stubCtx({
          registry,
          session,
          argsRaw: "accept-bypass",
          cwd: workspace,
        }),
      );

      expect(result).toMatchObject({ kind: "error" });
      expect(registry.current().bypassPermissionsAcceptedIn).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not bind or report daemon-backed consent when persistence fails", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-state-fail-"));
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    const configStore = new ConfigStore({
      home: tmp,
      env: { AGENC_HOME: tmp, HOME: tmp },
      cwd: workspace,
    });
    vi.spyOn(configStore.stateRepository, "updateNamespace").mockImplementation(
      () => {
        throw new Error("state fsync failed");
      },
    );
    try {
      const registry = new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      );
      const session = {
        services: { permissionModeRegistry: registry },
        setDaemonPermissionMode: vi.fn(),
      } as unknown as Session;
      const result = await permissionsCommand.execute(
        stubCtx({
          registry,
          session,
          configStore,
          argsRaw: "accept-bypass",
          cwd: workspace,
        }),
      );

      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("state fsync failed"),
      });
      expect(registry.current().bypassPermissionsAcceptedIn).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not persist daemon consent while authority publication is pending", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-pending-"));
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    const configStore = new ConfigStore({
      home: tmp,
      env: { AGENC_HOME: tmp, HOME: tmp },
      cwd: workspace,
    });
    try {
      const registry = new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      );
      const pending = registry.beginExternalAuthorityPublication();
      const session = {
        services: { permissionModeRegistry: registry, configStore },
        setDaemonPermissionMode: vi.fn(),
      } as unknown as Session;

      const result = await permissionsCommand.execute(
        stubCtx({
          registry,
          session,
          configStore,
          argsRaw: "accept-bypass",
          cwd: workspace,
        }),
      );

      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("permission authority is unavailable"),
      });
      expect(
        loadBypassPermissionsConsent(configStore.stateRepository, workspace),
      ).toEqual([]);
      await pending.publish((current) => ({
        next: null,
        result: () => current,
      }));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rolls back durable consent when daemon authority publication rejects", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-publish-fail-"));
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    const configStore = new ConfigStore({
      home: tmp,
      env: { AGENC_HOME: tmp, HOME: tmp },
      cwd: workspace,
    });
    try {
      const registry = new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      );
      const initial = registry.current();
      registry.installPublicationCoordinator(async (
        _next,
        _current,
        _metadata,
        publication,
      ) => {
        await publication.commit();
        throw new Error("daemon authority publication rejected");
      });
      const session = {
        services: { permissionModeRegistry: registry, configStore },
        setDaemonPermissionMode: vi.fn(),
      } as unknown as Session;

      const result = await permissionsCommand.execute(
        stubCtx({
          registry,
          session,
          configStore,
          argsRaw: "accept-bypass",
          cwd: workspace,
        }),
      );

      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("daemon authority publication rejected"),
      });
      expect(registry.current()).toBe(initial);
      expect(
        loadBypassPermissionsConsent(configStore.stateRepository, workspace, {
          reload: true,
        }),
      ).toEqual([]);
    } finally {
      configStore.stateRepository.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not persist daemon consent rejected by the latest policy", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-policy-"));
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    const configStore = new ConfigStore({
      home: tmp,
      env: { AGENC_HOME: tmp, HOME: tmp },
      cwd: workspace,
    });
    try {
      const registry = new PermissionModeRegistry({
        ...createEmptyToolPermissionContext(),
        bypassPermissionsModeDisabledByPolicy: true,
      });
      const session = {
        services: { permissionModeRegistry: registry, configStore },
        setDaemonPermissionMode: vi.fn(),
      } as unknown as Session;

      const result = await permissionsCommand.execute(
        stubCtx({
          registry,
          session,
          configStore,
          argsRaw: "accept-bypass",
          cwd: workspace,
        }),
      );

      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining(
          "managed policy disables it",
        ),
      });
      expect(
        loadBypassPermissionsConsent(configStore.stateRepository, workspace),
      ).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects conflicting ConfigStores before consent mutation", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-store-conflict-"));
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    try {
      const sessionStore = new ConfigStore({
        home: join(tmp, "session-home"),
        cwd: workspace,
        env: {},
      });
      const contextStore = new ConfigStore({
        home: join(tmp, "context-home"),
        cwd: workspace,
        env: {},
      });
      const registry = new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      );
      const ownedInitial = registry.current();
      const session = {
        services: {
          permissionModeRegistry: registry,
          configStore: sessionStore,
        },
        setDaemonPermissionMode: vi.fn(),
      } as unknown as Session;

      await expect(
        permissionsCommand.execute(
          stubCtx({
            registry,
            session,
            configStore: contextStore,
            argsRaw: "accept-bypass",
            cwd: workspace,
          }),
        ),
      ).resolves.toMatchObject({
        kind: "error",
        message: "Slash command received conflicting ConfigStore authorities",
      });
      expect(registry.current()).toBe(ownedInitial);
      expect(
        loadBypassPermissionsConsent(sessionStore.stateRepository, workspace),
      ).toEqual([]);
      expect(
        loadBypassPermissionsConsent(contextStore.stateRepository, workspace),
      ).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("binds daemon-backed consent when state committed but directory durability is indeterminate", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-state-durability-"));
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    const home = resolveHomeContext(
      { AGENC_HOME: tmp, HOME: tmp },
      { platformHome: tmp },
    );
    const stateRepository = new RuntimeStateRepository(home, {
      storage: "disk",
    });
    const configStore = new ConfigStore({
      home: tmp,
      env: { AGENC_HOME: tmp, HOME: tmp },
      cwd: workspace,
      stateRepository,
    });
    try {
      const registry = new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      );
      const session = {
        services: { permissionModeRegistry: registry },
        setDaemonPermissionMode: vi.fn(),
      } as unknown as Session;
      const failure = Object.assign(
        new Error("injected post-rename directory fsync failure"),
        { code: "EIO" },
      );
      const result = await withInjectedDirectoryFsyncFailure(
        tmp,
        failure,
        () => permissionsCommand.execute(stubCtx({
          registry,
          session,
          configStore,
          argsRaw: "accept-bypass",
          cwd: workspace,
        })),
      );

      expect(result).toMatchObject({
        kind: "text",
        text: expect.stringContaining("persisted to runtime state"),
      });
      expect(registry.current().bypassPermissionsAcceptedIn).toContain(
        workspace,
      );
      expect(
        loadBypassPermissionsConsent(configStore.stateRepository, workspace),
      ).toEqual([workspace]);
      expect(JSON.parse(readFileSync(join(tmp, "state.json"), "utf8")))
        .toMatchObject({
          state: {
            global: {
              permissions: {
                bypassPermissionsAcceptedByCwd: {
                  [workspace]: persistedBypassConsent(workspace),
                },
              },
            },
          },
        });
    } finally {
      configStore.stateRepository.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bridges persisted consent from the client repository to the daemon repository", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-repository-bridge-"));
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace);
    const home = resolveHomeContext(
      { AGENC_HOME: tmp, HOME: tmp },
      { platformHome: tmp },
    );
    const clientRepository = new RuntimeStateRepository(home, {
      storage: "disk",
    });
    const daemonRepository = new RuntimeStateRepository(home, {
      storage: "disk",
    });
    const configStore = new ConfigStore({
      home: tmp,
      env: { AGENC_HOME: tmp, HOME: tmp },
      cwd: workspace,
      stateRepository: clientRepository,
    });
    try {
      const registry = new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      );
      const setDaemonPermissionMode = vi.fn(async (mode: PermissionMode) => {
        if (
          loadBypassPermissionsConsent(daemonRepository, workspace, {
            reload: true,
          }).length === 0
        ) {
          throw new Error("daemon did not observe durable consent");
        }
        return applyCanonicalDaemonModeEvent(registry, mode, workspace);
      });
      const session = {
        services: { permissionModeRegistry: registry },
        setDaemonPermissionMode,
      } as unknown as Session;
      const base = {
        registry,
        session,
        configStore,
        cwd: workspace,
      };

      await expect(
        permissionsCommand.execute(stubCtx({ ...base, argsRaw: "accept-bypass" })),
      ).resolves.toMatchObject({ kind: "text" });
      await expect(
        permissionsCommand.execute(
          stubCtx({ ...base, argsRaw: "mode bypassPermissions" }),
        ),
      ).resolves.toMatchObject({ kind: "text" });
      expect(setDaemonPermissionMode).toHaveBeenCalledWith(
        "bypassPermissions",
      );
      expect(registry.current().mode).toBe("bypassPermissions");
    } finally {
      clientRepository.close();
      daemonRepository.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("second '/permissions mode bypassPermissions' succeeds after accept-bypass", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-bypass-"));
    try {
      const workspace = join(tmp, "workspace");
      mkdirSync(workspace);
      const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
      // Step 1: accept-bypass.
      const acceptRes = await permissionsCommand.execute(
        stubCtx({
          registry,
          argsRaw: "accept-bypass",
          home: tmp,
          cwd: workspace,
        }),
      );
      expect(acceptRes.kind).toBe("text");

      // Step 2: switch to bypassPermissions — should now succeed.
      const modeRes = await permissionsCommand.execute(
        stubCtx({
          registry,
          argsRaw: "mode bypassPermissions",
          home: tmp,
          cwd: workspace,
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
