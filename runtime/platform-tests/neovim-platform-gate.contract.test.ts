import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { waitForExactFileText } from "../scripts/check-tui-e2e/helpers/workbench-buffer-neovim.mjs";

import {
  HOSTED_NEOVIM_SCENARIOS,
  HOSTED_NEOVIM_TARGETS,
  PLATFORM_SCENARIO_REGISTRY,
  selectPlatformScenarios,
} from "../scripts/check-tui-e2e/platform-scenarios.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const RUNTIME_ROOT = resolve(REPO_ROOT, "runtime");

const EXPECTED_TARGETS = {
  "linux-x64": {
    runner: "ubuntu-24.04",
    file: "nvim-linux-x86_64.tar.gz",
    url: "https://github.com/neovim/neovim/releases/download/v0.12.1/nvim-linux-x86_64.tar.gz",
    sha256: "ab757a1fd9ad307d53d2df4045698906a7ca3993d92260dd8fe49108712d57d0",
    bytes: 11_359_184,
    executable: "bin/nvim",
  },
  "linux-arm64": {
    runner: "ubuntu-24.04-arm",
    file: "nvim-linux-arm64.tar.gz",
    url: "https://github.com/neovim/neovim/releases/download/v0.12.1/nvim-linux-arm64.tar.gz",
    sha256: "a3f8aa5590fd2ac930bcc5c9070b9ac1ec33461d262b6428874c5fc640f3f13c",
    bytes: 11_315_081,
    executable: "bin/nvim",
  },
  "darwin-x64": {
    runner: "macos-15-intel",
    file: "nvim-macos-x86_64.tar.gz",
    url: "https://github.com/neovim/neovim/releases/download/v0.12.1/nvim-macos-x86_64.tar.gz",
    sha256: "e59a5eafcdf824e2bf6a738e75f8f62ba4ff1b7f1c7daaec2d134aa46737907c",
    bytes: 9_857_818,
    executable: "bin/nvim",
  },
  "darwin-arm64": {
    runner: "macos-15",
    file: "nvim-macos-arm64.tar.gz",
    url: "https://github.com/neovim/neovim/releases/download/v0.12.1/nvim-macos-arm64.tar.gz",
    sha256: "b77e01c5421ac1bac593eed5c2ea1b950439306dd4c32371ac2473792da9a9d5",
    bytes: 9_585_853,
    executable: "bin/nvim",
  },
  "win-x64": {
    runner: "windows-2025-vs2026",
    file: "nvim-win64.zip",
    url: "https://github.com/neovim/neovim/releases/download/v0.12.1/nvim-win64.zip",
    sha256: "75fedc530b3772ca9f177edc7db92560bb9d2d6700ac6d5b2c53eaf5a9317ae3",
    bytes: 12_592_331,
    executable: "bin/nvim.exe",
  },
} as const;

