// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: vi.fn(() => false),
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

let bridgeEnabled = true;
vi.mock("../../bridge/bridgeEnabled.js", () => ({
  isBridgeEnabled: () => bridgeEnabled,
  getBridgeDisabledReason: () => null,
  isEnvLessBridgeEnabled: () => true,
  checkBridgeMinVersion: () => Promise.resolve(true),
}));

const { feature } = await import("bun:bundle");
const bridgeCommand = (await import("./index.js")).default;

afterEach(() => {
  bridgeEnabled = true;
  vi.mocked(feature).mockReturnValue(false);
});

describe("bridge (remote-control) command spec", () => {
  it("declares the right name + aliases + description", () => {
    expect(bridgeCommand.name).toBe("remote-control");
    expect(bridgeCommand.type).toBe("local-jsx");
    expect(bridgeCommand.aliases).toContain("rc");
    expect(bridgeCommand.description).toContain("remote-control");
  });

  it("isEnabled returns false when the BRIDGE_MODE feature flag is off", () => {
    vi.mocked(feature).mockImplementation((flag) =>
      flag === "BRIDGE_MODE" ? false : false,
    );
    expect(bridgeCommand.isEnabled?.()).toBe(false);
  });

  it("isEnabled returns false when bridge is disabled at runtime", () => {
    vi.mocked(feature).mockImplementation((flag) =>
      flag === "BRIDGE_MODE" ? true : false,
    );
    bridgeEnabled = false;
    expect(bridgeCommand.isEnabled?.()).toBe(false);
  });

  it("isEnabled returns true when the flag is on AND runtime says enabled", () => {
    vi.mocked(feature).mockImplementation((flag) =>
      flag === "BRIDGE_MODE" ? true : false,
    );
    bridgeEnabled = true;
    expect(bridgeCommand.isEnabled?.()).toBe(true);
  });
});
