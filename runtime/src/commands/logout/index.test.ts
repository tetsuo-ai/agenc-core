// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const logoutCommand = (await import("./index.js")).default;

const originalDisable = process.env.DISABLE_LOGOUT_COMMAND;
afterEach(() => {
  if (originalDisable === undefined) delete process.env.DISABLE_LOGOUT_COMMAND;
  else process.env.DISABLE_LOGOUT_COMMAND = originalDisable;
});

describe("logout command spec", () => {
  it("declares name + type + description", () => {
    expect(logoutCommand.name).toBe("logout");
    expect(logoutCommand.type).toBe("local-jsx");
    expect(logoutCommand.description).toContain("Sign out");
  });

  it("isEnabled defaults to true", () => {
    delete process.env.DISABLE_LOGOUT_COMMAND;
    expect(logoutCommand.isEnabled?.()).toBe(true);
  });

  it("isEnabled is false when DISABLE_LOGOUT_COMMAND is set", () => {
    process.env.DISABLE_LOGOUT_COMMAND = "true";
    expect(logoutCommand.isEnabled?.()).toBe(false);
  });

  it("declares the lazy load() factory", () => {
    expect(typeof logoutCommand.load).toBe("function");
  });
});
