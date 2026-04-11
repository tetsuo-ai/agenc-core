import { describe, expect, it } from "vitest";
import { diffGatewayConfig, validateGatewayConfig } from "./config-watcher.js";

function makeConfig(desktop?: Record<string, unknown>): Record<string, unknown> {
  return {
    gateway: { port: 3100 },
    agent: { name: "test-agent" },
    connection: { rpcUrl: "http://127.0.0.1:8899" },
    ...(desktop ? { desktop } : {}),
  };
}

const AUTH_SECRET = "test-secret-that-is-at-least-32-chars!!";

describe("validateGatewayConfig desktop resource limits", () => {
  it("accepts valid desktop.maxMemory and desktop.maxCpu", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxMemory: "8g",
        maxCpu: "2.5",
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects invalid desktop.maxMemory format", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxMemory: "eight-gb",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "desktop.maxMemory must be a string like 512m or 4g (plain integers are treated as GB)",
    );
  });

  it("rejects invalid desktop.maxCpu format", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxCpu: "two",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "desktop.maxCpu must be a positive numeric string like 0.5 or 2.0",
    );
  });

  it("rejects non-positive desktop.maxCpu values", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxCpu: "0",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("desktop.maxCpu must be greater than 0");
  });

  it("accepts subagent open-question controls", () => {
    const config = makeConfig();
    config.llm = {
      provider: "grok",
      subagents: {
        enabled: true,
        mode: "handoff",
        delegationAggressiveness: "adaptive",
        handoffMinPlannerConfidence: 0.85,
        childProviderStrategy: "capability_matched",
        hardBlockedTaskClasses: [
          "wallet_signing",
          "wallet_transfer",
          "stake_or_rewards",
        ],
      },
    };
    const result = validateGatewayConfig(config);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid subagent open-question controls", () => {
    const config = makeConfig();
    config.llm = {
      provider: "grok",
      subagents: {
        enabled: true,
        delegationAggressiveness: "extreme",
        handoffMinPlannerConfidence: 1.2,
        childProviderStrategy: "random",
        hardBlockedTaskClasses: ["bad_class"],
      },
    };
    const result = validateGatewayConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "llm.subagents.delegationAggressiveness must be one of: conservative, balanced, aggressive, adaptive",
    );
    expect(result.errors).toContain(
      "llm.subagents.handoffMinPlannerConfidence must be a number between 0 and 1",
    );
    expect(result.errors).toContain(
      "llm.subagents.childProviderStrategy must be one of: same_as_parent, capability_matched",
    );
    expect(result.errors).toContain(
      "llm.subagents.hardBlockedTaskClasses[0] must be one of: wallet_signing, wallet_transfer, stake_or_rewards, destructive_host_mutation, credential_exfiltration",
    );
  });

});

describe("validateGatewayConfig plugin channel hosting", () => {
  it("accepts trusted package allowlists and plugin channel entries", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      plugins: {
        trustedPackages: [
          {
            packageName: "@tetsuo-ai/plugin-kit-channel-fixture",
            allowedSubpaths: ["mock"],
          },
        ],
      },
      channels: {
        "fixture-chat": {
          type: "plugin",
          moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/mock",
          config: {
            token: "abc",
          },
        },
      },
    });

    expect(result.valid).toBe(true);
  });

  it("rejects unsafe plugin module specifiers", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      channels: {
        custom: {
          type: "plugin",
          moduleSpecifier: "file:../../evil.mjs",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "channels.custom.moduleSpecifier must be a bare package specifier like @scope/name or @scope/name/subpath",
    );
  });

  it("rejects invalid trusted package names and subpaths", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      plugins: {
        trustedPackages: [
          {
            packageName: "../evil",
            allowedSubpaths: ["../escape"],
          },
        ],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "plugins.trustedPackages[0].packageName must be a bare package name like @scope/name",
    );
    expect(result.errors).toContain(
      "plugins.trustedPackages[0].allowedSubpaths[0] must be a relative package subpath like channels/example",
    );
  });

  it("rejects plugin wrappers on reserved built-in channel names", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      channels: {
        discord: {
          type: "plugin",
          moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/mock",
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'channels.discord.type cannot be "plugin" for reserved built-in channel "discord"',
    );
  });
});

