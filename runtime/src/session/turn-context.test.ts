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
  buildTurnContext,
  codexHome,
  deepFreeze,
  imageGenerationToolAuthAllowed,
  isChatgptAuth,
  threadConfigSnapshot,
  type AuthManager,
  type Config,
  type ManagedFeatures,
  type ModelInfo,
  type SessionConfiguration,
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
    // File-system split policy is preserved even when sandbox policy
    // changed; the deny-preserving rebuild lands with T11.
    expect(next.fileSystemSandboxPolicy).toBe(current.fileSystemSandboxPolicy);
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
});
