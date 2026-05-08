// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const envState: { platform: string | undefined } = { platform: undefined };
vi.mock("../utils/env.js", () => ({
  env: new Proxy(envState as Record<string, unknown>, {
    get(t, p) {
      return t[p as string];
    },
  }),
}));

const { getInstallationPath, install } = await import("./install.js");

afterEach(() => {
  envState.platform = undefined;
});

describe("install command spec", () => {
  it("declares the right name + type", () => {
    expect(install.name).toBe("install");
    expect(install.type).toBe("local-jsx");
    expect(install.description).toContain("AgenC native build");
  });
});

describe("getInstallationPath", () => {
  it("returns ~/.local/bin/agenc on Linux", () => {
    envState.platform = "linux";
    expect(getInstallationPath()).toBe("~/.local/bin/agenc");
  });

  it("returns ~/.local/bin/agenc on macOS (darwin)", () => {
    envState.platform = "darwin";
    expect(getInstallationPath()).toBe("~/.local/bin/agenc");
  });

  it("returns a Windows-style path on win32", () => {
    envState.platform = "win32";
    const path = getInstallationPath();
    expect(path).toContain(".local\\bin\\agenc.exe");
    expect(path).not.toContain("/");
  });
});
