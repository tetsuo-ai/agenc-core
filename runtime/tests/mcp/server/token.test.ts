import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveHomeContext } from "../../../src/config/home.js";
import { resolveGatewayGeneratedToken } from "../../../src/gateway/credentials.js";
import {
  MCP_SERVER_TOKEN_ENV,
  resolveMcpServerToken,
} from "../../../src/mcp/server/token.js";
import {
  getSecureStorage,
  type SecureStorage,
} from "../../../src/utils/secureStorage/index.js";
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
} from "../../../src/utils/secureStorage/native.js";
import { SecureStorageUnavailableError } from "../../../src/utils/secureStorage/unavailable.js";
import { subprocessEnv } from "../../../src/utils/subprocessEnv.js";
import { createTempWorkspaceFixture } from "../../helpers/temp-workspace.js";

const fixture = createTempWorkspaceFixture("agenc-mcp-server-token-");
const getSecureStorageMock = vi.mocked(getSecureStorage);
const hermeticStorageFactory = getSecureStorageMock.getMockImplementation();

async function home() {
  return resolveHomeContext({ AGENC_HOME: await fixture.create() });
}

/** A host with no native backend: reads report absence, writes are refused. */
function absentBackend(): SecureStorage {
  const unavailable = (): never => {
    throw new SecureStorageUnavailableError(
      "Secret Service is unavailable: no session message bus",
    );
  };
  return {
    name: "absent-libsecret",
    read: unavailable,
    readFresh: unavailable,
    readAsync: async () => unavailable(),
    update: () => ({ success: false, warning: "no backend" }),
    delete: () => true,
  };
}

afterEach(async () => {
  if (!hermeticStorageFactory) {
    throw new Error("Expected the hermetic secure-storage mock");
  }
  getSecureStorageMock.mockImplementation(hermeticStorageFactory);
  await fixture.cleanup();
});

describe("MCP SSE server token", () => {
  test("names the environment variable the docs and the CLI refer to", () => {
    expect(MCP_SERVER_TOKEN_ENV).toBe("AGENC_MCP_SERVER_TOKEN");
  });

  test("is scrubbed from the environment of tool and helper subprocesses", () => {
    const scrubbed = subprocessEnv({
      PATH: "/usr/bin",
      [MCP_SERVER_TOKEN_ENV]: "explicit-environment-token-0123",
    });
    expect(scrubbed).toEqual({ PATH: "/usr/bin" });
  });

  test("an explicit environment value of at least 16 characters wins and is never stored", async () => {
    const context = await home();
    const stored = resolveMcpServerToken(context, undefined);

    expect(resolveMcpServerToken(context, "0123456789abcdef")).toBe(
      "0123456789abcdef",
    );
    expect(resolveMcpServerToken(context, "  padded-explicit-token-value  ")).toBe(
      "padded-explicit-token-value",
    );
    expect(readNativeSecureStorage(context).mcpServer).toEqual({ token: stored });

    const fresh = await home();
    expect(resolveMcpServerToken(fresh, "explicit-token-for-a-fresh-home")).toBe(
      "explicit-token-for-a-fresh-home",
    );
    expect(readNativeSecureStorage(fresh).mcpServer).toBeUndefined();
  });

  test("ignores an environment value shorter than 16 characters", async () => {
    const context = await home();
    for (const short of ["", "   ", "short", "0123456789abcde", " 0123456789abcde "]) {
      const resolved = resolveMcpServerToken(context, short);
      expect(resolved).not.toBe(short.trim());
      expect(resolved).toBe(resolveMcpServerToken(context, undefined));
    }
  });

  test("generates one token per home and keeps it in native secure storage", async () => {
    const first = await home();
    const second = await home();
    const token = resolveMcpServerToken(first, undefined);

    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(resolveMcpServerToken(first, undefined)).toBe(token);
    expect(readNativeSecureStorage(first).mcpServer).toEqual({ token });
    expect(resolveMcpServerToken(second, undefined)).not.toBe(token);
  });

  test("leaves every other credential in the shared record alone", async () => {
    const context = await home();
    updateNativeSecureStorage(
      context,
      (current) => ({ ...current, primaryApiKey: "provider-secret" }),
      "test secure storage unavailable",
    );
    const hooks = resolveGatewayGeneratedToken(context, "hooks", undefined);

    const token = resolveMcpServerToken(context, undefined);

    expect(readNativeSecureStorage(context)).toEqual({
      primaryApiKey: "provider-secret",
      gateway: { generatedTokens: { hooks } },
      mcpServer: { token },
    });
    expect(resolveGatewayGeneratedToken(context, "hooks", undefined)).toBe(hooks);
    expect(token).not.toBe(hooks);
  });

  test("replaces a stored value that is too short to be a token", async () => {
    const context = await home();
    updateNativeSecureStorage(
      context,
      (current) => ({ ...current, mcpServer: { token: "too-short" } }),
      "test secure storage unavailable",
    );

    const token = resolveMcpServerToken(context, undefined);

    expect(token).not.toBe("too-short");
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(readNativeSecureStorage(context).mcpServer).toEqual({ token });
  });

  test("fails, naming the environment variable, when neither source has a token", async () => {
    const context = await home();
    getSecureStorageMock.mockReturnValue(absentBackend());

    for (const environmentValue of [undefined, "", "short-value"]) {
      let caught: unknown;
      try {
        resolveMcpServerToken(context, environmentValue);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("MCP SSE server has no bearer token");
      expect(message).toContain("AGENC_MCP_SERVER_TOKEN");
      expect(message).toContain("at least 16 characters");
      expect(message).toContain("Secret Service is unavailable");
      expect((caught as Error).cause).toBeInstanceOf(Error);
    }

    // The environment value needs no storage at all.
    expect(resolveMcpServerToken(context, "environment-only-token-value")).toBe(
      "environment-only-token-value",
    );
  });

  test("fails the same way when the backend refuses the write", async () => {
    const context = await home();
    getSecureStorageMock.mockReturnValue({
      name: "read-only-backend",
      read: () => null,
      readFresh: () => null,
      readAsync: async () => null,
      update: () => ({ success: false, warning: "keyring is locked" }),
      delete: () => true,
    });

    expect(() => resolveMcpServerToken(context, undefined)).toThrow(
      /AGENC_MCP_SERVER_TOKEN.*keyring is locked/u,
    );
  });
});
