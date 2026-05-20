import { afterEach, describe, expect, test, vi } from "vitest";

describe("StructuredDiff colorDiff module availability", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns native color helpers when syntax highlighting is enabled", async () => {
    vi.stubEnv("AGENC_SYNTAX_HIGHLIGHT", "1");
    const {
      expectColorDiff,
      expectColorFile,
      getColorModuleUnavailableReason,
      getSyntaxTheme,
    } = await import("./colorDiff.js");

    expect(getColorModuleUnavailableReason()).toBeNull();
    expect(expectColorDiff()).not.toBeNull();
    expect(expectColorFile()).not.toBeNull();
    expect(getSyntaxTheme("ansi")).toMatchObject({
      source: null,
    });
  });

  test("returns env as the unavailable reason when syntax highlighting is disabled", async () => {
    vi.stubEnv("AGENC_SYNTAX_HIGHLIGHT", "false");
    const {
      expectColorDiff,
      expectColorFile,
      getColorModuleUnavailableReason,
      getSyntaxTheme,
    } = await import("./colorDiff.js");

    expect(getColorModuleUnavailableReason()).toBe("env");
    expect(expectColorDiff()).toBeNull();
    expect(expectColorFile()).toBeNull();
    expect(getSyntaxTheme("ansi")).toBeNull();
  });
});
