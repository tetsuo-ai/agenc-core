import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildRipgrepDiagnostic,
  buildRipgrepWarning,
} from "../../src/utils/doctorDiagnostic.js";
import {
  formatAgenCDoctorCliHelpText,
  parseAgenCDoctorCliArgs,
  runAgenCDoctorCli,
} from "./doctor-cli.js";
import {
  enterCanonicalSettingsAuthority,
  getCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
} from "../../src/utils/settings/canonicalAuthority.js";

async function withoutAmbientSettingsAuthority<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = getCanonicalSettingsAuthority();
  resetCanonicalSettingsAuthorityForTesting();
  try {
    return await operation();
  } finally {
    if (previous !== null) enterCanonicalSettingsAuthority(previous);
  }
}

// MACRO is a build-time esbuild define (tsup) that getDoctorDiagnostic reads
// (MACRO.VERSION / MACRO.PACKAGE_URL); it is not defined under vitest. Stand it
// in for the duration of the suite, mirroring the established test pattern.
let priorMacro: unknown;
beforeAll(() => {
  priorMacro = (globalThis as { MACRO?: unknown }).MACRO;
  (globalThis as { MACRO?: unknown }).MACRO = {
    VERSION: "test",
    PACKAGE_URL: "@tetsuo-ai/agenc",
  };
});
afterAll(() => {
  (globalThis as { MACRO?: unknown }).MACRO = priorMacro;
});

describe("parseAgenCDoctorCliArgs", () => {
  it("returns null for non-doctor argv so other CLIs can match", () => {
    expect(parseAgenCDoctorCliArgs(["mcp", "doctor"])).toBeNull();
    expect(parseAgenCDoctorCliArgs([])).toBeNull();
    expect(parseAgenCDoctorCliArgs(["--print", "hi"])).toBeNull();
  });

  it("parses `doctor` and the --json flag", () => {
    expect(parseAgenCDoctorCliArgs(["doctor"])).toEqual({
      kind: "doctor",
      json: false,
    });
    expect(parseAgenCDoctorCliArgs(["doctor", "--json"])).toEqual({
      kind: "doctor",
      json: true,
    });
    expect(parseAgenCDoctorCliArgs(["doctor", "--apparmor-profile"])).toEqual({
      kind: "apparmor-profile",
    });
  });

  it("does not combine diagnostic JSON with AppArmor profile output", () => {
    expect(
      parseAgenCDoctorCliArgs(["doctor", "--json", "--apparmor-profile"]),
    ).toEqual({
      kind: "error",
      message:
        "doctor command cannot combine '--json' and '--apparmor-profile'",
    });
  });

  it("rejects unknown flags instead of silently ignoring them", () => {
    // Revert-sensitive: the old parser only checked `rest.includes('--json')`
    // and returned a mode for any argv, so a typo'd flag ran a normal report.
    const typo = parseAgenCDoctorCliArgs(["doctor", "--jsonn"]);
    expect(typo).toEqual({
      kind: "error",
      message: "doctor command does not accept argument '--jsonn'",
    });
  });

  it("rejects unknown positional arguments", () => {
    const positional = parseAgenCDoctorCliArgs(["doctor", "foo"]);
    expect(positional?.kind).toBe("error");
  });

  it("returns help for --help and -h", () => {
    const long = parseAgenCDoctorCliArgs(["doctor", "--help"]);
    expect(long?.kind).toBe("help");
    const short = parseAgenCDoctorCliArgs(["doctor", "-h"]);
    expect(short?.kind).toBe("help");
  });
});

describe("runAgenCDoctorCli", () => {
  it("prints a human-readable diagnostic and returns an exit code", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const code = await withoutAmbientSettingsAuthority(() =>
        runAgenCDoctorCli({ kind: "doctor", json: false }),
      );
      const printed = out.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("AgenC Doctor");
      expect(printed).toContain("Configured rg:");
      expect(printed).toContain("Packaged rg (Grep/Glob/Orient):");
      // Exit code is 0 (clean) or 1 (warnings present) — always a number.
      expect([0, 1]).toContain(code);
    } finally {
      out.mockRestore();
    }
  });

  it("emits valid JSON under --json", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await withoutAmbientSettingsAuthority(() =>
        runAgenCDoctorCli({ kind: "doctor", json: true }),
      );
      const printed = out.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(printed);
      expect(parsed.ripgrepStatus).toEqual(
        expect.objectContaining({
          working: expect.any(Boolean),
          grepPinnedWorking: expect.any(Boolean),
        }),
      );
      expect(parsed).toHaveProperty("installationType");
    } finally {
      out.mockRestore();
    }
  });

  it("writes the error to stderr and exits 1 for an unknown argument", async () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const code = await runAgenCDoctorCli({
        kind: "error",
        message: "doctor command does not accept argument '--jsonn'",
      });
      const printed = err.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("--jsonn");
      expect(code).toBe(1);
    } finally {
      err.mockRestore();
    }
  });

  it("prints help to stdout and exits 0", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const code = await runAgenCDoctorCli({
        kind: "help",
        text: formatAgenCDoctorCliHelpText(),
      });
      const printed = out.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("agenc doctor");
      expect(code).toBe(0);
    } finally {
      out.mockRestore();
    }
  });
});

