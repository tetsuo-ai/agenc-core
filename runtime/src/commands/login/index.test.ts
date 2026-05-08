// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

let hasApiAuth = false;
vi.mock("../../utils/auth.js", () => ({
  hasproviderApiKeyAuth: () => hasApiAuth,
}));

const loginFactory = (await import("./index.js")).default;

const originalDisable = process.env.DISABLE_LOGIN_COMMAND;
afterEach(() => {
  if (originalDisable === undefined) delete process.env.DISABLE_LOGIN_COMMAND;
  else process.env.DISABLE_LOGIN_COMMAND = originalDisable;
  hasApiAuth = false;
});

describe("login command spec", () => {
  it("description shows 'Sign in' when there is no provider auth", () => {
    hasApiAuth = false;
    const cmd = loginFactory();
    expect(cmd.description).toContain("Sign in");
  });

  it("description shows 'Switch provider accounts' when API key auth is already configured", () => {
    hasApiAuth = true;
    const cmd = loginFactory();
    expect(cmd.description).toContain("Switch");
  });

  it("isEnabled defaults to true", () => {
    delete process.env.DISABLE_LOGIN_COMMAND;
    expect(loginFactory().isEnabled?.()).toBe(true);
  });

  it("isEnabled is false when DISABLE_LOGIN_COMMAND is truthy", () => {
    process.env.DISABLE_LOGIN_COMMAND = "1";
    expect(loginFactory().isEnabled?.()).toBe(false);
  });

  it("declares the lazy load() factory", () => {
    expect(typeof loginFactory().load).toBe("function");
  });

  it("type and name are local-jsx + login", () => {
    const cmd = loginFactory();
    expect(cmd.type).toBe("local-jsx");
    expect(cmd.name).toBe("login");
  });
});
