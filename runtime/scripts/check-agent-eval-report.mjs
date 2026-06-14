#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const runtimeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const schemaPath = path.join(
  runtimeRoot,
  "src",
  "eval",
  "agent-eval-report.schema.json",
);

function usage() {
  return [
    "Usage: node scripts/check-agent-eval-report.mjs <report.json> [--json]",
    "",
    "Validates an AgenC agent evaluation report and prints a local summary.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  let json = false;
  const positional = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, json, reportPath: null };
    }
    if (arg?.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (arg) {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error("expected exactly one report path");
  }

  return {
    help: false,
    json,
    reportPath: path.resolve(positional[0]),
  };
}

async function readJson(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `failed to read ${label} at ${filePath}: ${error.message}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `failed to parse ${label} at ${filePath}: ${error.message}`,
    );
  }
}

function compileValidator(schema) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
  });
  return ajv.compile(schema);
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .map((error) => {
      const location = error.instancePath || "/";
      return `- ${location}: ${error.message}`;
    })
    .join("\n");
}

function emptyStatusCounts() {
  return {
    passed: 0,
    failed: 0,
    error: 0,
    skipped: 0,
  };
}

function percent(numerator, denominator) {
  if (denominator === 0) {
    return 0;
  }
  return (numerator / denominator) * 100;
}

function tokenTotal(tokens) {
  if (!tokens || typeof tokens !== "object") {
    return 0;
  }
  if (Number.isFinite(tokens.total)) {
    return tokens.total;
  }
  return (Number.isFinite(tokens.input) ? tokens.input : 0) +
    (Number.isFinite(tokens.output) ? tokens.output : 0);
}

function summarizeReport(report) {
  const taskCounts = emptyStatusCounts();
  const verifierCounts = emptyStatusCounts();
  const riskFlags = new Map();
  let durationMs = 0;
  let tokenCount = 0;
  let commandCount = 0;
  let failedCommandCount = 0;

  for (const task of report.tasks) {
    taskCounts[task.status] += 1;
    durationMs += task.durationMs;
    tokenCount += tokenTotal(task.tokens);

    for (const command of task.commands ?? []) {
      commandCount += 1;
      if (
        Number.isInteger(command.exitCode) &&
        command.exitCode !== 0
      ) {
        failedCommandCount += 1;
      }
    }

    for (const verifier of task.verifiers) {
      verifierCounts[verifier.status] += 1;
    }

    for (const flag of task.riskFlags ?? []) {
      riskFlags.set(flag, (riskFlags.get(flag) ?? 0) + 1);
    }
  }

  const attemptedTasks = taskCounts.passed + taskCounts.failed + taskCounts.error;
  const attemptedVerifiers = verifierCounts.passed +
    verifierCounts.failed +
    verifierCounts.error;

  return {
    schemaVersion: report.schemaVersion,
    run: report.run,
    tasks: {
      total: report.tasks.length,
      ...taskCounts,
      attempted: attemptedTasks,
      fixRate: percent(taskCounts.passed, attemptedTasks),
    },
    verifiers: {
      total: verifierCounts.passed +
        verifierCounts.failed +
        verifierCounts.error +
        verifierCounts.skipped,
      ...verifierCounts,
      attempted: attemptedVerifiers,
      passRate: percent(verifierCounts.passed, attemptedVerifiers),
    },
    durationMs,
    tokens: {
      total: tokenCount,
    },
    commands: {
      total: commandCount,
      failed: failedCommandCount,
    },
    riskFlags: Object.fromEntries(
      [...riskFlags.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
  };
}

function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatMarkdownSummary(summary) {
  const agent = summary.run.agent;
  const modelLabel = [agent.provider, agent.model].filter(Boolean).join("/");
  const agentLabel = modelLabel ? `${agent.name} (${modelLabel})` : agent.name;
  const riskEntries = Object.entries(summary.riskFlags);
  const riskLine = riskEntries.length === 0
    ? "Risk flags: none"
    : `Risk flags: ${riskEntries.map(([flag, count]) => `${flag}=${count}`).join(", ")}`;

  return [
    "# Agent Eval Report",
    "",
    `Run: ${summary.run.id}`,
    `Benchmark: ${summary.run.benchmark}`,
    `Agent: ${agentLabel}`,
    `Tasks: ${summary.tasks.total} total, ${summary.tasks.passed} passed, ${summary.tasks.failed} failed, ${summary.tasks.error} error, ${summary.tasks.skipped} skipped`,
    `Fix rate: ${formatPercent(summary.tasks.fixRate)}`,
    `Verifiers: ${summary.verifiers.total} total, ${summary.verifiers.passed} passed, ${summary.verifiers.failed} failed, ${summary.verifiers.error} error, ${summary.verifiers.skipped} skipped`,
    `Verifier pass rate: ${formatPercent(summary.verifiers.passRate)}`,
    `Tokens: ${summary.tokens.total}`,
    `Duration: ${formatDuration(summary.durationMs)}`,
    `Commands: ${summary.commands.total} total, ${summary.commands.failed} failed`,
    riskLine,
  ].join("\n");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const [schema, report] = await Promise.all([
    readJson(schemaPath, "agent eval report schema"),
    readJson(args.reportPath, "agent eval report"),
  ]);
  const validate = compileValidator(schema);

  if (!validate(report)) {
    process.stderr.write(
      `agent eval report validation failed:\n${formatAjvErrors(validate.errors)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const summary = summarizeReport(report);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatMarkdownSummary(summary)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
