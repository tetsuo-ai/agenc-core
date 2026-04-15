import { resolve as resolvePath } from "node:path";

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import {
  buildVerificationProbeDescriptors,
  runVerificationProbe,
  type VerifierProfileKind,
  type VerificationProbeDescriptor,
} from "../../gateway/verifier-probes.js";
import type { AcceptanceProbeCategory } from "../../gateway/subagent-orchestrator-types.js";

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function okResult(data: unknown): ToolResult {
  return { content: safeStringify(data) };
}

function asWorkspaceRoot(args: Record<string, unknown>): string | undefined {
  const value =
    typeof args.workspaceRoot === "string" && args.workspaceRoot.trim().length > 0
      ? args.workspaceRoot.trim()
      : typeof args.cwd === "string" && args.cwd.trim().length > 0
        ? args.cwd.trim()
        : undefined;
  return value ? resolvePath(value) : undefined;
}

function asProfiles(
  args: Record<string, unknown>,
): readonly VerifierProfileKind[] | undefined {
  if (!Array.isArray(args.profiles)) {
    return undefined;
  }
  const profiles = args.profiles
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry): entry is VerifierProfileKind =>
      entry === "generic" ||
      entry === "cli" ||
      entry === "api" ||
      entry === "browser" ||
      entry === "infra"
    );
  return profiles.length > 0 ? profiles : undefined;
}

function asCategories(
  args: Record<string, unknown>,
): readonly AcceptanceProbeCategory[] | undefined {
  if (!Array.isArray(args.categories)) {
    return undefined;
  }
  const categories = args.categories
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry): entry is AcceptanceProbeCategory =>
      entry === "build" ||
      entry === "typecheck" ||
      entry === "lint" ||
      entry === "test" ||
      entry === "smoke" ||
      entry === "api_smoke" ||
      entry === "browser_e2e" ||
      entry === "infra_validate"
    );
  return categories.length > 0 ? categories : undefined;
}

function findProbe(
  probes: readonly VerificationProbeDescriptor[],
  probeId: string,
): VerificationProbeDescriptor | undefined {
  return probes.find((probe) => probe.id === probeId);
}

export function createVerificationTools(): readonly Tool[] {
  const listProbes: Tool = {
    name: "verification.listProbes",
    description:
      "List repo-local verification probes that the runtime can execute to validate the workspace without intentionally editing source files.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "Workspace root to inspect. Defaults to the injected working directory.",
        },
        profiles: {
          type: "array",
          items: {
            type: "string",
            enum: ["generic", "cli", "api", "browser", "infra"],
          },
          description: "Optional verifier profiles to filter probes by.",
        },
        categories: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "build",
              "typecheck",
              "lint",
              "test",
              "smoke",
              "api_smoke",
              "browser_e2e",
              "infra_validate",
            ],
          },
          description: "Optional verification categories to filter probes by.",
        },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const workspaceRoot = asWorkspaceRoot(args);
      if (!workspaceRoot) {
        return errorResult(
          "workspaceRoot is required when no default working directory is available",
        );
      }
      const probes = buildVerificationProbeDescriptors({
        workspaceRoot,
        ...(asProfiles(args) ? { profiles: asProfiles(args) } : {}),
        ...(asCategories(args) ? { categories: asCategories(args) } : {}),
      });
      return okResult({
        workspaceRoot,
        profiles: [...new Set(probes.map((probe) => probe.profile))],
        categories: [...new Set(probes.map((probe) => probe.category))],
        probes: probes.map((probe) => ({
          id: probe.id,
          label: probe.label,
          category: probe.category,
          profile: probe.profile,
          command: [probe.command, ...probe.args].join(" ").trim(),
          cwd: probe.cwd,
          writesTempOnly: probe.writesTempOnly,
          timeoutMs: probe.timeoutMs,
        })),
      });
    },
  };

  const runProbeTool: Tool = {
    name: "verification.runProbe",
    description:
      "Run one repo-local verification probe selected from verification.listProbes. Probes may run normal repo-local build or test commands as part of verification.",
    inputSchema: {
      type: "object",
      properties: {
        probeId: {
          type: "string",
          description: "Probe id returned by verification.listProbes.",
        },
        workspaceRoot: {
          type: "string",
          description: "Workspace root to inspect. Defaults to the injected working directory.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: "Optional timeout override for this probe.",
        },
      },
      required: ["probeId"],
      additionalProperties: false,
    },
    async execute(args) {
      const probeId =
        typeof args.probeId === "string" && args.probeId.trim().length > 0
          ? args.probeId.trim()
          : undefined;
      if (!probeId) {
        return errorResult("probeId must be a non-empty string");
      }
      const workspaceRoot = asWorkspaceRoot(args);
      if (!workspaceRoot) {
        return errorResult(
          "workspaceRoot is required when no default working directory is available",
        );
      }
      const probes = buildVerificationProbeDescriptors({ workspaceRoot });
      const probe = findProbe(probes, probeId);
      if (!probe) {
        return errorResult(`verification probe "${probeId}" is not available`);
      }
      const result = await runVerificationProbe(probe, {
        ...(typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
          ? { timeoutMs: Math.max(1, Math.floor(args.timeoutMs)) }
          : {}),
      });
      return okResult({
        ...result,
        __agencVerification: {
          probeId: result.probeId,
          category: result.category,
          profile: result.profile,
          repoLocal: true,
          cwd: result.cwd,
          command: result.command,
          writesTempOnly: result.writesTempOnly,
        },
      });
    },
  };

  return [listProbes, runProbeTool];
}
