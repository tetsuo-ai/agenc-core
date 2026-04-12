import { describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_SHELL_PROFILE,
  appendShellProfilePromptSection,
  coerceSessionShellProfile,
  getShellProfilePreferredToolNames,
  resolveSessionShellProfile,
} from "./shell-profile.js";

describe("shell-profile", () => {
  it("defaults to general when metadata is missing", () => {
    expect(resolveSessionShellProfile({})).toBe(DEFAULT_SESSION_SHELL_PROFILE);
  });

  it("coerces supported profile names and rejects unknown values", () => {
    expect(coerceSessionShellProfile("Coding")).toBe("coding");
    expect(coerceSessionShellProfile("unknown")).toBeUndefined();
  });

  it("appends profile-specific prompt guidance", () => {
    const prompt = appendShellProfilePromptSection({
      systemPrompt: "Base prompt",
      profile: "validation",
    });

    expect(prompt).toContain("## Validation Shell Defaults");
    expect(prompt).toContain("Bias toward reproduction, inspection, verification");
  });

  it("selects coding-biased tools without dropping the entire catalog", () => {
    const preferred = getShellProfilePreferredToolNames({
      profile: "coding",
      availableToolNames: [
        "system.readFile",
        "system.writeFile",
        "system.bash",
        "system.grep",
        "system.searchTools",
        "agenc.inspectMarketplace",
      ],
    });

    expect(preferred).toContain("system.readFile");
    expect(preferred).toContain("system.writeFile");
    expect(preferred).toContain("system.bash");
    expect(preferred).toContain("system.grep");
    expect(preferred).toContain("system.searchTools");
    expect(preferred).not.toContain("agenc.inspectMarketplace");
  });
});
