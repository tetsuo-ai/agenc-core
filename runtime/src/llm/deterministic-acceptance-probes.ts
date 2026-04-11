import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import { areDocumentationOnlyArtifacts } from "../workflow/artifact-paths.js";
import type { ToolCallRecord } from "./chat-executor-types.js";
import {
  didToolCallFail,
  extractToolFailureTextFromResult,
} from "./chat-executor-tool-utils.js";
import {
  buildVerificationProbeDescriptors,
  runVerificationProbe,
} from "../gateway/verifier-probes.js";

const FILE_MUTATION_TOOL_NAMES = new Set([
  "system.appendFile",
  "system.editFile",
  "system.mkdir",
  "system.move",
  "system.writeFile",
  "desktop.text_editor",
]);

type AcceptanceProbeValidationCode = Extract<
  DelegationOutputValidationCode,
  "deterministic_acceptance_probe_failed"
>;

export interface DeterministicAcceptanceProbeEvidence {
  readonly workspaceRoot: string;
  readonly executedProbeCount: number;
  readonly failedProbeCount: number;
  readonly executedCommands: readonly string[];
  readonly failureExcerpts: readonly string[];
}

export interface DeterministicAcceptanceProbeDecision {
  readonly shouldIntervene: boolean;
  readonly validationCode?: AcceptanceProbeValidationCode;
  readonly stopReasonDetail?: string;
  readonly blockingMessage?: string;
  readonly evidence?: DeterministicAcceptanceProbeEvidence;
  readonly probeRuns: readonly ToolCallRecord[];
}

function hasSuccessfulStructuredMutation(
  toolCalls: readonly ToolCallRecord[],
): boolean {
  return toolCalls.some((toolCall) => {
    if (didToolCallFail(toolCall.isError, toolCall.result)) {
      return false;
    }
    if (!FILE_MUTATION_TOOL_NAMES.has(toolCall.name)) {
      return false;
    }
    if (toolCall.name !== "desktop.text_editor") {
      return true;
    }
    const command =
      typeof toolCall.args.command === "string"
        ? toolCall.args.command.trim().toLowerCase()
        : "";
    return command !== "view";
  });
}

function buildAcceptanceProbePlans(
  workspaceRoot: string,
): readonly ReturnType<typeof buildVerificationProbeDescriptors>[number][] {
  return buildVerificationProbeDescriptors({ workspaceRoot });
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function buildStopReasonDetail(
  failedRuns: readonly ToolCallRecord[],
): string {
  const excerpts = failedRuns
    .slice(0, 2)
    .map((run) => extractToolFailureTextFromResult(run.result))
    .filter((value) => value.trim().length > 0)
    .map((value) => truncate(value, 200));
  if (excerpts.length === 0) {
    return "Deterministic acceptance probe failed.";
  }
  return `Deterministic acceptance probe failed: ${excerpts.join(" | ")}`;
}

function buildBlockingMessage(params: {
  readonly failedRuns: readonly ToolCallRecord[];
  readonly evidence: DeterministicAcceptanceProbeEvidence;
}): string {
  const lines = [
    "Runtime acceptance probe blocked completion because deterministic workspace checks failed.",
    "",
    "Failing checks:",
  ];
  for (let i = 0; i < Math.min(params.failedRuns.length, 3); i += 1) {
    const run = params.failedRuns[i];
    const command =
      typeof run.args.command === "string"
        ? run.args.command
        : run.name;
    const commandArgs = Array.isArray(run.args.args)
      ? run.args.args.filter((value): value is string => typeof value === "string")
      : [];
    lines.push(`- \`${[command, ...commandArgs].join(" ")}\``);
    lines.push(`  ${truncate(extractToolFailureTextFromResult(run.result), 240)}`);
  }
  lines.push("");
  lines.push(
    "Use tools to fix the workspace until these checks pass. Do not claim completion while deterministic acceptance probes are still failing.",
  );
  return lines.join("\n");
}

export async function runDeterministicAcceptanceProbes(params: {
  readonly workspaceRoot?: string;
  readonly targetArtifacts?: readonly string[];
  readonly allToolCalls: readonly ToolCallRecord[];
  readonly activeToolHandler?: unknown;
}): Promise<DeterministicAcceptanceProbeDecision> {
  if (!shouldRunDeterministicAcceptanceProbes(params)) {
    return {
      shouldIntervene: false,
      probeRuns: [],
    };
  }
  const workspaceRoot = params.workspaceRoot!.trim();
  const plans = buildAcceptanceProbePlans(workspaceRoot);
  const probeRuns: ToolCallRecord[] = [];
  for (const plan of plans) {
    const startedAt = Date.now();
    let result: string;
    try {
      result = JSON.stringify({
        ...(await runVerificationProbe(plan)),
        __agencVerification: {
          probeId: plan.id,
          category: plan.category,
          profile: plan.profile,
          repoLocal: true,
          cwd: plan.cwd,
          command: [plan.command, ...plan.args].join(" ").trim(),
          writesTempOnly: plan.writesTempOnly,
        },
      });
    } catch (error) {
      result = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const isError = didToolCallFail(false, result);
    probeRuns.push({
      name: "verification.runProbe",
      args: {
        probeId: plan.id,
        cwd: plan.cwd,
        __runtimeAcceptanceProbe: true,
      },
      result,
      isError,
      durationMs: Date.now() - startedAt,
    });
    if (isError) {
      break;
    }
  }

  const failedRuns = probeRuns.filter((run) =>
    didToolCallFail(run.isError, run.result)
  );
  const evidence: DeterministicAcceptanceProbeEvidence = {
    workspaceRoot,
    executedProbeCount: probeRuns.length,
    failedProbeCount: failedRuns.length,
    executedCommands: probeRuns.map((run) => {
      try {
        const parsed = JSON.parse(run.result) as Record<string, unknown>;
        if (typeof parsed.command === "string" && parsed.command.trim().length > 0) {
          return parsed.command.trim();
        }
      } catch {
        // Ignore malformed results and fall back to the probe id.
      }
      return typeof run.args.probeId === "string" ? run.args.probeId : run.name;
    }),
    failureExcerpts: failedRuns
      .map((run) => truncate(extractToolFailureTextFromResult(run.result), 240)),
  };

  if (failedRuns.length === 0) {
    return {
      shouldIntervene: false,
      evidence,
      probeRuns,
    };
  }

  return {
    shouldIntervene: true,
    validationCode: "deterministic_acceptance_probe_failed",
    stopReasonDetail: buildStopReasonDetail(failedRuns),
    blockingMessage: buildBlockingMessage({
      failedRuns,
      evidence,
    }),
    evidence,
    probeRuns,
  };
}

export function shouldRunDeterministicAcceptanceProbes(params: {
  readonly workspaceRoot?: string;
  readonly targetArtifacts?: readonly string[];
  readonly allToolCalls: readonly ToolCallRecord[];
  readonly activeToolHandler?: unknown;
}): boolean {
  const workspaceRoot = params.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return false;
  }
  if (
    params.targetArtifacts &&
    params.targetArtifacts.length > 0 &&
    areDocumentationOnlyArtifacts(params.targetArtifacts)
  ) {
    return false;
  }
  if (!hasSuccessfulStructuredMutation(params.allToolCalls)) {
    return false;
  }
  const plans = buildAcceptanceProbePlans(workspaceRoot);
  return plans.length > 0;
}
