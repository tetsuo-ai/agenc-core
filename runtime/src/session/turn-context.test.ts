/**
 * Tests for `turn-context.ts`.
 *
 * Covers the two audit-surfaced gaps plus the shallow-freeze fix:
 *   - A2 OAuth gate (`imageGenerationToolAuthAllowed`): codex parity —
 *     only ChatGPT OAuth mode unlocks image generation.
 *   - D3 SessionConfiguration fields + `applySessionConfiguration`:
 *     legacy-FS-policy preservation on cwd-only updates.
 *   - I-30 depth: deep-freeze rejects nested mutation on the per-turn
 *     config snapshot.
 */

import { describe, expect, test } from "vitest";
import {
  applySessionConfiguration,
  buildPerTurnConfig,
  buildTurnContext,
  codexHome,
  deepFreeze,
  deriveFileSystemSandboxPolicyForMode,
  imageGenerationToolAuthAllowed,
  isChatgptAuth,
  newDefaultTurn,
  newDefaultTurnWithSubId,
  newTurnWithSubId,
  threadConfigSnapshot,
  toTurnContextItem,
  type AuthManager,
  type Config,
  type ManagedFeatures,
  type ModelInfo,
  type SessionConfiguration,
  type SessionForTurn,
} from "./turn-context.js";
import type { LLMProvider } from "../llm/types.js";

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
  return {
    model: "test-model",
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function mkModelInfo(): ModelInfo {
  return {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(): SessionConfiguration {
  return {
    cwd: "/tmp",
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: ["/workspace"],
      denyWrite: ["/workspace/secrets"],
      allowRead: ["/workspace"],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
}

function mkProvider(): LLMProvider {
  return {
    name: "stub-provider",
    chat: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
    chatStream: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
  } as unknown as LLMProvider;
}

// ─────────────────────────────────────────────────────────────────────
// A2 — image-generation OAuth gate parity
// ─────────────────────────────────────────────────────────────────────

describe("imageGenerationToolAuthAllowed (codex AuthMode::Chatgpt parity)", () => {
  test("returns false when no AuthManager is present", () => {
    expect(imageGenerationToolAuthAllowed(undefined)).toBe(false);
  });

  test("bearer_key auth is rejected", () => {
    const auth: AuthManager = { mode: "bearer_key" };
    expect(imageGenerationToolAuthAllowed(auth)).toBe(false);
    expect(isChatgptAuth(auth)).toBe(false);
  });

  test("local_no_auth is rejected", () => {
    const auth: AuthManager = { mode: "local_no_auth" };
    expect(imageGenerationToolAuthAllowed(auth)).toBe(false);
    expect(isChatgptAuth(auth)).toBe(false);
  });

  test("oauth without ChatGPT provider is rejected", () => {
    const auth: AuthManager = { mode: "oauth", authProvider: "xai" };
    expect(imageGenerationToolAuthAllowed(auth)).toBe(false);
    expect(isChatgptAuth(auth)).toBe(false);
  });

  test("oauth with missing authProvider is rejected (no default to chatgpt)", () => {
    const auth: AuthManager = { mode: "oauth" };
    expect(imageGenerationToolAuthAllowed(auth)).toBe(false);
    expect(isChatgptAuth(auth)).toBe(false);
  });

  test("oauth + chatgpt provider unlocks image generation", () => {
    const auth: AuthManager = { mode: "oauth", authProvider: "chatgpt" };
    expect(imageGenerationToolAuthAllowed(auth)).toBe(true);
    expect(isChatgptAuth(auth)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// D3 — SessionConfiguration fields + apply/helpers
// ─────────────────────────────────────────────────────────────────────

describe("SessionConfiguration helpers", () => {
  test("codexHome accessor returns the stored codexHome value", () => {
    const sc: SessionConfiguration = {
      ...mkSessionConfiguration(),
      codexHome: "/home/u/.agenc",
    };
    expect(codexHome(sc)).toBe("/home/u/.agenc");
  });

  test("threadConfigSnapshot returns a fresh shallow copy", () => {
    const sc = mkSessionConfiguration();
    const a = threadConfigSnapshot(sc);
    const b = threadConfigSnapshot(sc);
    expect(a).not.toBe(b);
    expect(a.model).toBe("test-model");
    expect(a.sessionSource).toBe("cli_main");
    expect(a.sandboxPolicy).toBe("read_only");
    expect(a.cwd).toBe("/tmp");
  });

  test("apply: cwd-only update preserves fileSystemSandboxPolicy", () => {
    const current = mkSessionConfiguration();
    const next = applySessionConfiguration(current, { cwd: "/workspace/v2" });
    expect(next.cwd).toBe("/workspace/v2");
    // Richer allow/deny lists must not be silently rederived when only
    // cwd changed.
    expect(next.fileSystemSandboxPolicy).toBe(current.fileSystemSandboxPolicy);
    expect(next.fileSystemSandboxPolicy.allowWrite).toEqual(["/workspace"]);
    expect(next.fileSystemSandboxPolicy.denyWrite).toEqual([
      "/workspace/secrets",
    ]);
  });

  test("apply: approval + sandbox policy fields merge correctly", () => {
    const current: SessionConfiguration = {
      ...mkSessionConfiguration(),
      approvalPolicy: {
        value: "never",
        allowed: ["never", "on_request"],
      },
    };
    const next = applySessionConfiguration(current, {
      approvalPolicy: "on_request",
      sandboxPolicy: "workspace_write",
    });
    expect(next.approvalPolicy.value).toBe("on_request");
    expect(next.approvalPolicy.allowed).toEqual(["never", "on_request"]);
    expect(next.sandboxPolicy.value).toBe("workspace_write");
    // A sandbox-policy change now rebuilds `fileSystemSandboxPolicy`
    // from the new mode via `deriveFileSystemSandboxPolicyForMode`,
    // matching codex `apply_sandbox_policy_changes`. The deny-entry
    // preservation still lands with T11; this default projection
    // covers the zero-op "new richer policy" baseline.
    expect(next.fileSystemSandboxPolicy).not.toBe(
      current.fileSystemSandboxPolicy,
    );
    expect(next.fileSystemSandboxPolicy.allowWrite).toEqual([current.cwd]);
    expect(next.fileSystemSandboxPolicy.denyWrite).toEqual([]);
  });

  test("apply: empty updates returns an equivalent configuration", () => {
    const current = mkSessionConfiguration();
    const next = applySessionConfiguration(current, {});
    expect(next).not.toBe(current); // new object
    expect(next.cwd).toBe(current.cwd);
    expect(next.collaborationMode).toBe(current.collaborationMode);
    expect(next.fileSystemSandboxPolicy).toBe(current.fileSystemSandboxPolicy);
  });
});

// ─────────────────────────────────────────────────────────────────────
// I-30 — deep-freeze enforcement at depth
// ─────────────────────────────────────────────────────────────────────

describe("deepFreeze / buildTurnContext I-30 snapshot", () => {
  test("deepFreeze rejects nested mutation", () => {
    const obj = {
      nested: { allowLoginShell: false, list: ["a", "b"] },
    };
    deepFreeze(obj);
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.nested)).toBe(true);
    expect(Object.isFrozen(obj.nested.list)).toBe(true);
    expect(() => {
      (obj.nested as { allowLoginShell: boolean }).allowLoginShell = true;
    }).toThrow(TypeError);
  });

  test("buildTurnContext produces a deep-frozen config (nested permissions locked)", () => {
    const ctx = buildTurnContext({
      conversationId: "conv-1",
      subId: "sub-1",
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      sessionConfiguration: mkSessionConfiguration(),
      clock: { currentDate: "2026-04-20", timezone: "Etc/UTC" },
    });
    expect(Object.isFrozen(ctx.config)).toBe(true);
    expect(Object.isFrozen(ctx.config.permissions)).toBe(true);
    expect(Object.isFrozen(ctx.configSnapshot)).toBe(true);
    expect(() => {
      (
        ctx.config.permissions as unknown as { allowLoginShell: boolean }
      ).allowLoginShell = true;
    }).toThrow(TypeError);
  });

  test("buildTurnContext freezing does not mutate caller's live config", () => {
    const live = mkConfig();
    buildTurnContext({
      conversationId: "conv-2",
      subId: "sub-2",
      config: live,
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      sessionConfiguration: mkSessionConfiguration(),
      clock: { currentDate: "2026-04-20", timezone: "Etc/UTC" },
    });
    // The caller's live object should remain unfrozen (deep-clone before
    // freeze prevents leaking readonly state onto the caller).
    expect(Object.isFrozen(live)).toBe(false);
    expect(Object.isFrozen(live.permissions)).toBe(false);
  });

  test("deepFreeze on a Map rejects .set / .delete / .clear", () => {
    const m = new Map<string, number>([["a", 1]]);
    deepFreeze(m);
    expect(() => m.set("b", 2)).toThrow(TypeError);
    expect(() => m.delete("a")).toThrow(TypeError);
    expect(() => m.clear()).toThrow(TypeError);
    // Reads still work.
    expect(m.get("a")).toBe(1);
    expect(m.size).toBe(1);
  });

  test("deepFreeze on a Set rejects .add / .delete / .clear", () => {
    const s = new Set<string>(["x"]);
    deepFreeze(s);
    expect(() => s.add("y")).toThrow(TypeError);
    expect(() => s.delete("x")).toThrow(TypeError);
    expect(() => s.clear()).toThrow(TypeError);
    expect(s.has("x")).toBe(true);
    expect(s.size).toBe(1);
  });

  test("deepFreeze recursively freezes Map values", () => {
    const inner = { flag: false };
    const m = new Map<string, typeof inner>([["k", inner]]);
    deepFreeze(m);
    expect(Object.isFrozen(inner)).toBe(true);
    expect(() => {
      (inner as { flag: boolean }).flag = true;
    }).toThrow(TypeError);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Sandbox-policy cascade on applySessionConfiguration
// ─────────────────────────────────────────────────────────────────────

describe("applySessionConfiguration sandbox cascade", () => {
  test("danger_full_access rebuilds to unrestricted (empty allow/deny)", () => {
    const current = mkSessionConfiguration();
    const next = applySessionConfiguration(current, {
      sandboxPolicy: "danger_full_access",
    });
    expect(next.sandboxPolicy.value).toBe("danger_full_access");
    expect(next.fileSystemSandboxPolicy).toEqual({
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    });
  });

  test("workspace_write rebuilds allowWrite to the current cwd", () => {
    const current = mkSessionConfiguration();
    const next = applySessionConfiguration(current, {
      sandboxPolicy: "workspace_write",
    });
    expect(next.sandboxPolicy.value).toBe("workspace_write");
    expect(next.fileSystemSandboxPolicy.allowWrite).toEqual([current.cwd]);
    expect(next.fileSystemSandboxPolicy.denyWrite).toEqual([]);
  });

  test("read_only rebuilds denyWrite to the current cwd", () => {
    const current = mkSessionConfiguration();
    const next = applySessionConfiguration(current, {
      sandboxPolicy: "read_only",
    });
    expect(next.sandboxPolicy.value).toBe("read_only");
    expect(next.fileSystemSandboxPolicy.allowWrite).toEqual([]);
    expect(next.fileSystemSandboxPolicy.denyWrite).toEqual([current.cwd]);
  });

  test("external_sandbox rebuilds to an empty policy", () => {
    const current = mkSessionConfiguration();
    const next = applySessionConfiguration(current, {
      sandboxPolicy: "external_sandbox",
    });
    expect(next.sandboxPolicy.value).toBe("external_sandbox");
    expect(next.fileSystemSandboxPolicy).toEqual({
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    });
  });

  test("sandbox change + cwd change honors the new cwd in the rebuilt policy", () => {
    const current = mkSessionConfiguration();
    const next = applySessionConfiguration(current, {
      sandboxPolicy: "workspace_write",
      cwd: "/workspace/v2",
    });
    expect(next.cwd).toBe("/workspace/v2");
    expect(next.fileSystemSandboxPolicy.allowWrite).toEqual(["/workspace/v2"]);
  });

  test("deriveFileSystemSandboxPolicyForMode is the exported helper", () => {
    expect(
      deriveFileSystemSandboxPolicyForMode("workspace_write", "/w").allowWrite,
    ).toEqual(["/w"]);
    expect(
      deriveFileSystemSandboxPolicyForMode("read_only", "/w").denyWrite,
    ).toEqual(["/w"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Codex `impl Session` turn-builder helpers
// ─────────────────────────────────────────────────────────────────────

function mkSessionForTurn(overrides: Partial<SessionForTurn> = {}): SessionForTurn {
  let subCounter = 0;
  return {
    conversationId: "conv-s",
    sessionConfiguration: mkSessionConfiguration(),
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    provider: mkProvider(),
    nextInternalSubId: () => {
      subCounter += 1;
      return `sub-${subCounter}`;
    },
    ...overrides,
  };
}

describe("codex-parity turn-builder helpers", () => {
  test("buildPerTurnConfig returns a frozen snapshot that cannot be mutated", () => {
    const session = mkSessionForTurn();
    const snap = buildPerTurnConfig(session);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.permissions)).toBe(true);
    expect(() => {
      (snap as unknown as { model: string }).model = "other";
    }).toThrow(TypeError);
  });

  test("buildPerTurnConfig applies overrides without mutating the live session config", () => {
    const session = mkSessionForTurn();
    const originalModel = session.config.model;
    const snap = buildPerTurnConfig(session, { model: "override-model" });
    expect(snap.model).toBe("override-model");
    expect(session.config.model).toBe(originalModel);
  });

  test("newDefaultTurnWithSubId uses the supplied sub-id and produces a frozen config", () => {
    const session = mkSessionForTurn();
    const ctx = newDefaultTurnWithSubId(session, "sub-fixed");
    expect(ctx.subId).toBe("sub-fixed");
    expect(Object.isFrozen(ctx.config)).toBe(true);
    expect(ctx.cwd).toBe(session.sessionConfiguration.cwd);
  });

  test("newDefaultTurn allocates a sub-id via the session allocator", () => {
    const session = mkSessionForTurn();
    const a = newDefaultTurn(session);
    const b = newDefaultTurn(session);
    expect(a.subId).toBe("sub-1");
    expect(b.subId).toBe("sub-2");
  });

  test("newTurnWithSubId applies per-turn config overrides before freezing", () => {
    const session = mkSessionForTurn();
    const ctx = newTurnWithSubId(session, "sub-x", { model: "overridden" });
    expect(ctx.subId).toBe("sub-x");
    expect(ctx.config.model).toBe("overridden");
    expect(Object.isFrozen(ctx.config)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// TurnContextItem field parity with toTurnContextItem writer
// ─────────────────────────────────────────────────────────────────────

describe("toTurnContextItem field parity", () => {
  test("all 8 extended fields round-trip through toTurnContextItem", () => {
    const sc: SessionConfiguration = {
      ...mkSessionConfiguration(),
      userInstructions: "user-inst",
      developerInstructions: "dev-inst",
    };
    const ctx = buildTurnContext({
      conversationId: "conv-p",
      subId: "sub-p",
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      sessionConfiguration: sc,
      clock: { currentDate: "2026-04-20", timezone: "Etc/UTC" },
    });
    const item = toTurnContextItem(ctx);
    // Fields the rollout reader consumes directly (no typed cast):
    expect(item.realtimeActive).toBe(false);
    expect(item.userInstructions).toBe("user-inst");
    expect(item.developerInstructions).toBe("dev-inst");
    expect(item.finalOutputJsonSchema).toBeUndefined();
    expect(item.truncationPolicy).toBe("off");
    expect(item.collaborationMode).toEqual({ model: "test-model" });
    expect(item.fileSystemSandboxPolicy).toEqual(
      sc.fileSystemSandboxPolicy,
    );
    // traceId is undefined on a fresh context but the field exists.
    expect("traceId" in item).toBe(true);
  });
});
