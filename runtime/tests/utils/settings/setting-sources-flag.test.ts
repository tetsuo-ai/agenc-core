import { describe, expect, it } from "vitest";

import { parseSettingSourcesFlag } from "../../../src/utils/settings/constants.js";

describe("parseSettingSourcesFlag", () => {
  it("maps the three CLI names and trims surrounding spaces", () => {
    expect(parseSettingSourcesFlag("user,project,local")).toEqual([
      "userSettings",
      "projectSettings",
      "localSettings",
    ]);
    expect(parseSettingSourcesFlag(" user , local ")).toEqual([
      "userSettings",
      "localSettings",
    ]);
  });

  it("keeps an empty flag as no sources and preserves duplicates", () => {
    expect(parseSettingSourcesFlag("")).toEqual([]);
    expect(parseSettingSourcesFlag("user,user")).toEqual([
      "userSettings",
      "userSettings",
    ]);
  });

  it("rejects unknown, blank, and managed-only names", () => {
    expect(() => parseSettingSourcesFlag("flag")).toThrow(
      /Invalid setting source: flag/,
    );
    expect(() => parseSettingSourcesFlag("policy")).toThrow(
      /Valid options are: user, project, local/,
    );
    expect(() => parseSettingSourcesFlag("userSettings")).toThrow(
      /Invalid setting source: userSettings/,
    );
    expect(() => parseSettingSourcesFlag("user,")).toThrow(
      /Invalid setting source: \. Valid options are/,
    );
    expect(() => parseSettingSourcesFlag("USER")).toThrow(
      /Invalid setting source: USER/,
    );
  });
});
