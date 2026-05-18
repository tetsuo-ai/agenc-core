// @ts-nocheck — version.ts uses MACRO.VERSION which tsup inlines at bundle time.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

const originalUserType = process.env.USER_TYPE;
afterEach(() => {
  if (originalUserType === undefined) delete process.env.USER_TYPE;
  else process.env.USER_TYPE = originalUserType;
});

const versionCommand = (await import("./version.js")).default;

describe("/version command", () => {
  it("declares the expected metadata", () => {
    expect(versionCommand.type).toBe("local");
    expect(versionCommand.name).toBe("version");
    expect(versionCommand.supportsNonInteractive).toBe(true);
    expect(versionCommand.description).toContain("version");
  });

  it("isEnabled is true when USER_TYPE='ant'", () => {
    process.env.USER_TYPE = "ant";
    expect(versionCommand.isEnabled?.()).toBe(true);
  });

  it("isEnabled is false when USER_TYPE is unset", () => {
    delete process.env.USER_TYPE;
    expect(versionCommand.isEnabled?.()).toBe(false);
  });

  it("isEnabled is false when USER_TYPE is something else", () => {
    process.env.USER_TYPE = "external";
    expect(versionCommand.isEnabled?.()).toBe(false);
  });

  it("load() resolves the call() module without throwing", async () => {
    const mod = await versionCommand.load();
    expect(typeof mod.call).toBe("function");
    // Don't invoke mod.call() here — version.ts reads MACRO.VERSION,
    // which is a tsup bundle-time global that doesn't exist when the
    // source runs through vitest. The bundle-stage build separately
    // verifies the inlined version string.
  });
});
