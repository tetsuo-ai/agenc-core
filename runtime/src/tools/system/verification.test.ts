import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createVerificationTools } from "./verification.js";
import type { Tool } from "../types.js";

function findTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not found`);
  }
  return tool;
}

describe("verification tools", () => {
  it("lists repo-local probes for a package workspace", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "verification-tools-"));
    writeFileSync(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "verification-fixture",
        private: true,
        scripts: {
          build: "node -e \"process.stdout.write('build-ok')\"",
          test: "node -e \"process.stdout.write('test-ok')\"",
          smoke: "node -e \"process.stdout.write('smoke-ok')\"",
        },
      }),
    );
    const tools = createVerificationTools();
    const listProbes = findTool(tools, "verification.listProbes");

    const result = await listProbes.execute({ workspaceRoot });
    const parsed = JSON.parse(result.content) as {
      probes?: Array<{ id?: string; category?: string }>;
    };

    expect(result.isError).toBeUndefined();
    expect(parsed.probes?.some((probe) => probe.category === "build")).toBe(true);
    expect(parsed.probes?.some((probe) => probe.category === "smoke")).toBe(true);
  });

  it("runs a selected probe and returns verification metadata", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "verification-run-"));
    writeFileSync(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "verification-fixture",
        private: true,
        scripts: {
          build: "node -e \"process.stdout.write('build-ok')\"",
        },
      }),
    );
    const tools = createVerificationTools();
    const listProbes = findTool(tools, "verification.listProbes");
    const runProbe = findTool(tools, "verification.runProbe");

    const listed = JSON.parse(
      (await listProbes.execute({ workspaceRoot })).content,
    ) as {
      probes: Array<{ id: string; category: string }>;
    };
    const buildProbe = listed.probes.find((probe) => probe.category === "build");
    expect(buildProbe).toBeDefined();

    const result = await runProbe.execute({
      workspaceRoot,
      probeId: buildProbe!.id,
    });
    const parsed = JSON.parse(result.content) as {
      exitCode?: number;
      stdout?: string;
      __agencVerification?: {
        category?: string;
        probeId?: string;
      };
    };

    expect(result.isError).toBeUndefined();
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toContain("build-ok");
    expect(parsed.__agencVerification?.category).toBe("build");
    expect(parsed.__agencVerification?.probeId).toBe(buildProbe!.id);
  });

  it("does not list ctest when a CMake workspace does not declare tests", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "verification-cmake-no-tests-"));
    writeFileSync(
      join(workspaceRoot, "CMakeLists.txt"),
      [
        "cmake_minimum_required(VERSION 3.20)",
        "project(verification_fixture C)",
        "add_executable(sample main.c)",
      ].join("\n"),
    );
    writeFileSync(join(workspaceRoot, "main.c"), "int main(void) { return 0; }\n");

    const tools = createVerificationTools();
    const listProbes = findTool(tools, "verification.listProbes");
    const parsed = JSON.parse(
      (await listProbes.execute({ workspaceRoot })).content,
    ) as {
      probes?: Array<{ id?: string; category?: string }>;
    };

    expect(
      parsed.probes?.some((probe) => probe.id === "generic:test:ctest"),
    ).toBe(false);
  });

  it("lists ctest when a CMake workspace explicitly declares tests", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "verification-cmake-tests-"));
    writeFileSync(
      join(workspaceRoot, "CMakeLists.txt"),
      [
        "cmake_minimum_required(VERSION 3.20)",
        "project(verification_fixture C)",
        "enable_testing()",
        "add_test(NAME sample COMMAND ${CMAKE_COMMAND} -E echo ok)",
      ].join("\n"),
    );

    const tools = createVerificationTools();
    const listProbes = findTool(tools, "verification.listProbes");
    const parsed = JSON.parse(
      (await listProbes.execute({ workspaceRoot })).content,
    ) as {
      probes?: Array<{ id?: string; category?: string }>;
    };

    expect(
      parsed.probes?.some((probe) => probe.id === "generic:test:ctest"),
    ).toBe(true);
  });
});
