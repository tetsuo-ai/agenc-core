import { describe, expect, it } from "vitest";
import {
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
import { createAgentRoleWorkspace, resolveAgentRole } from "./role.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace(process.cwd());

describe("AgentRegistry", () => {
  it("I-63: slot acquisition is atomic and uncapped under the lock", async () => {
    const reg = new AgentRegistry({ maxThreads: 3 });
    const reservations = await Promise.all([
      reg.reserveSpawnSlot(),
      reg.reserveSpawnSlot(),
      reg.reserveSpawnSlot(),
    ]);
    expect(reservations).toHaveLength(3);
    await expect(reg.reserveSpawnSlot()).resolves.toBeDefined();
  });

  it("release() rolls back the slot counter", async () => {
    const reg = new AgentRegistry({ maxThreads: 1 });
    const r = await reg.reserveSpawnSlot();
    r.release();
    const r2 = await reg.reserveSpawnSlot();
    expect(r2).toBeDefined();
  });

  it("failed spawn rollback keeps the allocated nickname reserved like reference", async () => {
    const reg = new AgentRegistry({ maxThreads: 1 });
    const role = resolveAgentRole(ROLE_WORKSPACE, undefined);
    const nickname = reg.allocateNickname(role);
    const r = await reg.reserveSpawnSlot();
    r.release();

    expect(reg.activeCount).toBe(0);
    expect(reg.hasNickname(nickname)).toBe(true);
  });

  it("I-37: path reservation rejects same-path concurrent spawns", async () => {
    const reg = new AgentRegistry();
    const first = await reg.reserveSpawnSlot();
    first.reserveAgentPath("/root/alpha");

    const second = await reg.reserveSpawnSlot();
    expect(() => second.reserveAgentPath("/root/alpha")).toThrow(
      AgentPathExistsError,
    );
    second.release();
    expect(reg.activeCount).toBe(1);

    first.release();
    expect(reg.activeCount).toBe(0);

    const third = await reg.reserveSpawnSlot();
    expect(() => third.reserveAgentPath("/root/alpha")).not.toThrow();
    third.release();
  });

  it("I-37: finalize replaces its own path reservation", async () => {
    const reg = new AgentRegistry();
    const r = await reg.reserveSpawnSlot();
    r.reserveAgentPath("/root/alpha");
    const meta = buildChildMetadata({
      agentId: "t1",
      parentPath: "/root",
      role: resolveAgentRole(ROLE_WORKSPACE, undefined),
      roleWorkspaceId: ROLE_WORKSPACE.id,
      roleFingerprint: "test-role-fingerprint",
      nickname: "alpha",
      depth: 1,
    });
    r.finalize(meta);
    expect(reg.agentIdForPath("/root/alpha")).toBe("t1");

    const colliding = await reg.reserveSpawnSlot();
    expect(() => colliding.reserveAgentPath("/root/alpha")).toThrow(
      AgentPathExistsError,
    );
    colliding.release();
  });

  it("finalizeSpawnReservation indexes by path + nickname", async () => {
    const reg = new AgentRegistry();
    const r = await reg.reserveSpawnSlot();
    r.reserveAgentPath("/root/beta");
    const meta = buildChildMetadata({
      agentId: "t2",
      parentPath: "/root",
      role: resolveAgentRole(ROLE_WORKSPACE, undefined),
      roleWorkspaceId: ROLE_WORKSPACE.id,
      roleFingerprint: "test-role-fingerprint",
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
    "releaseSpawnedThread keeps nicknames reserved like reference",
    async () => {
      const reg = new AgentRegistry();
      const role = resolveAgentRole(ROLE_WORKSPACE, undefined);
      // Allocate via the registry (the single source of truth).
      const nickname = reg.allocateNickname(role);
      const reservation = await reg.reserveSpawnSlot();
      reservation.finalize(
        buildChildMetadata({
          agentId: "t-reuse",
          parentPath: "/root",
          role,
          roleWorkspaceId: ROLE_WORKSPACE.id,
          roleFingerprint: "test-role-fingerprint",
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

  it("registers the root thread outside the spawn counter", () => {
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
      role: resolveAgentRole(ROLE_WORKSPACE, undefined),
      roleWorkspaceId: ROLE_WORKSPACE.id,
      roleFingerprint: "test-role-fingerprint",
      nickname: "Scout the 2nd",
      depth: 1,
    });
    expect(meta.agentPath).toBe("/root/scout_the_2nd");
    expect(meta.agentNickname).toBe("Scout the 2nd");
  });
});
