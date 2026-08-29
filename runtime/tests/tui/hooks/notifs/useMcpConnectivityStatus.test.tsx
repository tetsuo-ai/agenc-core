import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConnection } from "../../../services/mcp/types.js";
import type { McpSurfaceServer } from "../../../session/session.js";
import { useMcpConnectivityStatus } from "./useMcpConnectivityStatus.js";

const probes = vi.hoisted(() => ({
  addNotification: vi.fn(),
  removeNotification: vi.fn(),
  logError: vi.fn(),
  remoteMode: false,
}));

vi.mock("react-compiler-runtime", () => ({
  c: (size: number) => new Array(size),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
  };
});

vi.mock("../../ink.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Text: ({ children }: { readonly children?: React.ReactNode }) =>
      React.createElement("span", null, children),
  };
});

vi.mock("../../context/notifications.js", () => ({
  useNotifications: () => ({
    addNotification: probes.addNotification,
    removeNotification: probes.removeNotification,
  }),
}));

vi.mock("../../../bootstrap/state", () => ({
  getIsRemoteMode: () => probes.remoteMode,
}));

vi.mock("../../../utils/log.js", () => ({
  logError: probes.logError,
}));

function runHookProbe(
  mcpClients: readonly MCPServerConnection[],
  mcpServers: readonly McpSurfaceServer[] = [],
): void {
  useMcpConnectivityStatus({
    mcpClients,
    mcpServers,
  });
}

describe("useMcpConnectivityStatus", () => {
  beforeEach(() => {
    probes.addNotification.mockReset();
    probes.removeNotification.mockReset();
    probes.logError.mockReset();
    probes.remoteMode = false;
  });

  it("adds the MCP failed notification for failed local server connections", () => {
    runHookProbe([
      {
        type: "failed",
        name: "files",
        config: {
          type: "stdio",
          command: "npx",
          args: [],
          scope: "user",
        },
        error: "spawn ENOENT",
      },
    ]);

    expect(probes.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "mcp-failed",
        priority: "medium",
      }),
    );
    expect(probes.logError).not.toHaveBeenCalled();
  });

  it("reports failed and auth-required daemon status without live clients", () => {
    runHookProbe([], [
      {
        name: "files",
        transport: "stdio",
        enabled: true,
        required: false,
        state: "failed",
        toolCount: 0,
      },
      {
        name: "calendar",
        transport: "http",
        enabled: true,
        required: false,
        state: "needs-auth",
        displayTarget: "https://calendar.example.test",
        toolCount: 0,
      },
    ]);

    expect(probes.addNotification).toHaveBeenCalledTimes(2);
    expect(probes.addNotification).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: "mcp-failed", priority: "medium" }),
    );
    expect(probes.addNotification).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: "mcp-needs-auth", priority: "medium" }),
    );
    expect(probes.logError).not.toHaveBeenCalled();
  });

  it("ignores passive status shadowed by a live client with the same name", () => {
    const liveClient = {
      type: "pending",
      name: "files",
      config: {
        type: "stdio",
        command: "node",
        args: [],
        scope: "user",
      },
    } satisfies MCPServerConnection;

    runHookProbe([liveClient], [
      {
        name: "files",
        transport: "stdio",
        enabled: true,
        required: false,
        state: "failed",
        toolCount: 0,
      },
    ]);

    expect(probes.addNotification).not.toHaveBeenCalled();
  });
});
