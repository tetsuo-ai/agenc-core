import { describe, expect, it } from "vitest";

import {
  isSandboxLauncherInjectionKey,
  sanitizeSandboxLauncherEnvironment,
} from "../../src/sandbox/launcher-environment.js";

const INJECTION_KEYS = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "ELECTRON_RUN_AS_NODE",
  "BUN_OPTIONS",
  "GCONV_PATH",
  "LOCPATH",
  "NLSPATH",
  "MALLOC_TRACE",
  "MALLOC_CHECK_",
  "GLIBC_TUNABLES",
  "LIBPATH",
  "SHLIB_PATH",
] as const;

const INJECTION_PREFIXES = ["LD_", "DYLD_"] as const;

describe("isSandboxLauncherInjectionKey", () => {
  it.each(INJECTION_KEYS)("rejects %s regardless of case", (key) => {
    expect(isSandboxLauncherInjectionKey(key)).toBe(true);
    expect(isSandboxLauncherInjectionKey(key.toLowerCase())).toBe(true);
  });

  it.each([
    "LD_PRELOAD",
    "ld_library_path",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "dyld_library_path",
  ])("rejects loader prefix %s", (key) => {
    expect(isSandboxLauncherInjectionKey(key)).toBe(true);
  });

  it.each(["PATH", "HOME", "LANG", "TERM", "USER", "TMPDIR", "AGENC_HOME"])(
    "keeps ordinary launcher key %s",
    (key) => {
      expect(isSandboxLauncherInjectionKey(key)).toBe(false);
    },
  );
});

describe("sanitizeSandboxLauncherEnvironment", () => {
  it("drops injection keys and undefined values while keeping PATH and caller env", () => {
    const sanitized = sanitizeSandboxLauncherEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/agenc",
      LANG: "C",
      NODE_OPTIONS: "--require=/tmp/preload.cjs",
      node_path: "/tmp/attacker-modules",
      LD_PRELOAD: "/tmp/inject.so",
      dyld_insert_libraries: "/tmp/inject.dylib",
      GCONV_PATH: "/tmp/gconv",
      EMPTY: undefined,
    });

    expect(sanitized).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/agenc",
      LANG: "C",
    });
    expect(sanitized).not.toHaveProperty("EMPTY");
    for (const prefix of INJECTION_PREFIXES) {
      expect(isSandboxLauncherInjectionKey(`${prefix}DEBUG`)).toBe(true);
    }
  });
});
