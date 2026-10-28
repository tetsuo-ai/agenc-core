import * as childProcess from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>() }));
const { buildLinuxProcessBroker } = await import("../../scripts/build-linux-process-broker.mjs");
const { assertLinuxBrokerElf, inspectLinuxBroker } = await import("../../scripts/linux-broker-elf.mjs");
const { buildPortableLinuxBroker, portableBrokerDockerArgs, portableBrokerImage } = await import("../../scripts/build-portable-linux-broker.mjs");
const roots: string[] = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), "broker-portability-")); roots.push(root); return root; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const elf = `Type: DYN (Position-Independent Executable file)
GNU_STACK 0x0 0x0 0x0 0x0 0x0 RW 0x10
GNU_RELRO 0x0 0x0 0x0 0x0 0x0 R 0x1
(FLAGS) BIND_NOW
(FLAGS_1) Flags: NOW PIE
UND __stack_chk_fail@GLIBC_2.4
Version needs section '.gnu.version_r':
Name: GLIBC_2.9
Name: GLIBC_2.17
`;

describe("portable broker ABI and hardening admission", () => {
  it("compares required symbol versions numerically and ignores defined versions", () => {
    expect(assertLinuxBrokerElf("Version definition section: GLIBC_99.0\n" + elf, "2.31").minimumGlibc).toBe("2.17");
    expect(() => assertLinuxBrokerElf(elf + "Name: GLIBC_2.34\n", "2.31")).toThrow("needs GLIBC 2.34");
    expect(assertLinuxBrokerElf(elf + "Name: GLIBC_2.31.0\n", "2.31").minimumGlibc).toBe("2.31.0");
    expect(assertLinuxBrokerElf(elf + "Name: GLIBC_2.31\n", "2.31.0").minimumGlibc).toBe("2.31");
    expect(() => assertLinuxBrokerElf(elf + "Name: GLIBC_2.31.1\n", "2.31")).toThrow("needs GLIBC 2.31.1");
  });
  it.each(["2", "2.", "2.31.1.1", "", "latest", "GLIBC_2.31", "2.31-1"] as const)(
    "refuses a malformed GLIBC ceiling before inspecting the artifact (%s)",
    ceiling => {
      expect(() => assertLinuxBrokerElf(elf, ceiling)).toThrow("Invalid GLIBC ceiling");
    },
  );
  it.each([
    [elf.replace("Type: DYN", "Type: EXEC"), "PIE"],
    [elf.replace(" PIE", ""), "PIE"],
    [elf.replace("GNU_RELRO", "no-relro"), "RELRO"],
    [elf.replace("BIND_NOW", "LAZY"), "RELRO"],
    [elf.replace(" RW ", " RWE "), "non-executable"],
    [elf.replace(" RW ", " R "), "non-executable"],
    [elf.replace("__stack_chk_fail", "missing_stack_guard"), "stack protection"],
    [elf.split("Version needs section")[0], "inspectable GLIBC"],
  ])("refuses an incompatible native artifact before installation", (output, reason) => {
    expect(() => assertLinuxBrokerElf(output, "2.31")).toThrow(reason);
  });
});

describe.runIf(process.platform === "linux" && process.arch === "x64")("portable compiler isolation", () => {
  it("pins the offline baseline builder, current UID and read-only sources", () => {
    vi.stubEnv("CC", "/untrusted/compiler");
    const args = portableBrokerDockerArgs("/runtime", "/output");
    expect(args).toContain(portableBrokerImage);
    expect(args).toContain("--pull=never");
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args).toContain(`${process.getuid!()}:${process.getgid!()}`);
    expect(args).toContain("type=bind,source=/runtime/native,target=/source/native,readonly");
    expect(args).toContain("CC=/usr/bin/cc");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--pids-limit=128");
    expect(args).toContain("type=bind,source=/runtime/scripts/build-linux-process-broker.mjs,target=/source/build-linux-process-broker.mjs,readonly");
    expect(args).toContain("type=bind,source=/runtime/scripts/linux-broker-elf.mjs,target=/source/linux-broker-elf.mjs,readonly");
    expect(args).toContain("type=bind,source=/output,target=/out");
    expect(args).not.toContain("type=bind,source=/output,target=/out,readonly");
    expect(args.at(-1)).toBe("2.31");
    expect(args).not.toContain("/untrusted/compiler");
    expect(args).not.toContain("/var/run/docker.sock");
  });
  it("keeps the prior installed broker when the portable build fails", () => {
    const root = temporary(); mkdirSync(join(root, "dist"));
    const broker = join(root, "dist/agenc-process-broker");
    writeFileSync(broker, "prior trusted executable"); chmodSync(broker, 0o755);
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({ status: 1, stderr: "baseline build rejected", stdout: "" } as never);
    expect(() => buildPortableLinuxBroker(root)).toThrow("Portable Linux broker build failed");
    expect(readFileSync(broker, "utf8")).toBe("prior trusted executable");
    expect(statSync(broker).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(root, "dist"))).toEqual(["agenc-process-broker"]);
  });
  it("rejects ambiguous Docker mount paths", () => {
    expect(() => portableBrokerDockerArgs("/runtime,other", "/out")).toThrow("commas");
  });
  it("compiles the standalone broker with size optimization and strict warnings", () => {
    const broker = join(temporary(), "agenc-process-broker");
    childProcess.execFileSync("cc", ["-Os", "-static", "-std=c11", "-Wall", "-Wextra", "-Werror",
      resolve(import.meta.dirname, "../../native/agenc-process-broker.c"), "-o", broker]);
    expect(childProcess.execFileSync(broker, ["--describe-protocol"], { encoding: "utf8" }))
      .toBe("AGB2 owner-pid seccomp-snapshot-sealed-v1\n");
  });
  it("builds the unchanged broker source with sealed namespace init and explicit PIE", () => {
    // The native sealed-init admission intentionally requires a dist directory.
    const output = join(temporary(), "dist");
    buildLinuxProcessBroker(resolve(import.meta.dirname, "../.."), output);
    const broker = join(output, "agenc-process-broker");
    expect(childProcess.execFileSync(broker, ["--describe-protocol-v3"], { encoding: "utf8" })).toContain("sealed-static-init-ro-artifact-v1");
    expect(inspectLinuxBroker(broker, "9.0")).toMatchObject({ pie: true, fullRelro: true, nxStack: true, stackProtection: true });
    expect(statSync(broker).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(output, "agenc-namespace-init-entry"), "utf8")).toBe("AGENC_NAMESPACE_INIT_ENTRY_V1\n");
  }, 30_000);
  it("builds and admits the broker when older libc headers omit SYS_close_range", () => {
    const root = temporary();
    const includes = join(root, "include");
    mkdirSync(join(includes, "sys"), { recursive: true });
    writeFileSync(join(includes, "sys/syscall.h"), "#pragma once\n#include_next <sys/syscall.h>\n#undef SYS_close_range\n");
    const output = join(root, "dist");
    buildLinuxProcessBroker(resolve(import.meta.dirname, "../.."), output, "cc", ["-I", includes]);
    expect(childProcess.execFileSync(join(output, "agenc-process-broker"), ["--describe-protocol-v3"], { encoding: "utf8" }))
      .toContain("sealed-static-init-ro-artifact-v1");
    expect(statSync(join(output, "agenc-session-sandbox")).mode & 0o777).toBe(0o755);
  }, 30_000);
});
