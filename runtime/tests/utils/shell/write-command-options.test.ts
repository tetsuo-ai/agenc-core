import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { classifyShellWorkspaceWritePolicy } from "../../../src/llm/shell-write-policy.js";
import {
  parseWriteCommandOperands,
  type WriteCommand,
  type WriteCommandDialect,
} from "../../../src/utils/shell/write-command-options.js";

const SOURCE = "tmp/payload";
const DEST = "dist/output";
const PROTECTED = join(homedir(), ".bashrc");
const DESTINATION_COMMANDS = new Set(["cp", "mv", "ln", "install"]);

function policy(command: WriteCommand, args: readonly string[], platform: NodeJS.Platform = "linux", bypass = false) {
  return classifyShellWorkspaceWritePolicy({
    toolName: "exec_command", args: { command, args }, workspaceRoot: "/repo",
    platform, allowWorkspaceDeletions: true, bypassesApprovalsAndSandbox: bypass,
  });
}

// Independently transcribed value options from the source getopt/clap tables.
// Ordinary values remain path-shaped so accidentally counting one as a source
// is observable as a fictitious child of the real file destination.
const VALUE_OPTIONS: [WriteCommand, WriteCommandDialect, string, string][] = [
  ["install", "gnu", "g", "staff"], ["install", "gnu", "m", "644"],
  ["install", "gnu", "o", "1000"], ["install", "gnu", "S", ".bak"],
  ["cp", "gnu", "S", ".bak"], ["mv", "gnu", "S", ".bak"], ["ln", "gnu", "S", ".bak"],
  ["install", "bsd", "B", ".bak"], ["install", "bsd", "D", "stage"],
  ["install", "bsd", "f", "nodump"], ["install", "bsd", "g", "staff"],
  ["install", "bsd", "h", "sha256"], ["install", "bsd", "l", "s"],
  ["install", "bsd", "m", "644"], ["install", "bsd", "N", "db"],
  ["install", "bsd", "o", "1000"], ["install", "bsd", "T", "tag"],
  ["touch", "gnu", "d", "2026-01-01"], ["touch", "gnu", "r", "reference"],
  ["touch", "gnu", "t", "202601010000"], ["touch", "bsd", "A", "010000"],
  ["touch", "bsd", "d", "2026-01-01"], ["touch", "bsd", "r", "reference"],
  ["touch", "bsd", "t", "202601010000"],
  ["truncate", "gnu", "r", "reference"], ["truncate", "gnu", "s", "0"],
  ["truncate", "bsd", "r", "reference"], ["truncate", "bsd", "s", "0"],
  ["truncate", "bsd", "o", "0"], ["truncate", "bsd", "l", "0"],
  ["mkdir", "gnu", "m", "755"], ["mkdir", "bsd", "m", "755"],
];
const LONG_VALUES: [WriteCommand, string, string][] = [
  ["install", "group", "staff"], ["install", "mode", "644"],
  ["install", "owner", "1000"], ["install", "strip-program", "strip"],
  ["install", "suffix", ".bak"], ["cp", "suffix", ".bak"],
  ["cp", "sparse", "always"], ["cp", "no-preserve", "mode"],
  ["mv", "suffix", ".bak"], ["ln", "suffix", ".bak"],
  ["touch", "date", "2026-01-01"], ["touch", "reference", "reference"],
  ["touch", "time", "mtime"], ["truncate", "reference", "reference"],
  ["truncate", "size", "0"], ["mkdir", "mode", "755"],
];

const FLAG_OPTIONS: [WriteCommand, WriteCommandDialect, string][] = [
  ["cp", "gnu", "abdfHilLnprsuvxPRTZ"], ["mv", "gnu", "bfinuvTZ"],
  ["ln", "gnu", "bdfinrsvFLPT"], ["install", "gnu", "bcCsDdpTvZ"],
  ["touch", "gnu", "acfmh"], ["tee", "gnu", "aip"], ["truncate", "gnu", "co"],
  ["rm", "gnu", "dfirvIR"], ["rmdir", "gnu", "v"], ["mkdir", "gnu", "pvZ"],
  ["cp", "bsd", "HLPRacfilNnprSsvXx"], ["mv", "bsd", "fhinv"],
  ["ln", "bsd", "FLPfhinsvw"], ["install", "bsd", "bcCdpSsUv"],
  ["touch", "bsd", "acfmh"], ["tee", "bsd", "ai"], ["truncate", "bsd", "cd"],
  ["rm", "bsd", "dfiIPRrvWx"], ["rmdir", "bsd", "v"], ["mkdir", "bsd", "pv"],
];
const flagCases = FLAG_OPTIONS.flatMap(([command, dialect, flags]) => [...flags]
  .map(flag => ({ command, dialect, flag })));

