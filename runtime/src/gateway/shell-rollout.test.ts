import { describe, expect, it } from "vitest";

import {
  evaluateShellFeatureRollout,
  resolveConfiguredShellProfile,
} from "./shell-rollout.js";
import type { GatewayAutonomyConfig } from "./types.js";

function makeAutonomy(): GatewayAutonomyConfig {
  return {
    enabled: true,
    featureFlags: {
      canaryRollout: true,
      shellProfiles: true,
      codingCommands: true,
      shellExtensions: true,
      watchCockpit: true,
      multiAgent: true,
      backgroundRuns: true,
      notifications: true,
      replayGates: true,
    },
    killSwitches: {
      canaryRollout: false,
      shellProfiles: false,
      codingCommands: false,
      shellExtensions: false,
      watchCockpit: false,
      multiAgent: false,
      backgroundRuns: false,
      notifications: false,
      replayGates: false,
    },
    canary: {
      enabled: true,
      featureAllowList: [
        "shellProfiles",
        "codingCommands",
        "shellExtensions",
        "watchCockpit",
        "multiAgent",
      ],
      domainAllowList: ["shell", "extensions", "watch"],
      percentage: 1,
    },
  };
}

describe("shell-rollout", () => {
  it("allows shell features when autonomy rollout is inactive", () => {
    const decision = evaluateShellFeatureRollout({
      autonomy: undefined,
      feature: "codingCommands",
      domain: "shell",
      stableKey: "session-1",
    });
    expect(decision).toMatchObject({
      allowed: true,
      cohort: "disabled",
    });
  });

  it("coerces non-general shell profiles when shellProfiles are held back", () => {
    const autonomy = makeAutonomy();
    const resolved = resolveConfiguredShellProfile({
      autonomy: {
        ...autonomy,
        featureFlags: {
          ...autonomy.featureFlags,
          shellProfiles: false,
        },
      },
      requested: "coding",
      stableKey: "session-1",
    });
    expect(resolved.profile).toBe("general");
    expect(resolved.coerced).toBe(true);
  });

  it("preserves non-general shell profiles when rollout allows them", () => {
    const resolved = resolveConfiguredShellProfile({
      autonomy: makeAutonomy(),
      requested: "research",
      stableKey: "session-1",
    });
    expect(resolved.profile).toBe("research");
    expect(resolved.coerced).toBe(false);
  });
});
