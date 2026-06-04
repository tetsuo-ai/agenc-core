import { describe, expect, test } from "vitest";

import type { LoadedPlugin } from "../../src/types/plugin.js";
import { mergePluginSources } from "../../src/utils/plugins/pluginLoader.js";

function loadedPlugin(name: string, source: string, enabled = true): LoadedPlugin {
  return {
    name,
    manifest: { name } as LoadedPlugin["manifest"],
    path: `/tmp/${source}`,
    source,
    repository: source,
    enabled,
  };
}

function marketplacePlugin(
  name: string,
  marketplace: string,
  enabled: boolean,
): LoadedPlugin {
  const pluginId = `${name}@${marketplace}`;
  return loadedPlugin(name, pluginId, enabled);
}

describe("mergePluginSources", () => {
  test("keeps the enabled copy when duplicate marketplace plugins disagree on enabled state", () => {
    const enabledOfficial = marketplacePlugin(
      "frontend-design",
      "agenc-plugins-official",
      true,
    );
    const disabledLegacy = marketplacePlugin(
      "frontend-design",
      "agenc-code-plugins",
      false,
    );

    const result = mergePluginSources({
      session: [],
      marketplace: [disabledLegacy, enabledOfficial],
      builtin: [],
    });

    expect(result.plugins).toEqual([enabledOfficial]);
    expect(result.errors).toEqual([]);
  });

  test("keeps the existing enabled copy when a later duplicate marketplace plugin is disabled", () => {
    const enabledOfficial = marketplacePlugin(
      "frontend-design",
      "agenc-plugins-official",
      true,
    );
    const disabledLegacy = marketplacePlugin(
      "frontend-design",
      "agenc-code-plugins",
      false,
    );

    const result = mergePluginSources({
      session: [],
      marketplace: [enabledOfficial, disabledLegacy],
      builtin: [],
    });

    expect(result.plugins).toEqual([enabledOfficial]);
    expect(result.errors).toEqual([]);
  });

  test("keeps the later copy when duplicate marketplace plugins are both disabled", () => {
    const legacy = marketplacePlugin(
      "frontend-design",
      "agenc-code-plugins",
      false,
    );
    const official = marketplacePlugin(
      "frontend-design",
      "agenc-plugins-official",
      false,
    );

    const result = mergePluginSources({
      session: [],
      marketplace: [legacy, official],
      builtin: [],
    });

    expect(result.plugins).toEqual([official]);
    expect(result.errors).toEqual([]);
  });

  test("keeps the later copy when duplicate marketplace plugins are both enabled", () => {
    const legacy = marketplacePlugin(
      "frontend-design",
      "agenc-code-plugins",
      true,
    );
    const official = marketplacePlugin(
      "frontend-design",
      "agenc-plugins-official",
      true,
    );

    const result = mergePluginSources({
      session: [],
      marketplace: [legacy, official],
      builtin: [],
    });

    expect(result.plugins).toEqual([official]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      type: "generic-error",
      source: legacy.source,
      plugin: legacy.name,
    });
  });

  test("lets session plugins override marketplace copies and keeps builtin plugins last", () => {
    const sessionCopy = loadedPlugin("dev-plugin", "session:/plugins/dev");
    const installedCopy = marketplacePlugin("dev-plugin", "agenc-code-plugins", true);
    const unrelatedMarketplace = marketplacePlugin("theme", "agenc-code-plugins", true);
    const builtin = loadedPlugin("builtin-tool", "builtin");

    const result = mergePluginSources({
      session: [sessionCopy],
      marketplace: [installedCopy, unrelatedMarketplace],
      builtin: [builtin],
    });

    expect(result.plugins).toEqual([sessionCopy, unrelatedMarketplace, builtin]);
    expect(result.errors).toEqual([]);
  });

  test("drops session plugins locked by managed settings and reports the override denial", () => {
    const sessionCopy = loadedPlugin("locked-plugin", "session:/plugins/locked");
    const installedCopy = marketplacePlugin("locked-plugin", "agenc-code-plugins", true);

    const result = mergePluginSources({
      session: [sessionCopy],
      marketplace: [installedCopy],
      builtin: [],
      managedNames: new Set(["locked-plugin"]),
    });

    expect(result.plugins).toEqual([installedCopy]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      type: "generic-error",
      source: sessionCopy.source,
      plugin: sessionCopy.name,
    });
  });
});
