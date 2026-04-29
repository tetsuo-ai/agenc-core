import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { runCommand } from "../utils/process.js";
import { captureFilesystemSnapshot } from "../workflow/compensation.js";
import { evaluateEffectLedgerCompleteness } from "./effect-ledger-checks.js";
import { EffectLedger } from "../workflow/effect-ledger.js";
import type { EffectRecord } from "../workflow/effects.js";

export interface PipelineLiveCodingScenarioArtifact {
  readonly scenarioId: string;
  readonly title: string;
  readonly passed: boolean;
  readonly tempRepoPath: string;
  readonly fileMutationCount: number;
  readonly shellMutationCount: number;
  readonly wrongRootIncident: boolean;
  readonly unauthorizedWriteBlocked: boolean;
  readonly effectLedgerComplete: boolean;
  readonly exitCode: number;
  readonly notes?: string;
}

export interface PipelineLiveCodingArtifact {
  readonly scenarioCount: number;
  readonly passingScenarios: number;
  readonly passRate: number;
  readonly tempRepoCount: number;
  readonly totalFileMutations: number;
  readonly totalShellMutations: number;
  readonly wrongRootIncidents: number;
  readonly unauthorizedWriteBlocks: number;
  readonly effectLedgerCompletenessRate: number;
  readonly scenarios: readonly PipelineLiveCodingScenarioArtifact[];
}

export interface PipelineLiveCodingRunnerConfig {
  readonly now?: () => number;
}