describe("validateGatewayConfig llm unlimited limit semantics", () => {
  it("accepts 0 for provider and execution ceilings that now mean unlimited", () => {
    const config = makeConfig();
    config.llm = {
      provider: "grok",
      timeoutMs: 0,
      requestTimeoutMs: 0,
      toolCallTimeoutMs: 0,
      maxTokens: 0,
      contextWindowTokens: 0,
      maxToolRounds: 0,
      plannerMaxTokens: 0,
      toolBudgetPerRequest: 0,
      maxModelRecallsPerRequest: 0,
      maxFailureBudgetPerRequest: 0,
      sessionTokenBudget: 0,
      subagents: {
        enabled: true,
        maxConcurrent: 0,
        maxDepth: 0,
        maxFanoutPerTurn: 0,
        maxTotalSubagentsPerRequest: 0,
        maxCumulativeToolCallsPerRequestTree: 0,
        maxCumulativeTokensPerRequestTree: 0,
        defaultTimeoutMs: 0,
      },
    };

    const result = validateGatewayConfig(config);
    expect(result.valid).toBe(true);
  });
});

describe("validateGatewayConfig durable async task prerequisites", () => {
  it("rejects memory.backend=memory when runtime contract v2 async tasks are enabled", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      memory: {
        backend: "memory",
      },
      llm: {
        provider: "grok",
        runtimeContractV2: true,
        asyncTasks: {
          enabled: true,
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "memory.backend=memory is invalid when llm.asyncTasks.enabled is true",
    );
  });
});

describe("validateGatewayConfig plugin host policy", () => {
  it("accepts plugin trust policy and plugin-backed channel wrapper fields", () => {
    const config = makeConfig();
    config.plugins = {
      trustedPackages: [
        {
          packageName: "@tetsuo-ai/plugin-kit-channel-example",
          allowedSubpaths: ["runtime"],
        },
      ],
    };
    config.channels = {
      discord: {
        type: "discord",
        token: "secret",
      },
      custom: {
        type: "plugin",
        moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-example/runtime",
        config: {
          endpoint: "https://example.com/webhook",
        },
      },
    };

    const result = validateGatewayConfig(config);

    expect(result.valid).toBe(true);
  });

  it("treats missing channel enabled as valid for legacy compatibility", () => {
    const config = makeConfig();
    config.channels = {
      telegram: {
        botToken: "secret-token",
      },
    };

    const result = validateGatewayConfig(config);

    expect(result.valid).toBe(true);
  });

  it("rejects invalid plugin trust policy and plugin channel wrapper fields", () => {
    const config = makeConfig();
    config.plugins = {
      trustedPackages: [
        {
          packageName: "",
          allowedSubpaths: [123],
        },
      ],
    } as any;
    config.channels = {
      custom: {
        type: "plugin",
        moduleSpecifier: "   ",
        enabled: "yes",
        config: "not-an-object",
      },
    } as any;

    const result = validateGatewayConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "plugins.trustedPackages[0].packageName must be a non-empty string",
    );
    expect(result.errors).toContain(
      "plugins.trustedPackages[0].allowedSubpaths[0] must be a relative package subpath like channels/example",
    );
    expect(result.errors).toContain("channels.custom.enabled must be a boolean");
    expect(result.errors).toContain(
      'channels.custom.moduleSpecifier must be a non-empty string when type is "plugin"',
    );
    expect(result.errors).toContain(
      "channels.custom.config must be an object when provided",
    );
  });
});

describe("validateGatewayConfig telegram connector lifecycle", () => {
  it("accepts a polling-first telegram connector config", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      channels: {
        telegram: {
          enabled: true,
          botToken: "bot-token",
          allowedUsers: [1234, 5678],
          pollingIntervalMs: 1500,
          maxAttachmentBytes: 1024,
          rateLimitPerChat: 2,
        },
      },
    });

    expect(result.valid).toBe(true);
  });

  it("rejects enabled telegram config without a bot token", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      channels: {
        telegram: {
          enabled: true,
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "channels.telegram.botToken must be a non-empty string when telegram is enabled",
    );
  });

  it("rejects invalid telegram webhook path values", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      channels: {
        telegram: {
          enabled: true,
          botToken: "bot-token",
          webhook: {
            url: "https://example.com",
            path: "/custom",
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'channels.telegram.webhook.path must be omitted or exactly "/update"',
    );
  });
});

describe("validateGatewayConfig workspace host path", () => {
  it("accepts a non-empty workspace.hostPath string", () => {
    const config = makeConfig();
    config.workspace = { hostPath: "/home/tetsuo/agent-test" };

    const result = validateGatewayConfig(config);

    expect(result.valid).toBe(true);
  });

  it("rejects a blank workspace.hostPath string", () => {
    const config = makeConfig();
    config.workspace = { hostPath: "   " };

    const result = validateGatewayConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "workspace.hostPath must be a non-empty string",
    );
  });
});

