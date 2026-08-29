import { describe, expect, test, vi } from "vitest";

import type { HomeContext } from "../../../src/config/home.js";
import type { ConfigLayerSnapshot } from "../../../src/config/repository.js";
import type { AgenCConfig } from "../../../src/config/schema.js";
import { RuntimeStateRepository } from "../../../src/config/runtime-state-repository.js";
import {
  runWithCanonicalSettingsAuthority,
  type CanonicalSettingsAuthority,
} from "../../../src/utils/settings/canonicalAuthority.js";
import {
  getInitialSettings,
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from "../../../src/utils/settings/settings.js";

function authority(model: string, suffix: string): CanonicalSettingsAuthority {
  return authorityForConfig({ model }, suffix);
}

function authorityForConfig(
  config: AgenCConfig,
  suffix: string,
  layers: readonly ConfigLayerSnapshot[] = [],
): CanonicalSettingsAuthority {
  const homeContext: HomeContext = Object.freeze({
    path: `/tmp/agenc-authority-${suffix}`,
    identityKey: `/tmp/agenc-authority-${suffix}`,
    secureStorageAccount: "test-user",
    oauthFileSuffix: "",
    source: "agenc-home",
    isDefault: false,
    configTomlPath: `/tmp/agenc-authority-${suffix}/config.toml`,
    statePath: `/tmp/agenc-authority-${suffix}/state.json`,
    authPath: `/tmp/agenc-authority-${suffix}/auth.json`,
    trustedProjectsPath: `/tmp/agenc-authority-${suffix}/trusted-projects.json`,
  });
  return Object.freeze({
    current: () => Object.freeze(config),
    sources: (scope) => Object.freeze(layers.filter((layer) => layer.scope === scope)),
    projectRoot: `/tmp/project-${suffix}`,
    homeContext,
    stateRepository: new RuntimeStateRepository(homeContext, {
      storage: "memory",
    }),
    reload: async () => undefined,
  });
}

describe("execution authority settings projection", () => {
  test("keeps two concurrent session authorities isolated", async () => {
    const first = authority("model-a", "a");
    const second = authority("model-b", "b");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const reads = [first, second].map((current, index) =>
      runWithCanonicalSettingsAuthority(current, async () => {
        await barrier;
        await Promise.resolve();
        return {
          model: getInitialSettings().model,
          configPath: getSettingsFilePathForSource("userSettings"),
          root: current.projectRoot,
          index,
        };
      })
    );
    release();

    await expect(Promise.all(reads)).resolves.toEqual([
      {
        model: "model-a",
        configPath: "/tmp/agenc-authority-a/config.toml",
        root: "/tmp/project-a",
        index: 0,
      },
      {
        model: "model-b",
        configPath: "/tmp/agenc-authority-b/config.toml",
        root: "/tmp/project-b",
        index: 1,
      },
    ]);
  });

  test("does not read or merge a runtime-state settings namespace", () => {
    const current = authority("canonical-model", "state-injection");
    const stateRead = vi.spyOn(current.stateRepository, "getNamespace")
      .mockReturnValue({ fastModePerSessionOptIn: true });

    const initial = runWithCanonicalSettingsAuthority(
      current,
      () => getInitialSettings(),
    );
    const userLayer = runWithCanonicalSettingsAuthority(
      current,
      () => getSettingsForSource("userSettings"),
    );

    expect(initial.model).toBe("canonical-model");
    expect(initial).not.toHaveProperty("fastModePerSessionOptIn");
    expect(userLayer).toBeNull();
    expect(stateRead).not.toHaveBeenCalled();
  });

  test("exposes canonical field names without a compatibility projection", () => {
    const current = authorityForConfig(
      {
        reasoning_effort: "xhigh",
        plugins: { plugins: { formatter: { enabled: true } } },
        sandbox_mode: "workspace-write",
      },
      "canonical-fields",
    );

    const settings = runWithCanonicalSettingsAuthority(
      current,
      () => getInitialSettings(),
    );

    expect(settings.reasoning_effort).toBe("xhigh");
    expect(settings.plugins?.plugins).toEqual({ formatter: { enabled: true } });
    expect(settings.sandbox_mode).toBe("workspace-write");
    expect(settings).not.toHaveProperty("effortLevel");
    expect(settings).not.toHaveProperty("enabledPlugins");
  });

  test("managed drop-ins replace ordinary arrays while permission restrictions accumulate", () => {
    const layers: readonly ConfigLayerSnapshot[] = [
      {
        scope: "managed",
        label: "managed base",
        path: "/etc/agenc/config.toml",
        config: {
          availableModels: ["base-model"],
          agencMdExcludes: ["base/**"],
          permissions: { deny: ["system.bash(base:*)"] },
        },
      },
      {
        scope: "managed",
        label: "managed drop-in 10-policy.toml",
        path: "/etc/agenc/config.d/10-policy.toml",
        config: {
          availableModels: ["drop-in-model"],
          agencMdExcludes: ["drop-in/**"],
          permissions: { deny: ["system.bash(drop-in:*)"] },
        },
      },
    ];
    const current = authorityForConfig({}, "managed-layers", layers);

    const managed = runWithCanonicalSettingsAuthority(
      current,
      () => getSettingsForSource("policySettings"),
    );

    expect(managed?.availableModels).toEqual(["drop-in-model"]);
    expect(managed?.agencMdExcludes).toEqual(["drop-in/**"]);
    expect(managed?.permissions?.deny).toEqual([
      "system.bash(base:*)",
      "system.bash(drop-in:*)",
    ]);
  });

  test("rejects managed-only writes and repository-owned operator or rollback writes before I/O", async () => {
    const retiredStatePatch = {
      fastModePerSessionOptIn: true,
    } as unknown as Partial<AgenCConfig>;
    await expect(updateSettingsForSource(
      "userSettings",
      retiredStatePatch,
      null,
    )).resolves.toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("retired surface"),
      }),
    });
    await expect(updateSettingsForSource(
      "userSettings",
      { availableModels: ["grok-4.6"] },
      null,
    )).resolves.toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("managed policy is writable only through a managed config.toml layer"),
      }),
    });
    await expect(updateSettingsForSource(
      "projectSettings",
      { modelOverrides: { "grok-4.6": "project-model" } },
      null,
    )).resolves.toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("operator-owned values belong in user or managed config.toml"),
      }),
    });
    await expect(updateSettingsForSource(
      "localSettings",
      { disableAllHooks: false },
      null,
    )).resolves.toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("repository restrictions are monotonic"),
      }),
    });
  });
});
