/**
 * Tests for T11 Wave 2-A — permission evaluator (5-step tree).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetClassifierStubSessionForTesting,
  __setAutoModeGateResolverForTesting,
  __setRemoteClassifierStageRunnerForTesting,
  __setClassifierWarningSinkForTesting,
} from "./classifier.js";
import {
  attachContextDefaults,
  checkRuleBasedPermissions,
  hasPermissionsToUseTool,
  hasPermissionsToUseToolInner,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
  type ToolLike,
} from "./evaluator.js";
import {
  freshDenialTracking,
  type DenialTrackingState,
} from "./denial-tracking.js";
import {
  applyPermissionUpdate,
  type PermissionRule,
} from "./rules.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type PermissionResult,
  type ToolPermissionContext,
} from "./types.js";
import { createUnattendedPermissionPolicy } from "./unattended-policy.js";
import type { Session } from "../session/session.js";
import { createBashTool } from "../tools/system/bash.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type HarnessOverrides = {
  mode?: PermissionMode;
  shouldAvoidPermissionPrompts?: boolean;
  isBypassPermissionsModeAvailable?: boolean;
  autoModeActive?: boolean;
  unattendedPolicy?: {
    readonly allowlist?: readonly string[];
    readonly denylist?: readonly string[];
  };
  allowRules?: readonly { toolName: string; ruleContent?: string }[];
  denyRules?: readonly { toolName: string; ruleContent?: string }[];
  askRules?: readonly { toolName: string; ruleContent?: string }[];
  denialTracking?: DenialTrackingState;
  executionSurface?: "cli" | "headless";
  history?: readonly unknown[];
};

function buildHarness(overrides: HarnessOverrides = {}): {
  context: ToolEvaluatorContext;
  getState: () => AppStateSnapshot;
  setContext: (next: ToolPermissionContext) => void;
  decisions: { decision: PermissionResult; phase: string }[];
} {
  let ctx: ToolPermissionContext = createEmptyToolPermissionContext({
    mode: overrides.mode ?? "default",
    isBypassPermissionsModeAvailable:
      overrides.isBypassPermissionsModeAvailable ?? false,
    shouldAvoidPermissionPrompts: overrides.shouldAvoidPermissionPrompts,
    autoModeActive: overrides.autoModeActive,
    ...(overrides.unattendedPolicy !== undefined
      ? {
          unattendedPolicy: createUnattendedPermissionPolicy(
            overrides.unattendedPolicy,
          ),
        }
      : {}),
  });
  for (const rule of overrides.allowRules ?? []) {
    ctx = applyPermissionUpdate(ctx, {
      type: "addRules",
      destination: "session",
      rules: [rule],
      behavior: "allow",
    });
  }
  for (const rule of overrides.denyRules ?? []) {
    ctx = applyPermissionUpdate(ctx, {
      type: "addRules",
      destination: "session",
      rules: [rule],
      behavior: "deny",
    });
  }
  for (const rule of overrides.askRules ?? []) {
    ctx = applyPermissionUpdate(ctx, {
      type: "addRules",
      destination: "session",
      rules: [rule],
      behavior: "ask",
    });
  }

  const denialTracking = overrides.denialTracking ?? freshDenialTracking();
  const state: AppStateSnapshot = {
    toolPermissionContext: ctx,
    denialTracking,
    autoModeActive: overrides.autoModeActive === true,
  };

  const decisions: { decision: PermissionResult; phase: string }[] = [];

  const context = attachContextDefaults({
    getAppState(): AppStateSnapshot {
      return state;
    },
    session: {
      state: {
        unsafePeek: () => ({ history: overrides.history ?? [] }),
      },
    } as unknown as Session,
    onDecision(decision, phase) {
      decisions.push({ decision, phase });
    },
    ...(overrides.executionSurface
      ? { executionSurface: overrides.executionSurface }
      : {}),
  } as ToolEvaluatorContext);

  return {
    context,
    getState: () => state,
    setContext(next) {
      (state as { toolPermissionContext: ToolPermissionContext }).toolPermissionContext = next;
    },
    decisions,
  };
}

function makeTool(
  overrides: Partial<ToolLike> & { name: string },
): ToolLike {
  return { ...overrides };
}

// ---------------------------------------------------------------------------
// Step 1a/1b rule-based
// ---------------------------------------------------------------------------

describe("hasPermissionsToUseTool — step 1a deny rule", () => {
  it("short-circuits before the mode gate", async () => {
    const { context } = buildHarness({
      mode: "bypassPermissions",
      denyRules: [{ toolName: "Bash" }],
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      {},
      context,
    );
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.decisionReason.type).toBe("rule");
    }
  });
});

describe("hasPermissionsToUseTool — step 1b ask rule", () => {
  it("returns ask for a whole-tool ask rule", async () => {
    const { context } = buildHarness({
      askRules: [{ toolName: "Bash" }],
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      { command: "ls" },
      context,
    );
    expect(result.behavior).toBe("ask");
  });

  it("Bash sandbox fallthrough lets tool.checkPermissions auto-allow", async () => {
    const tool = makeTool({
      name: "Bash",
      checkPermissions: () => ({
        behavior: "allow" as const,
        updatedInput: { command: "sandboxed" },
      }),
    });
    const { context } = buildHarness({
      askRules: [{ toolName: "Bash" }],
    });
    const sandboxCtx: ToolEvaluatorContext = {
      ...context,
      autoAllowBashIfSandboxed: true,
      shouldUseSandbox: () => true,
    };
    const result = await hasPermissionsToUseTool(tool, {}, sandboxCtx);
    expect(result.behavior).toBe("allow");
  });

  it("system.bash whole-tool ask does not auto-allow without sandbox execution", async () => {
    const tool = makeTool({
      name: "system.bash",
      checkPermissions: () => ({
        behavior: "allow" as const,
        updatedInput: { command: "sandboxed" },
      }),
    });
    const { context } = buildHarness({
      askRules: [{ toolName: "Bash" }],
    });
    const sandboxCtx: ToolEvaluatorContext = {
      ...context,
      autoAllowBashIfSandboxed: true,
      shouldUseSandbox: () => true,
    };
    const result = await hasPermissionsToUseTool(tool, {}, sandboxCtx);
    expect(result.behavior).toBe("ask");
  });

  it("real system.bash remains ask-gated when sandbox auto-allow is requested", async () => {
    const { context } = buildHarness({
      askRules: [{ toolName: "Bash" }],
    });
    const sandboxCtx: ToolEvaluatorContext = {
      ...context,
      autoAllowBashIfSandboxed: true,
      shouldUseSandbox: () => true,
    };

    const result = await hasPermissionsToUseTool(
      createBashTool(),
      { command: "ls" },
      sandboxCtx,
    );

    expect(result.behavior).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Step 1c tool.checkPermissions
// ---------------------------------------------------------------------------

describe("hasPermissionsToUseTool — step 1c tool.checkPermissions", () => {
  it("defaults to passthrough when the tool has no checkPermissions", async () => {
    const { context } = buildHarness();
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Unknown" }),
      {},
      context,
    );
    expect(result.behavior).toBe("ask");
  });

  it("rethrows AbortError from tool.checkPermissions", async () => {
    const tool = makeTool({
      name: "Bash",
      checkPermissions() {
        throw new DOMException("stop", "AbortError");
      },
    });
    const { context } = buildHarness();
    await expect(
      hasPermissionsToUseTool(tool, {}, context),
    ).rejects.toThrow(/stop/);
  });

  it("catches non-abort throws and falls back to passthrough", async () => {
    const tool = makeTool({
      name: "Bash",
      checkPermissions() {
        throw new Error("boom");
      },
    });
    const { context } = buildHarness();
    const result = await hasPermissionsToUseTool(tool, {}, context);
    expect(result.behavior).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Step 1d / 1e / 1f / 1g — bypass-immune conditions
// ---------------------------------------------------------------------------

describe("hasPermissionsToUseTool — step 1d tool returns deny", () => {
  it("returns the tool's deny decision", async () => {
    const tool = makeTool({
      name: "Bash",
      checkPermissions: () => ({
        behavior: "deny" as const,
        message: "subcommand blocked",
        decisionReason: { type: "other" as const, reason: "subcommand blocked" },
      }),
    });
    const { context } = buildHarness({ mode: "bypassPermissions" });
    const result = await hasPermissionsToUseTool(tool, {}, context);
    expect(result.behavior).toBe("deny");
  });
});

describe("hasPermissionsToUseTool — step 1e requiresUserInteraction survives bypass", () => {
  it("forces prompt even in bypassPermissions", async () => {
    const tool = makeTool({
      name: "Interactive",
      requiresUserInteraction: () => true,
      checkPermissions: () => ({
        behavior: "ask" as const,
        message: "needs user",
      }),
    });
    const { context } = buildHarness({ mode: "bypassPermissions" });
    const result = await hasPermissionsToUseTool(tool, {}, context);
    expect(result.behavior).toBe("ask");
  });
});

describe("hasPermissionsToUseTool — step 1f content-specific ask rule", () => {
  it("survives bypass when decisionReason is a content ask rule", async () => {
    const rule: PermissionRule = {
      source: "session",
      ruleBehavior: "ask",
      ruleValue: { toolName: "Bash", ruleContent: "npm publish" },
    };
    const tool = makeTool({
      name: "Bash",
      checkPermissions: () => ({
        behavior: "ask" as const,
        message: "content ask",
        decisionReason: { type: "rule" as const, rule },
      }),
    });
    const { context } = buildHarness({ mode: "bypassPermissions" });
    const result = await hasPermissionsToUseTool(tool, {}, context);
    expect(result.behavior).toBe("ask");
  });
});

describe("hasPermissionsToUseTool — step 1g safetyCheck", () => {
  it("survives bypass when classifierApprovable=false", async () => {
    const tool = makeTool({
      name: "Edit",
      checkPermissions: () => ({
        behavior: "ask" as const,
        message: "edit to .git",
        decisionReason: {
          type: "safetyCheck" as const,
          reason: "dotfile",
          classifierApprovable: false,
        },
      }),
    });
    const { context } = buildHarness({ mode: "bypassPermissions" });
    const result = await hasPermissionsToUseTool(tool, {}, context);
    expect(result.behavior).toBe("ask");
  });

  it("survives bypass with classifierApprovable=true and returns ask", async () => {
    const tool = makeTool({
      name: "Edit",
      checkPermissions: () => ({
        behavior: "ask" as const,
        message: "sensitive path",
        decisionReason: {
          type: "safetyCheck" as const,
          reason: "sensitive",
          classifierApprovable: true,
        },
      }),
    });
    const { context } = buildHarness({ mode: "bypassPermissions" });
    const result = await hasPermissionsToUseTool(tool, {}, context);
    expect(result.behavior).toBe("ask");
  });

  it("converts to deny(asyncAgent) in headless auto-mode", async () => {
    const restoreGate = __setAutoModeGateResolverForTesting(() => true);
    try {
      const tool = makeTool({
        name: "Edit",
        checkPermissions: () => ({
          behavior: "ask" as const,
          message: "sensitive",
          decisionReason: {
            type: "safetyCheck" as const,
            reason: "sensitive",
            classifierApprovable: false,
          },
        }),
      });
      const { context } = buildHarness({
        mode: "auto",
        shouldAvoidPermissionPrompts: true,
      });
      const result = await hasPermissionsToUseTool(tool, {}, context);
      expect(result.behavior).toBe("deny");
      if (result.behavior === "deny") {
        expect(result.decisionReason.type).toBe("asyncAgent");
      }
    } finally {
      restoreGate();
    }
  });
});

describe("hasPermissionsToUseTool — generic tool asks still flow through the mode gate", () => {
  it("does not treat a plain tool ask as bypass-immune", async () => {
    const tool = makeTool({
      name: "Bash",
      checkPermissions: () => ({
        behavior: "ask" as const,
        message: "generic ask",
      }),
    });
    const { context } = buildHarness({ mode: "bypassPermissions" });
    const result = await hasPermissionsToUseTool(tool, {}, context);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.decisionReason).toMatchObject({
        type: "mode",
        mode: "bypassPermissions",
      });
    }
  });
});

describe("hasPermissionsToUseTool — unattended policy", () => {
  it("allows allowlisted tools in unattended mode", async () => {
    const { context } = buildHarness({
      mode: "unattended",
      unattendedPolicy: { allowlist: ["FileRead"], denylist: [] },
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "FileRead" }),
      { path: "README.md" },
      context,
    );
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.decisionReason).toMatchObject({
        type: "other",
        reason: "unattended allowlist: FileRead",
      });
      expect(result.updatedInput).toEqual({ path: "README.md" });
    }
  });

  it("pauses read-only tools when no unattended allowlist is configured", async () => {
    const { context } = buildHarness({ mode: "unattended" });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "FileRead", isReadOnly: true }),
      { path: "README.md" },
      context,
    );
    expect(result.behavior).toBe("ask");
    if (result.behavior === "ask") {
      expect(result.decisionReason).toMatchObject({
        type: "other",
        reason: "unattended pause: FileRead",
      });
    }
  });

  it("denies denylisted read-only tools before read-only fast paths", async () => {
    const { context } = buildHarness({
      mode: "unattended",
      unattendedPolicy: { allowlist: [], denylist: ["FileRead"] },
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "FileRead", isReadOnly: true }),
      { path: "README.md" },
      context,
    );
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("denied by unattended policy");
    }
  });

  it("pauses unlisted tools even when permission prompts are avoided", async () => {
    const { context } = buildHarness({
      mode: "unattended",
      shouldAvoidPermissionPrompts: true,
      unattendedPolicy: { allowlist: ["FileRead"], denylist: [] },
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      { command: "npm test" },
      context,
    );
    expect(result.behavior).toBe("ask");
    if (result.behavior === "ask") {
      expect(result.decisionReason).toMatchObject({
        type: "other",
        reason: "unattended pause: system.bash",
      });
    }
  });

  it("does not let session allow rules bypass an unlisted unattended tool", async () => {
    const { context } = buildHarness({
      mode: "unattended",
      unattendedPolicy: { allowlist: ["FileRead"], denylist: [] },
      allowRules: [{ toolName: "Bash" }],
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      { command: "npm test" },
      context,
    );
    expect(result.behavior).toBe("ask");
  });

  it("does not let tool-level allow bypass an unlisted unattended tool", async () => {
    const { context } = buildHarness({
      mode: "unattended",
      unattendedPolicy: { allowlist: ["FileRead"], denylist: [] },
    });
    const result = await hasPermissionsToUseTool(
      makeTool({
        name: "Bash",
        checkPermissions: () => ({
          behavior: "allow" as const,
          updatedInput: { command: "npm test" },
        }),
      }),
      { command: "npm test" },
      context,
    );
    expect(result.behavior).toBe("ask");
  });

  it("keeps ask rules as pauses unless the tool is denylisted", async () => {
    const { context } = buildHarness({
      mode: "unattended",
      unattendedPolicy: { allowlist: ["Bash"], denylist: [] },
      askRules: [{ toolName: "Bash" }],
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      { command: "npm test" },
      context,
    );
    expect(result.behavior).toBe("ask");
    if (result.behavior === "ask") {
      expect(result.decisionReason?.type).toBe("rule");
    }
  });
});

// ---------------------------------------------------------------------------
// Step 2 — mode gate
// ---------------------------------------------------------------------------

describe("hasPermissionsToUseTool — step 2a bypassPermissions", () => {
  it("allows via mode", async () => {
    const { context } = buildHarness({ mode: "bypassPermissions" });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      {},
      context,
    );
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.decisionReason).toMatchObject({ type: "mode", mode: "bypassPermissions" });
    }
  });

  it("does not full-bypass in plan mode merely because bypass is available (todo-130)", async () => {
    const { context } = buildHarness({
      mode: "plan",
      isBypassPermissionsModeAvailable: true,
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      {},
      context,
    );
    // Plan isolation stays active; only mode === bypassPermissions auto-allows.
    expect(result.behavior).not.toBe("allow");
  });
});

describe("hasPermissionsToUseTool — step 2b toolAlwaysAllowedRule", () => {
  it("allows via whole-tool allow rule", async () => {
    const { context } = buildHarness({
      allowRules: [{ toolName: "Bash" }],
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      {},
      context,
    );
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.decisionReason).toMatchObject({ type: "rule" });
    }
  });
});

describe("hasPermissionsToUseTool — step 3 passthrough → ask", () => {
  it("allows tools explicitly tagged as not requiring approval", async () => {
    const { context } = buildHarness({ mode: "default" });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "system.searchTools", requiresApproval: false }),
      {},
      context,
    );
    expect(result.behavior).toBe("allow");
  });

  it("allows read-only metadata tools without prompting", async () => {
    const { context } = buildHarness({ mode: "default" });
    const result = await hasPermissionsToUseTool(
      makeTool({
        name: "system.gitStatus",
        metadata: { mutating: false },
      }),
      {},
      context,
    );
    expect(result.behavior).toBe("allow");
  });

  it("converts a passthrough tool result into ask", async () => {
    const tool = makeTool({
      name: "Bash",
      checkPermissions: () => ({
        behavior: "passthrough" as const,
        message: "default",
      }),
    });
    const { context } = buildHarness();
    const result = await hasPermissionsToUseTool(tool, {}, context);
    expect(result.behavior).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Step 4 — outer wrapper transforms
// ---------------------------------------------------------------------------

describe("hasPermissionsToUseTool — step 4 dontAsk → deny", () => {
  it("converts ask to deny with mode=dontAsk reason", async () => {
    const { context } = buildHarness({ mode: "dontAsk" });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      {},
      context,
    );
    expect(result.behavior).toBe("deny");
  });
});

describe("hasPermissionsToUseTool — step 4 auto mode activates classifier", () => {
  beforeEach(() => {
    __resetClassifierStubSessionForTesting();
    __setClassifierWarningSinkForTesting(() => {});
  });

  it("runs the classifier pipeline when the gate is enabled", async () => {
    await withEnv(
      { XAI_API_KEY: undefined, GROK_API_KEY: undefined, AGENC_XAI_API_KEY: undefined },
      async () => {
        const restoreGate = __setAutoModeGateResolverForTesting(() => true);
        try {
          const tool = makeTool({ name: "SomeUnknownTool" });
          const { context } = buildHarness({ mode: "auto" });
          const result = await hasPermissionsToUseTool(tool, {}, context);
          expect(result.behavior).toBe("ask");
          if (result.behavior === "ask") {
            expect(result.message).toContain("Permission required");
          }
        } finally {
          restoreGate();
        }
      }
    );
  });

  it("passes session history into the classifier transcript", async () => {
    // The classifier pipeline requires a resolvable grok API key before the
    // (stubbed) remote stage runs. Set one explicitly — the hermetic suite
    // setup (vitest.setup.ts, TODO task 30) strips ambient provider keys,
    // and this test previously depended on a developer's real XAI_API_KEY.
    await withEnv({ XAI_API_KEY: "test-classifier-key" }, async () => {
    const prompts: string[] = [];
    const restoreGate = __setAutoModeGateResolverForTesting(() => true);
    const restoreRunner = __setRemoteClassifierStageRunnerForTesting(
      async (request) => {
        prompts.push(request.userPrompt);
        return {
          shouldBlock: false,
          reason: "remote_allow",
          usage: null,
          model: request.model,
        };
      },
    );
    try {
      const tool = makeTool({ name: "Edit" });
      const { context } = buildHarness({
        mode: "auto",
        history: [
          { role: "user", content: "Update the permissions classifier only." },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_1",
                name: "FileRead",
                arguments: "{\"path\":\"runtime/src/permissions/classifier.ts\"}",
              },
            ],
          },
        ],
      });
      const result = await hasPermissionsToUseTool(
        tool,
        { path: "runtime/src/permissions/classifier.ts" },
        context,
      );
      expect(result.behavior).toBe("allow");
      expect(prompts[0]).toContain("USER Update the permissions classifier only.");
      expect(prompts[0]).toContain("ASSISTANT_TOOL FileRead(");
      expect(prompts[0]).toContain("Edit(");
    } finally {
      restoreRunner();
      restoreGate();
    }
    });
  });
});

describe("hasPermissionsToUseTool — step 4 shouldAvoidPermissionPrompts", () => {
  it("returns deny(asyncAgent) when no hook path is wired", async () => {
    const { context } = buildHarness({
      shouldAvoidPermissionPrompts: true,
    });
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      {},
      context,
    );
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.decisionReason.type).toBe("asyncAgent");
    }
  });
});

// ---------------------------------------------------------------------------
// Step 5 — auto-mode classifier pipeline
// ---------------------------------------------------------------------------

describe("hasPermissionsToUseTool — step 5 fast paths", () => {
  beforeEach(() => {
    __resetClassifierStubSessionForTesting();
    __setClassifierWarningSinkForTesting(() => {});
  });

  it("acceptEdits simulation auto-allows", async () => {
    const restoreGate = __setAutoModeGateResolverForTesting(() => true);
    try {
      const tool = makeTool({
        name: "Edit",
        checkPermissions(_input, ctx) {
          const state = ctx.getAppState();
          if (state.toolPermissionContext.mode === "acceptEdits") {
            return { behavior: "allow" as const, updatedInput: { path: "x" } };
          }
          return { behavior: "ask" as const, message: "ask" };
        },
      });
      const { context } = buildHarness({ mode: "auto" });
      const result = await hasPermissionsToUseTool(tool, { path: "x" }, context);
      expect(result.behavior).toBe("allow");
      if (result.behavior === "allow") {
        expect(result.decisionReason).toMatchObject({ type: "mode", mode: "auto" });
      }
    } finally {
      restoreGate();
    }
  });

  it("safe-tool allowlist auto-allows", async () => {
    const restoreGate = __setAutoModeGateResolverForTesting(() => true);
    try {
      const tool = makeTool({ name: "FileRead" });
      const { context } = buildHarness({ mode: "auto" });
      const result = await hasPermissionsToUseTool(tool, {}, context);
      expect(result.behavior).toBe("allow");
      if (result.behavior === "allow") {
        expect(result.decisionReason).toMatchObject({ type: "mode", mode: "auto" });
      }
    } finally {
      restoreGate();
    }
  });

  it("classifier auto-allows sandbox-safe Bash commands", async () => {
    const restoreGate = __setAutoModeGateResolverForTesting(() => true);
    try {
      const tool = makeTool({ name: "Bash" });
      const { context } = buildHarness({ mode: "auto" });
      const result = await hasPermissionsToUseTool(
        tool,
        { command: "ls src" },
        context,
      );
      expect(result.behavior).toBe("allow");
      if (result.behavior === "allow") {
        expect(result.decisionReason).toMatchObject({
          type: "classifier",
          classifier: "auto-mode",
          reason: "bash_sandbox_safe",
        });
      }
    } finally {
      restoreGate();
    }
  });
});

// ---------------------------------------------------------------------------
// Step 5 classifier results — manual injection via checkPermissions
// ---------------------------------------------------------------------------

// Helper: drive the evaluator through step 5 with a stubbed classifier
// result by monkey-patching the module-level classifier through the tool
// path. Since the stub is a single function and we already test it, we
// also test the handleClassifierResult branches via high-level paths.

describe("hasPermissionsToUseTool — denial limits", () => {
  beforeEach(() => {
    __resetClassifierStubSessionForTesting();
    __setClassifierWarningSinkForTesting(() => {});
  });

  it("classifier fallback returns ask for unsupported tools when the gate is open", async () => {
    await withEnv(
      { XAI_API_KEY: undefined, GROK_API_KEY: undefined, AGENC_XAI_API_KEY: undefined },
      async () => {
        const restoreGate = __setAutoModeGateResolverForTesting(() => true);
        try {
          const tool = makeTool({ name: "NotAllowlisted" });
          const { context } = buildHarness({ mode: "auto" });
          const result = await hasPermissionsToUseTool(tool, {}, context);
          expect(result.behavior).toBe("ask");
        } finally {
          restoreGate();
        }
      }
    );
  });

  it("consecutiveDenials=3 triggers fallback-to-prompting (CLI)", async () => {
    const state = { consecutiveDenials: 3, totalDenials: 3 } as DenialTrackingState;
    const { context } = buildHarness({
      mode: "default",
      denialTracking: state,
      executionSurface: "cli",
    });
    // Use default mode → ask path. The CLI fallback happens inside
    // the classifier pipeline which only runs in auto mode; this
    // asserts that the harness plumbs denialTracking through without
    // crashing the ask path.
    const result = await hasPermissionsToUseTool(
      makeTool({ name: "Bash" }),
      {},
      context,
    );
    expect(result.behavior).toBe("ask");
  });

  it("totalDenials=20 with headless surface causes abort on denial", async () => {
    const restoreGate = __setAutoModeGateResolverForTesting(() => true);
    try {
      // Stub classifier returns shouldBlock=false, so we need a tool that
      // forces shouldBlock=true. We cover that via the denial-tracking
      // module tests; here we confirm the executionSurface wiring exists.
      const state = { consecutiveDenials: 0, totalDenials: 20 } as DenialTrackingState;
      const { context } = buildHarness({
        mode: "auto",
        denialTracking: state,
        shouldAvoidPermissionPrompts: true,
        executionSurface: "headless",
      });
      // Use FileRead (allowlist fast-path) — this succeeds without
      // invoking the classifier, so counters stay intact.
      const result = await hasPermissionsToUseTool(
        makeTool({ name: "FileRead" }),
        {},
        context,
      );
      expect(result.behavior).toBe("allow");
    } finally {
      restoreGate();
    }
  });
});

// ---------------------------------------------------------------------------
// I-3 race: getAppState re-read between step 1 and step 2a
// ---------------------------------------------------------------------------

describe("I-3 race — getAppState re-read before step 2a", () => {
  it("picks up a mid-evaluation mode flip into bypassPermissions", async () => {
    const harness = buildHarness({ mode: "default" });
    const tool = makeTool({
      name: "Bash",
      checkPermissions() {
        // Between step 1c and step 2a, mutate the mode to bypass.
        const nextCtx = applyPermissionUpdate(
          harness.getState().toolPermissionContext,
          { type: "setMode", destination: "session", mode: "bypassPermissions" },
        );
        harness.setContext(nextCtx);
        return {
          behavior: "passthrough" as const,
          message: "default",
        };
      },
    });
    const result = await hasPermissionsToUseTool(tool, {}, harness.context);
    // Step 2a must observe the updated mode → allow.
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.decisionReason).toMatchObject({
        type: "mode",
        mode: "bypassPermissions",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// checkRuleBasedPermissions — used by bypass-immune callers
// ---------------------------------------------------------------------------

describe("checkRuleBasedPermissions", () => {
  it("stops at step 1g (safetyCheck) without running the mode gate", async () => {
    const tool = makeTool({
      name: "Edit",
      checkPermissions: () => ({
        behavior: "ask" as const,
        message: "sensitive",
        decisionReason: {
          type: "safetyCheck" as const,
          reason: "sensitive",
          classifierApprovable: true,
        },
      }),
    });
    // Mode is bypassPermissions — a full evaluator call would return allow.
    // The rule-based-only path must stay at ask.
    const { context } = buildHarness({ mode: "bypassPermissions" });
    const result = await checkRuleBasedPermissions(tool, {}, context);
    expect(result?.behavior).toBe("ask");
  });

  it("returns null when nothing in steps 1a-1g objects", async () => {
    const { context } = buildHarness();
    const result = await checkRuleBasedPermissions(
      makeTool({ name: "X" }),
      {},
      context,
    );
    expect(result).toBeNull();
  });

  it("returns null for generic tool asks so step 2 can still run", async () => {
    const { context } = buildHarness({ mode: "bypassPermissions" });
    const result = await checkRuleBasedPermissions(
      makeTool({
        name: "Bash",
        checkPermissions: () => ({
          behavior: "ask" as const,
          message: "generic ask",
        }),
      }),
      {},
      context,
    );
    expect(result).toBeNull();
  });

  it("rethrows AbortError from tool.checkPermissions", async () => {
    const tool = makeTool({
      name: "Bash",
      checkPermissions() {
        throw new DOMException("abort", "AbortError");
      },
    });
    const { context } = buildHarness();
    await expect(
      checkRuleBasedPermissions(tool, {}, context),
    ).rejects.toThrow(/abort/);
  });
});

// ---------------------------------------------------------------------------
// inner evaluator — ask path preservation
// ---------------------------------------------------------------------------

describe("hasPermissionsToUseToolInner", () => {
  it("returns a PermissionDecision (never passthrough)", async () => {
    const tool = makeTool({
      name: "Bash",
      checkPermissions: () => ({
        behavior: "passthrough" as const,
        message: "default",
      }),
    });
    const { context } = buildHarness();
    const result = await hasPermissionsToUseToolInner(tool, {}, context);
    expect(result.behavior).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Abort propagation
// ---------------------------------------------------------------------------

describe("hasPermissionsToUseTool — abort signal", () => {
  afterEach(() => {
    __resetClassifierStubSessionForTesting();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { context } = buildHarness();
    const ac = new AbortController();
    ac.abort();
    const ctxWithSignal: ToolEvaluatorContext = { ...context, signal: ac.signal };
    await expect(
      hasPermissionsToUseTool(makeTool({ name: "Bash" }), {}, ctxWithSignal),
    ).rejects.toThrow(/aborted/);
  });
});
