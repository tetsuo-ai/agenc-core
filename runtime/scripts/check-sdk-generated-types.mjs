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
  const [schemas, coreTypes, generated] = await Promise.all([
    readRuntimeFile(paths.schemas),
    readRuntimeFile(paths.coreTypes),
    readRuntimeFile(paths.generated),
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
