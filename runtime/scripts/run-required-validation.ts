#!/usr/bin/env node

import { spawn } from "node:child_process";

interface ValidationStep {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

const VALIDATION_STEPS: readonly ValidationStep[] = [
  {
    name: "runtime test suite",
    command: "npm",
    args: ["run", "test"],
    timeoutMs: 120_000,
  },
  {
    name: "runtime mutation artifact",
    command: "npm",
    args: ["run", "mutation:ci"],
    timeoutMs: 120_000,
  },
  {
    name: "runtime mutation gates",
    command: "npm",
    args: ["run", "mutation:gates"],
    timeoutMs: 60_000,
  },
  {
    name: "runtime pipeline-quality artifact",
    command: "npm",
    args: ["run", "benchmark:pipeline:ci"],
    timeoutMs: 180_000,
  },
  {
    name: "runtime pipeline-quality gates",
    command: "npm",
    args: ["run", "benchmark:pipeline:gates"],
    timeoutMs: 60_000,
  },
  {
    name: "runtime delegation-quality artifact",
    command: "npm",
    args: ["run", "benchmark:delegation:ci"],
    timeoutMs: 180_000,
  },
  {
    name: "runtime delegation-quality gates",
    command: "npm",
    args: ["run", "benchmark:delegation:gates"],
    timeoutMs: 60_000,
  },
  {
    name: "runtime background-run-quality artifact",
    command: "npm",
    args: ["run", "benchmark:background-runs:ci"],
    timeoutMs: 180_000,
  },
  {
    name: "runtime background-run-quality gates",
    command: "npm",
    args: ["run", "benchmark:background-runs:gates"],
    timeoutMs: 60_000,
  },
  {
    name: "runtime shell rollout readiness artifact",
    command: "npm",
    args: ["run", "shell:rollout:ci"],
    timeoutMs: 120_000,
  },
  {
    name: "runtime autonomy rollout gates",
    command: "npm",
    args: ["run", "autonomy:rollout:gates"],
    timeoutMs: 60_000,
  },
];

function runStep(step: ValidationStep): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(step.command, step.args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    const killTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      console.error(
        `Validation step "${step.name}" exceeded ${step.timeoutMs}ms and will be terminated.`,
      );
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref();
    }, step.timeoutMs);
    killTimer.unref();

    child.on("error", (error) => {
      settled = true;
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      settled = true;
      clearTimeout(killTimer);
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const failures: string[] = [];

  for (const step of VALIDATION_STEPS) {
    console.log(`\n==> ${step.name}`);
    const exitCode = await runStep(step);
    if (exitCode !== 0) {
      failures.push(`${step.name} (exit ${exitCode})`);
    }
  }

  if (failures.length === 0) {
    console.log("\nRequired runtime validation passed.");
    return;
  }

  console.error("\nRequired runtime validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Required runtime validation runner failed: ${message}`);
  process.exit(1);
});
