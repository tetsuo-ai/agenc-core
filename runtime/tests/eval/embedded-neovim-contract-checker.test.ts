import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { runtimeRootPath } from "../helpers/source-path.ts";

const repoRoot = resolve(runtimeRootPath, "..");
const scriptPath = resolve(repoRoot, "scripts", "check-embedded-neovim-buffer.mjs");
const matrixPath = resolve(repoRoot, "parity", "embedded-neovim-buffer.json");

function writeFakeChecker(helpFlags: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "agenc-contract-checker-"));
  const checkerPath = join(dir, "check_contract.mjs");
  const outputPath = join(dir, "argv.json");
  const helpText = `Usage: check_contract.mjs --matrix <path> [options]\n${helpFlags.join("\n")}\n`;

  writeFileSync(
    checkerPath,
    [
      'import { writeFileSync } from "node:fs";',
      'if (process.argv.includes("--help") || process.argv.includes("-h")) {',
      `  process.stdout.write(${JSON.stringify(helpText)});`,
      "  process.exit(0);",
      "}",
      'writeFileSync(process.env.FAKE_CHECKER_OUTPUT, JSON.stringify(process.argv.slice(2), null, 2));',
      "",
    ].join("\n"),
  );

  return { checkerPath, outputPath };
}

function runWrapper(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

function readDelegatedArgs(outputPath: string): string[] {
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

describe("embedded Neovim contract checker wrapper", () => {
  test("uses an explicit checker and keeps local requirements for legacy flag sets", () => {
    const { checkerPath, outputPath } = writeFakeChecker([
      "--require-inventory",
      "--require-commands",
      "--run-commands",
    ]);

    const result = runWrapper({
      AGENC_IMPLEMENTATION_CONTRACT_CHECKER: checkerPath,
      FAKE_CHECKER_OUTPUT: outputPath,
    });

    expect(result.status).toBe(0);
    const args = readDelegatedArgs(outputPath);
    expect(args).toContain("--matrix");
    expect(args[args.indexOf("--matrix") + 1]).toBe(matrixPath);
    expect(args).toContain("--require-inventory");
    expect(args).toContain("--require-commands");
    expect(args).toContain("--run-commands");
    expect(args).not.toContain("--require-edge-cases");
    expect(args).not.toContain("--require-reviews");
  });

  test("keeps row review mode non-executing even when the checker supports execution", () => {
    const { checkerPath, outputPath } = writeFakeChecker([
      "--require-inventory",
      "--require-edge-cases",
      "--require-reviews",
      "--require-commands",
      "--run-commands",
    ]);

    const result = runWrapper({
      AGENC_EMBEDDED_NEOVIM_CONTRACT_ROW_REVIEW: "1",
      AGENC_IMPLEMENTATION_CONTRACT_CHECKER: checkerPath,
      FAKE_CHECKER_OUTPUT: outputPath,
    });

    expect(result.status).toBe(0);
    const args = readDelegatedArgs(outputPath);
    expect(args).toContain("--require-inventory");
    expect(args).toContain("--require-edge-cases");
    expect(args).toContain("--require-commands");
    expect(args).not.toContain("--require-reviews");
    expect(args).not.toContain("--run-commands");
  });

  test("reports checked locations when no checker is installed", () => {
    const missingChecker = resolve(
      tmpdir(),
      `agenc-missing-contract-checker-${process.pid}`,
      "check_contract.mjs",
    );
    const result = runWrapper({
      AGENC_IMPLEMENTATION_CONTRACT_CHECKER: missingChecker,
      FAKE_CHECKER_OUTPUT: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("implementation-contract checker not found");
    expect(result.stderr).toContain("AGENC_IMPLEMENTATION_CONTRACT_CHECKER");
    expect(result.stderr).toContain(missingChecker);
  });
});
