/** Locked policy replay over real frozen provider responses. No API calls and no fitting. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { extractTaskFeatures } from "../../src/agents/provider-selector-irt.js";
import { selectChildProviderV2, pairKey } from "../../src/agents/provider-selector-v2.js";
import { selectChildProvider, classifyChildTask } from "../../src/agents/provider-selector.js";
import { runChildRoutingFallback } from "../../src/agents/child-routing-fallback.js";
const [bench, calibrationPath, freezePath, outputPath] = process.argv.slice(2);
if (!bench || !calibrationPath || !freezePath || !outputPath) throw Error("evaluate benchmark calibration freeze output");
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const freeze = JSON.parse(readFileSync(freezePath, "utf8"));
for (const [file, expected] of Object.entries(freeze.files)) if (hash(readFileSync(file)) !== expected) throw Error("Policy freeze mismatch: " + file);
const cal = JSON.parse(readFileSync(calibrationPath, "utf8"));
const suite = JSON.parse(readFileSync(resolve(bench, "tasks.json"), "utf8"));
const tasks = Array.isArray(suite) ? suite : suite.tasks;
const cfg = JSON.parse(readFileSync(resolve(bench, "candidates.json"), "utf8"));
const matrix = readFileSync(resolve(bench, "direct-v1/records.jsonl"), "utf8");
const records = matrix.trim().split("\n").map(line => JSON.parse(line));
const recordMap = new Map<string, any>();
for (const r of records) { const key = r.taskId + "|" + (r.arm === "matrix" ? r.provider + "/" + r.model : r.arm); if (!recordMap.has(key)) recordMap.set(key, r); }
const output: any[] = [];
const missing: any[] = [];
function record(t: any, model: string) {
  const r = recordMap.get(t.id + "|" + model);
  if (!r) { missing.push({ taskId: t.id, model }); return undefined; }
  return r;
}
const grade = (t: any, r: any) => JSON.parse(execFileSync("python3", [resolve(bench, "bench_tasks.py"), "grade", t.id], { input: r.answer ?? "", encoding: "utf8" }));
function row(t: any, arm: string, rs: any[], extra: any = {}) {
  const last = rs.at(-1); const verdict = last ? grade(t, last) : { pass: false, reason: "missing" };
  return { taskId: t.id, split: t.split, arm, covered: rs.length > 0, passed: verdict.pass === true,
    grader: verdict, costUsd: rs.every(r => typeof r.costUsd === "number") ? rs.reduce((a, r) => a + r.costUsd, 0) : null,
    latencyMs: rs.reduce((a, r) => a + (r.latencyMs ?? 0), 0), requestIds: rs.map(r => r.requestId),
    models: rs.map(r => r.provider + "/" + r.model), actualModels: rs.map(r => r.actualModel),
    costReconciled: rs.every(r => r.costReconciled), errors: rs.map(r => r.error).filter(Boolean), ...extra };
}
for (const t of tasks) {
  const labels = classifyChildTask(t.prompt);
  const task = { ...labels, requiresTools: false, inputTokens: Math.ceil(Buffer.byteLength(cfg.systemPrompt + "\n" + t.prompt) / 3), outputTokens: 4096, expectedModelCalls: 1, maxCostUsd: 0.05 };
  const features = extractTaskFeatures(t.prompt, false);
  const current = selectChildProvider({ task, candidates: cal.candidates, nowMs: 0 });
  const currentRecord = current.selected ? record(t, pairKey(current.selected)) : undefined;
  output.push(row(t, "current_selector", currentRecord ? [currentRecord] : [], { reason: current.reason }));
  for (const [arm, pair] of Object.entries({ fixed_parent: cfg.baselines.fixed_parent, always_strongest: cfg.baselines.strongest, always_cheapest: cfg.baselines.cheapest })) {
    const r = record(t, pairKey(pair as any)); output.push(row(t, arm, r ? [r] : []));
  }
  for (const arm of ["openrouter_restricted", "openrouter_unrestricted"]) { const r = record(t, arm); output.push(row(t, arm, r ? [r] : [])); }
  for (const arm of ["v2_cold", "v2_irt", "selector_v2"]) {
    // Calibration v2 rows use precomputed leave-one-task-out predictions; never score a task with its own fitted label.
    if (t.split === "calibration") {
      const configName = arm === "v2_cold" ? "parent_first_cold" : arm === "v2_irt" ? "irt" : cal.chosen.name;
      const r = cal.trials.find((x: any) => x.config.name === configName).rows.find((x: any) => x.taskId === t.id);
      const rs = r.requestIds.map((id: string) => records.find(x => x.requestId === id));
      output.push(row(t, arm, rs, { mode: r.mode, reason: r.decision.reason, calibrationMode: "leave-one-task-out" })); continue;
    }
    const verified = arm === "selector_v2";
    const decision = selectChildProviderV2({ task, features, parent: cal.parent, candidates: cal.candidates, nowMs: 0,
      abilities: arm === "v2_cold" ? [] : cal.fit.abilities, outcomes: arm === "v2_cold" ? { aggregates: [], health: [] } : cal.fit.outcomes,
      preferences: verified ? cal.chosen.preferences : { cost: "balanced" },
      ...(verified ? { verification: { available: true as const, retrySafe: true, costUsd: 0, latencyMs: 1,
        targetQuality: cal.chosen.target, conditional: cal.fit.conditional } } : {}) });
    const rs: any[] = [];
    let verificationMs = 0;
    const chain = decision.cascade?.candidates ?? (decision.selected ? [decision.selected] : []);
    const result = await runChildRoutingFallback({ candidates: chain, maxAttempts: 2, maxModelCalls: 2, maxCostUsd: task.maxCostUsd,
      ...(verified ? { verification: { retrySafe: true, costUsd: 0, check: async (attempt: any) => {
        const started = performance.now(); const verdict = grade(t, attempt.value); verificationMs += performance.now() - started;
        return verdict.pass ? "pass" as const : "fail" as const;
      } } } : {}),
      runAttempt: async ({ candidate }) => {
        const r = record(t, pairKey(candidate)); if (!r) throw Error("Missing selected matrix cell"); rs.push(r);
        return { value: r, modelCalls: 1, toolCalls: 0, ...(r.costUsd !== null ? { costUsd: r.costUsd } : { heldUnknownCostUsd: r.reservationUsd }),
          terminal: { provider: candidate.provider, model: candidate.model, reason: r.error ? "provider_unavailable" as const : "completed" as const,
            dispatch: "sent" as const, retryable: false, completedWork: r.answer ?? "", unfinishedWork: "" } };
      } });
    output.push(row(t, arm, rs, { mode: decision.mode, reason: decision.reason, decision, stopReason: result.stopReason, verificationMs,
      accountingUsd: result.accountedCostUsd }));
  }
}
writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), policyFreezeSha256: hash(readFileSync(freezePath)),
  taskSha256: hash(readFileSync(resolve(bench, "tasks.json"))), matrixSha256: hash(matrix), missing, rows: output,
  methodology: "Matched real first recorded responses; frozen task graders act as independent local verifiers; no answers or expected values enter routing; no holdout updates; calibration uses leave-one-task-out; direct costs exclude daemon/parent overhead." }, null, 2) + "\n");
console.log(JSON.stringify({ rows: output.length, missing: missing.length, newProviderCalls: 0 }));
