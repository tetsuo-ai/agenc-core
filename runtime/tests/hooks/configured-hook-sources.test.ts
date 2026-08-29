import { describe, expect, test } from "vitest";

import type { ConfigLayerSnapshot } from "../config/repository.js";
import type { AgenCConfig, HooksMap } from "../config/schema.js";
import {
  resolveConfiguredHookSources,
  type ConfiguredHookAuthoritySnapshot,
} from "./configured-hook-sources.js";

function hooks(command: string): HooksMap {
  return {
    Stop: [{ hooks: [{ type: "command", command }] }],
  };
}

function layer(
  scope: ConfigLayerSnapshot["scope"],
  config: AgenCConfig,
): ConfigLayerSnapshot {
  return { scope, label: scope, config };
}

function authority(
  config: AgenCConfig,
  layers: readonly ConfigLayerSnapshot[],
): ConfiguredHookAuthoritySnapshot {
  return { config, layers };
}

function commands(resolved: HooksMap | undefined): string[] {
  return (resolved?.Stop ?? []).flatMap((matcher) =>
    matcher.hooks.map((hook) => hook.command),
  );
}

describe("configured hook source policy", () => {
  test("keeps plugin hooks dormant until canonical authority is loaded", () => {
    expect(
      resolveConfiguredHookSources(undefined, hooks("plugin")),
    ).toBeUndefined();
  });

  test("managed disableAllHooks suppresses config, managed, and plugin hooks", () => {
    const managedHooks = hooks("managed");
    const resolved = resolveConfiguredHookSources(
      authority({ hooks: hooks("effective"), disableAllHooks: true }, [
        layer("user", { hooks: hooks("user") }),
        layer("managed", {
          hooks: managedHooks,
          disableAllHooks: true,
        }),
      ]),
      hooks("plugin"),
    );

    expect(resolved).toBeUndefined();
  });

  test.each([
    ["managed-only policy", { allowManagedHooksOnly: true }, false],
    ["non-managed disable", {}, true],
  ] as const)(
    "%s admits only managed config hooks",
    (_label, managedPolicy, nonManagedDisable) => {
      const resolved = resolveConfiguredHookSources(
        authority(
          {
            hooks: hooks("effective"),
            ...(nonManagedDisable ? { disableAllHooks: true } : {}),
          },
          [
            layer("user", {
              hooks: hooks("user"),
              ...(nonManagedDisable ? { disableAllHooks: true } : {}),
            }),
            layer("managed", {
              hooks: hooks("managed"),
              ...managedPolicy,
            }),
          ],
        ),
        hooks("plugin"),
      );

      expect(commands(resolved)).toEqual(["managed"]);
    },
  );

  test.each([true, ["hooks"]] as const)(
    "strict plugin-only policy %j admits managed and plugin hooks",
    (strictPluginOnlyCustomization) => {
      const resolved = resolveConfiguredHookSources(
        authority({ hooks: hooks("effective") }, [
          layer("user", { hooks: hooks("user") }),
          layer("managed", {
            hooks: hooks("managed"),
            strictPluginOnlyCustomization,
          }),
        ]),
        hooks("plugin"),
      );

      expect(commands(resolved)).toEqual(["managed", "plugin"]);
    },
  );

  test("unrelated strict-plugin surfaces do not filter hook sources", () => {
    const resolved = resolveConfiguredHookSources(
      authority({ hooks: hooks("effective") }, [
        layer("managed", {
          strictPluginOnlyCustomization: ["skills"],
        }),
      ]),
      hooks("plugin"),
    );

    expect(commands(resolved)).toEqual(["effective", "plugin"]);
  });

  test("default policy combines effective canonical config with plugin hooks", () => {
    const resolved = resolveConfiguredHookSources(
      authority({ hooks: hooks("effective") }, [
        layer("user", { hooks: hooks("effective") }),
      ]),
      hooks("plugin"),
    );

    expect(commands(resolved)).toEqual(["effective", "plugin"]);
  });
});
