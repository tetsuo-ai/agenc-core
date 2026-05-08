// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const ideCommand = (await import("./index.js")).default;

describe("ide command spec", () => {
  it("declares name + type + description + argumentHint", () => {
    expect(ideCommand.name).toBe("ide");
    expect(ideCommand.type).toBe("local-jsx");
    expect(ideCommand.description).toContain("IDE integrations");
    expect(ideCommand.argumentHint).toContain("open");
  });

  it("declares the lazy load() factory", () => {
    expect(typeof ideCommand.load).toBe("function");
  });
});