describe("diffGatewayConfig restart-only channel/plugin surfaces", () => {
  it("marks channels and plugins changes as unsafe", () => {
    const oldConfig = makeConfig() as any;
    const newConfig = {
      ...makeConfig(),
      plugins: {
        trustedPackages: [
          { packageName: "@tetsuo-ai/plugin-kit-channel-fixture" },
        ],
      },
      channels: {
        "fixture-chat": {
          type: "plugin",
          enabled: true,
          moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/mock",
        },
      },
    } as any;

    const diff = diffGatewayConfig(oldConfig, newConfig);

    expect(diff.unsafe).toContain("plugins.trustedPackages");
    expect(diff.unsafe).toContain("channels.fixture-chat.type");
    expect(diff.unsafe).toContain("channels.fixture-chat.enabled");
    expect(diff.unsafe).toContain("channels.fixture-chat.moduleSpecifier");
  });
});

describe("validateGatewayConfig autonomy controls", () => {
  it("accepts autonomy notifications, feature flags, kill switches, and canary settings", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      autonomy: {
        enabled: true,
        featureFlags: {
          backgroundRuns: true,
          multiAgent: true,
          notifications: true,
          replayGates: true,
          canaryRollout: true,
        },
        killSwitches: {
          backgroundRuns: false,
          multiAgent: false,
          notifications: false,
          replayGates: false,
          canaryRollout: false,
        },
        slo: {
          runStartLatencyMs: 500,
          updateCadenceMs: 10_000,
          completionAccuracyRate: 0.98,
          recoverySuccessRate: 0.95,
          stopLatencyMs: 1_000,
          eventLossRate: 0,
        },
        canary: {
          enabled: true,
          tenantAllowList: ["tenant-a"],
          featureAllowList: ["multiAgent"],
          domainAllowList: ["research"],
          percentage: 10,
        },
        notifications: {
          enabled: true,
          sinks: [
            {
              id: "ops-webhook",
              type: "webhook",
              url: "https://example.com/hook",
              events: ["run_started", "run_completed"],
              sessionIds: ["session-1"],
              headers: {
                "x-ops-team": "platform",
              },
              signingSecret: "signing-secret",
            },
          ],
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects invalid autonomy notification sink configuration", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      autonomy: {
        notifications: {
          sinks: [
            {
              id: "",
              type: "pagerduty",
              url: "",
              enabled: "yes",
              events: ["bad_event"],
              headers: "bad",
            },
          ],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "autonomy.notifications.sinks[0].id must be a non-empty string",
    );
    expect(result.errors).toContain(
      "autonomy.notifications.sinks[0].type must be one of: webhook, discord_webhook, email_webhook, mobile_push_webhook",
    );
    expect(result.errors).toContain(
      "autonomy.notifications.sinks[0].url must be a non-empty string",
    );
    expect(result.errors).toContain(
      "autonomy.notifications.sinks[0].enabled must be a boolean",
    );
    expect(result.errors).toContain(
      "autonomy.notifications.sinks[0].events[0] must be one of: run_started, run_updated, run_blocked, run_completed, run_failed, run_cancelled, run_controlled",
    );
    expect(result.errors).toContain(
      "autonomy.notifications.sinks[0].headers must be an object",
    );
  });
});

describe("validateGatewayConfig auth safety for bind address", () => {
  it("rejects non-local bind without auth.secret", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      gateway: { port: 3100, bind: "0.0.0.0" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "auth.secret is required when gateway.bind is non-local",
    );
  });

  it("accepts non-local bind with auth.secret", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      gateway: { port: 3100, bind: "0.0.0.0" },
      auth: { secret: AUTH_SECRET },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts loopback bind without auth.secret", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      gateway: { port: 3100, bind: "127.0.0.1" },
    });
    expect(result.valid).toBe(true);
  });
});