describe("buildRipgrepWarning", () => {
  it("returns null when ripgrep is working", () => {
    expect(
      buildRipgrepWarning({ working: true, mode: "system" }, "linux"),
    ).toBeNull();
  });

  it("returns an actionable install warning when configured rg is unavailable", () => {
    // Revert-sensitive: configured ripgrep is the Glob/TUI dependency. Its
    // remediation must install rg, independently of Grep's packaged binary.
    // (Revert-sensitive: drop the wiring and no warning is produced.)
    const warning = buildRipgrepWarning(
      { working: false, mode: "system" },
      "darwin",
    );
    expect(warning).not.toBeNull();
    expect(warning?.issue).toContain("configured ripgrep");
    expect(warning?.issue).toContain("interactive search");
    expect(warning?.fix).toContain("brew install ripgrep");
  });

  it("tailors configured-rg remediation to the platform", () => {
    expect(
      buildRipgrepWarning({ working: false, mode: "builtin" }, "win32")?.fix,
    ).toContain("winget install BurntSushi.ripgrep.MSVC");
    expect(
      buildRipgrepWarning({ working: false, mode: "system" }, "linux")?.fix,
    ).toContain("apt install ripgrep");
  });

  it.each([
    {
      name: "both available",
      working: true,
      grepPinnedWorking: true,
      configuredWarnings: 0,
      pinnedWarnings: 0,
    },
    {
      name: "only configured ripgrep missing",
      working: false,
      grepPinnedWorking: true,
      configuredWarnings: 1,
      pinnedWarnings: 0,
    },
    {
      name: "only packaged Grep ripgrep missing",
      working: true,
      grepPinnedWorking: false,
      configuredWarnings: 0,
      pinnedWarnings: 1,
    },
    {
      name: "both missing",
      working: false,
      grepPinnedWorking: false,
      configuredWarnings: 1,
      pinnedWarnings: 1,
    },
  ])(
    "keeps configured and pinned probes independent: $name",
    ({ working, grepPinnedWorking, configuredWarnings, pinnedWarnings }) => {
      // Revert-sensitive: combining the booleans makes either divergent case
      // emit the wrong diagnosis and remediation.
      const diagnostic = buildRipgrepDiagnostic(
        { working, mode: "system", systemPath: "/usr/bin/rg" },
        grepPinnedWorking,
        "linux",
      );
      expect(diagnostic.ripgrepStatus).toEqual({
        working,
        grepPinnedWorking,
        mode: "system",
        systemPath: "/usr/bin/rg",
      });
      const { warnings } = diagnostic;
      expect(
        warnings.filter((warning) =>
          warning.issue.includes("configured ripgrep"),
        ),
      ).toHaveLength(configuredWarnings);
      expect(
        warnings.filter((warning) =>
          warning.issue.includes("packaged pinned binary"),
        ),
      ).toHaveLength(pinnedWarnings);

      const configured = warnings.find((warning) =>
        warning.issue.includes("configured ripgrep"),
      );
      const pinned = warnings.find((warning) =>
        warning.issue.includes("packaged pinned binary"),
      );
      if (configured !== undefined) {
        expect(configured.fix).toContain("apt install ripgrep");
        expect(configured.fix).not.toContain(
          "reinstall that same AgenC version",
        );
      }
      if (pinned !== undefined) {
        expect(pinned.fix).toContain("reinstall that same AgenC version");
        expect(pinned.fix).toContain(
          "PATH-installed `rg` does not repair Grep, Glob, or Orient",
        );
        expect(pinned.fix).not.toContain("apt install ripgrep");
      }
    },
  );

  it("keeps pinned remediation platform-independent", () => {
    const status = {
      working: true,
      mode: "system" as const,
      systemPath: "/usr/bin/rg",
    };
    const windows = buildRipgrepDiagnostic(status, false, "win32").warnings[0]
      ?.fix;
    const linux = buildRipgrepDiagnostic(status, false, "linux").warnings[0]
      ?.fix;
    expect(windows).toBe(linux);
    expect(windows).not.toContain("winget");
    expect(linux).not.toContain("apt install");
  });
});

describe("formatAgenCDoctorCliHelpText", () => {
  it("documents usage and the mcp doctor pointer", () => {
    const help = formatAgenCDoctorCliHelpText();
    expect(help).toContain("agenc doctor");
    expect(help).toContain("--json");
    expect(help).toContain("--apparmor-profile");
    expect(help).toContain("agenc mcp doctor");
  });
});
