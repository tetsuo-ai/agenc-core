import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { linuxSecretStorage } from "../../../src/utils/secureStorage/linuxSecretStorage.ts";
import { windowsCredentialStorage } from "../../../src/utils/secureStorage/windowsCredentialStorage.ts";
import { getSecureStorageServiceName, CREDENTIALS_SERVICE_SUFFIX } from "../../../src/utils/secureStorage/macOsKeychainHelpers.ts";

type ExecaSyncOptions = {
  input?: string;
  reject?: boolean;
};

type ExecaSyncResult = {
  exitCode: number;
  stdout: string;
};

type ExecaSyncMock = (
  command: string,
  args: string[],
  options?: ExecaSyncOptions,
) => ExecaSyncResult;

const { mockExecaSync } = vi.hoisted(() => ({
  mockExecaSync: vi.fn<ExecaSyncMock>(() => ({ exitCode: 0, stdout: "" })),
}));

vi.mock("execa", () => ({
  execaSync: mockExecaSync,
}));

function getExecaCall(index: number): Parameters<ExecaSyncMock> {
  const call = mockExecaSync.mock.calls[index];
  if (!call) {
    throw new Error(`Expected execaSync call ${index}`);
  }
  return call;
}

function getPowerShellScript(index: number): string {
  const [, args] = getExecaCall(index);
  const script = args[1];
  if (script === undefined) {
    throw new Error(`Expected PowerShell script for execaSync call ${index}`);
  }
  return script;
}

function getExecaOptions(index: number): ExecaSyncOptions {
  const [, , options] = getExecaCall(index);
  if (!options) {
    throw new Error(`Expected execaSync options for call ${index}`);
  }
  return options;
}

