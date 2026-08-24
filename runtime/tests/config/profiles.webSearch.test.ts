import { describe, expect, test } from "vitest";

import { defaultConfig } from "src/config/schema.js";
import { resolveProfile } from "src/config/profiles.js";

function configWithProfile(profile: Record<string, unknown>) {
  return {
    ...defaultConfig(),
    profiles: { dev: profile },
  } as unknown as Parameters<typeof resolveProfile>[0];
}

describe("resolveProfile canonical tools_config", () => {
  test("applies the profile tools_config over the base tool config", () => {
    const config = {
      ...configWithProfile({
        tools_config: {
          disabled_tools: ["WebSearch"],
          WebSearch: { default_permission_mode: "never" },
        },
      }),
      tools_config: {
        enabled_tools: ["WebSearch", "FileRead"],
        disabled_tools: [],
      },
    };
    const resolved = resolveProfile(config, "dev");
    expect(resolved.tools_config).toEqual({
      enabled_tools: ["WebSearch", "FileRead"],
      disabled_tools: ["WebSearch"],
      WebSearch: { default_permission_mode: "never" },
    });
  });
});
