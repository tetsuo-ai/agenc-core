import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const policyLimitsMocks = vi.hoisted(() => ({
  configurePolicyLimitsService: vi.fn(),
}));

vi.mock("../services/policyLimits/index.js", () => ({
  configurePolicyLimitsService: policyLimitsMocks.configurePolicyLimitsService,
}));

import {
  ConfiguredHooksRuntime,
  type HookInstallTarget,
} from "../hooks/configured-hooks.js";
import { defaultConfig } from "../config/schema.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type { PostToolUseHook } from "../tools/hooks.js";
import {
  buildBootstrapSessionServices,
  loadBootstrapHooks,
} from "./bootstrap-services.js";

afterEach(() => {
  policyLimitsMocks.configurePolicyLimitsService.mockReset();
});

describe("loadBootstrapHooks", () => {
  test("installs the built-in auto-fix post hook once across reloads", () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-bootstrap-hooks-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    const autoFixHook: PostToolUseHook = () => ({ kind: "continue" });
    const config = {
      ...defaultConfig(),
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command" as const,
                command: "node -e 'process.exit(0)'",
              },
            ],
          },
        ],
      },
    };

    runtime.attachTarget(target);
    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      config,
      autoFixPostToolHook: autoFixHook,
    });
    expect(target.postToolUseHooks).toHaveLength(2);
    expect(target.postToolUseHooks.at(-1)).toBe(autoFixHook);

    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      config,
      autoFixPostToolHook: autoFixHook,
    });
    expect(target.postToolUseHooks).toHaveLength(2);
    expect(target.postToolUseHooks.filter((hook) => hook === autoFixHook)).toHaveLength(1);

    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      config: { ...defaultConfig(), hooks: undefined },
      autoFixPostToolHook: autoFixHook,
    });
    expect(target.postToolUseHooks).toEqual([autoFixHook]);
  });
});

describe("buildBootstrapSessionServices policy limits wiring", () => {
  test("initializes policy limits and stops polling on shutdown", () => {
    const stopBackgroundPolling = vi.fn();
    const policyLimits = {
      initializePolicyLimitsLoadingPromise: vi.fn(),
      loadPolicyLimits: vi.fn(async () => {}),
      stopBackgroundPolling,
    };
    policyLimitsMocks.configurePolicyLimitsService.mockReturnValue(
      policyLimits as never,
    );
    const home = mkdtempSync(join(tmpdir(), "agenc-policy-bootstrap-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-policy-bootstrap-ws-"));
    try {
      const handle = buildBootstrapSessionServices({
        provider: {
          name: "anthropic",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
          chatStream: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
          healthCheck: async () => true,
        },
        providerName: "anthropic",
        apiKey: "direct-policy-key",
        registry: { tools: [] } as never,
        mcpManager: {} as never,
        unifiedExecManager: {} as never,
        permissionModeRegistry: new PermissionModeRegistry(
          createEmptyToolPermissionContext(),
        ),
        configStore: {
          current: () => defaultConfig(),
          subscribe: () => () => {},
        } as never,
        toolApprovals: {
          get: () => undefined,
          set: () => {},
          clear: () => {},
          withCachedApproval: async (request: {
            fetchDecision: () => Promise<unknown>;
          }) => request.fetchDecision(),
        } as never,
        networkApproval: {
          clearSessionHosts: () => {},
          requestNetworkApproval: async () => ({ kind: "approved" }),
          requestDeferredApproval: async () => ({ kind: "approved" }),
        } as never,
        modelsManager: {} as never,
        agencHome: home,
        workspaceRoot: workspace,
        env: { HOME: home, SHELL: "/bin/sh" },
        conversationId: "session-policy-bootstrap",
        model: "agenc-opus-4-7",
        sessionConfiguration: {} as never,
      });

      expect(policyLimitsMocks.configurePolicyLimitsService).toHaveBeenCalledWith(
        expect.objectContaining({
          agencHome: home,
          providerName: "anthropic",
          apiKey: "direct-policy-key",
          sessionId: "session-policy-bootstrap",
        }),
      );
      expect(policyLimits.initializePolicyLimitsLoadingPromise).toHaveBeenCalled();
      expect(policyLimits.loadPolicyLimits).toHaveBeenCalled();
      expect(handle.services.policyLimits).toBe(policyLimits);

      handle.shutdown();

      expect(stopBackgroundPolling).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
