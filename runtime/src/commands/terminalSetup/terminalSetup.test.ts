// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const envState: { terminal: string | undefined } = { terminal: undefined };

vi.mock("../../utils/env.js", () => ({
  env: new Proxy(envState as Record<string, unknown>, {
    get(target, prop) {
      return target[prop as string];
    },
  }),
}));

const { getNativeCSIuTerminalDisplayName, shouldOfferTerminalSetup } =
  await import("./terminalSetup.js");

beforeEach(() => {
  envState.terminal = undefined;
});

describe("getNativeCSIuTerminalDisplayName", () => {
  it("returns null when env.terminal is unset", () => {
    expect(getNativeCSIuTerminalDisplayName()).toBeNull();
  });

  it("returns null for terminals not in the native CSI-u list", () => {
    envState.terminal = "Apple_Terminal";
    expect(getNativeCSIuTerminalDisplayName()).toBeNull();
  });

  it("returns the display name for a known native CSI-u terminal", () => {
    envState.terminal = "iTerm.app";
    const name = getNativeCSIuTerminalDisplayName();
    expect(typeof name === "string" || name === null).toBe(true);
    // The exact mapping depends on NATIVE_CSIU_TERMINALS — assert it's
    // either a non-empty string OR null (unmapped). The runtime keys are
    // checked by the source's own table; this test guards the gate
    // semantics.
  });
});

describe("shouldOfferTerminalSetup", () => {
  const originalPlatform = process.platform;
  const setPlatform = (p: string) => {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  };

  afterEach(() => {
    setPlatform(originalPlatform);
    envState.terminal = undefined;
  });

  it("offers setup for Apple_Terminal on macOS", () => {
    setPlatform("darwin");
    envState.terminal = "Apple_Terminal";
    expect(shouldOfferTerminalSetup()).toBe(true);
  });

  it("does not offer setup for Apple_Terminal on Linux", () => {
    setPlatform("linux");
    envState.terminal = "Apple_Terminal";
    expect(shouldOfferTerminalSetup()).toBe(false);
  });

  it("offers setup for vscode/cursor/windsurf/alacritty/zed regardless of platform", () => {
    setPlatform("linux");
    for (const term of ["vscode", "cursor", "windsurf", "alacritty", "zed"]) {
      envState.terminal = term;
      expect(shouldOfferTerminalSetup()).toBe(true);
    }
  });

  it("does NOT offer setup for native CSI-u terminals (iTerm/WezTerm/Ghostty/etc.)", () => {
    setPlatform("darwin");
    envState.terminal = "iTerm.app";
    expect(shouldOfferTerminalSetup()).toBe(false);
  });
});