describe("validateGatewayConfig policy bundles", () => {
  it("accepts scoped policy budgets and tenant/project bundles", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      policy: {
        enabled: true,
        defaultTenantId: "tenant-a",
        defaultProjectId: "project-x",
        simulationMode: "shadow",
        networkAccess: {
          allowHosts: ["api.example.com"],
          denyHosts: ["blocked.example.com"],
        },
        writeScope: {
          allowRoots: ["/srv/workspace"],
          denyRoots: ["/srv/workspace/secrets"],
        },
        scopedActionBudgets: {
          run: {
            "tool_call:*": { limit: 4, windowMs: 60_000 },
          },
        },
        scopedSpendBudgets: {
          tenant: {
            limitLamports: "1000",
            windowMs: 60_000,
          },
        },
        tokenBudget: {
          limitTokens: 50_000,
          windowMs: 60_000,
        },
        runtimeBudget: {
          maxElapsedMs: 120_000,
        },
        processBudget: {
          maxConcurrent: 4,
        },
        scopedTokenBudgets: {
          run: {
            limitTokens: 5_000,
            windowMs: 30_000,
          },
        },
        scopedRuntimeBudgets: {
          project: {
            maxElapsedMs: 30_000,
          },
        },
        scopedProcessBudgets: {
          tenant: {
            maxConcurrent: 2,
          },
        },
        policyClassRules: {
          credential_secret_access: {
            deny: true,
          },
        },
        audit: {
          enabled: true,
          signingKey: "audit-signing-key",
          retentionMs: 60_000,
          maxEntries: 500,
          retentionMode: "archive",
          legalHold: true,
          redaction: {
            redactActors: true,
            stripFields: ["payload.secret"],
            redactPatterns: ["sk-[a-z0-9]+"],
          },
        },
        credentialCatalog: {
          api_token: {
            sourceEnvVar: "API_TOKEN",
            domains: ["api.example.com"],
            headerTemplates: {
              Authorization: "Bearer ${secret}",
            },
            allowedTools: ["system.httpGet"],
            ttlMs: 30_000,
          },
        },
        tenantBundles: {
          tenant_a: {
            toolDenyList: ["system.bash"],
            credentialAllowList: ["api_token"],
          },
        },
        projectBundles: {
          project_x: {
            actionBudgets: {
              "tool_call:*": { limit: 2, windowMs: 60_000 },
            },
          },
        },
      },
    });

    expect(result.valid).toBe(true);
  });

  it("rejects invalid policy bundle fields", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      policy: {
        enabled: true,
        simulationMode: "preview",
        networkAccess: {
          allowHosts: "api.example.com" as unknown as string[],
        },
        writeScope: {
          denyRoots: "/srv/blocked" as unknown as string[],
        },
        credentialCatalog: {
          broken: {
            sourceEnvVar: "",
            domains: [] as string[],
            headerTemplates: {
              "": 5 as unknown as string,
            },
            ttlMs: 10,
          },
        },
        policyClassRules: {
          not_real: { deny: true },
        },
        scopedSpendBudgets: {
          run: {
            limitLamports: "bad",
            windowMs: "nope" as unknown as number,
          },
        },
        tokenBudget: {
          limitTokens: "bad" as unknown as number,
          windowMs: 60_000,
        },
        runtimeBudget: {
          maxElapsedMs: "bad" as unknown as number,
        },
        processBudget: {
          maxConcurrent: 0,
        },
        scopedTokenBudgets: {
          tenant: {
            limitTokens: 5_000,
            windowMs: "bad" as unknown as number,
          },
        },
        scopedRuntimeBudgets: {
          project: {
            maxElapsedMs: -1,
          },
        },
        scopedProcessBudgets: {
          run: {
            maxConcurrent: "bad" as unknown as number,
          },
        },
        audit: {
          retentionMode: "keep" as unknown as "archive",
          legalHold: "true" as unknown as boolean,
          redaction: {
            stripFields: "nope" as unknown as string[],
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "policy.simulationMode must be one of: off, shadow",
    );
    expect(result.errors).toContain(
      "policy.networkAccess.allowHosts must be an array of strings",
    );
    expect(result.errors).toContain(
      "policy.writeScope.denyRoots must be an array of strings",
    );
    expect(result.errors).toContain(
      "policy.policyClassRules.not_real is not a valid policy class",
    );
    expect(result.errors).toContain(
      "policy.scopedSpendBudgets.run.limitLamports must be a decimal string",
    );
    expect(result.errors).toContain(
      "policy.scopedSpendBudgets.run.windowMs must be a number",
    );
    expect(result.errors).toContain(
      "policy.tokenBudget.limitTokens must be a finite positive number",
    );
    expect(result.errors).toContain(
      "policy.runtimeBudget.maxElapsedMs must be a finite positive number",
    );
    expect(result.errors).toContain(
      "policy.processBudget.maxConcurrent must be a finite positive integer",
    );
    expect(result.errors).toContain(
      "policy.scopedTokenBudgets.tenant.windowMs must be a finite positive number",
    );
    expect(result.errors).toContain(
      "policy.scopedRuntimeBudgets.project.maxElapsedMs must be a finite positive number",
    );
    expect(result.errors).toContain(
      "policy.scopedProcessBudgets.run.maxConcurrent must be a finite positive integer",
    );
    expect(result.errors).toContain(
      "policy.audit.redaction.stripFields must be an array of strings",
    );
    expect(result.errors).toContain(
      "policy.audit.retentionMode must be one of: delete, archive",
    );
    expect(result.errors).toContain(
      "policy.audit.legalHold must be a boolean",
    );
    expect(result.errors).toContain(
      "policy.credentialCatalog.broken.sourceEnvVar must be a non-empty string",
    );
    expect(result.errors).toContain(
      "policy.credentialCatalog.broken.domains must be a non-empty array of strings",
    );
    expect(result.errors).toContain(
      "policy.credentialCatalog.broken.headerTemplates contains an empty header name",
    );
    expect(result.errors).toContain(
      "policy.credentialCatalog.broken.headerTemplates. must be a non-empty string",
    );
    expect(result.errors).toContain(
      "policy.credentialCatalog.broken.ttlMs must be an integer between 1000 and 86400000",
    );
  });
});

