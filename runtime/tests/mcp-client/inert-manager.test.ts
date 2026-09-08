import { describe, expect, it } from "vitest";
import { createInertMcpManager } from "../../src/mcp-client/inert-manager.js";

describe("createInertMcpManager", () => {
  it("returns empty server and tool state without provenance or connections", async () => {
    const manager = createInertMcpManager();

    expect(await manager.effectiveServers({}, {})).toEqual(new Map());
    expect(await manager.toolPluginProvenance({})).toBeNull();
    expect(manager.getTools?.()).toEqual([]);
    expect(manager.getToolsByServer?.("parent")).toEqual([]);
    expect(manager.getConfiguredServers?.()).toEqual([]);
    expect(manager.getConnectedServers?.()).toEqual([]);
    expect(manager.isConnected?.("parent")).toBe(false);
    expect(manager.isConnected?.("")).toBe(false);
  });

  it("creates a frozen manager for each caller", () => {
    const manager = createInertMcpManager();
    const otherManager = createInertMcpManager();

    expect(manager).not.toBe(otherManager);
    expect(Object.isFrozen(manager)).toBe(true);
    expect(Object.isFrozen(otherManager)).toBe(true);
    expect(Reflect.set(manager, "isConnected", () => true)).toBe(false);
    expect(Reflect.set(manager, "callTool", () => undefined)).toBe(false);
    expect(manager.isConnected?.("parent")).toBe(false);
    expect(otherManager.isConnected?.("parent")).toBe(false);
  });

  it("does not expose transport, refresh, resource, or disposal authority", () => {
    expect(Object.keys(createInertMcpManager()).sort()).toEqual([
      "effectiveServers",
      "getConfiguredServers",
      "getConnectedServers",
      "getTools",
      "getToolsByServer",
      "isConnected",
      "toolPluginProvenance",
    ]);
  });

  it("returns independent maps on every call", async () => {
    const manager = createInertMcpManager();
    const otherManager = createInertMcpManager();
    const servers = await manager.effectiveServers({}, {});
    const nextServers = await manager.effectiveServers({}, {});
    const otherServers = await otherManager.effectiveServers({}, {});

    expect(servers).not.toBe(nextServers);
    expect(servers).not.toBe(otherServers);
    servers.set("parent", { enabled: true, required: false });
    expect(nextServers.size).toBe(0);
    expect(otherServers.size).toBe(0);
    expect(await manager.effectiveServers({}, {})).toEqual(new Map());
  });

  it.each([
    "getTools",
    "getToolsByServer",
    "getConfiguredServers",
    "getConnectedServers",
  ] as const)("returns independent arrays from %s", (method) => {
    const manager = createInertMcpManager();
    const otherManager = createInertMcpManager();
    const values = manager[method]?.("parent");
    const nextValues = manager[method]?.("parent");
    const otherValues = otherManager[method]?.("parent");

    expect(values).toEqual([]);
    expect(values).not.toBe(nextValues);
    expect(values).not.toBe(otherValues);
    Object.defineProperty(values, "0", { value: "parent" });
    expect(nextValues).toEqual([]);
    expect(otherValues).toEqual([]);
    expect(manager[method]?.("parent")).toEqual([]);
  });
});
