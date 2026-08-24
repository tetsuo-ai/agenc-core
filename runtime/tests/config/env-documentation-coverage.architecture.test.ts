import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

import { DAEMON_CLIENT_ENV_SNAPSHOT_KEYS } from "../../src/app-server/client-env-snapshot.js";
import { RETIRED_CONFIG_DIR_ENV } from "../../src/config/home.js";

const RUNTIME_SOURCE = resolve(import.meta.dirname, "../../src");
const ENV_REFERENCE = resolve(import.meta.dirname, "../../../docs/reference/env.md");

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
        if (name && (/^AGENC_[A-Z0-9_]+$/u.test(name) || name === "NVIDIA_NIM")) {
          names.add(name);
        }
      }
    }
  }

  return names;
}

function obsoleteConfigNames(): Set<string> {
  const path = resolve(RUNTIME_SOURCE, "config/env.ts");
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>([RETIRED_CONFIG_DIR_ENV, "AGENC_BARE"]);

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.name.text.startsWith("OBSOLETE_")
      ) continue;
      const call = declaration.initializer;
      if (!call || !ts.isCallExpression(call)) continue;
      const object = call.arguments[0];
      if (!object || !ts.isObjectLiteralExpression(object)) continue;
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = ts.isIdentifier(property.name) ||
            ts.isStringLiteralLike(property.name)
          ? property.name.text
          : undefined;
        if (name) names.add(name);
      }
    }
  }
  return names;
}

describe("environment reference coverage", () => {
  test("documents every production env name consumed by runtime authorities", () => {
    const reference = readFileSync(ENV_REFERENCE, "utf8");
    const missing = [...runtimeEnvironmentNames()]
      .filter((name) => !reference.includes(`\`${name}\``))
      .sort();

    expect(missing, relative(process.cwd(), ENV_REFERENCE)).toEqual([]);
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
