import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

import { DAEMON_CLIENT_ENV_SNAPSHOT_KEYS } from "../../src/app-server/client-env-snapshot.js";
import { OBSOLETE_CONFIG_ENV_REPLACEMENTS } from "../../src/config/env.js";
import { RETIRED_CONFIG_DIR_ENV } from "../../src/config/home.js";
import { RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS } from "../../src/session/runtime-options.js";

const RUNTIME_SOURCE = resolve(import.meta.dirname, "../../src");
const ENV_REFERENCE = resolve(import.meta.dirname, "../../../docs/reference/env.md");
const CONFIG_REFERENCE = resolve(
  import.meta.dirname,
  "../../../docs/reference/config.md",
);
const NON_ENV_RUNTIME_NAMES = new Set([
  // Error code attached to authority-lock release diagnostics, not an
  // environment variable read by the runtime.
  "AGENC_CONFIG_AUTHORITY_RELEASE",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

function runtimeEnvironmentNames(): Set<string> {
  const names = new Set<string>(DAEMON_CLIENT_ENV_SNAPSHOT_KEYS);

  for (const path of sourceFiles(RUNTIME_SOURCE)) {
    const source = readFileSync(path, "utf8");
    const file = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      // Exact AGENC_* strings are the runtime's helper/allowlist form for env
      // keys. Property reads cover the direct process.env/env form. Keeping
      // both here prevents a helper refactor from weakening documentation.
      if (
        ts.isStringLiteralLike(node) &&
        /^AGENC_[A-Z0-9_]+$/u.test(node.text)
      ) {
        names.add(node.text);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        /^AGENC_[A-Z0-9_]+$/u.test(node.name.text)
      ) {
        const owner = node.expression.getText(file);
        if (
          owner === "process.env" ||
          owner === "e" ||
          /(?:^|\.)env$/iu.test(owner) ||
          /environment/iu.test(owner)
        ) {
          names.add(node.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    if (path.endsWith("/config/env.ts")) {
      const snapshot = file.statements.find(
        (statement): statement is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(statement) &&
          statement.name.text === "EnvSnapshot",
      );
      for (const member of snapshot?.members ?? []) {
        const name = member.name && ts.isIdentifier(member.name)
          ? member.name.text
          : undefined;
        if (name && /^AGENC_[A-Z0-9_]+$/u.test(name)) {
          names.add(name);
        }
      }
    }
  }

  return names;
}

function obsoleteConfigNames(): Set<string> {
  return new Set<string>([
    RETIRED_CONFIG_DIR_ENV,
    ...Object.keys(RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS),
    ...Object.keys(OBSOLETE_CONFIG_ENV_REPLACEMENTS),
  ]);
}

function advancedDocumentedEnvironmentNames(reference: string): string[] {
  const startMarker = "## Complete advanced and runtime-managed name index";
  const endMarker = "## External, platform, and runtime-managed inputs";
  const start = reference.indexOf(startMarker);
  const end = reference.indexOf(endMarker);
  if (start < 0 || end <= start) {
    throw new Error("environment reference is missing the advanced-name index");
  }

  return [...reference.slice(start, end).matchAll(/`(AGENC_[A-Z0-9_]+)`/gu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

describe("environment reference coverage", () => {
  test("documents model-only provider selection in both configuration references", () => {
    for (const path of [ENV_REFERENCE, CONFIG_REFERENCE]) {
      const reference = readFileSync(path, "utf8");
      expect(reference).toMatch(
        /model-only layer[\s\S]{0,120}`--model`[\s\S]{0,120}`AGENC_MODEL`[\s\S]{0,120}`model`[\s\S]{0,180}(?:selects|resolves)[\s\S]{0,80}provider/iu,
      );
      expect(reference).not.toMatch(
        /(?:only|exactly one)[^\n]{0,120}(?:`--provider`|`AGENC_PROVIDER`|`model_provider`)[^\n]{0,120}provider/iu,
      );
    }
  });

  test("documents every production env name consumed by runtime authorities", () => {
    const reference = readFileSync(ENV_REFERENCE, "utf8");
    const missing = [...runtimeEnvironmentNames()]
      .filter((name) => !NON_ENV_RUNTIME_NAMES.has(name))
      .filter((name) => !reference.includes(`\`${name}\``))
      .sort();

    expect(missing, relative(process.cwd(), ENV_REFERENCE)).toEqual([]);
  });

  test("lists only production names in the advanced environment index", () => {
    const reference = readFileSync(ENV_REFERENCE, "utf8");
    const productionNames = runtimeEnvironmentNames();
    const unsupported = advancedDocumentedEnvironmentNames(reference)
      .filter((name) => !productionNames.has(name))
      .sort();

    expect(unsupported, relative(process.cwd(), ENV_REFERENCE)).toEqual([]);
  });

  test("keeps removed authorities only in the explicit rejection section", () => {
    const reference = readFileSync(ENV_REFERENCE, "utf8");
    const marker = "## Removed and rejected names";
    const markerOffset = reference.indexOf(marker);
    expect(markerOffset).toBeGreaterThan(0);

    const activeReference = reference.slice(0, markerOffset);
    const rejectedReference = reference.slice(markerOffset);
    const misplaced = [...obsoleteConfigNames()]
      .filter((name) =>
        activeReference.includes(`\`${name}\``) ||
        !rejectedReference.includes(`\`${name}\``)
      )
      .sort();

    expect(misplaced).toEqual([]);
  });
});
