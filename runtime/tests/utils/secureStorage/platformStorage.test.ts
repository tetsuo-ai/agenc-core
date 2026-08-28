import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createLinuxSecretStorage,
} from "../../../src/utils/secureStorage/linuxSecretStorage.ts";
import { createWindowsCredentialStorage } from "../../../src/utils/secureStorage/windowsCredentialStorage.ts";
import { createMacOsKeychainStorage } from "../../../src/utils/secureStorage/macOsKeychainStorage.ts";
import {
  clearKeychainCache,
  formatRetiredSecureStorageServiceName,
  getSecureStorageServiceName,
  CREDENTIALS_SERVICE_SUFFIX,
} from "../../../src/utils/secureStorage/macOsKeychainHelpers.ts";
import { resolveHomeContext } from "../../../src/config/home.ts";
import { homedir } from "node:os";
import { join } from "node:path";

type ExecaSyncOptions = {
  input?: string;
  reject?: boolean;
  stdio?: readonly string[];
};

type ExecaSyncResult = {
  exitCode: number;
  stdout: string;
  stderr?: string;
};

type ExecaSyncMock = (
  command: string,
  args: string[],
  options?: ExecaSyncOptions,
) => ExecaSyncResult;

const { mockExecaSync } = vi.hoisted(() => ({
  mockExecaSync: vi.fn<ExecaSyncMock>(() => ({ exitCode: 0, stdout: "" })),
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
  const commandIndex = args.indexOf("-Command");
  const script = commandIndex < 0 ? undefined : args[commandIndex + 1];
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

function defaultHome() {
  return resolveHomeContext({}, { platformHome: homedir() });
}

function relocatedHome(path: string) {
  return resolveHomeContext(
    { AGENC_HOME: path },
    { platformHome: homedir() },
  );
}

describe("Secure Storage Platform Implementations", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AGENC_HOME;
    clearKeychainCache();
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

  describe("AgenC-home isolation", () => {
    test("an explicit default home keeps the default service name", () => {
      const implicit = defaultHome();
      const defaultName = getSecureStorageServiceName(
        implicit,
        CREDENTIALS_SERVICE_SUFFIX,
      );

      const explicit = relocatedHome(join(homedir(), ".agenc"));
      expect(
        getSecureStorageServiceName(explicit, CREDENTIALS_SERVICE_SUFFIX),
      ).toBe(defaultName);
    });

    test("a relocated AGENC_HOME changes the service name", () => {
      const defaultName = getSecureStorageServiceName(
        defaultHome(),
        CREDENTIALS_SERVICE_SUFFIX,
      );

      const otherName = getSecureStorageServiceName(
        relocatedHome("/tmp/other-config"),
        CREDENTIALS_SERVICE_SUFFIX,
      );

      expect(otherName).not.toBe(defaultName);
      expect(otherName).toContain("AgenC");
      expect(otherName).toContain(CREDENTIALS_SERVICE_SUFFIX);
    });

    test("canonical relocated-home names eliminate historical 32-bit collisions", () => {
      const firstPath = "/tmp/agenc-collision-home-84347";
      const secondPath = "/tmp/agenc-collision-home-119788";
      const firstRetired = formatRetiredSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
        firstPath,
        "",
      );
      const secondRetired = formatRetiredSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
        secondPath,
        "",
      );

      expect(firstRetired).toBe(secondRetired);
      expect(getSecureStorageServiceName(
        relocatedHome(firstPath),
        CREDENTIALS_SERVICE_SUFFIX,
      )).not.toBe(getSecureStorageServiceName(
        relocatedHome(secondPath),
        CREDENTIALS_SERVICE_SUFFIX,
      ));
    });

    test("Linux storage uses scoped service name", () => {
      const home = relocatedHome("/tmp/linux-scoped");
      const expectedName = getSecureStorageServiceName(
        home,
        CREDENTIALS_SERVICE_SUFFIX,
      );
      const storage = createLinuxSecretStorage(home, mockExecaSync);

      process.env.AGENC_HOME = "/tmp/ambient-home-must-not-win";
      storage.update(testData);

      const [, args] = getExecaCall(0);
      expect(args).toContain(expectedName);
    });

    test("Windows storage uses scoped resource name", () => {
      const home = relocatedHome("/tmp/win-scoped");
      const expectedName = getSecureStorageServiceName(
        home,
        CREDENTIALS_SERVICE_SUFFIX,
      );
      const storage = createWindowsCredentialStorage(home, mockExecaSync);

      process.env.AGENC_HOME = "/tmp/ambient-home-must-not-win";
      storage.update(testData);

      const [command, args] = getExecaCall(0);
      const script = getPowerShellScript(0);
      const options = getExecaOptions(0);
      expect(command).toBe(
        String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      );
      expect(args.slice(0, 4)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ]);
      expect(script).toContain(expectedName);
      expect(script).toContain("ProtectedData");
      expect(script).toContain("$ErrorActionPreference = 'Stop'");
      expect(script).toContain(home.path);
      expect(script).not.toContain("ambient-home-must-not-win");
      expect(script).toContain("FileOptions]::WriteThrough");
      expect(script).toContain("[System.IO.File]::Replace");
      expect(script).toContain("[System.IO.File]::Move");
      expect(script).toContain("[System.IO.File]::Delete($tempPath)");
      expect(script).not.toContain("WriteAllText(\n          $path");
      expect(options.input).toContain("secret-token");
    });

    test("macOS keychain cache is isolated by bound home and service", () => {
      const homeA = relocatedHome("/tmp/mac-cache-a");
      const homeB = relocatedHome("/tmp/mac-cache-b");
      const storageA = createMacOsKeychainStorage(homeA, mockExecaSync);
      const storageB = createMacOsKeychainStorage(homeB, mockExecaSync);
      mockExecaSync
        .mockReturnValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ primaryApiKey: "secret-a" }),
        })
        .mockReturnValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ primaryApiKey: "secret-b" }),
        });

      process.env.AGENC_HOME = "/tmp/ambient-home-must-not-win";
      expect(storageA.read()).toEqual({ primaryApiKey: "secret-a" });
      expect(storageB.read()).toEqual({ primaryApiKey: "secret-b" });
      expect(storageA.read()).toEqual({ primaryApiKey: "secret-a" });
      expect(mockExecaSync).toHaveBeenCalledTimes(2);

      expect(getExecaCall(0)[1]).toContain(
        getSecureStorageServiceName(homeA, CREDENTIALS_SERVICE_SUFFIX),
      );
      expect(getExecaCall(1)[1]).toContain(
        getSecureStorageServiceName(homeB, CREDENTIALS_SERVICE_SUFFIX),
      );
    });

    test("binds the OS account and OAuth secure-storage namespace in HomeContext", () => {
      const home = resolveHomeContext(
        {
          AGENC_HOME: "/tmp/bound-native-secure-storage",
          USER: "captured-user",
          USER_TYPE: "ant",
          USE_LOCAL_OAUTH: "1",
        },
        { platformHome: homedir() },
      );
      const expectedService = getSecureStorageServiceName(
        home,
        CREDENTIALS_SERVICE_SUFFIX,
      );
      const storage = createMacOsKeychainStorage(home, mockExecaSync);

      process.env.USER = "ambient-user-must-not-win";
      delete process.env.USE_LOCAL_OAUTH;
      storage.update(testData);

      const [command, args, callOptions] = getExecaCall(0);
      expect(expectedService).toContain("-local-oauth");
      expect(command).toBe("/usr/libexec/agenc-keychain-helper");
      expect(args).toEqual([
        "write",
        expectedService,
        home.secureStorageAccount,
      ]);
      expect(args).not.toContain("captured-user");
      expect(args).not.toContain("ambient-user-must-not-win");
      expect(callOptions?.input).toContain("secret-token");
      expect(args.join(" ")).not.toContain("secret-token");
    });
  });

  describe("Windows PowerShell Escaping", () => {
    test("uses an injected absolute resolver and rejects relative results", () => {
      const resolved = String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
      const resolveExecutable = vi.fn(() => resolved);
      createWindowsCredentialStorage(
        defaultHome(),
        mockExecaSync,
        undefined,
        resolveExecutable,
      ).delete();

      expect(getExecaCall(0)[0]).toBe(resolved);
      expect(resolveExecutable).toHaveBeenCalledTimes(1);

      const relativeResolver = vi.fn(() => "powershell.exe");
      expect(() =>
        createWindowsCredentialStorage(
          defaultHome(),
          mockExecaSync,
          undefined,
          relativeResolver,
        ).read(),
      ).toThrow(/could not start PowerShell/u);
      expect(relativeResolver).toHaveBeenCalledTimes(1);
      expect(mockExecaSync).toHaveBeenCalledTimes(1);
    });

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

      const storage = createWindowsCredentialStorage(defaultHome(), mockExecaSync);
      storage.update(dataWithDollar);

      const script = getPowerShellScript(0);
      const options = getExecaOptions(0);
      expect(script).toContain("[Console]::In.ReadToEnd()");
      expect(options.input).toContain("token-with-$env:USERNAME");

      const dataWithQuote = { mcpOAuth: { "s": { accessToken: "token'quote", expiresAt: 1, serverName: "s", serverUrl: "u" } } };
      storage.update(dataWithQuote);
      const options2 = getExecaOptions(1);
      expect(options2.input).toContain("token'quote");
    });

    test("delete() uses only the canonical DPAPI store", () => {
      createWindowsCredentialStorage(defaultHome(), mockExecaSync).delete();
      expect(mockExecaSync).toHaveBeenCalledTimes(1);
      const script = getPowerShellScript(0);
      expect(script).toContain("$ErrorActionPreference = 'Stop'");
      expect(script).toContain("-ErrorAction Stop");
      expect(script).not.toContain("System.Runtime.WindowsRuntime");
      expect(script).not.toContain("PasswordVault");
    });

    test("quotes username-derived DPAPI entropy without PowerShell expansion", () => {
      process.env.USER = "user'$(calc)";
      const home = defaultHome();
      const identity = {
        serviceName: getSecureStorageServiceName(
          home,
          CREDENTIALS_SERVICE_SUFFIX,
        ),
        homePath: home.path,
        accountName: process.env.USER,
      };
      mockExecaSync.mockReturnValueOnce({ exitCode: 2, stdout: "" });
      expect(
        createWindowsCredentialStorage(home, mockExecaSync, identity).read(),
      ).toBeNull();
      const script = getPowerShellScript(0);
      expect(script).toContain("user''$(calc)");
      expect(script).not.toContain("PasswordVault");
      expect(script).not.toContain("Retrieve(");
    });

    test("delete() reports a PowerShell provider failure", () => {
      mockExecaSync.mockReturnValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "Access denied",
      });

      expect(
        createWindowsCredentialStorage(defaultHome(), mockExecaSync).delete(),
      ).toBe(false);
    });

    test("read() returns no credential when the canonical DPAPI record is absent", () => {
      mockExecaSync.mockImplementationOnce(() => ({ exitCode: 2, stdout: "" }));

      const result = createWindowsCredentialStorage(defaultHome(), mockExecaSync).read();

      expect(result).toBeNull();
      expect(mockExecaSync).toHaveBeenCalledTimes(1);
      const script = getPowerShellScript(0);
      expect(script.indexOf("Test-Path -LiteralPath")).toBeLessThan(
        script.indexOf("Add-Type -AssemblyName System.Security"),
      );
    });

    test("read() never classifies an exit-2 backend error as absence", () => {
      mockExecaSync.mockImplementationOnce(() => ({
        exitCode: 2,
        stdout: "",
        stderr: "Access denied",
      }));

      expect(() =>
        createWindowsCredentialStorage(defaultHome(), mockExecaSync).read(),
      ).toThrow(/Access denied/u);
    });

    test("read() reports an invalid canonical DPAPI payload as an error", () => {
      mockExecaSync.mockImplementationOnce(() => ({
        exitCode: 0,
        stdout: "{not-json",
      }));

      expect(() =>
        createWindowsCredentialStorage(defaultHome(), mockExecaSync).read(),
      ).toThrow(/invalid JSON/);
      expect(mockExecaSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("macOS Keychain read outcomes", () => {
    test("uses and caches an injected absolute bundled-helper resolver", () => {
      const resolveExecutable = vi.fn(() => "/opt/agenc/agenc-keychain-helper");
      const storage = createMacOsKeychainStorage(
        defaultHome(),
        mockExecaSync,
        undefined,
        false,
        undefined,
        resolveExecutable,
      );
      mockExecaSync.mockReturnValue({
        exitCode: 0,
        stdout: JSON.stringify({ primaryApiKey: "secret" }),
      });

      expect(storage.read()).toEqual({ primaryApiKey: "secret" });
      expect(storage.update(testData)).toEqual({ success: true });
      expect(storage.delete()).toBe(true);

      expect(resolveExecutable).toHaveBeenCalledTimes(1);
      expect(mockExecaSync.mock.calls.map((call) => call[0])).toEqual([
        "/opt/agenc/agenc-keychain-helper",
        "/opt/agenc/agenc-keychain-helper",
        "/opt/agenc/agenc-keychain-helper",
      ]);

      const relativeResolver = vi.fn(() => "agenc-keychain-helper");
      expect(() =>
        createMacOsKeychainStorage(
          defaultHome(),
          mockExecaSync,
          undefined,
          true,
          undefined,
          relativeResolver,
        ).read(),
      ).toThrow(/helper resolver returned a relative path/u);
    });

    test("returns null only for helper exit 2 with empty stderr", () => {
      mockExecaSync.mockReturnValueOnce({
        exitCode: 2,
        stdout: "",
        stderr: "",
      });

      expect(
        createMacOsKeychainStorage(
          relocatedHome("/tmp/mac-missing"),
          mockExecaSync,
        ).read(),
      ).toBeNull();
    });

    test("does not confuse helper exit 2 with a diagnostic for absence", () => {
      mockExecaSync.mockReturnValueOnce({
        exitCode: 2,
        stdout: "",
        stderr: "agenc-keychain-helper: internal protocol failure",
      });

      expect(() =>
        createMacOsKeychainStorage(
          relocatedHome("/tmp/mac-exit-two-diagnostic"),
          mockExecaSync,
        ).read(),
      ).toThrow(/internal protocol failure/u);
    });

    test("reports backend and parse failures instead of caching absence", () => {
      mockExecaSync
        .mockReturnValueOnce({ exitCode: 1, stdout: "" })
        .mockReturnValueOnce({ exitCode: 0, stdout: "{not-json" })
        .mockReturnValueOnce({ exitCode: 0, stdout: "null" });

      expect(() =>
        createMacOsKeychainStorage(
          relocatedHome("/tmp/mac-backend-error"),
          mockExecaSync,
        ).read(),
      ).toThrow(/lookup failed/u);
      expect(() =>
        createMacOsKeychainStorage(
          relocatedHome("/tmp/mac-parse-error"),
          mockExecaSync,
        ).read(),
      ).toThrow(/invalid JSON/u);
      expect(() =>
        createMacOsKeychainStorage(
          relocatedHome("/tmp/mac-null-record"),
          mockExecaSync,
        ).read(),
      ).toThrow(/non-null JSON object/u);
    });

    test("migration reads bypass the ordinary keychain TTL cache", () => {
      mockExecaSync
        .mockReturnValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ primaryApiKey: "first" }),
        })
        .mockReturnValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ primaryApiKey: "second" }),
        });
      const storage = createMacOsKeychainStorage(
        relocatedHome("/tmp/mac-migration-cas"),
        mockExecaSync,
        "AgenC-test-retired-credentials",
        true,
      );

      expect(storage.read()?.primaryApiKey).toBe("first");
      expect(storage.read()?.primaryApiKey).toBe("second");
      expect(mockExecaSync).toHaveBeenCalledTimes(2);
    });

    test("fresh reads bypass a stale ordinary keychain cache for locked RMW", () => {
      mockExecaSync
        .mockReturnValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({ primaryApiKey: "cached" }),
        })
        .mockReturnValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({
            primaryApiKey: "cached",
            trustedDeviceToken: "concurrent-write",
          }),
        });
      const storage = createMacOsKeychainStorage(
        relocatedHome("/tmp/mac-fresh-rmw"),
        mockExecaSync,
      );

      expect(storage.read()).toEqual({ primaryApiKey: "cached" });
      expect(storage.read()).toEqual({ primaryApiKey: "cached" });
      expect(storage.readFresh?.()).toEqual({
        primaryApiKey: "cached",
        trustedDeviceToken: "concurrent-write",
      });
      expect(mockExecaSync).toHaveBeenCalledTimes(2);
    });

    test("delete reports keychain command failures and accepts already-absent state", () => {
      mockExecaSync
        .mockReturnValueOnce({ exitCode: 1, stdout: "" })
        .mockReturnValueOnce({
          exitCode: 2,
          stdout: "",
          stderr: "",
        });

      expect(
        createMacOsKeychainStorage(
          relocatedHome("/tmp/mac-delete-failure"),
          mockExecaSync,
        ).delete(),
      ).toBe(false);
      expect(
        createMacOsKeychainStorage(
          relocatedHome("/tmp/mac-delete-absent"),
          mockExecaSync,
        ).delete(),
      ).toBe(true);
    });

    test("passes a hostile historical account as one argv value and never places secrets in argv", () => {
      process.env.USER = 'user"\n delete-generic-password -s victim'
      const home = resolveHomeContext(
        {
          AGENC_HOME: "/tmp/mac-hostile-account",
          USER: process.env.USER,
        },
        { platformHome: homedir() },
      )
      const result = createMacOsKeychainStorage(
        home,
        mockExecaSync,
        undefined,
        false,
        process.env.USER,
      ).update(testData)

      expect(result).toEqual({ success: true })
      const [command, args, options] = getExecaCall(0)
      expect(command).toBe('/usr/libexec/agenc-keychain-helper')
      expect(args).toEqual([
        'write',
        getSecureStorageServiceName(home, CREDENTIALS_SERVICE_SUFFIX),
        process.env.USER,
      ])
      expect(args.join(' ')).not.toContain('secret-token')
      expect(options?.input).toContain('secret-token')
    });

    test("accepts the last byte below the helper limit and rejects the limit without spawning", () => {
      const limit = 16 * 1024 * 1024
      const emptyPayloadBytes = Buffer.byteLength(
        JSON.stringify({ primaryApiKey: "" }),
        "utf8",
      )
      const storage = createMacOsKeychainStorage(defaultHome(), mockExecaSync)
      const belowLimit = "x".repeat(limit - emptyPayloadBytes - 1)

      expect(storage.update({ primaryApiKey: belowLimit })).toEqual({
        success: true,
      })
      expect(Buffer.byteLength(getExecaOptions(0).input ?? "", "utf8")).toBe(
        limit - 1,
      )
      expect(getExecaCall(0)[1].join(" ")).not.toContain(belowLimit.slice(0, 64))

      mockExecaSync.mockClear()
      const atLimit = "x".repeat(limit - emptyPayloadBytes)
      expect(storage.update({ primaryApiKey: atLimit })).toMatchObject({
        success: false,
        warning: expect.stringMatching(/at or above 16777216 bytes/u),
      })
      expect(mockExecaSync).not.toHaveBeenCalled()
    });

    test("readAsync uses the same native helper contract under injection", async () => {
      mockExecaSync.mockReturnValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ primaryApiKey: "async-secret" }),
      })
      const storage = createMacOsKeychainStorage(
        relocatedHome("/tmp/mac-async-helper"),
        mockExecaSync,
        undefined,
        true,
      )

      await expect(storage.readAsync()).resolves.toEqual({
        primaryApiKey: "async-secret",
      })
      expect(getExecaCall(0)[0]).toBe("/usr/libexec/agenc-keychain-helper")
      expect(getExecaCall(0)[1][0]).toBe("read")
    });
  });

  describe("Linux Secret Service helper interaction", () => {
    test("uses and caches an injected absolute executable resolver", () => {
      const helper = "/opt/system/bin/agenc-secret-service-helper";
      const resolveExecutable = vi.fn(() => helper);
      const storage = createLinuxSecretStorage(
        defaultHome(),
        mockExecaSync,
        undefined,
        resolveExecutable,
      );

      storage.update(testData);
      storage.delete();

      expect(getExecaCall(0)[0]).toBe(helper);
      expect(getExecaCall(1)[0]).toBe(helper);
      expect(resolveExecutable).toHaveBeenCalledTimes(1);

      const relativeResolver = vi.fn(() => "agenc-secret-service-helper");
      expect(() =>
        createLinuxSecretStorage(
          defaultHome(),
          mockExecaSync,
          undefined,
          relativeResolver,
        ).read(),
      ).toThrow(/relative path/u);
    });

    test("update passes only the payload via stdin to exact-item write", () => {
      createLinuxSecretStorage(defaultHome(), mockExecaSync).update(testData);

      const [, args] = getExecaCall(0);
      const options = getExecaOptions(0);
      expect(args[0]).toBe("write");
      expect(args).not.toContain("secret-token");
      expect(options.input).toContain("secret-token");
    });

    test("does not retain the retired secret-tool 8 KiB payload ceiling", () => {
      const storage = createLinuxSecretStorage(defaultHome(), mockExecaSync);
      const largeRecord = { primaryApiKey: "x".repeat(32 * 1024) };

      expect(storage.update(largeRecord)).toEqual({ success: true });
      expect(getExecaOptions(0).input).toContain(largeRecord.primaryApiKey);
    });

    test("accepts the last byte below the helper limit and rejects the limit without spawning", () => {
      const limit = 16 * 1024 * 1024;
      const emptyPayloadBytes = Buffer.byteLength(
        JSON.stringify({ primaryApiKey: "" }),
        "utf8",
      );
      const storage = createLinuxSecretStorage(defaultHome(), mockExecaSync);
      const belowLimit = "x".repeat(limit - emptyPayloadBytes - 1);

      expect(storage.update({ primaryApiKey: belowLimit })).toEqual({
        success: true,
      });
      expect(Buffer.byteLength(getExecaOptions(0).input ?? "", "utf8")).toBe(
        limit - 1,
      );
      expect(getExecaCall(0)[1].join(" ")).not.toContain(
        belowLimit.slice(0, 64),
      );

      mockExecaSync.mockClear();
      const atLimit = "x".repeat(limit - emptyPayloadBytes);
      expect(storage.update({ primaryApiKey: atLimit })).toMatchObject({
        success: false,
        warning: expect.stringMatching(/at or above 16777216 bytes/u),
      });
      expect(mockExecaSync).not.toHaveBeenCalled();
    });

    test("read parses stdout", () => {
      mockExecaSync.mockReturnValue({ exitCode: 0, stdout: JSON.stringify(testData) });
      const result = createLinuxSecretStorage(defaultHome(), mockExecaSync).read();

      expect(result).toEqual(testData);
      expect(getExecaCall(0)[1][0]).toBe("read");
    });

    test("distinguishes a missing record from backend and parse failures", () => {
      const home = defaultHome();
      mockExecaSync
        .mockReturnValueOnce({ exitCode: 2, stdout: "" })
        .mockReturnValueOnce({ exitCode: 2, stdout: "", stderr: "locked" })
        .mockReturnValueOnce({ exitCode: 0, stdout: "{not-json" });

      expect(createLinuxSecretStorage(home, mockExecaSync).read()).toBeNull();
      expect(() =>
        createLinuxSecretStorage(home, mockExecaSync).read(),
      ).toThrow(/locked/u);
      expect(() =>
        createLinuxSecretStorage(home, mockExecaSync).read(),
      ).toThrow(/invalid JSON/u);
    });

    test("fails closed on duplicate exact identities and deletes one exact item only", () => {
      const home = defaultHome();
      mockExecaSync
        .mockReturnValueOnce({
          exitCode: 1,
          stdout: "",
          stderr: "multiple records for the exact AgenC identity",
        })
        .mockReturnValueOnce({ exitCode: 2, stdout: "" })
        .mockReturnValueOnce({ exitCode: 1, stdout: "", stderr: "ambiguous" });

      const storage = createLinuxSecretStorage(home, mockExecaSync);
      expect(() => storage.read()).toThrow(/multiple records/u);
      expect(storage.delete()).toBe(true);
      expect(storage.delete()).toBe(false);
      expect(getExecaCall(1)[1][0]).toBe("delete");
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

    test("darwin returns the native keychain", async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const { getSecureStorage } = await importFreshSecureStorage();
      const storage = getSecureStorage(defaultHome());
      expect(storage.name).toContain("keychain");
    });

    test("linux returns native libsecret", async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { getSecureStorage } = await importFreshSecureStorage();
      const storage = getSecureStorage(defaultHome());
      expect(storage.name).toContain("libsecret");
    });

    test("win32 returns native DPAPI storage", async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { getSecureStorage } = await importFreshSecureStorage();
      const storage = getSecureStorage(defaultHome());
      expect(storage.name).toContain("windows-dpapi");
    });
  });
});
