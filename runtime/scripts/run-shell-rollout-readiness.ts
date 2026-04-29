#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

interface ShellRolloutCheck {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly testRefs: readonly string[];
}

interface ShellRolloutArtifact {
  readonly schemaVersion: 1;
  readonly generatedAtMs: number;
  readonly allPassed: boolean;
  readonly checks: readonly {
    name: string;
    passed: boolean;
    command: string;
    testRefs: readonly string[];
  }[];
}

const RUNTIME_DIR = process.cwd();
const CORE_DIR = path.resolve(RUNTIME_DIR, "..");

const DEFAULT_OUTPUT = path.resolve(
  RUNTIME_DIR,
  "benchmarks/artifacts/shell-rollout-readiness.ci.json",
);

const CHECKS: readonly ShellRolloutCheck[] = [
  {
    name: "shell command and task-tracker flows",
    command: "npx",
    args: [
      "vitest",
      "run",
      "src/gateway/daemon-command-registry.test.ts",
    ],
    cwd: RUNTIME_DIR,
    testRefs: ["runtime/src/gateway/daemon-command-registry.test.ts"],
  },
  {
    name: "shell MCP policy coverage",
    command: "npx",
    args: [
      "vitest",
      "run",
      "src/mcp-client/manager.test.ts",
      "src/gateway/daemon-command-registry.test.ts",
    ],
    cwd: RUNTIME_DIR,
    testRefs: [
      "runtime/src/mcp-client/manager.test.ts",
      "runtime/src/gateway/daemon-command-registry.test.ts",
    ],
  },
  {
    name: "watch cockpit integration",
    command: "npx",
    args: [
      "vitest",
      "run",
      "src/channels/webchat/plugin.test.ts",
      "src/channels/webchat/operator-events.test.ts",
    ],
    cwd: RUNTIME_DIR,
    testRefs: [
      "runtime/src/channels/webchat/plugin.test.ts",
      "runtime/src/channels/webchat/operator-events.test.ts",
    ],
  },
  {
    name: "watch export bundle smoke",
    command: "node",
    args: ["--test", "tests/watch/agenc-watch-export-bundle.test.mjs"],
    cwd: RUNTIME_DIR,
    testRefs: ["runtime/tests/watch/agenc-watch-export-bundle.test.mjs"],
  },
  {
    name: "packages agenc wrapper smoke",
    command: "node",
    args: ["--test", "packages/agenc/tests/cli.test.mjs"],
    cwd: CORE_DIR,
    testRefs: ["packages/agenc/tests/cli.test.mjs"],
  },
];

function parseOutputPath(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output" && argv[index + 1]) {
      return path.resolve(RUNTIME_DIR, argv[index + 1]!);
    }
  }
  return DEFAULT_OUTPUT;
}

function runCheck(check: ShellRolloutCheck): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(check.command, check.args, {
      cwd: check.cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code, signal) => {
      resolve(signal === null && (code ?? 1) === 0);
    });
    child.on("error", () => resolve(false));
  });
}

async function main(): Promise<void> {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const checks: ShellRolloutArtifact["checks"] = [];
  for (const check of CHECKS) {
    console.log(`\n==> ${check.name}`);
    const passed = await runCheck(check);
    checks.push({
      name: check.name,
      passed,
      command: [check.command, ...check.args].join(" "),
      testRefs: check.testRefs,
    });
  }

  const artifact: ShellRolloutArtifact = {
    schemaVersion: 1,
    generatedAtMs: Date.now(),
    allPassed: checks.every((check) => check.passed),
    checks,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  if (!artifact.allPassed) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Shell rollout readiness failed: ${message}`);
  process.exit(1);
});
