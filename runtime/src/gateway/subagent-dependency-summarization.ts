/**
 * Dependency result summarization for sub-agent prompt construction.
 *
 * Extracted from SubAgentOrchestrator — helpers that parse and summarize
 * dependency step results for injection into downstream sub-agent prompts.
 *
 * @module
 */

import { safeStringify } from "../tools/types.js";
import type { PipelinePlannerSynthesisStep } from "../workflow/pipeline.js";
import type {
  ReviewerHandoffArtifact,
  ReviewerHandoffEntry,
  ReviewerHandoffEvidenceRef,
} from "./subagent-orchestrator-types.js";
import {
  extractReviewerHandoffArtifactFromResult,
} from "./subagent-orchestrator-types.js";
import {
  extractDependencyArtifactsFromToolCall,
  truncateText,
  normalizeDependencyArtifactPath,
  isDependencyArtifactPathCandidate,
} from "./subagent-context-curation.js";

/* ------------------------------------------------------------------ */
/*  Dependency result summarization                                    */
/* ------------------------------------------------------------------ */

export function summarizeDependencyResultForPrompt(result: string | null): string {
  if (result === null) return "null";

  const reviewerHandoffArtifact = extractReviewerHandoffArtifactFromResult(result);
  if (reviewerHandoffArtifact) {
    const summary: Record<string, unknown> = {
      reviewerHandoffArtifact: {
        artifactId: reviewerHandoffArtifact.artifactId,
        producerStep: reviewerHandoffArtifact.producerStep,
        sourceSteps: reviewerHandoffArtifact.sourceSteps.slice(0, 8),
        synthesizedFeedback: truncateText(
          reviewerHandoffArtifact.synthesizedFeedback,
          1_200,
        ),
        reviewers: reviewerHandoffArtifact.reviewers.slice(0, 8).map((entry) => ({
          stepName: entry.stepName,
          role: entry.role,
          status: entry.status,
          ...(entry.subagentSessionId
            ? { subagentSessionId: entry.subagentSessionId }
            : {}),
          feedback: summarizeDependencyOutputText(entry.feedback),
          ...(entry.evidenceRefs.length > 0
            ? { evidenceRefs: entry.evidenceRefs.slice(0, 6) }
            : {}),
        })),
      },
    };
    return safeStringify(summary);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return truncateText(result, 320);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return truncateText(result, 320);
  }

  const record = parsed as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  if (record.type === "planner_synthesis_feedback") {
    const sourceSteps = Array.isArray(record.sourceSteps)
      ? record.sourceSteps
          .filter((value): value is string => typeof value === "string")
          .slice(0, 8)
      : [];
    const reviewerFeedback = Array.isArray(record.reviewerFeedback)
      ? record.reviewerFeedback
          .map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return null;
            }
            const item = entry as Record<string, unknown>;
            const stepName =
              typeof item.stepName === "string" ? item.stepName.trim() : "";
            const feedback =
              typeof item.feedback === "string"
                ? summarizeDependencyOutputText(item.feedback)
                : "";
            if (stepName.length === 0 || feedback.length === 0) {
              return null;
            }
            return `${stepName}: ${feedback}`;
          })
          .filter((value): value is string => value !== null)
          .slice(0, 8)
      : [];
    const synthesizedFeedback =
      typeof record.synthesizedFeedback === "string"
        ? truncateText(record.synthesizedFeedback, 1_200)
        : undefined;
    if (sourceSteps.length > 0) {
      summary.sourceSteps = sourceSteps;
    }
    if (reviewerFeedback.length > 0) {
      summary.reviewerFeedback = reviewerFeedback;
    }
    if (synthesizedFeedback && synthesizedFeedback.trim().length > 0) {
      summary.synthesizedFeedback = synthesizedFeedback;
    }
  }

  for (const key of [
    "status",
    "success",
    "durationMs",
    "providerName",
    "attempts",
    "stopReason",
    "stopReasonDetail",
    "validationCode",
  ]) {
    const value = record[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      summary[key] = value;
    }
  }

  if (Array.isArray(record.toolCalls)) {
    const toolNames = new Set<string>();
    const modifiedFiles: string[] = [];
    const verificationCommandStates = new Map<string, number>();
    for (const entry of record.toolCalls) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const toolCall = entry as Record<string, unknown>;
      const name = toolCall.name;
      if (typeof name === "string" && name.trim().length > 0) {
        toolNames.add(name);
      }
      const args =
        typeof toolCall.args === "object" &&
          toolCall.args !== null &&
          !Array.isArray(toolCall.args)
          ? toolCall.args as Record<string, unknown>
          : undefined;
      if ((name === "system.writeFile" || name === "system.appendFile") && args) {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        const normalizedPath = normalizeDependencyArtifactPath(path);
        if (
          normalizedPath.length > 0 &&
          isDependencyArtifactPathCandidate(normalizedPath) &&
          !modifiedFiles.includes(normalizedPath)
        ) {
          modifiedFiles.push(normalizedPath);
        }
      }
      if (name === "system.bash" || name === "desktop.bash") {
        const command = summarizeDependencyShellCommand(args);
        if (!command || !isDependencyVerificationCommand(command)) {
          continue;
        }
        const exitCode = extractDependencyCommandExitCode(
          typeof toolCall.result === "string" ? toolCall.result : "",
        );
        if (typeof exitCode === "number") {
          verificationCommandStates.set(command, exitCode);
        }
      }
    }
    const verifiedCommands = [...verificationCommandStates.entries()]
      .filter(([, exitCode]) => exitCode === 0)
      .map(([command]) => command);
    const failedCommands = [...verificationCommandStates.entries()]
      .filter(([, exitCode]) => exitCode !== 0)
      .map(([command]) => command);
    if (modifiedFiles.length > 0) {
      summary.modifiedFiles = modifiedFiles.slice(0, 6);
    }
    if (verifiedCommands.length > 0) {
      summary.verifiedCommands = verifiedCommands.slice(0, 4);
    }
    if (failedCommands.length > 0) {
      summary.failedCommands = failedCommands.slice(0, 4);
    }
    summary.toolCallSummary = {
      count: record.toolCalls.length,
      tools: [...toolNames],
    };
  }

  if (
    typeof record.output === "string" &&
    record.output.trim().length > 0 &&
    summary.reviewerFeedback === undefined &&
    summary.synthesizedFeedback === undefined &&
    summary.modifiedFiles === undefined &&
    summary.verifiedCommands === undefined &&
    summary.failedCommands === undefined
  ) {
    summary.outputSummary = summarizeDependencyOutputText(record.output);
  }

  return safeStringify(
    Object.keys(summary).length > 0 ? summary : record,
  );
}