describe("hosted Neovim platform gate contract", () => {
  it("waits through marker-bearing partial proof reads until the bytes are exact", async () => {
    const expected = "platform-alpha\nPLATFORM_NVIM_MARK\n";
    const reads = [
      "platform-alpha\nPLATFORM_NVIM_MARK",
      expected,
    ];
    const readText = vi.fn(async () => reads.shift() ?? expected);
    const wait = vi.fn(async () => {});

    await expect(
      waitForExactFileText(
        "/private/proof.txt",
        expected,
        1_000,
        "platform edit proof",
        { readText, wait },
      ),
    ).resolves.toBe(expected);
    expect(readText).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("pins every required hosted target without changing the legacy Linux release pin", () => {
    const toolchain = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "release-toolchain.json"), "utf8"),
    ) as Record<string, any>;
    const hosted = toolchain.neovimHostedTestRuntime;

    expect(hosted.schemaVersion).toBe(1);
    expect(hosted.version).toBe("0.12.1");
    expect(hosted.requiredTargets).toEqual(Object.keys(EXPECTED_TARGETS));
    for (const [slug, expected] of Object.entries(EXPECTED_TARGETS)) {
      expect(hosted[slug]).toEqual(expected);
    }
    const { runner: _runner, executable: _executable, ...legacyLinuxX64 } =
      EXPECTED_TARGETS["linux-x64"];
    expect(toolchain.neovimTestRuntime["linux-x64"]).toEqual(legacyLinuxX64);
  });

  it("encodes five required matrix checks with checksum, zero-skip, PTY, and cleanup assertions", () => {
    const source = readFileSync(
      resolve(REPO_ROOT, ".github/workflows/platform-tests.yml"),
      "utf8",
    );
    const workflow = parse(source) as Record<string, any>;
    const job = workflow.jobs.neovim;
    const matrix = job.strategy.matrix.include;

    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job["runs-on"]).toBe("${{ matrix.runner }}");
    expect(job["continue-on-error"]).toBeUndefined();
    expect(matrix).toEqual(
      Object.entries(EXPECTED_TARGETS).map(([slug, target]) => ({
        slug,
        runner: target.runner,
      })),
    );
    expect(source).toContain('["neovimHostedTestRuntime"]');
    expect(source).toContain('["neovimTestRuntime"]["linux-x64"]');
    expect(source).toContain("Get-FileHash");
    expect(source).toContain("Get-Command nvim -CommandType Application");
    expect(source).toContain("sha256sum");
    expect(source).toContain("AGENC_BUFFER_NVIM=$pinned_nvim");
    expect(source).toContain("AGENC_BUFFER_NVIM=$pinnedNvim");
    expect(source).toContain("--config vitest.neovim.config.ts");
    expect(source).toContain("numTotalTests: 18");
    expect(source).toContain("numPassedTests: 18");
    expect(source).toContain("--config vitest.neovim-platform.config.ts");
    expect(
      JSON.stringify(job).match(/--require-zero-skips/gu),
    ).toHaveLength(2);
    expect(source).toContain(
      "tests/tui/workbench/buffer-neovim-provider.contract.test.ts",
    );
    expect(source).toContain(
      "platform-tests/neovim-process-tree.real.test.ts",
    );
    expect(source).toContain(
      "scripts/check-tui-e2e/runner.mjs --platform",
    );
    expect(source).toContain("agenc-neovim-platform-descendant");
    expect(source).toContain("numPendingTests: 0");
    expect(source).toContain("numTodoTests: 0");
    expect(source).toContain("2/2 passed");
    expect(source).not.toContain("continue-on-error: true");
  });

  it("selects the same two non-skipped PTY regressions on every required target", () => {
    expect(HOSTED_NEOVIM_TARGETS).toEqual(Object.keys(EXPECTED_TARGETS));
    for (const target of HOSTED_NEOVIM_TARGETS) {
      expect(PLATFORM_SCENARIO_REGISTRY[target]).toBe(
        HOSTED_NEOVIM_SCENARIOS,
      );
      expect(
        selectPlatformScenarios([...HOSTED_NEOVIM_SCENARIOS], target),
      ).toEqual(HOSTED_NEOVIM_SCENARIOS);
    }
    for (const scenario of HOSTED_NEOVIM_SCENARIOS) {
      const source = readFileSync(
        resolve(
          RUNTIME_ROOT,
          "scripts/check-tui-e2e/scenarios",
          scenario,
        ),
        "utf8",
      );
      expect(source).not.toMatch(/\bskip\b/u);
      expect(source).toContain("waitForPidGone");
    }
    const saveScenario = readFileSync(
      resolve(
        RUNTIME_ROOT,
        "scripts/check-tui-e2e/scenarios",
        "130-workbench-buffer-neovim-platform-gate.mjs",
      ),
      "utf8",
    );
    expect(saveScenario).toContain('"write", {');
    expect(saveScenario).toContain("readySession: true");
    expect(saveScenario).toContain("waitForExactFileText(");
    expect(saveScenario).toMatch(
      /waitForExactFileText\(\s*editProofFile,\s*expectedEditProof,/u,
    );
    expect(saveScenario).not.toMatch(
      /waitForFileText\(\s*editProofFile,/u,
    );
    expect(saveScenario).toMatch(
      /waitForExactFileText\(\s*target,\s*expectedEditProof,/u,
    );
    expect(saveScenario).not.toMatch(
      /waitForFileText\(\s*target,/u,
    );
    expect(saveScenario).toContain("PLATFORM_NVIM_MARK");
    expect(saveScenario).toContain("nvim-platform-edit-proof.txt");
    expect(saveScenario).toContain(
      "autocmd TextChangedI,TextChangedP target.txt",
    );
    expect(saveScenario).toContain("editProof !== expectedEditProof");
    expect(saveScenario).toContain("saved !== expectedEditProof");
    const editInputIndex = saveScenario.indexOf(
      'session.type("PLATFORM_NVIM_MARK"',
    );
    const editProofWaitIndex = saveScenario.indexOf(
      "const editProof = await waitForExactFileText(",
    );
    const editEscapeIndex = saveScenario.indexOf(
      'session.send("\\x1b")',
      editInputIndex,
    );
    expect(editInputIndex).toBeGreaterThan(-1);
    expect(editProofWaitIndex).toBeGreaterThan(editInputIndex);
    expect(editEscapeIndex).toBeGreaterThan(editProofWaitIndex);
    expect(saveScenario).toContain("nvim-platform-exit.intent");
    expect(saveScenario).toContain("| qa!");
    expect(saveScenario).toContain(
      "Ctrl+S boundary is covered separately through the terminal parser",
    );
    const helperSource = readFileSync(
      resolve(
        RUNTIME_ROOT,
        "scripts/check-tui-e2e/helpers/workbench-buffer-neovim.mjs",
      ),
      "utf8",
    );
    expect(helperSource).toContain("/CMDLINE_NORMAL/u");
    expect(helperSource).toContain("\\x1b[200~");
    expect(helperSource).toContain("\\x1b[201~");
    expect(helperSource).not.toContain("session.type(`:${command}`");
    const killScenario = readFileSync(
      resolve(
        RUNTIME_ROOT,
        "scripts/check-tui-e2e/scenarios",
        "131-workbench-buffer-neovim-platform-kill-cleanup.mjs",
      ),
      "utf8",
    );
    expect(killScenario).toContain("nvim-platform-dirty-proof.txt");
    expect(killScenario).toContain(
      "autocmd TextChangedI,TextChangedP target.txt",
    );
    expect(killScenario).toContain("writefile(getline(1, '$')");
    expect(killScenario).toMatch(
      /waitForExactFileText\(\s*dirtyProofFile,\s*expectedDirtyProof,/u,
    );
    expect(killScenario).not.toMatch(
      /waitForFileText\(\s*dirtyProofFile,/u,
    );
    expect(killScenario).toContain("targetBeforeKill !== originalTarget");
    expect(killScenario).toContain("dirtyProof !== expectedDirtyProof");
    expect(killScenario).toContain("readySession: true");
    const dirtyAcknowledgementIndex = killScenario.indexOf(
      "autocmd TextChangedI,TextChangedP target.txt",
    );
    const dirtyInputIndex = killScenario.indexOf(
      'session.type("UNSAVED_PLATFORM_KILL_MARK"',
    );
    const dirtyProofWaitIndex = killScenario.indexOf(
      "const dirtyProof = await waitForExactFileText(",
    );
    const dirtyProcessingFenceIndex = killScenario.indexOf(
      'session.send("\\x1b")',
      dirtyInputIndex,
    );
    const dirtyNormalProofIndex = killScenario.indexOf(
      "embedded Neovim marker processing before hosted-platform termination",
      dirtyProcessingFenceIndex,
    );
    expect(dirtyAcknowledgementIndex).toBeGreaterThan(-1);
    expect(dirtyInputIndex).toBeGreaterThan(dirtyAcknowledgementIndex);
    expect(dirtyProcessingFenceIndex).toBeGreaterThan(dirtyInputIndex);
    expect(dirtyNormalProofIndex).toBeGreaterThan(dirtyProcessingFenceIndex);
    expect(dirtyProofWaitIndex).toBeGreaterThan(dirtyNormalProofIndex);
    expect(
      killScenario.slice(dirtyInputIndex),
    ).not.toContain("runEmbeddedNeovimCommand");
    expect(() =>
      selectPlatformScenarios([...HOSTED_NEOVIM_SCENARIOS], "freebsd-x64")
    ).toThrow("unsupported TUI E2E platform");
  });
});
