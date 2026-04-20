import { describe, expect, it } from "vitest";
import {
  AgentLimitReachedError,
  AgentPathExistsError,
  AgentRegistry,
  buildChildMetadata,
  depthOfAgentPath,
  joinAgentPath,
} from "./registry.js";
import { resolveAgentRole } from "./role.js";

describe("AgentRegistry", () => {
  it("I-63: slot acquisition is atomic under the lock", async () => {
    const reg = new AgentRegistry({ maxThreads: 3 });
    const reservations = await Promise.all([
      reg.reserveSpawnSlot(),
      reg.reserveSpawnSlot(),
      reg.reserveSpawnSlot(),
    ]);
    expect(reservations).toHaveLength(3);
    await expect(reg.reserveSpawnSlot()).rejects.toBeInstanceOf(
      AgentLimitReachedError,
    );
  });

  it("release() rolls back the slot counter", async () => {
    const reg = new AgentRegistry({ maxThreads: 1 });
    const r = await reg.reserveSpawnSlot();
    r.release();
    const r2 = await reg.reserveSpawnSlot();
    expect(r2).toBeDefined();
  });

  it("I-37: reserveAgentPath throws AgentPathExistsError on collision", async () => {
    const reg = new AgentRegistry();
    const r = await reg.reserveSpawnSlot();
    const meta = buildChildMetadata({
      agentId: "t1",
      parentPath: "/root",
      role: resolveAgentRole(undefined),
      nickname: "alpha",
      depth: 1,
    });
    r.finalize(meta);
    expect(() => reg.reserveAgentPath("/root/alpha")).toThrow(
      AgentPathExistsError,
    );
  });

  it("finalizeSpawnReservation indexes by path + nickname", async () => {
    const reg = new AgentRegistry();
    const r = await reg.reserveSpawnSlot();
    const meta = buildChildMetadata({
      agentId: "t2",
      parentPath: "/root",
      role: resolveAgentRole(undefined),
      nickname: "beta",
      depth: 1,
    });
    r.finalize(meta);
    expect(reg.agentIdForPath("/root/beta")).toBe("t2");
    expect(reg.hasNickname("beta")).toBe(true);
  });

  it("releaseSpawnedThread is idempotent", async () => {
    const reg = new AgentRegistry();
    await reg.releaseSpawnedThread("nonexistent");
    await reg.releaseSpawnedThread("nonexistent");
    expect(reg.activeCount).toBe(0);
  });

  it("root thread is exempt from maxThreads", () => {
    const reg = new AgentRegistry({ maxThreads: 1 });
    reg.registerRootThread("root-id");
    expect(reg.agentIdForPath("/root")).toBe("root-id");
  });
});

describe("path helpers", () => {
  it("joinAgentPath composes paths", () => {
    expect(joinAgentPath("/root", "worker")).toBe("/root/worker");
    expect(joinAgentPath("/root/worker", "sub")).toBe("/root/worker/sub");
  });

  it("joinAgentPath sanitizes invalid chars", () => {
    expect(joinAgentPath("/root", "bad name!!")).toBe("/root/bad-name-");
  });

  it("depthOfAgentPath counts hops past root", () => {
    expect(depthOfAgentPath("/root")).toBe(0);
    expect(depthOfAgentPath("/root/a")).toBe(1);
    expect(depthOfAgentPath("/root/a/b/c")).toBe(3);
  });
});