function extractPlannerSynthesisFeedback(result: string | null): {
  readonly status: string;
  readonly stopReason?: string;
  readonly validationCode?: string;
  readonly subagentSessionId?: string;
  readonly feedback: string;
  readonly evidenceRefs: readonly ReviewerHandoffEvidenceRef[];
} {
  if (result === null) {
    return {
      status: "missing",
      feedback: "Dependency result missing.",
      evidenceRefs: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return {
      status: "completed",
      feedback: result.trim(),
      evidenceRefs: [],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "completed",
      feedback: result.trim(),
      evidenceRefs: [],
    };
  }

  const record = parsed as Record<string, unknown>;
  const output =
    typeof record.output === "string" && record.output.trim().length > 0
      ? record.output
      : result;
  return {
    status:
      typeof record.status === "string" && record.status.trim().length > 0
        ? record.status
        : "completed",
    stopReason:
      typeof record.stopReason === "string" ? record.stopReason : undefined,
    validationCode:
      typeof record.validationCode === "string"
        ? record.validationCode
        : undefined,
    subagentSessionId:
      typeof record.subagentSessionId === "string" &&
        record.subagentSessionId.trim().length > 0
        ? record.subagentSessionId.trim()
        : undefined,
    feedback: output.trim(),
    evidenceRefs: collectReviewerEvidenceRefs(record),
  };
}

function collectReviewerEvidenceRefs(
  record: Readonly<Record<string, unknown>>,
): readonly ReviewerHandoffEvidenceRef[] {
  const refs: ReviewerHandoffEvidenceRef[] = [];
  const seen = new Set<string>();
  const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
      continue;
    }
    const call = toolCall as Record<string, unknown>;
    const toolName = typeof call.name === "string" ? call.name.trim() : "";
    for (const artifact of extractDependencyArtifactsFromToolCall(toolCall)) {
      const normalizedPath = normalizeDependencyArtifactPath(artifact.path);
      if (
        normalizedPath.length === 0 ||
        !isDependencyArtifactPathCandidate(normalizedPath)
      ) {
        continue;
      }
      const kind: ReviewerHandoffEvidenceRef["kind"] =
        toolName === "system.writeFile" || toolName === "system.appendFile"
          ? "modified_artifact"
          : "read_artifact";
      const key = `${kind}::${normalizedPath}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push({
        kind,
        toolName: toolName || undefined,
        path: normalizedPath,
      });
    }
    if (
      toolName === "system.listDir" ||
      toolName === "system.stat" ||
      toolName === "system.readFile"
    ) {
      const args =
        typeof call.args === "object" &&
          call.args !== null &&
          !Array.isArray(call.args)
          ? call.args as Record<string, unknown>
          : undefined;
      const normalizedPath = normalizeDependencyArtifactPath(
        typeof args?.path === "string" ? args.path : "",
      );
      if (normalizedPath.length > 0) {
        const key = `workspace_inspection::${normalizedPath}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({
            kind: "workspace_inspection",
            toolName,
            path: normalizedPath,
          });
        }
      }
    }
    if (toolName === "system.bash" || toolName === "desktop.bash") {
      const args =
        typeof call.args === "object" &&
          call.args !== null &&
          !Array.isArray(call.args)
          ? call.args as Record<string, unknown>
          : undefined;
      const command = summarizeDependencyShellCommand(args);
      if (!command || !isDependencyVerificationCommand(command)) {
        continue;
      }
      const exitCode = extractDependencyCommandExitCode(
        typeof call.result === "string" ? call.result : "",
      );
      const key = `verification_command::${command}::${String(exitCode ?? "")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push({
        kind: "verification_command",
        toolName,
        command,
        ...(typeof exitCode === "number" ? { exitCode } : {}),
      });
    }
  }
  return refs;
}

function buildReviewerHandoffArtifact(params: {
  readonly step: Pick<PipelinePlannerSynthesisStep, "name" | "objective">;
  readonly reviewers: readonly ReviewerHandoffEntry[];
}): ReviewerHandoffArtifact {
  const synthesizedFeedback = params.reviewers
    .map((entry) => `- ${entry.stepName}: ${summarizeDependencyOutputText(entry.feedback)}`)
    .join("\n");
  return {
    type: "reviewer_handoff_artifact",
    artifactId: `${params.step.name}:reviewer_handoff`,
    producerStep: params.step.name,
    objective: params.step.objective ?? null,
    sourceSteps: params.reviewers.map((entry) => entry.stepName),
    synthesizedFeedback,
    reviewers: params.reviewers,
  };
}

export function materializePlannerSynthesisResult(
  step: Pick<PipelinePlannerSynthesisStep, "name" | "objective" | "dependsOn">,
  results: Readonly<Record<string, string>>,
): string {
  const reviewerFeedback: ReviewerHandoffEntry[] = (step.dependsOn ?? []).map((dependencyName) => {
    const dependencyResult = extractPlannerSynthesisFeedback(
      results[dependencyName] ?? null,
    );
    return {
      stepName: dependencyName,
      role: "reviewer",
      status: dependencyResult.status,
      ...(dependencyResult.subagentSessionId
        ? { subagentSessionId: dependencyResult.subagentSessionId }
        : {}),
      ...(dependencyResult.stopReason
        ? { stopReason: dependencyResult.stopReason }
        : {}),
      ...(dependencyResult.validationCode
        ? { validationCode: dependencyResult.validationCode }
        : {}),
      feedback: dependencyResult.feedback,
      evidenceRefs: dependencyResult.evidenceRefs,
    };
  });
  const reviewerHandoffArtifact = buildReviewerHandoffArtifact({
    step,
    reviewers: reviewerFeedback,
  });

  return safeStringify({
    type: "planner_synthesis_feedback",
    name: step.name,
    status: "completed",
    objective: step.objective ?? null,
    sourceSteps: reviewerHandoffArtifact.sourceSteps,
    reviewerFeedback,
    synthesizedFeedback: reviewerHandoffArtifact.synthesizedFeedback,
    reviewerHandoffArtifact,
  });
}

export function summarizeDependencyShellCommand(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  const command =
    typeof args.command === "string" ? args.command.trim() : "";
  const commandArgs = Array.isArray(args.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  const rendered = [command, ...commandArgs]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return rendered.length > 0 ? rendered : undefined;
}

export function isDependencyVerificationCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun|vitest|jest|tsc)\b/i.test(command) &&
    /\b(?:build|test|coverage|verify|check|install|run)\b/i.test(command);
}

export function extractDependencyCommandExitCode(result: string): number | undefined {
  if (result.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode)
      ? parsed.exitCode
      : undefined;
  } catch {
    return undefined;
  }
}

export function summarizeDependencyOutputText(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return truncateText(output.trim(), 240);
  }
  return truncateText(lines.slice(0, 3).join(" "), 240);
}

export function resolveParentSessionId(pipelineId: string): string {
  if (!pipelineId.startsWith("planner:")) return pipelineId;
  const encodedParentSessionId = pipelineId.slice("planner:".length);
  const separatorIndex = encodedParentSessionId.lastIndexOf(":");
  if (separatorIndex <= 0) {
    return encodedParentSessionId || pipelineId;
  }
  return encodedParentSessionId.slice(0, separatorIndex);
}