// GNU option names are a fixture from the source tables, including flags that
// can make a value prefix ambiguous. Exact names always beat longer names.
const GNU_LONG_FIXTURE: [WriteCommand, string][] = [
  ["cp", "archive attributes-only backup? copy-contents debug dereference force interactive link no-clobber no-dereference no-preserve: no-target-directory one-file-system parents path preserve? recursive remove-destination sparse: reflink? strip-trailing-slashes suffix: symbolic-link target-directory: update? verbose keep-directory-symlink context? help version"],
  ["mv", "backup? context debug exchange force interactive no-clobber no-copy no-target-directory strip-trailing-slashes suffix: target-directory: update? verbose help version"],
  ["ln", "backup? directory no-dereference no-target-directory force interactive suffix: target-directory: logical physical relative symbolic verbose help version"],
  ["install", "backup? compare context? debug directory group: mode: no-target-directory owner: preserve-timestamps preserve-context strip strip-program: suffix: target-directory: verbose help version"],
  ["touch", "time: no-create date: reference: no-dereference help version"],
  ["tee", "append ignore-interrupts output-error? help version"],
  ["truncate", "no-create io-blocks reference: size: help version"],
  ["rm", "dir force interactive? one-file-system no-preserve-root preserve-root? recursive verbose -presume-input-tty help version"],
  ["rmdir", "ignore-fail-on-non-empty path parents verbose help version"],
  ["unlink", "help version"], ["mkdir", "context? mode: parents verbose help version"],
];
const longCases = GNU_LONG_FIXTURE.flatMap(([command, fixture]) => fixture.split(" ").map(signature => ({
  command, signature, signatures: fixture.split(" "), names: fixture.split(" ").map(word => word.replace(/[:?]$/, "")),
})));

const shortCases = [...VALUE_OPTIONS, ...VALUE_OPTIONS.filter(row => row[1] === "gnu").map(([command, , option, value]) => [command, "uutils", option, value] as [WriteCommand, WriteCommandDialect, string, string])].flatMap(([command, dialect, option, value]) => {
  const tail = DESTINATION_COMMANDS.has(command) ? [SOURCE, DEST] : [DEST];
  const flag = command === "install" ? "p" : command === "mkdir" ? "p" :
    command === "touch" || command === "truncate" ? "c" : "v";
  return [[`-${option}`, value], [`-${option}${value}`], [`-${flag}${option}`, value], [`-${flag}${option}${value}`]]
    .map(prefix => ({ command, dialect, option, args: [...prefix, ...tail], tail }));
});

