import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildRipgrepWarning } from "../../src/utils/doctorDiagnostic.js";
import {
  formatAgenCDoctorCliHelpText,
  parseAgenCDoctorCliArgs,
  runAgenCDoctorCli,
} from "./doctor-cli.js";

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
      const code = await runAgenCDoctorCli({ kind: "doctor", json: false });
      const printed = out.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("AgenC Doctor");
      expect(printed).toContain("ripgrep:");
      // Exit code is 0 (clean) or 1 (warnings present) — always a number.
      expect([0, 1]).toContain(code);
    } finally {
      out.mockRestore();
    }
  });

  it("emits valid JSON under --json", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await runAgenCDoctorCli({ kind: "doctor", json: true });
      const printed = out.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(printed);
      expect(parsed).toHaveProperty("ripgrepStatus");
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

  it("returns an actionable install warning when rg is unavailable", () => {
    // No rg binary is bundled: when the resolved rg can't start, `agenc doctor`
    // must surface a concrete fix command, not just a status line.
    // (Revert-sensitive: drop the wiring and no warning is produced.)
    const warning = buildRipgrepWarning(
      { working: false, mode: "system" },
      "darwin",
    );
    expect(warning).not.toBeNull();
    expect(warning?.issue).toContain("ripgrep");
    expect(warning?.fix).toContain("brew install ripgrep");
  });

  it("tailors the fix command to the platform", () => {
    expect(
      buildRipgrepWarning({ working: false, mode: "builtin" }, "win32")?.fix,
    ).toContain("winget install BurntSushi.ripgrep.MSVC");
    expect(
      buildRipgrepWarning({ working: false, mode: "system" }, "linux")?.fix,
    ).toContain("apt install ripgrep");
  });
});

describe("formatAgenCDoctorCliHelpText", () => {
  it("documents usage and the mcp doctor pointer", () => {
    const help = formatAgenCDoctorCliHelpText();
    expect(help).toContain("agenc doctor");
    expect(help).toContain("--json");
    expect(help).toContain("agenc mcp doctor");
  });
});
