/** Run through Core's installed tsx binary. This script performs no network IO. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [coreArg, runArg] = process.argv.slice(2);
if (!coreArg || !runArg) throw new Error("Usage: tsx live-eval-replay.mjs <core-checkout> <run-folder>");
const core = resolve(coreArg);
const folder = resolve(runArg);
const readJson = name => JSON.parse(readFileSync(join(folder, name), "utf8"));
const hash = source => createHash("sha256").update(source).digest("hex");
const selectorPath = join(core, "runtime/src/agents/provider-selector.ts");
const profilesPath = join(core, "runtime/src/agents/provider-selector-profiles.ts");
const { selectChildProvider, classifyChildTask, estimateChildCandidateCost } = await import(pathToFileURL(selectorPath).href);
const { CHILD_ROUTING_PROFILE_REVISION } = await import(pathToFileURL(profilesPath).href);
const suite = readJson("suite.json");
const manifest = readJson("manifest.json");
const fixture = readJson("recorded-measurements.json");
if (fixture.provenance !== "recorded-measurements" || fixture.tasks.length !== 6 || manifest.suiteVersion !== suite.suiteVersion) {
  throw new Error("Run the Python export verifier against the fixed twelve-task suite first.");
}
const records = readFileSync(join(folder, "records.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
const byTaskModel = new Map();
for (const record of records) {
  const task = suite.tasks.find(entry => entry.id === record.taskId);
  const key = `${record.taskId}\0${record.model}`;
  if (byTaskModel.has(key) || task === undefined || hash(task.prompt) !== record.promptSha256) {
    throw new Error("Duplicate record or altered task prompt.");
  }
  byTaskModel.set(key, record);
}
const candidates = fixture.candidates;
const heldout = suite.tasks.filter(task => task.split === "holdout");
const calibration = suite.tasks.filter(task => task.split === "calibration");
if (heldout.length !== 6 || calibration.length !== 6) throw new Error("Invalid frozen split");
const recordFor = (task, key) => byTaskModel.get(`${task.id}\0${key.replace(/^deepseek\//, "")}`);
const candidateKey = candidate => `${candidate.provider}/${candidate.model}`;
const aggregates = [];
for (const task of calibration) {
  for (const candidate of candidates) {
    const record = recordFor(task, candidateKey(candidate));
    if (record === undefined) continue;
    const responseReceived = typeof record.finishReason === "string";
    const completed = responseReceived && record.finishReason === "stop" && record.answer.length > 0 && record.error === undefined;
    aggregates.push({
      provider: candidate.provider, model: candidate.model, taskKind: task.kind, complexity: task.complexity,
      profileRevision: CHILD_ROUTING_PROFILE_REVISION, attempts: 1, successes: Number(completed),
      infrastructureFailures: Number(!responseReceived),
      qualityObservations: Number(responseReceived), qualitySuccesses: Number(responseReceived && record.grade.passed),
      latencySamples: 1, latencyTotalMs: record.latencyMs,
      // Live installation cost learning requires reconciled dollars. The API reports
      // tokens here, so leave cost learning empty instead of relabeling estimates.
      costSamples: 0, costTotalUsd: 0, lastObservedAtMs: 0,
    });
  }
}
const outcomes = { aggregates, health: [] };

function selectionTask(task, classified = false) {
  const recorded = records.find(record => record.taskId === task.id);
  const labels = classified ? classifyChildTask(task.prompt) : { kind: task.kind, complexity: task.complexity };
  return {
    ...labels, requiresTools: false, requiresReasoning: task.complexity === "hard",
    inputTokens: recorded?.inputTokenUpperBound ?? Buffer.byteLength(suite.systemPrompt + task.prompt) + 512,
    outputTokens: manifest.maxOutputTokens, expectedModelCalls: 1,
  };
}

const strategies = ["selector", "selector_calibrated", "selector_classified", "always_strongest", "always_cheapest", "fixed_parent"];
function choose(strategy, task) {
  const requirements = selectionTask(task, strategy === "selector_classified");
  if (strategy.startsWith("selector")) {
    const result = selectChildProvider({ task: requirements, candidates, nowMs: 0,
      ...(strategy === "selector_calibrated" ? { outcomes } : {}) });
    return { key: result.selected === undefined ? undefined : candidateKey(result.selected), reason: result.reason, requirements };
  }
  const cheapest = [...candidates].sort((a, b) => (estimateChildCandidateCost(a, requirements) ?? Infinity) -
    (estimateChildCandidateCost(b, requirements) ?? Infinity))[0];
  const key = strategy === "always_strongest" ? fixture.baselines.strongest :
    strategy === "fixed_parent" ? fixture.baselines.parent : candidateKey(cheapest);
  return { key, reason: strategy, requirements };
}

function wilson(passed, count) {
  if (count === 0) return null;
  const z = 1.96;
  const p = passed / count;
  const denominator = 1 + z * z / count;
  const center = (p + z * z / (2 * count)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator;
  return [center - radius, center + radius].map(value => Number(value.toFixed(4)));
}

const decisions = [];
const scores = strategies.map(strategy => {
  let recorded = 0;
  let passed = 0;
  let knownCost = 0;
  let costUsd = 0;
  let latencyMs = 0;
  for (const task of heldout) {
    const selected = choose(strategy, task);
    const record = selected.key === undefined ? undefined : recordFor(task, selected.key);
    decisions.push({ taskId: task.id, strategy, selected: selected.key ?? null,
      reason: selected.reason, taskRequirements: selected.requirements,
      observedPassed: record?.grade.passed ?? null, usageCostUsdAtPeakRates: record?.usageCostUsdAtPeakRates ?? null });
    if (record === undefined) continue;
    recorded += 1;
    passed += Number(record.grade.passed);
    latencyMs += record.latencyMs;
    if (typeof record.usageCostUsdAtPeakRates === "number" && Number.isFinite(record.usageCostUsdAtPeakRates) && record.usageCostUsdAtPeakRates >= 0) {
      knownCost += 1;
      costUsd += record.usageCostUsdAtPeakRates;
    }
  }
  return { strategy, tasks: heldout.length, recorded, passed, knownCost,
    usageCostUsdAtPeakRates: Number(costUsd.toFixed(8)),
    passedPerEstimatedDollar: recorded === heldout.length && knownCost === heldout.length && costUsd > 0
      ? Number((passed / costUsd).toFixed(4)) : null,
    totalLatencyMs: latencyMs, passFractionWilson95: wilson(passed, recorded) };
});
const modelScores = ["calibration", "holdout"].flatMap(split => candidates.map(candidate => {
  const rows = records.filter(record => record.split === split && record.model === candidate.model);
  const priced = rows.filter(record => typeof record.usageCostUsdAtPeakRates === "number");
  return { split, model: candidate.model, tasks: 6, recorded: rows.length,
    passed: rows.filter(record => record.grade.passed).length,
    knownCost: priced.length, usageCostUsdAtPeakRates: Number(priced.reduce((sum, record) => sum + record.usageCostUsdAtPeakRates, 0).toFixed(8)),
    totalLatencyMs: rows.reduce((sum, record) => sum + record.latencyMs, 0) };
}));
const report = {
  provenance: "recorded-measurements", suiteVersion: suite.suiteVersion, split: "held-out",
  selectorSourceSha256: hash(readFileSync(selectorPath)), profilesSourceSha256: hash(readFileSync(profilesPath)),
  profileRevision: CHILD_ROUTING_PROFILE_REVISION,
  costBasis: fixture.costBasis, accountBalanceDeltaUsd: manifest.accountBalanceDeltaUsd ?? null,
  accountUsageExclusive: manifest.accountUsageExclusive,
  completeMatrix: heldout.every(task => candidates.every(candidate => recordFor(task, candidateKey(candidate)) !== undefined)),
  calibrationObservations: aggregates.length, calibrationCostLearning: "omitted; per-call dollars are unreconciled",
  scores, modelScores, decisions,
  errors: records.filter(record => record.error !== undefined).map(record => ({ taskId: record.taskId, model: record.model, error: record.error })),
  limitations: [
    "Six held-out tasks and one completion per model and task cannot establish general routing superiority.",
    "Only native DeepSeek was measured. These direct API calls do not measure AgenC sub-agent orchestration or tool use.",
    "Strongest means the predeclared Pro baseline, not a measured universal ranking.",
    "selector and selector_calibrated use predeclared human task kind and complexity. selector_classified uses the current runtime text classifier.",
    "Calibration uses only calibration labels. No measured holdout outcome is passed to the selector.",
    "Price calculations use reported tokens and registry peak rates; off-peak rates and rounded account balance differ.",
    "No commercial router or provider outside DeepSeek was called.",
  ],
};
writeFileSync(join(folder, "selector-replay.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const money = value => `$${value.toFixed(6)}`;
const lines = [
  "# Measured DeepSeek selector replay", "",
  `Suite: ${suite.suiteVersion}. Held-out tasks: ${heldout.length}. Matrix complete: ${report.completeMatrix}.`, "",
  "Both models received each fixed task once. Quality is an exact JSON verifier result. Costs below are token-usage estimates at registry peak rates.", "",
  "| Strategy | Passed / recorded | Estimated cost | Passes / estimated dollar | Sum of call latency |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...scores.map(score => `| ${score.strategy} | ${score.passed}/${score.recorded} | ${money(score.usageCostUsdAtPeakRates)} | ${score.passedPerEstimatedDollar ?? "unknown"} | ${(score.totalLatencyMs / 1000).toFixed(2)}s |`),
  "", `Account balance delta: ${manifest.accountBalanceDeltaUsd ?? "unknown"} USD. Exclusive account asserted: ${manifest.accountUsageExclusive}.`, "",
  "| Split | Model | Passed / recorded | Estimated cost |",
  "| --- | --- | ---: | ---: |",
  ...modelScores.map(score => `| ${score.split} | ${score.model} | ${score.passed}/${score.recorded} | ${money(score.usageCostUsdAtPeakRates)} |`),
  "", ...report.limitations.map(line => `- ${line}`), "",
  "See selector-replay.json for every selection, source hashes, uncertainty intervals and sanitized error codes.", "",
];
writeFileSync(join(folder, "selector-replay.md"), lines.join("\n"), { mode: 0o600 });
process.stdout.write(JSON.stringify({ completeMatrix: report.completeMatrix, scores, accountBalanceDeltaUsd: report.accountBalanceDeltaUsd }, null, 2) + "\n");
