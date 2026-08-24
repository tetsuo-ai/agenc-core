import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, test } from "vitest";

const RUNTIME_SOURCE = resolve(import.meta.dirname, "../../src");
const ENV_REFERENCE = resolve(
  import.meta.dirname,
  "../../../docs/reference/env.md",
);

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

function isProcessEnv(node: ts.Node, source: ts.SourceFile): boolean {
  return node.getText(source) === "process.env";
}

function bindingPropertyName(
  element: ts.BindingElement,
): string | undefined {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? name.text
    : undefined;
}

function directProcessEnvironmentNames(): readonly string[] {
  const names = new Set<string>();

  for (const path of sourceFiles(RUNTIME_SOURCE)) {
    const text = readFileSync(path, "utf8");
    // Some supervised helpers embed a child program in a template literal.
    // Scan the source text as well as the host AST so those real child-process
    // inputs cannot evade the documentation contract.
    for (const match of text.matchAll(
      /\bprocess\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[["']([A-Za-z_][A-Za-z0-9_]*)["']\])/gu,
    )) {
      const name = match[1] ?? match[2];
      if (name !== undefined) names.add(name);
    }
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        isProcessEnv(node.expression, source)
      ) {
        names.add(node.name.text);
      } else if (
        ts.isElementAccessExpression(node) &&
        isProcessEnv(node.expression, source) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        names.add(node.argumentExpression.text);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isProcessEnv(node.initializer, source)
      ) {
        for (const element of node.name.elements) {
          const name = bindingPropertyName(element);
          if (name !== undefined) names.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return [...names].sort();
}

describe("direct environment documentation", () => {
  test("documents every statically named process.env input", () => {
    const reference = readFileSync(ENV_REFERENCE, "utf8");
    const missing = directProcessEnvironmentNames().filter(
      (name) => !reference.includes(`\`${name}\``),
    );

    expect(
      missing,
      `${relative(process.cwd(), ENV_REFERENCE)} is missing direct environment inputs:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
