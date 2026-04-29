import { describe, expect, it } from "vitest";
import { getDefaultWorkspacePath, WORKSPACE_FILES } from "../gateway/workspace-files.js";
import type { GatewayConfig } from "../gateway/types.js";
import { buildOnboardingProfile, createDefaultOnboardingAnswers } from "./profile.js";
import type { OnboardingAnswers } from "./types.js";

function makeAnswers(
  overrides: Partial<OnboardingAnswers> = {},
): OnboardingAnswers {
  return {
    apiKey: "xai-test-key",
    model: "grok-4-1-fast-reasoning",
    agentName: "AgenC",
    mission: "Help me execute real work.",
    role: "General-purpose operator",
    alwaysDoRules: ["Prefer action over narration."],
    soulTraits: ["direct", "strategic"],
    tone: "Direct and calm",
    verbosity: "balanced",
    autonomy: "balanced",
    toolPosture: "balanced",
    memorySeeds: ["The workspace is operator-owned."],
    desktopAutomationEnabled: true,
    walletPath: "/tmp/id.json",
    rpcUrl: "http://rpc.example",
    marketplaceEnabled: true,
    socialEnabled: false,
    ...overrides,
  };
}

describe("onboarding profile", () => {
  it("hydrates onboarding defaults from an existing gateway config", () => {
    const existingConfig = {
      gateway: { port: 3100 },
      agent: { name: "Scout" },
      connection: {
        rpcUrl: "http://rpc.example",
        keypairPath: "/tmp/custom-id.json",
      },
      llm: {
        provider: "grok",
        apiKey: "xai-existing",
        model: "grok-3-mini",
      },
      desktop: { enabled: true },
      marketplace: { enabled: false },
      social: { enabled: true },
    } as GatewayConfig & { marketplace?: { enabled?: boolean } };

    const defaults = createDefaultOnboardingAnswers(existingConfig);

    expect(defaults.agentName).toBe("Scout");
    expect(defaults.apiKey).toBe("xai-existing");
    expect(defaults.model).toBe("grok-3-mini");
    expect(defaults.walletPath).toBe("/tmp/custom-id.json");
    expect(defaults.rpcUrl).toBe("http://rpc.example");
    expect(defaults.desktopAutomationEnabled).toBe(true);
    expect(defaults.marketplaceEnabled).toBe(false);
    expect(defaults.socialEnabled).toBe(true);
  });

  it("builds a canonical config plus curated workspace files", () => {
    const profile = buildOnboardingProfile(makeAnswers());

    expect(profile.config.llm?.provider).toBe("grok");
    expect(profile.config.llm?.apiKey).toBe("xai-test-key");
    expect(profile.config.workspace?.hostPath).toBe(getDefaultWorkspacePath());
    expect(
      (profile.config as GatewayConfig & { marketplace?: unknown }).marketplace,
    ).toBeUndefined();
    expect(profile.config.social?.enabled).toBe(false);
    expect(profile.workspaceFiles[WORKSPACE_FILES.AGENT]).toContain(
      "## Mission",
    );
    expect(profile.workspaceFiles[WORKSPACE_FILES.SOUL]).toContain("# Soul");
    expect(profile.workspaceFiles[WORKSPACE_FILES.MEMORY]).toContain(
      "The workspace is operator-owned.",
    );
  });

  it("removes blank wallet paths from the generated config", () => {
    const profile = buildOnboardingProfile(
      makeAnswers({
        walletPath: null,
      }),
    );

    expect(profile.config.connection.keypairPath).toBeUndefined();
  });
});
