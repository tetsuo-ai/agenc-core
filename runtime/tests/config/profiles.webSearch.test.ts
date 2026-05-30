import { describe, expect, test } from "vitest";

import { defaultConfig } from "src/config/schema.js";
import { resolveProfile } from "src/config/profiles.js";

function configWithProfile(profile: Record<string, unknown>) {
  return {
    ...defaultConfig(),
    profiles: { dev: profile },
  } as unknown as Parameters<typeof resolveProfile>[0];
}

describe("resolveProfile web_search + tools composition", () => {
  test("preserves web_search when the profile also sets tools", () => {
    // Regression: the `tools` block re-read the base config and clobbered the
    // tools_config built by the `web_search` block, silently dropping it.
    const config = configWithProfile({ web_search: true, tools: {} });
    const resolved = resolveProfile(config, "dev");
    expect(resolved.tools_config?.web_search).toBe(true);
  });

  test("an explicit profile.tools.web_search still wins over the web_search field", () => {
    const config = configWithProfile({
      web_search: true,
      tools: { web_search: false },
    });
    const resolved = resolveProfile(config, "dev");
    expect(resolved.tools_config?.web_search).toBe(false);
  });

  test("web_search alone still applies", () => {
    const config = configWithProfile({ web_search: true });
    const resolved = resolveProfile(config, "dev");
    expect(resolved.tools_config?.web_search).toBe(true);
  });
});