describe("pure write command option parser", () => {
  it.each(flagCases)("keeps operands after $command $dialect -$flag", ({ command, dialect, flag }) => {
    const parsed = parseWriteCommandOperands(command, [`-${flag}`, SOURCE, DEST], [dialect]);
    expect(parsed.indeterminate).toBe(false);
    expect(parsed.operands).toEqual([SOURCE, DEST]);
    expect(parsed.createsDirectories).toBe(command === "install" && flag === "d");
    expect(parsed.noTargetDirectory).toBe(flag === "T");
  });

  it.each(longCases)("checks every GNU prefix of $command --$signature", ({ command, signature, names, signatures }) => {
    const name = signature.replace(/[:?]$/, "");
    for (let length = 1; length <= name.length; length += 1) {
      const prefix = name.slice(0, length);
      const matches = names.includes(prefix) ? [prefix] : names.filter(other => other.startsWith(prefix));
      const resolved = matches[0];
      const spec = signatures.find(word => word.replace(/[:?]$/, "") === resolved) ?? signature;
      const unsupported = command === "cp" && ["parents", "path"].includes(resolved ?? "") ||
        command === "rmdir" && ["parents", "path"].includes(resolved ?? "");
      const forms = spec.endsWith(":") ? [[`--${prefix}`, "value"], [`--${prefix}=value`]] :
        spec.endsWith("?") ? [[`--${prefix}`], [`--${prefix}=value`]] : [[`--${prefix}`]];
      for (const form of forms) {
        const parsed = parseWriteCommandOperands(command, [...form, SOURCE, DEST], ["gnu"]);
        expect(parsed.indeterminate, prefix).toBe(matches.length !== 1 || unsupported);
        if (parsed.indeterminate) {
          expect(parsed.fallbackTargets).toContain(DEST);
        } else if (resolved === "target-directory") {
          expect(parsed.targetDirectory).toBe("value");
          expect(parsed.operands).toEqual([SOURCE, DEST]);
        } else {
          expect(parsed.operands, prefix).toEqual([SOURCE, DEST]);
        }
      }
    }
  });

  it.each(shortCases)("consumes $command $dialect $args", ({ command, dialect, args, tail }) => {
    const parsed = parseWriteCommandOperands(command, Object.freeze(args), [dialect]);
    expect(parsed.indeterminate).toBe(false);
    expect(parsed.operands).toEqual(tail);
    expect(parsed.targetDirectory).toBeUndefined();
    expect(parsed.noTargetDirectory).toBe(false);
    expect(parsed.extraTargets).toEqual([]);
  });

  it.each(LONG_VALUES)("consumes GNU %s --%s", (command, name, value) => {
    const tail = DESTINATION_COMMANDS.has(command) ? [SOURCE, DEST] : [DEST];
    for (const prefix of [[`--${name}`, value], [`--${name}=${value}`]]) {
      const parsed = parseWriteCommandOperands(command, [...prefix, ...tail], ["gnu"]);
      expect(parsed.indeterminate).toBe(false);
      expect(parsed.operands).toEqual(tail);
    }
  });

  it.each(["gnu", "uutils"] as const)("reads short and long target-directory forms in %s", dialect => {
    for (const command of ["cp", "mv", "ln", "install"] as const) {
      for (const prefix of [["-t", "dist"], ["-tdist"], ["-vt", "dist"], ["-vtdist"],
        ["--target-directory", "dist"], ["--target-directory=dist"], ["--target", "dist"], ["--target=dist"]]) {
        const parsed = parseWriteCommandOperands(command, [...prefix, SOURCE], [dialect]);
        expect(parsed.indeterminate).toBe(false);
        expect(parsed.operands).toEqual([SOURCE]);
        expect(parsed.targetDirectory).toBe("dist");
      }
      for (const flag of ["-T", "-vT", "--no-target-directory", "--no-target"]) {
        expect(parseWriteCommandOperands(command, [flag, SOURCE, DEST], [dialect])).toMatchObject({
          operands: [SOURCE, DEST], noTargetDirectory: true, indeterminate: false,
        });
      }
    }
  });

  it.each([
    ["install", "--mo", "644"], ["install", "--ow", "1000"], ["install", "--gro", "staff"],
    ["cp", "--suf", ".bak"], ["mv", "--suf", ".bak"], ["ln", "--suf", ".bak"],
    ["cp", "--spa", "always"], ["install", "--strip-p", "strip"],
  ] as const)("resolves %s %s with either value form", (command, prefix, value) => {
    for (const args of [[prefix, value, SOURCE, DEST], [`${prefix}=${value}`, SOURCE, DEST]]) {
      expect(parseWriteCommandOperands(command, args)).toMatchObject({ operands: [SOURCE, DEST], indeterminate: false });
    }
  });

  it.each(["cp", "mv", "ln", "install", "touch", "tee", "truncate", "rm", "rmdir", "unlink", "mkdir"] as const)(
    "ends %s options at -- and keeps a lone dash as an operand", command => {
      const args = ["--", "-m", "644", "--target-directory=elsewhere", "-", DEST];
      expect(parseWriteCommandOperands(command, args)).toMatchObject({ operands: args.slice(1), indeterminate: false });
    },
  );

  it("preserves empty argument words", () => {
    expect(parseWriteCommandOperands("install", ["-m", "", SOURCE, DEST]).operands).toEqual([SOURCE, DEST]);
    expect(parseWriteCommandOperands("cp", ["", DEST]).operands).toEqual(["", DEST]);
  });

  it("consumes an option-looking required value, including --", () => {
    expect(parseWriteCommandOperands("install", ["-m", "--", SOURCE, DEST], ["gnu"]).operands).toEqual([SOURCE, DEST]);
    expect(parseWriteCommandOperands("cp", ["--suffix", "-T", SOURCE, DEST], ["gnu"]).noTargetDirectory).toBe(false);
    expect(parseWriteCommandOperands("install", ["-m", "--", SOURCE, DEST], ["uutils"]).indeterminate).toBe(true);
    expect(parseWriteCommandOperands("cp", ["--suffix", "-T", SOURCE, DEST]).indeterminate).toBe(true);
  });

  it("uses uutils hyphen-value declarations and optional context boundaries", () => {
    for (const [command, option, value] of [["touch", "--date", "-1day"], ["truncate", "--size", "-10"], ["mkdir", "--mode", "-w"]] as const) {
      expect(parseWriteCommandOperands(command, [option, value, DEST], ["uutils"]).operands).toEqual([DEST]);
    }
    expect(parseWriteCommandOperands("install", ["--context", "-m", "644", SOURCE, DEST], ["uutils"]).operands).toEqual([SOURCE, DEST]);
    expect(parseWriteCommandOperands("install", ["--context", "--", SOURCE, DEST], ["uutils"]).operands).toEqual([SOURCE, DEST]);
  });

  it("reads BSD operands after the first source literally", () => {
    expect(parseWriteCommandOperands("install", [SOURCE, "-m", "644", DEST], ["bsd"]).operands)
      .toEqual([SOURCE, "-m", "644", DEST]);
    expect(parseWriteCommandOperands("install", [SOURCE, "-m", "644", DEST], ["gnu"]).operands)
      .toEqual([SOURCE, DEST]);
    expect(parseWriteCommandOperands("install", [SOURCE, "-m", "644", DEST], ["gnu", "uutils", "bsd"]).indeterminate).toBe(true);
  });

  it("keeps the GNU POSIXLY_CORRECT reading after an operand", () => {
    const args = [SOURCE, "--suffix", ".bak", DEST];
    expect(parseWriteCommandOperands("cp", args, ["gnu-posix"]).operands).toEqual(args);
    expect(parseWriteCommandOperands("cp", args).indeterminate).toBe(true);
    expect(policy("cp", [SOURCE, "--suffix", ".bak", PROTECTED]).blockedTargets).toContain(PROTECTED);
  });

  it("does not hide an unknown option after a BSD operand", () => {
    const args = [SOURCE, "--unknown", "value", PROTECTED];
    expect(parseWriteCommandOperands("cp", args, ["gnu", "uutils", "bsd"]).indeterminate).toBe(true);
    expect(policy("cp", args, "darwin", true).blockedTargets).toContain(PROTECTED);
  });

  it("keeps BSD install's metadata log as an independent write", () => {
    for (const prefix of [["-M", "dist/log"], ["-Mdist/log"], ["-pM", "dist/log"]]) {
      expect(parseWriteCommandOperands("install", [...prefix, SOURCE, DEST], ["bsd"])).toMatchObject({
        operands: [SOURCE, DEST], extraTargets: ["dist/log"], indeterminate: false,
      });
    }
  });

  it("reads -d according to the command", () => {
    expect(parseWriteCommandOperands("install", ["-d", "build/one", "dist/two"]).createsDirectories).toBe(true);
    expect(parseWriteCommandOperands("cp", ["-d", SOURCE, DEST]).createsDirectories).toBe(false);
    expect(parseWriteCommandOperands("ln", ["--directory", SOURCE, DEST]).createsDirectories).toBe(false);
  });

  it.each([
    ["install", "backup"], ["cp", "backup"], ["cp", "preserve"], ["cp", "reflink"],
    ["cp", "update"], ["mv", "backup"], ["mv", "update"], ["ln", "backup"], ["tee", "output-error"],
  ] as const)("keeps the next word after optional %s --%s", (command, name) => {
    expect(parseWriteCommandOperands(command, [`--${name}`, SOURCE, DEST]).operands).toEqual([SOURCE, DEST]);
    expect(parseWriteCommandOperands(command, [`--${name}=value`, SOURCE, DEST]).operands).toEqual([SOURCE, DEST]);
  });

  it("retains every path when optional value readings differ", () => {
    expect(parseWriteCommandOperands("install", ["--context", "ctx", SOURCE, DEST]).indeterminate).toBe(true);
    expect(parseWriteCommandOperands("cp", ["--no-preserve", "mode", SOURCE, DEST]).indeterminate).toBe(true);
    expect(parseWriteCommandOperands("install", ["--context=ctx", SOURCE, DEST]).operands).toEqual([SOURCE, DEST]);
  });

  it.each([
    ["install", ["--pres", "value", SOURCE, DEST]],
    ["install", ["--str", "value", SOURCE, DEST]],
    ["cp", ["--s", "value", SOURCE, DEST]],
    ["cp", ["--no", "value", SOURCE, DEST]],
    ["cp", ["--unknown", "value", SOURCE, DEST]],
    ["install", ["-q", "value", SOURCE, DEST]],
    ["cp", ["--mode", "644", SOURCE, DEST]],
    ["ln", ["--owner", "1000", SOURCE, DEST]],
    ["install", ["-m"]], ["cp", ["--suffix"]],
    ["cp", ["--verbose=unexpected", SOURCE, DEST]],
    ["cp", ["-t", "dist", "-T", SOURCE]],
    ["cp", ["-t", "build", "-t", "dist", SOURCE]],
    ["cp", ["--parents", SOURCE, DEST]],
  ] as const)("fails closed on %s %s", (command, args) => {
    const parsed = parseWriteCommandOperands(command, args);
    expect(parsed.indeterminate).toBe(true);
    for (const word of args) expect(parsed.fallbackTargets).toContain(word);
  });

  it("keeps attached paths even when the prefix is ambiguous", () => {
    expect(parseWriteCommandOperands("cp", [`--s=${PROTECTED}`, SOURCE, DEST]).fallbackTargets).toContain(PROTECTED);
    expect(parseWriteCommandOperands("install", [`-qM${PROTECTED}`, SOURCE, DEST], ["bsd"]).fallbackTargets).toContain(PROTECTED);
  });
});