describe("validateGatewayConfig mcp security", () => {
  it("accepts trust tier, risk controls, and supply-chain fields", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      mcp: {
        servers: [
          {
            name: "peekaboo",
            command: "npx",
            args: ["-y", "@pkg/server@1.2.3"],
            trustTier: "sandboxed",
            container: "desktop",
            riskControls: {
              toolAllowList: ["browser_*"],
              requireApproval: true,
            },
            supplyChain: {
              requirePinnedPackageVersion: true,
              requireDesktopImageDigest: true,
              binarySha256: "a".repeat(64),
              catalogSha256: "b".repeat(64),
            },
          },
        ],
      },
    });

    expect(result.valid).toBe(true);
  });

  it("rejects invalid mcp trust and supply-chain fields", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      mcp: {
        servers: [
          {
            name: "",
            command: "",
            args: "bad" as unknown as string[],
            trustTier: "nope",
            riskControls: {
              toolAllowList: "bad" as unknown as string[],
            },
            supplyChain: {
              binarySha256: "short",
              catalogSha256: "also-short",
            },
          },
        ],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("mcp.servers[0].name must be a non-empty string");
    expect(result.errors).toContain("mcp.servers[0].command must be a non-empty string");
    expect(result.errors).toContain("mcp.servers[0].args must be an array of strings");
    expect(result.errors).toContain(
      "mcp.servers[0].trustTier must be one of: trusted, sandboxed, untrusted",
    );
    expect(result.errors).toContain(
      "mcp.servers[0].riskControls.toolAllowList must be an array of strings",
    );
    expect(result.errors).toContain(
      "mcp.servers[0].supplyChain.binarySha256 must be a 64-character hex SHA-256 digest",
    );
    expect(result.errors).toContain(
      "mcp.servers[0].supplyChain.catalogSha256 must be a 64-character hex SHA-256 digest",
    );
  });
});

describe("validateGatewayConfig approvals", () => {
  it("accepts approval SLA and escalation config", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      approvals: {
        enabled: true,
        mode: "safe_local_dev",
        gateDesktopAutomation: true,
        timeoutMs: 60_000,
        defaultSlaMs: 10_000,
        defaultEscalationDelayMs: 15_000,
        resolverSigningKey: "approval-signing-key",
      },
    });

    expect(result.valid).toBe(true);
  });

  it("rejects invalid approval SLA and escalation config", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      approvals: {
        enabled: "yes" as unknown as boolean,
        mode: "reckless" as unknown as string,
        gateDesktopAutomation: "strict" as unknown as boolean,
        timeoutMs: "slow" as unknown as number,
        defaultSlaMs: "fast" as unknown as number,
        defaultEscalationDelayMs: {} as unknown as number,
        resolverSigningKey: 5 as unknown as string,
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("approvals.enabled must be a boolean");
    expect(result.errors).toContain(
      "approvals.mode must be one of safe_local_dev, trusted_operator, unattended_background, benchmark",
    );
    expect(result.errors).toContain(
      "approvals.gateDesktopAutomation must be a boolean",
    );
    expect(result.errors).toContain("approvals.timeoutMs must be a number");
    expect(result.errors).toContain("approvals.defaultSlaMs must be a number");
    expect(result.errors).toContain(
      "approvals.defaultEscalationDelayMs must be a number",
    );
    expect(result.errors).toContain("approvals.resolverSigningKey must be a string");
  });
});