describe("Secure Storage Platform Implementations", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockExecaSync.mockReset();
    mockExecaSync.mockImplementation(() => ({ exitCode: 0, stdout: "" }));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const testData = {
    mcpOAuth: {
      "test-server": {
        accessToken: "secret-token",
        expiresAt: 123456789,
        serverName: "test",
        serverUrl: "http://test"
      }
    }
  };

  describe("Config-Dir Isolation", () => {
    test("service name changes with AGENC_CONFIG_DIR", () => {
      const defaultName = getSecureStorageServiceName(CREDENTIALS_SERVICE_SUFFIX);

      process.env.AGENC_CONFIG_DIR = "/tmp/other-config";
      const otherName = getSecureStorageServiceName(CREDENTIALS_SERVICE_SUFFIX);

      expect(otherName).not.toBe(defaultName);
      expect(otherName).toContain("AgenC");
      expect(otherName).toContain(CREDENTIALS_SERVICE_SUFFIX);
    });

    test("Linux storage uses scoped service name", () => {
      process.env.AGENC_CONFIG_DIR = "/tmp/linux-scoped";
      const expectedName = getSecureStorageServiceName(CREDENTIALS_SERVICE_SUFFIX);

      linuxSecretStorage.update(testData);

      const [, args] = getExecaCall(0);
      expect(args).toContain(expectedName);
    });

    test("Windows storage uses scoped resource name", () => {
      process.env.AGENC_CONFIG_DIR = "/tmp/win-scoped";
      const expectedName = getSecureStorageServiceName(CREDENTIALS_SERVICE_SUFFIX);

      windowsCredentialStorage.update(testData);

      const script = getPowerShellScript(0);
      const options = getExecaOptions(0);
      expect(script).toContain(expectedName);
      expect(script).toContain("ProtectedData");
      expect(options.input).toContain("secret-token");
    });
  });

  describe("Windows PowerShell Escaping", () => {
    test("escapes single quotes and prevents $ expansion", () => {
      const dataWithDollar = {
        mcpOAuth: {
          "server": {
            accessToken: "token-with-$env:USERNAME",
            expiresAt: 123,
            serverName: "s",
            serverUrl: "u"
          }
        }
      };

      windowsCredentialStorage.update(dataWithDollar);

      const script = getPowerShellScript(0);
      const options = getExecaOptions(0);
      expect(script).toContain("[Console]::In.ReadToEnd()");
      expect(options.input).toContain("token-with-$env:USERNAME");

      const dataWithQuote = { mcpOAuth: { "s": { accessToken: "token'quote", expiresAt: 1, serverName: "s", serverUrl: "u" } } };
      windowsCredentialStorage.update(dataWithQuote);
      const options2 = getExecaOptions(1);
      expect(options2.input).toContain("token'quote");
    });

    test("delete() skips legacy PasswordVault by default", () => {
      windowsCredentialStorage.delete();
      expect(mockExecaSync).toHaveBeenCalledTimes(1);
      const script = getPowerShellScript(0);
      expect(script).not.toContain("System.Runtime.WindowsRuntime");
    });

    test("delete() includes legacy assembly load when explicitly enabled", () => {
      process.env.AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT = "1";
      windowsCredentialStorage.delete();
      const script = getPowerShellScript(1);
      expect(script).toContain("Add-Type -AssemblyName System.Runtime.WindowsRuntime");
    });

    test("renders a double-quote in username as a single-quoted literal", () => {
      process.env.AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT = "1";
      process.env.USER = 'user"name';
      windowsCredentialStorage.read();
      const script = getPowerShellScript(1);
      // gaphunt3 #29: untrusted values are emitted as single-quoted PowerShell
      // literals, so the double quote is passed through verbatim (no expansion,
      // no backtick escaping) inside Retrieve('...').
      expect(script).toContain('user"name');
      expect(script).toContain(`'user"name'`);
      expect(script).not.toContain('user`"name');
      expect(script).not.toContain('"user"name"');
    });

    test("read() does not touch legacy PasswordVault by default", () => {
      mockExecaSync.mockImplementationOnce(() => ({ exitCode: 1, stdout: "" }));

      const result = windowsCredentialStorage.read();

      expect(result).toBeNull();
      expect(mockExecaSync).toHaveBeenCalledTimes(1);
    });

    test("read() falls back to legacy PasswordVault when explicitly enabled", () => {
      process.env.AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT = "1";
      mockExecaSync
        .mockImplementationOnce(() => ({ exitCode: 0, stdout: "{not-json" }))
        .mockImplementationOnce(() => ({
          exitCode: 0,
          stdout: JSON.stringify(testData),
        }));

      const result = windowsCredentialStorage.read();

      expect(result).toEqual(testData);
      expect(mockExecaSync).toHaveBeenCalledTimes(2);
    });

    test("read() fails closed when the legacy PasswordVault payload is invalid JSON", () => {
      process.env.AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT = "1";
      mockExecaSync
        .mockImplementationOnce(() => ({ exitCode: 1, stdout: "" }))
        .mockImplementationOnce(() => ({ exitCode: 0, stdout: "{not-json" }));

      const result = windowsCredentialStorage.read();

      expect(result).toBeNull();
      expect(mockExecaSync).toHaveBeenCalledTimes(2);
    });
  });

  describe("Linux secret-tool Interaction", () => {
    test("update passes payload via stdin", () => {
      linuxSecretStorage.update(testData);

      const options = getExecaOptions(0);
      expect(options.input).toContain("secret-token");
    });

    test("read parses stdout", () => {
      mockExecaSync.mockReturnValue({ exitCode: 0, stdout: JSON.stringify(testData) });
      const result = linuxSecretStorage.read();

      expect(result).toEqual(testData);
    });
  });

  describe("Platform Selection", () => {
    const originalPlatform = process.platform;

    async function importFreshSecureStorage() {
      vi.resetModules();
      vi.doUnmock("../../../src/utils/secureStorage/index.js");
      return import("../../../src/utils/secureStorage/index.js");
    }

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    test("darwin returns keychain with fallback", async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const { getSecureStorage } = await importFreshSecureStorage();
      const storage = getSecureStorage();
      expect(storage.name).toContain("keychain");
    });

    test("linux returns libsecret with fallback", async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { getSecureStorage } = await importFreshSecureStorage();
      const storage = getSecureStorage();
      expect(storage.name).toContain("libsecret");
    });

    test("win32 returns credential-locker with fallback", async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { getSecureStorage } = await importFreshSecureStorage();
      const storage = getSecureStorage();
      expect(storage.name).toContain("credential-locker");
    });
  });
});