describe("derived destinations and protected-path decisions", () => {
  it.each(flagCases)("derives the protected-path decision for $command $dialect -$flag", ({ command, dialect, flag }) => {
    const result = policy(command, [`-${flag}`, SOURCE, PROTECTED], dialect === "bsd" ? "darwin" : "linux");
    if (command === "mkdir") {
      // The existing policy permits known directory creation. The parser
      // still reads its operands, and unknown mkdir options fail closed.
      expect(result.blocked).toBe(false);
      expect(result.observedTargets).toEqual([]);
      return;
    }
    expect(result.blocked).toBe(true);
    expect(result.observedTargets).toContain(PROTECTED);
  });
  it.each(shortCases)("checks $command $dialect $args against a protected destination", ({ command, dialect, args }) => {
    const protectedArgs = [...args.slice(0, -1), PROTECTED];
    const result = policy(command, protectedArgs, dialect === "bsd" ? "darwin" : "linux");
    if (command === "mkdir") {
      expect(result.blocked).toBe(false);
      expect(result.observedTargets).toEqual([]);
      return;
    }
    expect(result.blocked).toBe(true);
    expect(result.observedTargets).toContain(PROTECTED);
    expect([...result.blockedTargets, ...result.blockedDeletions]).toContain(PROTECTED);
  });

  it.each(LONG_VALUES)("checks GNU %s --%s with both value forms", (command, name, value) => {
    const tail = DESTINATION_COMMANDS.has(command) ? [SOURCE, PROTECTED] : [PROTECTED];
    for (const prefix of [[`--${name}`, value], [`--${name}=${value}`]]) {
      const result = policy(command, [...prefix, ...tail]);
      if (command === "mkdir") {
        expect(result.blocked).toBe(false);
        expect(result.observedTargets).toEqual([]);
        continue;
      }
      expect(result.observedTargets).toContain(PROTECTED);
      expect(result.blocked).toBe(true);
    }
  });

  it.each(["cp", "mv", "ln", "install"] as const)("derives ordinary %s file and directory destinations", command => {
    for (const options of [[], ["-T"], ["--no-target-directory"]]) {
      const result = policy(command, [...options, SOURCE, DEST]);
      expect(result.indeterminate).toBe(false);
      expect(result.blocked).toBe(false);
      expect(result.observedTargets).toContain("/repo/dist/output");
    }
    for (const prefix of [["-t", "build"], ["-tbuild"], ["-vtbuild"], ["--target-directory=build"], ["--target", "build"]]) {
      const result = policy(command, [...prefix, SOURCE]);
      expect(result.blocked).toBe(false);
      expect(result.observedTargets).toContain("/repo/build/payload");

    }
  });

  it.each(["cp", "mv", "ln", "install"] as const)("blocks %s target-directory children with protected names", command => {
    for (const prefix of [["-t", "dist"], ["-tdist"], ["-vtdist"], ["--target=dist"], ["--target-directory", "dist"]]) {
      const result = policy(command, [...prefix, "tmp/.bashrc"]);
      expect(result.blocked).toBe(true);
      expect(result.observedTargets).toContain("/repo/dist/.bashrc");
    }
  });

  it.each([
    ["install", ["--mo", "644", SOURCE]], ["install", ["--mo=644", SOURCE]],
    ["install", ["--ow", "1000", SOURCE]], ["install", ["--ow=1000", SOURCE]],
    ["cp", ["--suf", ".bak", SOURCE]], ["cp", ["--suf=.bak", SOURCE]],
    ["install", ["-pm", "644", SOURCE]], ["install", ["-pm644", SOURCE]],
  ] as const)("blocks the reviewed %s %s bypass", (command, args) => {
    const result = policy(command, [...args, PROTECTED]);
    expect(result.indeterminate).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedTargets).toEqual([PROTECTED]);
  });

  it.each([false, true])("blocks unknown options and attached values even in bypass mode %s", bypass => {
    for (const command of ["cp", "mv", "ln", "install", "touch", "tee", "truncate", "rm", "rmdir", "unlink", "mkdir"] as const) {
      for (const args of [["--unknown", PROTECTED, SOURCE, DEST], [`--unknown=${PROTECTED}`, SOURCE, DEST], ["--unknown", SOURCE, PROTECTED, DEST]]) {
        const result = policy(command, args, "linux", bypass);
        expect(result.indeterminate).toBe(true);
        expect(result.observedTargets).toContain(PROTECTED);
        expect(result.blocked).toBe(true);
      }
    }
  });

  it.each(["B", "N", "M"])("finds BSD install -%s destinations", option => {
    const result = policy("install", [`-${option}`, "dist/value", SOURCE, PROTECTED], "darwin");
    expect(result.indeterminate).toBe(false);
    expect(result.blockedTargets).toEqual([PROTECTED]);
  });

  it("blocks a protected BSD metadata log independently of a legitimate build destination", () => {
    for (const prefix of [["-M", PROTECTED], [`-M${PROTECTED}`]]) {
      const result = policy("install", [...prefix, SOURCE, DEST], "darwin");
      expect(result.blockedTargets).toEqual([PROTECTED]);
      expect(result.observedTargets).toContain("/repo/dist/output");
    }
  });

  it("fails closed on BSD/GNU -S, -T and -D disagreements", () => {
    for (const args of [["-S", "value", SOURCE, PROTECTED], ["-T", "value", SOURCE, PROTECTED], ["-D", "value", SOURCE, PROTECTED]]) {
      const result = policy("install", args, "darwin", true);
      expect(result.indeterminate).toBe(true);
      expect(result.blockedTargets).toContain(PROTECTED);
    }
  });

  it("checks every install -d operand including a single directory", () => {
    expect(policy("install", ["-d", PROTECTED, "dist/ok"]).blockedTargets).toEqual([PROTECTED]);
    expect(policy("install", ["-d", PROTECTED]).blockedTargets).toEqual([PROTECTED]);
    expect(policy("install", ["-d", "build/one", "dist/two"]).blocked).toBe(false);
  });

  it.each([
    ["cp", [SOURCE, "build/"]], ["cp", [SOURCE, "dist/file"]],
    ["cp", ["--sparse", "always", SOURCE, "dist/file"]],
    ["cp", ["--suf", ".bak", SOURCE, "build/file"]],
    ["install", ["-pm", "644", SOURCE, "build/tool"]],
    ["install", ["--mo", "644", SOURCE, "dist/tool"]],
    ["install", ["-D", "-m", "755", SOURCE, "dist/bin/tool"]],
    ["touch", ["-r", PROTECTED, "build/stamp"]],
    ["truncate", ["-r", PROTECTED, "dist/file"]],
    ["mkdir", ["-pm", "755", "build/one", "dist/two"]],
    ["tee", ["--output-error=warn", "dist/log"]],
    ["rm", ["-rf", "tmp/scratch"]], ["rmdir", ["tmp/scratch"]], ["unlink", ["tmp/file"]],
  ] as const)("allows legitimate %s %s", (command, args) => {
    const result = policy(command, args);
    expect(result.indeterminate).toBe(false);
    expect(result.blocked).toBe(false);
  });
});
