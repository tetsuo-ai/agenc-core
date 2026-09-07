import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { RunRuntimeSettingsSnapshot } from "../../src/contracts/run-contracts.js";
import { runtimeSettingsEqual } from "../../src/state/runtime-settings-snapshot.js";

const baseline: RunRuntimeSettingsSnapshot = {
  permissionMode: "default",
  prePlanMode: null,
  autoModeActive: false,
  autoModeAvailable: false,
  bypassPermissionsModeAvailable: false,
  bypassPermissionsWorkspace: null,
  bypassPermissionsConsentWorkspace: null,
  model: "grok-4.5",
  provider: "grok",
  profile: null,
  reasoningEffort: null,
  modelVerbosity: null,
  serviceTier: null,
  hooksDisabled: false,
};

const alternatives: RunRuntimeSettingsSnapshot = {
  permissionMode: "plan",
  prePlanMode: "default",
  autoModeActive: true,
  autoModeAvailable: true,
  bypassPermissionsModeAvailable: true,
  bypassPermissionsWorkspace: "/workspace",
  bypassPermissionsConsentWorkspace: "/workspace",
  model: "gpt-5",
  provider: "openai",
  profile: "review",
  reasoningEffort: "high",
  modelVerbosity: "low",
  serviceTier: "priority",
  hooksDisabled: true,
};

const keys = Object.keys(baseline) as (keyof RunRuntimeSettingsSnapshot)[];

describe("runtime settings equality", () => {
  it.each(keys)("detects a change to %s in either direction", (key) => {
    const changed = { ...baseline, [key]: alternatives[key] };
    expect(runtimeSettingsEqual(baseline, changed)).toBe(false);
    expect(runtimeSettingsEqual(changed, baseline)).toBe(false);
  });

  it("compares detached snapshots independently of property order and durable metadata", () => {
    const reversed = Object.fromEntries(
      Object.entries(baseline).toReversed(),
    ) as unknown as RunRuntimeSettingsSnapshot;
    const durable = {
      ...structuredClone(baseline),
      eventId: "settings:1",
      epoch: 1,
    };
    expect(runtimeSettingsEqual(baseline, reversed)).toBe(true);
    expect(runtimeSettingsEqual(baseline, durable)).toBe(true);
    expect(
      runtimeSettingsEqual(alternatives, structuredClone(alternatives)),
    ).toBe(true);
  });

  it.each(keys.filter((key) => baseline[key] === null))(
    "requires the canonical null representation for absent %s",
    (key) => {
      const absent = {
        ...baseline,
        [key]: undefined,
      } as unknown as RunRuntimeSettingsSnapshot;
      expect(runtimeSettingsEqual(baseline, { ...baseline })).toBe(true);
      expect(runtimeSettingsEqual(baseline, absent)).toBe(false);
      expect(runtimeSettingsEqual(absent, baseline)).toBe(false);
    },
  );
});

const snapshotPath = fileURLToPath(
  new URL("../../src/state/runtime-settings-snapshot.ts", import.meta.url),
);
const contractsPath = fileURLToPath(
  new URL("../../src/contracts/run-contracts.ts", import.meta.url),
);
const snapshotSource = readFileSync(snapshotPath, "utf8");
const contractsSource = ts.createSourceFile(
  contractsPath,
  readFileSync(contractsPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
// Compile the actual snapshot contract without unrelated run/tool contracts.
const snapshotContracts = contractsSource.statements
  .filter((statement) => {
    if (ts.isInterfaceDeclaration(statement)) {
      return statement.name.text === "RunRuntimeSettingsSnapshot";
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      return statement.name.text.startsWith("RunRuntime");
    }
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text.startsWith("RUN_RUNTIME_"),
      )
    );
  })
  .map((statement) => statement.getFullText(contractsSource))
  .join("\n");

function compileSnapshot(additionalField = "", source = snapshotSource) {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile;
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    if (fileName === snapshotPath || fileName === contractsPath) {
      const content =
        fileName === snapshotPath
          ? source
          : snapshotContracts + additionalField;
      return ts.createSourceFile(fileName, content, languageVersion, true);
    }
    return readSource(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  return ts
    .getPreEmitDiagnostics(ts.createProgram([snapshotPath], options, host))
    .map((diagnostic) => ({
      file: diagnostic.file?.fileName,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
}

describe("runtime settings comparison coverage", () => {
  it("type-checks the current production comparator", () => {
    expect(compileSnapshot()).toEqual([]);
  });

  it.each(["", "?"])(
    "rejects an unlisted future field%s until a policy is chosen",
    (optional) => {
      const extra = `\nexport interface RunRuntimeSettingsSnapshot { readonly futureSetting${optional}: string; }`;
      expect(compileSnapshot(extra)).toEqual([
        expect.objectContaining({ file: snapshotPath, code: 2345 }),
      ]);
      const updated = snapshotSource.replace(
        '"hooksDisabled",',
        '"hooksDisabled", "futureSetting",',
      );
      expect(updated).not.toBe(snapshotSource);
      expect(compileSnapshot(extra, updated)).toEqual([]);
    },
  );
});
