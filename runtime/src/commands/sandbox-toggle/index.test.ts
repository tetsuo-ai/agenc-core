// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const sandboxState = {
  enabled: false,
  autoAllow: false,
  unsandboxedAllowed: false,
  locked: false,
  hasDeps: true,
  supportedPlatform: true,
  platformEnabled: true,
};

vi.mock("../../utils/sandbox/sandbox-runtime.js", () => ({
  SandboxManager: {
    isSandboxingEnabled: () => sandboxState.enabled,
    isAutoAllowBashIfSandboxedEnabled: () => sandboxState.autoAllow,
    areUnsandboxedCommandsAllowed: () => sandboxState.unsandboxedAllowed,
    areSandboxSettingsLockedByPolicy: () => sandboxState.locked,
    checkDependencies: () => ({ errors: sandboxState.hasDeps ? [] : ["err"] }),
    isSupportedPlatform: () => sandboxState.supportedPlatform,
    isPlatformInEnabledList: () => sandboxState.platformEnabled,
  },
}));

const sandboxCommand = (await import("./index.js")).default;

afterEach(() => {
  Object.assign(sandboxState, {
    enabled: false,
    autoAllow: false,
    unsandboxedAllowed: false,
    locked: false,
    hasDeps: true,
    supportedPlatform: true,
    platformEnabled: true,
  });
});

describe("sandbox command metadata", () => {
  it("declares the right name + type + immediate", () => {
    expect(sandboxCommand.name).toBe("sandbox");
    expect(sandboxCommand.type).toBe("local-jsx");
    expect(sandboxCommand.immediate).toBe(true);
  });

  it("description shows 'sandbox disabled' when sandboxing is off", () => {
    sandboxState.enabled = false;
    expect(sandboxCommand.description).toContain("sandbox disabled");
  });

  it("description shows 'sandbox enabled' when sandboxing is on", () => {
    sandboxState.enabled = true;
    expect(sandboxCommand.description).toContain("sandbox enabled");
  });

  it("description includes '(auto-allow)' when autoAllow is on", () => {
    sandboxState.enabled = true;
    sandboxState.autoAllow = true;
    expect(sandboxCommand.description).toContain("auto-allow");
  });

  it("description includes 'fallback allowed' when unsandboxed commands are allowed", () => {
    sandboxState.enabled = true;
    sandboxState.unsandboxedAllowed = true;
    expect(sandboxCommand.description).toContain("fallback allowed");
  });

  it("description includes '(managed)' when policy-locked", () => {
    sandboxState.locked = true;
    expect(sandboxCommand.description).toContain("(managed)");
  });

  it("isHidden returns true on unsupported platforms", () => {
    sandboxState.supportedPlatform = false;
    expect(sandboxCommand.isHidden).toBe(true);
  });

  it("isHidden returns true when platform is supported but not in enabled list", () => {
    sandboxState.supportedPlatform = true;
    sandboxState.platformEnabled = false;
    expect(sandboxCommand.isHidden).toBe(true);
  });

  it("isHidden returns false when platform is supported and enabled", () => {
    sandboxState.supportedPlatform = true;
    sandboxState.platformEnabled = true;
    expect(sandboxCommand.isHidden).toBe(false);
  });
});