interface LiveScenarioContext {
  readonly repoDir: string;
  readonly ledger: EffectLedger;
  readonly now: () => number;
  readonly sessionId: string;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

async function recordFileWrite(params: {
  readonly context: LiveScenarioContext;
  readonly targetPath: string;
  readonly content: string;
  readonly label: string;
  readonly toolCallId: string;
}): Promise<void> {
  const pre = await captureFilesystemSnapshot(params.targetPath);
  const effectId = `${params.context.sessionId}:${params.toolCallId}`;
  await params.context.ledger.beginEffect({
    id: effectId,
    idempotencyKey: `${effectId}:write`,
    toolCallId: params.toolCallId,
    toolName: "system.writeFile",
    args: { path: params.targetPath, content: params.content },
    scope: { sessionId: params.context.sessionId },
    kind: "filesystem_write",
    effectClass: "filesystem_write",
    intentSummary: params.label,
    targets: [{ kind: "path", path: params.targetPath }],
    createdAt: params.context.now(),
    requiresApproval: false,
    preExecutionSnapshots: [pre],
  });
  await writeFile(params.targetPath, params.content, "utf8");
  const post = await captureFilesystemSnapshot(params.targetPath);
  await params.context.ledger.recordOutcome({
    effectId,
    success: true,
    isError: false,
    result: `Wrote ${path.basename(params.targetPath)}`,
    postExecutionSnapshots: [post],
  });
}

async function recordShellMutation(params: {
  readonly context: LiveScenarioContext;
  readonly command: string;
  readonly args: readonly string[];
  readonly targetPaths: readonly string[];
  readonly label: string;
  readonly toolCallId: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const preExecutionSnapshots = await Promise.all(
    params.targetPaths.map((targetPath) => captureFilesystemSnapshot(targetPath)),
  );
  const effectId = `${params.context.sessionId}:${params.toolCallId}`;
  await params.context.ledger.beginEffect({
    id: effectId,
    idempotencyKey: `${effectId}:shell`,
    toolCallId: params.toolCallId,
    toolName: "system.bash",
    args: {
      command: params.command,
      args: [...params.args],
      cwd: params.context.repoDir,
    },
    scope: { sessionId: params.context.sessionId },
    kind: "shell_command",
    effectClass: "shell",
    intentSummary: params.label,
    targets: params.targetPaths.map((targetPath) => ({
      kind: "path" as const,
      path: targetPath,
      cwd: params.context.repoDir,
      command: [params.command, ...params.args].join(" "),
    })),
    createdAt: params.context.now(),
    requiresApproval: false,
    preExecutionSnapshots,
  });
  const result = await runCommand(params.command, [...params.args], {
    cwd: params.context.repoDir,
  });
  const postExecutionSnapshots = await Promise.all(
    params.targetPaths.map((targetPath) => captureFilesystemSnapshot(targetPath)),
  );
  await params.context.ledger.recordOutcome({
    effectId,
    success: result.exitCode === 0,
    isError: result.exitCode !== 0,
    result: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    error: result.exitCode === 0 ? undefined : `exit ${result.exitCode}`,
    postExecutionSnapshots,
  });
  return result;
}

async function collectEffects(
  ledger: EffectLedger,
  sessionId: string,
): Promise<readonly EffectRecord[]> {
  return ledger.listSessionEffects(sessionId, 64);
}

async function runWorkspaceScaffoldScenario(
  context: LiveScenarioContext,
): Promise<PipelineLiveCodingScenarioArtifact> {
  await recordFileWrite({
    context,
    targetPath: path.join(context.repoDir, "package.json"),
    content: JSON.stringify({ type: "module" }, null, 2),
    label: "Create package.json for temp repo scaffold.",
    toolCallId: "write-package-json",
  });
  await mkdir(path.join(context.repoDir, "src"), { recursive: true });
  await recordFileWrite({
    context,
    targetPath: path.join(context.repoDir, "src", "math.js"),
    content: "export const multiply = (a, b) => a * b;\n",
    label: "Create math module in temp repo.",
    toolCallId: "write-math-module",
  });
  await recordFileWrite({
    context,
    targetPath: path.join(context.repoDir, "test.js"),
    content: [
      'import { multiply } from "./src/math.js";',
      "if (multiply(6, 7) !== 42) {",
      '  throw new Error("expected multiply(6, 7) to equal 42");',
      "}",
      'console.log("ok");',
      "",
    ].join("\n"),
    label: "Create temp repo test file.",
    toolCallId: "write-test",
  });
  const result = await runCommand(process.execPath, ["test.js"], {
    cwd: context.repoDir,
  });
  const effects = await collectEffects(context.ledger, context.sessionId);
  const completeness = evaluateEffectLedgerCompleteness(effects);
  return {
    scenarioId: "workspace_scaffold_js_module",
    title: "Scaffold a fresh temp repo module and execute its test",
    passed: result.exitCode === 0,
    tempRepoPath: "temp://workspace_scaffold_js_module",
    fileMutationCount: 3,
    shellMutationCount: 0,
    wrongRootIncident: false,
    unauthorizedWriteBlocked: false,
    effectLedgerComplete: completeness.completenessRate === 1,
    exitCode: result.exitCode,
    notes: result.stdout.trim() || result.stderr.trim() || "ok",
  };
}

async function runRelativeTargetPatchScenario(
  context: LiveScenarioContext,
): Promise<PipelineLiveCodingScenarioArtifact> {
  await writeFile(
    path.join(context.repoDir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2),
    "utf8",
  );
  await mkdir(path.join(context.repoDir, "src"), { recursive: true });
  const relativeTarget = "./src/greeter.js";
  const normalizedTarget = path.resolve(context.repoDir, relativeTarget);
  await writeFile(
    normalizedTarget,
    'export const greet = (name) => `bye ${name}`;\n',
    "utf8",
  );
  await recordFileWrite({
    context,
    targetPath: normalizedTarget,
    content: 'export const greet = (name) => `hello ${name}`;\n',
    label: "Patch relative target inside temp repo using normalized workspace path.",
    toolCallId: "patch-relative-greeter",
  });
  const result = await runCommand(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { greet } from "./src/greeter.js"; if (greet("tetsuo") !== "hello tetsuo") { process.exit(1); }',
    ],
    { cwd: context.repoDir },
  );
  const effects = await collectEffects(context.ledger, context.sessionId);
  const completeness = evaluateEffectLedgerCompleteness(effects);
  return {
    scenarioId: "relative_target_patch",
    title: "Normalize a relative target path and patch inside the workspace only",
    passed: result.exitCode === 0,
    tempRepoPath: "temp://relative_target_patch",
    fileMutationCount: 1,
    shellMutationCount: 0,
    wrongRootIncident: !normalizedTarget.startsWith(context.repoDir),
    unauthorizedWriteBlocked: false,
    effectLedgerComplete: completeness.completenessRate === 1,
    exitCode: result.exitCode,
    notes: relativeTarget,
  };
}

async function runShellGeneratedSourceScenario(
  context: LiveScenarioContext,
): Promise<PipelineLiveCodingScenarioArtifact> {
  await writeFile(
    path.join(context.repoDir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2),
    "utf8",
  );
  const generatedPath = path.join(context.repoDir, "generated.js");
  const shell = await recordShellMutation({
    context,
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("generated.js", "export const answer = 42;\\n", "utf8");',
      ].join(" "),
    ],
    targetPaths: [generatedPath],
    label: "Generate source file via shell command in temp repo.",
    toolCallId: "shell-generate-source",
  });
  const verify = await runCommand(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { answer } from "./generated.js"; if (answer !== 42) { process.exit(1); }',
    ],
    { cwd: context.repoDir },
  );
  const effects = await collectEffects(context.ledger, context.sessionId);
  const completeness = evaluateEffectLedgerCompleteness(effects);
  return {
    scenarioId: "shell_generated_source",
    title: "Generate source through a shell command and execute it in the temp repo",
    passed: shell.exitCode === 0 && verify.exitCode === 0,
    tempRepoPath: "temp://shell_generated_source",
    fileMutationCount: 0,
    shellMutationCount: 1,
    wrongRootIncident: false,
    unauthorizedWriteBlocked: false,
    effectLedgerComplete: completeness.completenessRate === 1,
    exitCode: shell.exitCode !== 0 ? shell.exitCode : verify.exitCode,
    notes: verify.stdout.trim() || shell.stderr.trim() || "ok",
  };
}

