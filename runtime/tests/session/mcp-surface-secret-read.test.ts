import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readNativeSecureStorage = vi.hoisted(() => vi.fn());
vi.mock("../utils/secureStorage/native.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/secureStorage/native.js")>()),
  readNativeSecureStorage,
}));

import { createLazySavedPluginSecretRedactor } from "../plugins/secret-redaction.js";
import { createSessionMcpService } from "./mcp-startup.js";
import type { MCPManager } from "../mcp-client/manager.js";

const SAVED_SECRET = "saved-plugin-token-4817";
const HOME = { path: join(tmpdir(), "agenc-lazy-secret-home") };

function serviceFor(manager: unknown) {
  return createSessionMcpService(manager as MCPManager, {
    authority: { subscribe: () => () => {}, homeContext: HOME } as never,
    environment: {},
    pluginStorageRoot: join(tmpdir(), "agenc-mcp-plugin-storage"),
  });
}

function managerWith(servers: readonly Record<string, unknown>[]) {
  return {
    getConfiguredServers: vi.fn(() => servers),
    isConnected: vi.fn(() => false),
    getConnectionState: vi.fn(() => ({ type: "pending" })),
  };
}

beforeEach(() => {
  readNativeSecureStorage.mockReset();
  readNativeSecureStorage.mockReturnValue({ pluginSecrets: { demo: { token: SAVED_SECRET } } });
});

describe("saved plugin secret redaction in MCP projections", () => {
  it("reads secure storage only once a value needs redacting", () => {
    const redact = createLazySavedPluginSecretRedactor(HOME as never);
    expect(readNativeSecureStorage).not.toHaveBeenCalled();
    expect(redact(`token=${SAVED_SECRET}`)).toBe("token=[REDACTED]");
    expect(redact(`again ${SAVED_SECRET}`)).toBe("again [REDACTED]");
    expect(readNativeSecureStorage).toHaveBeenCalledTimes(1);
  });

  it("redacts everything when secure storage cannot be read, like the eager redactor", () => {
    readNativeSecureStorage.mockImplementation(() => {
      throw new Error("storage locked");
    });
    expect(createLazySavedPluginSecretRedactor(HOME as never)("anything")).toBe("[REDACTED]");
  });

  it("does not read secure storage for a session without MCP servers", () => {
    const service = serviceFor(managerWith([]));
    expect(service.mcpSurfaceSnapshot?.()).toBeDefined();
    expect(readNativeSecureStorage).not.toHaveBeenCalled();
  });

  it("still redacts saved secrets from a configured server's projection", () => {
    const service = serviceFor(managerWith([
      // The surface shows the command's executable name, redacted.
      { name: "demo", command: `demo-mcp-${SAVED_SECRET}` },
    ]));
    const surface = JSON.stringify(service.mcpSurfaceSnapshot?.());
    expect(readNativeSecureStorage).toHaveBeenCalled();
    expect(surface).not.toContain(SAVED_SECRET);
    expect(surface).toContain("[REDACTED]");
  });
});
