import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerStartOptions, StartedMcpSseServer } from "../../../src/mcp/server/start.js";

const implementationPath = "../../../src/mcp/server/start.js";
const workspacePath = "../../../src/mcp/server/workspace.js";
let resolveWorkspace: ReturnType<typeof vi.fn>;
let implementationLoads: number;
let startServer: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  implementationLoads = 0;
  resolveWorkspace = vi.fn(async (workspace: string) => workspace);
  startServer = vi.fn(async () => ({}) as StartedMcpSseServer);
  vi.doMock(workspacePath, async (importOriginal) => ({
    ...await importOriginal<typeof import("../../../src/mcp/server/workspace.js")>(),
    resolveMcpServeWorkspace: resolveWorkspace,
  }));
  vi.doMock(implementationPath, () => {
    implementationLoads++;
    return { startMcpSseServe: startServer };
  });
});

afterEach(() => {
  vi.doUnmock(implementationPath);
  vi.doUnmock(workspacePath);
  vi.resetModules();
});

describe("configured MCP first-use boundary", () => {
  it.each([
    { server: undefined, kind: "disabled", reason: undefined },
    { server: { enabled: true }, kind: "unsupported", reason: "MCP stdio transport requires foreground `agenc mcp serve`" },
    { server: { enabled: true, transport: "sse" as const }, kind: "unsupported", reason: "daemon MCP autostart requires an explicit absolute mcp.server.workspace; use foreground `agenc mcp serve` from the target workspace otherwise" },
  ])("returns $kind without workspace, option or implementation work", async ({ server, kind, reason }) => {
    const { startMcpServerFromConfig } = await import("../../../src/mcp/server/configured-start.js");
    const options = { get cwd(): string { throw new Error("inactive options must not be read"); } };
    const result = await startMcpServerFromConfig({ mcp: { server } }, options);
    expect(result).toEqual({
      kind,
      defaults: { enabled: server?.enabled === true, transport: server !== undefined && "transport" in server ? "sse" : "stdio", host: "127.0.0.1", port: 3334 },
      ...(reason === undefined ? {} : { reason }),
    });
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(implementationLoads).toBe(0);
    expect(startServer).not.toHaveBeenCalled();
  });

  it("preserves workspace rejection before loading an implementation", async () => {
    const failure = new Error("mcp.server.workspace must resolve to a directory");
    resolveWorkspace.mockRejectedValueOnce(failure);
    const { startMcpServerFromConfig } = await import("../../../src/mcp/server/configured-start.js");
    await expect(startMcpServerFromConfig({ mcp: { server: {
      enabled: true, transport: "sse", workspace: "/invalid",
    } } })).rejects.toBe(failure);
    expect(resolveWorkspace).toHaveBeenCalledExactlyOnceWith("/invalid");
    expect(implementationLoads).toBe(0);
  });

  it("captures config before workspace resolution and options before import, then awaits listen", async () => {
    const workspace = Promise.withResolvers<string>();
    const importStarted = Promise.withResolvers<void>();
    const importAllowed = Promise.withResolvers<void>();
    const listenStarted = Promise.withResolvers<void>();
    const listening = Promise.withResolvers<StartedMcpSseServer>();
    resolveWorkspace.mockReturnValueOnce(workspace.promise);
    startServer.mockImplementationOnce(() => {
      listenStarted.resolve();
      return listening.promise;
    });
    vi.doMock(implementationPath, async () => {
      implementationLoads++;
      importStarted.resolve();
      await importAllowed.promise;
      return { startMcpSseServe: startServer };
    });
    const { startMcpServerFromConfig } = await import("../../../src/mcp/server/configured-start.js");
    const serverConfig = { enabled: true, transport: "sse" as const, host: "127.0.0.1", port: 0, workspace: "/requested" };
    const firstIo = {} as NonNullable<McpServerStartOptions["io"]>;
    const beforeImportIo = {} as NonNullable<McpServerStartOptions["io"]>;
    const afterImportIo = {} as NonNullable<McpServerStartOptions["io"]>;
    const options: { cwd: string; io: NonNullable<McpServerStartOptions["io"]> } = { cwd: "/ignored", io: firstIo };
    let completed = false;
    const pending = startMcpServerFromConfig({ mcp: { server: serverConfig } }, options).then((result) => {
      completed = true;
      return result;
    });
    serverConfig.port = 9001;
    serverConfig.workspace = "/changed-config";
    options.io = beforeImportIo;
    workspace.resolve("/canonical");
    await importStarted.promise;
    expect(completed).toBe(false);
    options.cwd = "/changed-options";
    options.io = afterImportIo;
    importAllowed.resolve();
    await listenStarted.promise;
    expect(startServer).toHaveBeenCalledExactlyOnceWith(
      { enabled: true, transport: "sse", host: "127.0.0.1", port: 0, workspace: "/requested" },
      { cwd: "/canonical", io: beforeImportIo },
    );
    expect(completed).toBe(false);
    const live = {} as StartedMcpSseServer;
    listening.resolve(live);
    expect(await pending).toMatchObject({ kind: "started", server: live, defaults: { port: 0, workspace: "/requested" } });
    expect(resolveWorkspace).toHaveBeenCalledExactlyOnceWith("/requested");
    expect(implementationLoads).toBe(1);
  });

  it("propagates an enabled server startup failure", async () => {
    const failure = new Error("implementation unavailable");
    startServer.mockRejectedValueOnce(failure);
    const { startMcpServerFromConfig } = await import("../../../src/mcp/server/configured-start.js");
    await expect(startMcpServerFromConfig({ mcp: { server: {
      enabled: true, transport: "sse", workspace: "/workspace",
    } } })).rejects.toBe(failure);
    expect(resolveWorkspace).toHaveBeenCalledExactlyOnceWith("/workspace");
    expect(startServer).toHaveBeenCalledOnce();
  });

  it("prepares a live listener replacement without loading another implementation", async () => {
    const apply = vi.fn(() => 3);
    const prepareContextReplacement = vi.fn(() => apply);
    const live = { configuredHost: "127.0.0.1", configuredPort: 4321, prepareContextReplacement } as unknown as StartedMcpSseServer;
    resolveWorkspace.mockResolvedValueOnce("/canonical");
    const { prepareMcpSseServerReconfigurationFromConfig } = await import("../../../src/mcp/server/configured-start.js");
    const prepared = await prepareMcpSseServerReconfigurationFromConfig(live, { mcp: { server: {
      enabled: true, transport: "sse", host: "127.0.0.1", port: 4321, workspace: "/requested",
    } } });
    expect(prepareContextReplacement).toHaveBeenCalledExactlyOnceWith("/canonical");
    expect(apply).not.toHaveBeenCalled();
    expect(prepared.apply()).toBe(3);
    expect(implementationLoads).toBe(0);
    expect(startServer).not.toHaveBeenCalled();
  });
});
