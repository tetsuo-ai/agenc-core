/**
 * gaphunt3 secure-storage regression tests — ids #24, #28, #29.
 *
 * #24 plainTextStorage.update must create the credentials file atomically with
 *     restrictive perms (openSync 'w' mode 0o600) instead of writing with the
 *     default umask mode and tightening to 0o600 only afterward (a window in
 *     which the plaintext secrets are world/group-readable). The dir is created
 *     0o700 and any pre-existing file is chmod'd to 0o600 BEFORE the write.
 *
 * #28 macOsKeychainStorage.read()/delete() must invoke `security` via argv with
 *     NO shell (mirroring update()), not by string-interpolating the env-derived
 *     username into a shell command — otherwise USER='"; <cmd>; "' escapes the
 *     quotes and executes arbitrary shell.
 *
 * #29 The Windows legacy PasswordVault read/delete scripts must single-quote
 *     untrusted values (escapePowerShellSingleQuoted) instead of the weak `\"`
 *     double-quote escaping, so PowerShell does not expand $ / $(...) / backtick
 *     in a crafted USER value.
 *
 * Fast unit tests: no network, no real subprocesses, no real fs writes. Each
 * test fails if its corresponding fix is reverted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────
// #24 — plainTextStorage.update creates the file with mode 0o600 atomically
// ─────────────────────────────────────────────────────────────────────

// Capture options handed to the write wrapper and the mkdir mode; capture the
// chmod calls (path + mode) so we can assert the pre-write tightening.
const writeCalls: Array<{ path: string; options: unknown }> = [];
const mkdirCalls: Array<{ path: string; options: unknown }> = [];
const chmodCalls: Array<{ path: string; mode: number }> = [];

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    chmodSync: (path: string, mode: number) => {
      chmodCalls.push({ path, mode });
    },
  };
});

vi.mock("src/utils/slowOperations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/utils/slowOperations")>();
  return {
    ...actual,
    writeFileSync_DEPRECATED: (
      path: string,
      _data: unknown,
      options: unknown,
    ) => {
      writeCalls.push({ path, options });
    },
  };
});

vi.mock("src/utils/fsOperations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/utils/fsOperations")>();
  return {
    ...actual,
    getFsImplementation: () => ({
      mkdirSync: (path: string, options: unknown) => {
        mkdirCalls.push({ path, options });
      },
    }),
  };
});

import { plainTextStorage } from "src/utils/secureStorage/plainTextStorage";

describe("gaphunt3 #24: plaintext credentials file is never world/group-readable", () => {
  beforeEach(() => {
    writeCalls.length = 0;
    mkdirCalls.length = 0;
    chmodCalls.length = 0;
  });

  it("creates the file atomically with mode 0o600 (flush path), not the default umask mode", () => {
    const result = plainTextStorage.update({
      agenc: { accessToken: "secret-token" },
    });

    expect(result.success).toBe(true);
    expect(writeCalls).toHaveLength(1);

    const options = writeCalls[0].options as {
      mode?: number;
      flush?: boolean;
    };
    // Revert-sensitive: before the fix the write used { flush:false } and NO
    // mode, so the file was created with the umask default (0o644/0o660) and
    // only chmod'd to 0o600 afterward. The fix passes mode 0o600 + flush:true
    // (which routes through openSync(path,'w',0o600) — atomic restrictive create).
    expect(options.mode).toBe(0o600);
    expect(options.flush).toBe(true);
  });

  it("creates the config dir with mode 0o700", () => {
    plainTextStorage.update({ agenc: { accessToken: "t" } });

    expect(mkdirCalls).toHaveLength(1);
    const mkdirOptions = mkdirCalls[0].options as { mode?: number };
    expect(mkdirOptions.mode).toBe(0o700);
  });

  it("tightens an existing file to 0o600 BEFORE writing", () => {
    plainTextStorage.update({ agenc: { accessToken: "t" } });

    // There must be a chmod(path, 0o600) recorded before the write call.
    // (Revert removes the pre-write chmod entirely.)
    expect(chmodCalls.length).toBeGreaterThanOrEqual(1);
    expect(chmodCalls[0].mode).toBe(0o600);
    // And every chmod tightens to 0o600 (never leaves a broader mode).
    for (const c of chmodCalls) {
      expect(c.mode).toBe(0o600);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// #28 — macOS keychain read()/delete() use argv (no shell), not shell strings
// ─────────────────────────────────────────────────────────────────────

const execaSyncCalls: Array<{ file: unknown; args: unknown; options: unknown }> =
  [];

vi.mock("execa", () => ({
  execaSync: (file: unknown, args: unknown, options: unknown) => {
    execaSyncCalls.push({ file, args, options });
    // For read(): exitCode 0 with no stdout -> read() returns null. For
    // delete(): return value is ignored. Either way no shell is involved.
    return { exitCode: 0, stdout: "" };
  },
}));

import { macOsKeychainStorage } from "src/utils/secureStorage/macOsKeychainStorage";
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  CREDENTIALS_SERVICE_SUFFIX,
} from "src/utils/secureStorage/macOsKeychainHelpers";

const INJECTION = '"; INJECT; "';

describe("gaphunt3 #28: macOS keychain read()/delete() resist USER shell injection", () => {
  const originalUser = process.env.USER;

  beforeEach(() => {
    execaSyncCalls.length = 0;
    process.env.USER = INJECTION;
    // The 30s TTL cache would otherwise short-circuit read() without spawning.
    clearKeychainCache();
  });

  afterEach(() => {
    if (originalUser === undefined) {
      delete process.env.USER;
    } else {
      process.env.USER = originalUser;
    }
    clearKeychainCache();
  });

  it("read() passes the username as a single literal argv element (no shell)", () => {
    macOsKeychainStorage.read();

    expect(execaSyncCalls.length).toBeGreaterThanOrEqual(1);
    const call = execaSyncCalls[0];
    expect(call.file).toBe("security");

    const svc = getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX);
    // Revert-sensitive: before the fix read() called
    // execSyncWithDefaults_DEPRECATED(`security ... -a "${username}" ...`) with
    // shell:true (a string command, not argv). After the fix it is argv.
    expect(call.args).toEqual([
      "find-generic-password",
      "-a",
      INJECTION,
      "-w",
      "-s",
      svc,
    ]);

    // No shell, and the malicious value is carried verbatim as one arg — never
    // a concatenated command string with shell:true.
    expect(Array.isArray(call.args)).toBe(true);
    expect(call.file).not.toContain(INJECTION);
    const opts = call.options as { shell?: boolean } | undefined;
    expect(opts?.shell).not.toBe(true);
  });

  it("delete() passes the username as a single literal argv element (no shell)", () => {
    macOsKeychainStorage.delete();

    expect(execaSyncCalls.length).toBeGreaterThanOrEqual(1);
    const call = execaSyncCalls[0];
    expect(call.file).toBe("security");

    const svc = getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX);
    expect(call.args).toEqual([
      "delete-generic-password",
      "-a",
      INJECTION,
      "-s",
      svc,
    ]);
    const opts = call.options as { shell?: boolean } | undefined;
    expect(opts?.shell).not.toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// #29 — Windows legacy PasswordVault scripts single-quote untrusted values
// ─────────────────────────────────────────────────────────────────────

import { windowsCredentialStorage } from "src/utils/secureStorage/windowsCredentialStorage";

describe("gaphunt3 #29: Windows legacy PasswordVault resists PowerShell expansion injection", () => {
  const originalUser = process.env.USER;
  const originalLegacy = process.env.AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT;
  const POISON = "a$(INJECT)";

  beforeEach(() => {
    execaSyncCalls.length = 0;
    process.env.AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT = "1";
    process.env.USER = POISON;
  });

  afterEach(() => {
    if (originalUser === undefined) delete process.env.USER;
    else process.env.USER = originalUser;
    if (originalLegacy === undefined)
      delete process.env.AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT;
    else process.env.AGENC_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT = originalLegacy;
  });

  function legacyScripts(): string[] {
    return execaSyncCalls
      .map((c) => {
        const args = c.args as unknown;
        return Array.isArray(args) ? String(args[1] ?? "") : "";
      })
      .filter((s) => s.includes("PasswordVault"));
  }

  it("read() fallback renders the username inside a single-quoted literal, not a $(...)-active double-quoted string", () => {
    // The execaSync mock returns exitCode 0 with empty stdout; read()'s DPAPI
    // branch requires non-empty stdout, so it falls through to the legacy
    // PasswordVault read whose script we inspect below.
    windowsCredentialStorage.read();

    const scripts = legacyScripts();
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    const script = scripts[0];

    // Revert-sensitive: before the fix the script embedded the value in a
    // DOUBLE-quoted PowerShell string ("a$(INJECT)") where $(...) is evaluated.
    // After the fix it is inside a SINGLE-quoted literal ('a$(INJECT)') with
    // expansion disabled.
    // gaphunt3 #29: the poison is the USERNAME (Retrieve's 2nd argument), so
    // assert the value appears as a single-quoted PowerShell literal anywhere
    // in the script (revert-sensitive: the old code double-quoted it).
    expect(script).toContain("'a$(INJECT)'");
    // The dangerous double-quoted form must be gone.
    expect(script).not.toContain('Retrieve("');
    expect(script).not.toContain('"a$(INJECT)"');
  });

  it("delete() legacy branch renders the username inside a single-quoted literal", () => {
    windowsCredentialStorage.delete();

    const scripts = legacyScripts();
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    const script = scripts[0];

    // gaphunt3 #29: the poison is the USERNAME (Retrieve's 2nd argument), so
    // assert the value appears as a single-quoted PowerShell literal anywhere
    // in the script (revert-sensitive: the old code double-quoted it).
    expect(script).toContain("'a$(INJECT)'");
    expect(script).not.toContain('Retrieve("');
    expect(script).not.toContain('"a$(INJECT)"');
  });
});
