import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "../../src/auth/backend.js";
import { readAccountModelAccess } from "../../src/auth/account-access.js";

describe("retired account model access", () => {
  it.each([true, false])("returns no models when authenticated is %s", async authenticated => {
    const backend = {
      kind: "remote",
      whoami: vi.fn(async () => ({ authenticated })),
      getLlmUsage: vi.fn(), listAgencModels: vi.fn(), vendKey: vi.fn(), inferAgencModel: vi.fn(),
    } as unknown as AuthBackend;
    expect(await readAccountModelAccess(backend)).toEqual({ authenticated, managedModelsEnabled: false, models: [] });
    for (const method of [backend.getLlmUsage, backend.listAgencModels, backend.vendKey, backend.inferAgencModel]) {
      expect(method).not.toHaveBeenCalled();
    }
  });
  it("keeps the compatibility response closed when identity is unavailable", async () => {
    const backend = { whoami: vi.fn(async () => { throw new Error("unavailable"); }) } as unknown as AuthBackend;
    expect(await readAccountModelAccess(backend)).toEqual({ authenticated: false, unavailable: true, managedModelsEnabled: false, models: [] });
  });
});
