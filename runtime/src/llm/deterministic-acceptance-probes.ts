import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import { areDocumentationOnlyArtifacts } from "../workflow/artifact-paths.js";
import type { ToolCallRecord } from "./chat-executor-types.js";
import {
  didToolCallFail,
  extractToolFailureTextFromResult,
} from "./chat-executor-tool-utils.js";
import type { ToolHandler } from "./types.js";

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

interface AcceptanceProbePlan {
  readonly toolName: "system.bash";
  readonly args: Record<string, unknown>;
  readonly commandDisplay: string;
  readonly label: string;
}

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

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Best-effort probe discovery must stay non-fatal.
  }
  return undefined;
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

function detectNodeBuildPlan(workspaceRoot: string): AcceptanceProbePlan[] {
  const manifestPath = resolvePath(workspaceRoot, "package.json");
  if (!existsSync(manifestPath)) {
    return [];
  }
  const manifest = readJsonObject(manifestPath);
  const scripts =
    manifest?.scripts &&
    typeof manifest.scripts === "object" &&
    !Array.isArray(manifest.scripts)
      ? manifest.scripts as Record<string, unknown>
      : undefined;
  if (typeof scripts?.build !== "string" || scripts.build.trim().length === 0) {
    return [];
  }
  const command = existsSync(resolvePath(workspaceRoot, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(resolvePath(workspaceRoot, "yarn.lock"))
      ? "yarn"
      : existsSync(resolvePath(workspaceRoot, "bun.lockb")) ||
          existsSync(resolvePath(workspaceRoot, "bun.lock"))
        ? "bun"
        : "npm";
  const args =
    command === "yarn"
      ? ["build"]
      : command === "bun"
        ? ["run", "build"]
        : ["run", "build"];
  return [
    {
      toolName: "system.bash",
      args: {
        command,
        args,
        cwd: workspaceRoot,
      },
      commandDisplay: [command, ...args].join(" "),
      label: "package build",
    },
  ];
}

function buildAcceptanceProbePlans(
  workspaceRoot: string,
): AcceptanceProbePlan[] {
  if (existsSync(resolvePath(workspaceRoot, "CMakeLists.txt"))) {
    return [
      {
        toolName: "system.bash",
        args: {
          command: "cmake",
          args: ["-S", ".", "-B", "build"],
          cwd: workspaceRoot,
        },
        commandDisplay: "cmake -S . -B build",
        label: "cmake configure",
      },
      {
        toolName: "system.bash",
        args: {
          command: "cmake",
          args: ["--build", "build"],
          cwd: workspaceRoot,
        },
        commandDisplay: "cmake --build build",
        label: "cmake build",
      },
    ];
  }
  if (
    existsSync(resolvePath(workspaceRoot, "Makefile")) ||
    existsSync(resolvePath(workspaceRoot, "makefile"))
  ) {
    return [
      {
        toolName: "system.bash",
        args: {
          command: "make",
          args: [],
          cwd: workspaceRoot,
        },
        commandDisplay: "make",
        label: "make build",
      },
    ];
  }
  return detectNodeBuildPlan(workspaceRoot);
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
  readonly activeToolHandler?: ToolHandler;
}): Promise<DeterministicAcceptanceProbeDecision> {
  const workspaceRoot = params.workspaceRoot?.trim();
  if (!workspaceRoot || !params.activeToolHandler) {
    return {
      shouldIntervene: false,
      probeRuns: [],
    };
  }
  if (
    params.targetArtifacts &&
    params.targetArtifacts.length > 0 &&
    areDocumentationOnlyArtifacts(params.targetArtifacts)
  ) {
    return {
      shouldIntervene: false,
      probeRuns: [],
    };
  }
  if (!hasSuccessfulStructuredMutation(params.allToolCalls)) {
    return {
      shouldIntervene: false,
      probeRuns: [],
    };
  }

  const plans = buildAcceptanceProbePlans(workspaceRoot);
  if (plans.length === 0) {
    return {
      shouldIntervene: false,
      probeRuns: [],
    };
  }

  const probeRuns: ToolCallRecord[] = [];
  for (const plan of plans) {
    const startedAt = Date.now();
    let result: string;
    try {
      result = await params.activeToolHandler(plan.toolName, plan.args);
    } catch (error) {
      result = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const isError = didToolCallFail(false, result);
    probeRuns.push({
      name: plan.toolName,
      args: {
        ...plan.args,
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
      const command =
        typeof run.args.command === "string" ? run.args.command : run.name;
      const commandArgs = Array.isArray(run.args.args)
        ? run.args.args.filter((value): value is string => typeof value === "string")
        : [];
      return [command, ...commandArgs].join(" ");
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
