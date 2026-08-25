#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const runtimeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const paths = {
  schemas: "src/entrypoints/sdk/coreSchemas.ts",
  coreTypes: "src/entrypoints/sdk/coreTypes.ts",
  generated: "src/entrypoints/sdk/coreTypes.generated.ts",
  packageWorkflowResult: "../packages/agenc-sdk/src/workflow-result.generated.ts",
};
const checkCommand =
  "npm --workspace=@tetsuo-ai/runtime run check:sdk-generated-types";

async function readRuntimeFile(relativePath) {
  return readFile(path.join(runtimeRoot, relativePath), "utf8");
}

function countMatches(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

function expectCondition(failures, condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

async function main() {
  const [schemas, coreTypes, generated, packageWorkflowResult] = await Promise.all([
    readRuntimeFile(paths.schemas),
    readRuntimeFile(paths.coreTypes),
    readRuntimeFile(paths.generated),
    readRuntimeFile(paths.packageWorkflowResult),
  ]);
  const failures = [];
  const sources = [
    [paths.schemas, schemas],
    [paths.coreTypes, coreTypes],
    [paths.generated, generated],
  ];

  for (const [relativePath, source] of sources) {
    expectCondition(
      failures,
      !source.includes("generate-sdk-types.ts"),
      `${relativePath} still references the removed SDK type generator`,
    );
    expectCondition(
      failures,
      source.includes(checkCommand),
      `${relativePath} does not point at ${checkCommand}`,
    );
  }

  for (const fieldName of ["updatedPermissions", "permission_suggestions"]) {
    expectCondition(
      failures,
      schemas.includes(
        `${fieldName}: z.array(PermissionUpdateSchema()).optional()`,
      ),
      `${paths.schemas} no longer declares ${fieldName} as a PermissionUpdate array`,
    );
  }

  expectCondition(
    failures,
    !/(updatedPermissions|permission_suggestions)\?: \(\{/.test(generated),
    `${paths.generated} expanded a PermissionUpdate array as an object-union array`,
  );

  for (const marker of [
    "export const WorkflowHandoffOwnerSchema",
    "export const WorkflowHandoffArtifactSchema",
    "kind: z.literal('workflow_handoff')",
    "compatibility_epoch: z.literal('workflow_handoff.v1/state-schema.22')",
    "byte_length: z.number().int().min(0).max(16_777_216)",
    "token_count: z.number().int().min(0).max(131_072)",
  ]) {
    expectCondition(
      failures,
      schemas.includes(marker),
      `${paths.schemas} is missing workflow handoff marker ${marker}`,
    );
  }
  for (const marker of [
    "export const WorkflowStepOutcomeV2Schema",
    "export const WorkflowRunOutcomeV2Schema",
    "export const WorkflowRunResultV2Schema",
    "workflow_result_version: z.literal(2)",
    "manifest_format_version: z.literal(2)",
    "blocked_dependency_unknown",
    "unknown_outcome",
  ]) {
    expectCondition(
      failures,
      schemas.includes(marker),
      `${paths.schemas} is missing workflow result marker ${marker}`,
    );
  }
  for (const marker of [
    "export type WorkflowStepOutcomeV2",
    "export type WorkflowRunOutcomeV2",
    "export type WorkflowRunResultV2",
    "workflow_result_version: 2",
    "manifest_format_version: 2",
    'outcome: WorkflowRunOutcomeV2',
  ]) {
    expectCondition(
      failures,
      generated.includes(marker),
      `${paths.generated} is missing workflow result marker ${marker}`,
    );
  }
  for (const marker of [
    "export const AGENC_WORKFLOW_RESULT_VERSION = 2 as const",
    "export const AGENC_WORKFLOW_STEP_OUTCOMES_V2",
    "export const AGENC_WORKFLOW_RUN_OUTCOMES_V2",
    "export interface WorkflowRunResultV2",
    '"blocked_dependency_unknown"',
    '"unknown_outcome"',
  ]) {
    expectCondition(
      failures,
      packageWorkflowResult.includes(marker),
      `${paths.packageWorkflowResult} is missing workflow result marker ${marker}`,
    );
  }
  for (const marker of [
    "export type WorkflowHandoffOwner",
    "export type WorkflowHandoffArtifact",
    'kind: "workflow_handoff"',
    'compatibility_epoch: "workflow_handoff.v1/state-schema.22"',
    'digest: `sha256:${string}`',
  ]) {
    expectCondition(
      failures,
      generated.includes(marker),
      `${paths.generated} is missing workflow handoff marker ${marker}`,
    );
  }
  expectCondition(
    failures,
    countMatches(
      generated,
      /(updatedPermissions|permission_suggestions)\?: PermissionUpdate\[\]/g,
    ) === 6,
    `${paths.generated} should contain six generated PermissionUpdate[] fields`,
  );

  const duplicatedObjectProperty = generated.match(
    /^\s*([A-Za-z_]\w*\??): \{\n\s*\1: \{/m,
  );
  expectCondition(
    failures,
    duplicatedObjectProperty === null,
    `${paths.generated} contains adjacent duplicate object property ${duplicatedObjectProperty?.[1]}`,
  );

  expectCondition(
    failures,
    !schemas.includes("McpSdkServerConfig") &&
      !generated.includes("McpSdkServerConfig"),
    "committed SDK types reintroduced removed MCP surface McpSdkServerConfig",
  );

  if (failures.length > 0) {
    process.stderr.write(
      `[sdk generated types] found ${failures.length} issue(s):\n- ${failures.join("\n- ")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write("[sdk generated types] verified committed SDK types\n");
}

await main();
