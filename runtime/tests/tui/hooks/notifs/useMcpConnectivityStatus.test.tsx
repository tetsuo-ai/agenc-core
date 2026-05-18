import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConnection } from "../../../services/mcp/types.js";
import { useMcpConnectivityStatus } from "./useMcpConnectivityStatus.js";

const probes = vi.hoisted(() => ({
  addNotification: vi.fn(),
  removeNotification: vi.fn(),
  logError: vi.fn(),
  remoteMode: false,
  agencAiConnected: false,
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

vi.mock("../../../services/mcp/agencai", () => ({
  hasAgenCAiMcpEverConnected: () => probes.agencAiConnected,
}));

vi.mock("../../../utils/log.js", () => ({
  logError: probes.logError,
}));

function runHookProbe(mcpClients: readonly MCPServerConnection[]): void {
  useMcpConnectivityStatus({
    mcpClients: mcpClients as MCPServerConnection[],
  });
}

describe("useMcpConnectivityStatus", () => {
  beforeEach(() => {
    probes.addNotification.mockReset();
    probes.removeNotification.mockReset();
    probes.logError.mockReset();
    probes.remoteMode = false;
    probes.agencAiConnected = false;
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
});
