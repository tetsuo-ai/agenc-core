#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const defaultBaselinePath = path.join(runtimeRoot, "eval", "baseline-report.json");
const defaultReportsDir = path.join(runtimeRoot, "eval", "reports");

export const DEFAULT_THRESHOLDS = {
  // Percentage points of pass-rate drop tolerated before failing.
  maxPassRateDropPct: 0,
  // Percent increase in average tokens per attempted task tolerated.
  maxTokenIncreasePct: 20,
  // Percent increase in average duration per attempted task tolerated.
  maxLatencyIncreasePct: 50,
  // Treat a config-fingerprint mismatch as a regression instead of a warning.
  requireSameConfig: false,
};

const EPSILON = 1e-9;

function usage() {
  return [
    "Usage: node scripts/check-eval-regression.mjs [report.json] [options]",
    "",
    "Compares an agent-eval report against the committed baseline and exits",
    "nonzero when it regresses beyond the configured thresholds.",
    "",
    "When no report path is given, the newest *.json in --reports-dir is used.",
    "",
    "Options:",
    "  --baseline <path>              Baseline report (default: eval/baseline-report.json)",
    "  --reports-dir <dir>            Where to look for the newest report (default: eval/reports)",
    `  --max-pass-rate-drop <pp>      Tolerated pass-rate drop in percentage points (default: ${DEFAULT_THRESHOLDS.maxPassRateDropPct})`,
    `  --max-token-increase-pct <pct> Tolerated avg-token increase percent (default: ${DEFAULT_THRESHOLDS.maxTokenIncreasePct})`,
    `  --max-latency-increase-pct <pct> Tolerated avg-latency increase percent (default: ${DEFAULT_THRESHOLDS.maxLatencyIncreasePct})`,
    "  --require-same-config          Fail (not warn) on config fingerprint mismatch",
    "  --json                         Emit the comparison as JSON",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const parsed = {
    help: false,
    json: false,
    reportPath: undefined,
    baselinePath: defaultBaselinePath,
    reportsDir: defaultReportsDir,
    thresholds: {},
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    const readValue = () => {
      const value = args.shift();
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    const readNumber = () => {
      const value = Number(readValue());
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${arg} must be a non-negative number`);
      }
      return value;
    };
    switch (arg) {
      case "--baseline":
        parsed.baselinePath = path.resolve(readValue());
        break;
      case "--reports-dir":
        parsed.reportsDir = path.resolve(readValue());
        break;
      case "--max-pass-rate-drop":
        parsed.thresholds.maxPassRateDropPct = readNumber();
        break;
      case "--max-token-increase-pct":
        parsed.thresholds.maxTokenIncreasePct = readNumber();
        break;
      case "--max-latency-increase-pct":
        parsed.thresholds.maxLatencyIncreasePct = readNumber();
        break;
      case "--require-same-config":
        parsed.thresholds.requireSameConfig = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new Error(`unknown option: ${arg}`);
        }
        if (parsed.reportPath) {
          throw new Error("expected at most one report path");
        }
        parsed.reportPath = path.resolve(arg);
    }
  }

  return parsed;
}

async function readJson(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`failed to read ${label} at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse ${label} at ${filePath}: ${error.message}`);
  }
}

async function newestReportPath(reportsDir) {
  let entries;
  try {
    entries = await readdir(reportsDir);
  } catch (error) {
    throw new Error(
      `no report path given and reports dir is unreadable at ${reportsDir}: ${error.message}`,
    );
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(reportsDir, entry);
    const info = await stat(filePath).catch(() => undefined);
    if (info?.isFile()) {
      candidates.push({ filePath, mtimeMs: info.mtimeMs });
    }
  }
  if (candidates.length === 0) {
    throw new Error(`no *.json reports found in ${reportsDir}`);
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].filePath;
}

function tokenTotal(tokens) {
  if (!tokens || typeof tokens !== "object") return 0;
  if (Number.isFinite(tokens.total)) return tokens.total;
  return (
    (Number.isFinite(tokens.input) ? tokens.input : 0) +
    (Number.isFinite(tokens.output) ? tokens.output : 0)
  );
}

export function reportMetrics(report) {
  let passed = 0;
  let failed = 0;
  let error = 0;
  let skipped = 0;
  let durationMs = 0;
  let tokens = 0;

  for (const task of report.tasks) {
    if (task.status === "passed") passed += 1;
    else if (task.status === "failed") failed += 1;
    else if (task.status === "error") error += 1;
    else skipped += 1;
    if (task.status !== "skipped") {
      durationMs += task.durationMs;
      tokens += tokenTotal(task.tokens);
    }
  }

  const attempted = passed + failed + error;
  return {
    totalTasks: report.tasks.length,
    attempted,
    passed,
    failed,
    error,
    skipped,
    passRatePct: attempted === 0 ? 0 : (passed / attempted) * 100,
    avgDurationMs: attempted === 0 ? 0 : durationMs / attempted,
    avgTokens: attempted === 0 ? 0 : tokens / attempted,
    totalDurationMs: durationMs,
    totalTokens: tokens,
  };
}

export function compareReports(baseline, candidate, thresholds = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const base = reportMetrics(baseline);
  const next = reportMetrics(candidate);
  const regressions = [];
  const warnings = [];

  if (next.attempted === 0) {
    regressions.push("candidate report attempted zero tasks");
  }

  const passRateDrop = base.passRatePct - next.passRatePct;
  if (passRateDrop > limits.maxPassRateDropPct + EPSILON) {
    regressions.push(
      `pass rate dropped ${passRateDrop.toFixed(2)}pp ` +
        `(${base.passRatePct.toFixed(2)}% -> ${next.passRatePct.toFixed(2)}%, ` +
        `tolerated: ${limits.maxPassRateDropPct}pp)`,
    );
  }

  if (base.avgTokens > 0) {
    if (next.avgTokens === 0) {
      warnings.push(
        "candidate reports no token usage; cost delta not comparable",
      );
    } else {
      const increasePct = ((next.avgTokens - base.avgTokens) / base.avgTokens) * 100;
      if (increasePct > limits.maxTokenIncreasePct + EPSILON) {
        regressions.push(
          `avg tokens per task rose ${increasePct.toFixed(2)}% ` +
            `(${base.avgTokens.toFixed(1)} -> ${next.avgTokens.toFixed(1)}, ` +
            `tolerated: ${limits.maxTokenIncreasePct}%)`,
        );
      }
    }
  } else if (next.avgTokens > 0) {
    warnings.push("baseline has no token usage; cost delta not enforced");
  }

  if (base.avgDurationMs > 0) {
    const increasePct =
      ((next.avgDurationMs - base.avgDurationMs) / base.avgDurationMs) * 100;
    if (increasePct > limits.maxLatencyIncreasePct + EPSILON) {
      regressions.push(
        `avg latency per task rose ${increasePct.toFixed(2)}% ` +
          `(${base.avgDurationMs.toFixed(0)}ms -> ${next.avgDurationMs.toFixed(0)}ms, ` +
          `tolerated: ${limits.maxLatencyIncreasePct}%)`,
      );
    }
  }

  if (base.totalTasks !== next.totalTasks) {
    warnings.push(
      `task count changed (${base.totalTasks} -> ${next.totalTasks})`,
    );
  }
  if (baseline.run?.benchmark !== candidate.run?.benchmark) {
    warnings.push(
      `benchmark differs (${baseline.run?.benchmark} vs ${candidate.run?.benchmark})`,
    );
  }
  const baseFingerprint = baseline.run?.environment?.configFingerprint;
  const nextFingerprint = candidate.run?.environment?.configFingerprint;
  if (baseFingerprint && nextFingerprint && baseFingerprint !== nextFingerprint) {
    const message =
      `config fingerprint mismatch (${baseFingerprint} vs ${nextFingerprint}); ` +
      "deltas may compare different suites/executors";
    if (limits.requireSameConfig) {
      regressions.push(message);
    } else {
      warnings.push(message);
    }
  }

  return {
    thresholds: limits,
    baseline: base,
    candidate: next,
    regressions,
    warnings,
  };
}

function compileValidator(schema) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .map((error) => `- ${error.instancePath || "/"}: ${error.message}`)
    .join("\n");
}

function formatSummary(comparison, reportPath, baselinePath) {
  const { baseline, candidate } = comparison;
  const lines = [
    "# Agent Eval Regression Check",
    "",
    `Baseline: ${baselinePath}`,
    `Report: ${reportPath}`,
    `Pass rate: ${baseline.passRatePct.toFixed(2)}% -> ${candidate.passRatePct.toFixed(2)}%`,
    `Avg tokens/task: ${baseline.avgTokens.toFixed(1)} -> ${candidate.avgTokens.toFixed(1)}`,
    `Avg latency/task: ${baseline.avgDurationMs.toFixed(0)}ms -> ${candidate.avgDurationMs.toFixed(0)}ms`,
    `Tasks: ${baseline.totalTasks} -> ${candidate.totalTasks} (attempted ${baseline.attempted} -> ${candidate.attempted})`,
  ];
  if (comparison.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of comparison.warnings) lines.push(`- ${warning}`);
  }
  if (comparison.regressions.length > 0) {
    lines.push("", "Regressions:");
    for (const regression of comparison.regressions) lines.push(`- ${regression}`);
  } else {
    lines.push("", "No regressions beyond thresholds.");
  }
  return lines.join("\n");
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

  const reportPath = args.reportPath ?? (await newestReportPath(args.reportsDir));
  const [schema, baseline, candidate] = await Promise.all([
    readJson(schemaPath, "agent eval report schema"),
    readJson(args.baselinePath, "baseline eval report"),
    readJson(reportPath, "candidate eval report"),
  ]);

  const validate = compileValidator(schema);
  for (const [label, report] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ]) {
    if (!validate(report)) {
      throw new Error(
        `${label} eval report failed schema validation:\n${formatAjvErrors(validate.errors)}`,
      );
    }
  }

  const comparison = compareReports(baseline, candidate, args.thresholds);
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ reportPath, baselinePath: args.baselinePath, ...comparison }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `${formatSummary(comparison, reportPath, args.baselinePath)}\n`,
    );
  }
  if (comparison.regressions.length > 0) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isMain) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
