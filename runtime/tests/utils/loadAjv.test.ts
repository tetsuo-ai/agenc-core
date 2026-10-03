import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ require: vi.fn() }));
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: () => state.require };
});
afterEach(() => { vi.resetModules(); state.require.mockReset(); });

describe("lazy Ajv package boundary", () => {
  it("loads only on demand and returns the package's constructor identity", async () => {
    const { loadAjv } = await import("../../src/utils/loadAjv.js");
    expect(state.require).not.toHaveBeenCalled();
    class Ajv {}
    state.require.mockReturnValue({ Ajv });
    expect(loadAjv()).toBe(Ajv);
    expect(state.require).toHaveBeenCalledWith("ajv");
  });

  it("propagates a deferred load failure and allows the next call to retry", async () => {
    const { loadAjv } = await import("../../src/utils/loadAjv.js");
    const error = new Error("Ajv package unavailable");
    state.require.mockImplementationOnce(() => { throw error; });
    expect(() => loadAjv()).toThrow(error);
    class Ajv {}
    state.require.mockReturnValue({ Ajv });
    expect(loadAjv()).toBe(Ajv);
  });
});