async function runScenario(
  scenarioId: string,
  now: () => number,
  runner: (context: LiveScenarioContext) => Promise<PipelineLiveCodingScenarioArtifact>,
): Promise<PipelineLiveCodingScenarioArtifact> {
  const repoDir = await mkdtemp(path.join(tmpdir(), `agenc-live-coding-${scenarioId}-`));
  const ledger = EffectLedger.fromMemoryBackend(new InMemoryBackend());
  const sessionId = `live-coding:${scenarioId}`;
  try {
    return await runner({
      repoDir,
      ledger,
      now,
      sessionId,
    });
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

export async function runLiveCodingSuite(
  config: PipelineLiveCodingRunnerConfig = {},
): Promise<PipelineLiveCodingArtifact> {
  const now = config.now ?? Date.now;
  const scenarios = await Promise.all([
    runScenario("workspace-scaffold", now, runWorkspaceScaffoldScenario),
    runScenario("relative-target", now, runRelativeTargetPatchScenario),
    runScenario("shell-generated", now, runShellGeneratedSourceScenario),
  ]);
  const passingScenarios = scenarios.filter((scenario) => scenario.passed).length;
  const effectLedgerCompletenessRate = ratio(
    scenarios.filter((scenario) => scenario.effectLedgerComplete).length,
    scenarios.length,
  );
  return {
    scenarioCount: scenarios.length,
    passingScenarios,
    passRate: ratio(passingScenarios, scenarios.length),
    tempRepoCount: scenarios.length,
    totalFileMutations: scenarios.reduce(
      (sum, scenario) => sum + scenario.fileMutationCount,
      0,
    ),
    totalShellMutations: scenarios.reduce(
      (sum, scenario) => sum + scenario.shellMutationCount,
      0,
    ),
    wrongRootIncidents: scenarios.filter((scenario) => scenario.wrongRootIncident).length,
    unauthorizedWriteBlocks: scenarios.filter((scenario) => scenario.unauthorizedWriteBlocked).length,
    effectLedgerCompletenessRate,
    scenarios,
  };
}
