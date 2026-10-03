import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const readCredential = vi.hoisted(() => vi.fn());
vi.mock("../../../src/auth/native-credentials.js", async (original) => ({
  ...await original<typeof import("../../../src/auth/native-credentials.js")>(),
  readRemoteBearerCredential: readCredential,
}));
import { RemoteAuthBackend } from "../../../src/auth/backends/remote.js";

describe("remote token state gate", () => {
  const homes: string[] = [];
  const createdAt = "2026-01-01T00:00:00.000Z";
  const state = { version: 1, provider: "remote", createdAt };
  async function fixture(extra = {}) {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-token-state-"));
    homes.push(agencHome);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ subscriptionTier: "pro" }), { status: 200 }));
    const backend = new RemoteAuthBackend({ agencHome, env: {}, fetchImpl, ...extra });
    return { backend, fetchImpl };
  }
  beforeEach(() => readCredential.mockReset());
  afterEach(async () => {
    readCredential.mockReset();
    await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
  });

  it("keeps default tier, usage and catalog signed-out lookups out of secure storage", async () => {
    const { backend, fetchImpl } = await fixture();
    await expect(backend.getSubscriptionTier()).resolves.toBe("free");
    await expect(backend.getLlmUsage()).resolves.toMatchObject({ subscriptionTier: "free" });
    await expect(backend.listAgencModels()).resolves.toEqual([]);
    expect(readCredential).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["{invalid", JSON.stringify({ ...state, provider: "local" }), JSON.stringify({ ...state, version: 99 })])(
    "does not read native credentials for invalid state %s", async (metadata) => {
      const { backend, fetchImpl } = await fixture();
      await writeFile(backend.authFile(), metadata);
      await expect(backend.getSubscriptionTier()).resolves.toBe("free");
      expect(readCredential).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("keeps explicit token precedence without persisted state", async () => {
    const { backend, fetchImpl } = await fixture({ token: "explicit-token" });
    await expect(backend.getSubscriptionTier()).resolves.toBe("pro");
    expect(readCredential).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer explicit-token" }),
    }));
  });

  it("observes a later sign-in without a negative credential cache", async () => {
    const { backend, fetchImpl } = await fixture();
    await expect(backend.getSubscriptionTier()).resolves.toBe("free");
    await writeFile(backend.authFile(), JSON.stringify(state));
    readCredential.mockReturnValue({ bearerToken: "signed-in-token", createdAt });
    await expect(backend.getSubscriptionTier()).resolves.toBe("pro");
    expect(fetchImpl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer signed-in-token" }),
    }));
  });

  it("does not send an orphan or mismatched-generation credential", async () => {
    const { backend, fetchImpl } = await fixture();
    readCredential.mockReturnValue({ bearerToken: "orphan-token", createdAt: "different-generation" });
    await expect(backend.getSubscriptionTier()).resolves.toBe("free");
    expect(readCredential).not.toHaveBeenCalled();
    await writeFile(backend.authFile(), JSON.stringify(state));
    await expect(backend.getSubscriptionTier()).resolves.toBe("free");
    expect(readCredential).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("propagates native read errors when signed-in metadata is present", async () => {
    const { backend, fetchImpl } = await fixture();
    await writeFile(backend.authFile(), JSON.stringify(state));
    readCredential.mockImplementationOnce(() => { throw new Error("native storage locked"); });
    await expect(backend.getLlmUsage()).rejects.toThrow("native storage locked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
