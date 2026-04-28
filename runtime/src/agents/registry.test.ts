import { describe, expect, it } from "vitest";
import {
  AgentLimitReachedError,
  InvalidAgentPathError,
  AgentPathExistsError,
  AgentRegistry,
  MEMORY_AGENT_PATH,
  ROOT_AGENT_PATH,
  buildChildMetadata,
  depthOfAgentPath,
  agentPathName,
  joinAgentPath,
  normalizeAgentNameForPath,
  resolveAgentPath,
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

  it("failed spawn rollback keeps the allocated nickname reserved like Codex", async () => {
    const reg = new AgentRegistry({ maxThreads: 1 });
    const role = resolveAgentRole(undefined);
    const nickname = reg.allocateNickname(role);
    const r = await reg.reserveSpawnSlot();
    r.release();

    expect(reg.activeCount).toBe(0);
    expect(reg.hasNickname(nickname)).toBe(true);
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

  it(
    "releaseSpawnedThread keeps nicknames reserved like Codex",
    async () => {
      const reg = new AgentRegistry();
      const role = resolveAgentRole(undefined);
      // Allocate via the registry (the single source of truth).
      const nickname = reg.allocateNickname(role);
      const reservation = await reg.reserveSpawnSlot();
      reservation.finalize(
        buildChildMetadata({
          agentId: "t-reuse",
          parentPath: "/root",
          role,
          nickname,
          depth: 1,
        }),
      );
      expect(reg.hasNickname(nickname)).toBe(true);
      await reg.releaseSpawnedThread("t-reuse");
      expect(reg.hasNickname(nickname)).toBe(true);
      const next = reg.allocateNickname(role);
      expect(next).not.toBe(nickname);
    },
  );

  it("root thread is exempt from maxThreads", () => {
    const reg = new AgentRegistry({ maxThreads: 1 });
    reg.registerRootThread("root-id");
    expect(reg.agentIdForPath("/root")).toBe("root-id");
  });
});

describe("path helpers", () => {
  it("exposes root and memory consolidation paths", () => {
    expect(ROOT_AGENT_PATH).toBe("/root");
    expect(MEMORY_AGENT_PATH).toBe("/morpheus");
    expect(agentPathName(ROOT_AGENT_PATH)).toBe("root");
    expect(agentPathName(MEMORY_AGENT_PATH)).toBe("morpheus");
  });

  it("joinAgentPath composes paths", () => {
    expect(joinAgentPath("/root", "worker")).toBe("/root/worker");
    expect(joinAgentPath("/root/worker", "sub")).toBe("/root/worker/sub");
  });

  it("joinAgentPath rejects invalid chars", () => {
    expect(() => joinAgentPath("/root", "bad name!!")).toThrow(
      InvalidAgentPathError,
    );
  });

  it("depthOfAgentPath counts hops past root", () => {
    expect(depthOfAgentPath("/root")).toBe(0);
    expect(depthOfAgentPath("/root/a")).toBe(1);
    expect(depthOfAgentPath("/root/a/b/c")).toBe(3);
  });

  it("resolveAgentPath supports relative and absolute references", () => {
    expect(resolveAgentPath("/root/researcher", "worker")).toBe(
      "/root/researcher/worker",
    );
    expect(resolveAgentPath("/root/researcher", "/root/other")).toBe(
      "/root/other",
    );
  });

  it("normalizes display nicknames into valid path segments before metadata build", () => {
    expect(normalizeAgentNameForPath("Scout the 2nd")).toBe("scout_the_2nd");
    const meta = buildChildMetadata({
      agentId: "t3",
      parentPath: "/root",
      role: resolveAgentRole(undefined),
      nickname: "Scout the 2nd",
      depth: 1,
    });
    expect(meta.agentPath).toBe("/root/scout_the_2nd");
    expect(meta.agentNickname).toBe("Scout the 2nd");
  });
});
