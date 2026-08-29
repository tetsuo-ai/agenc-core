import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = join(HERE, "../..");
const REPO_ROOT = join(RUNTIME_ROOT, "..");
const SCHEMA_PATH = join(RUNTIME_ROOT, "src/config/schema.ts");
const AUTO_FIX_PATH = join(RUNTIME_ROOT, "src/services/autoFix/autoFixConfig.ts");
const REFERENCE_PATH = join(REPO_ROOT, "docs/reference/config.md");

type NamedDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

function declarationMap(): ReadonlyMap<string, NamedDeclaration> {
  const declarations = new Map<string, NamedDeclaration>();
  for (const path of [SCHEMA_PATH, AUTO_FIX_PATH]) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        declarations.set(statement.name.text, statement);
      }
    }
  }
  return declarations;
}

function propertyName(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

const RECORD_SEGMENTS: Readonly<Record<string, string>> = Object.freeze({
  profiles: "<profile>",
  providers: "<provider>",
  tools_config: "<tool>",
  hooks: "<event>",
  mcp_servers: "<server>",
  lsp_servers: "<server>",
  "plugins.plugins": "<plugin>",
  pluginConfigs: "<plugin>",
  "pluginConfigs.<plugin>.mcpServers": "<server>",
  modelOverrides: "<model>",
});

function recordSegment(path: string): string {
  return RECORD_SEGMENTS[path] ?? "<name>";
}

function collectTypePaths(
  type: ts.TypeNode,
  path: string,
  declarations: ReadonlyMap<string, NamedDeclaration>,
  paths: Set<string>,
  stack: ReadonlySet<string>,
): void {
  if (ts.isParenthesizedTypeNode(type)) {
    collectTypePaths(type.type, path, declarations, paths, stack);
    return;
  }
  if (ts.isTypeOperatorNode(type)) {
    collectTypePaths(type.type, path, declarations, paths, stack);
    return;
  }
  if (ts.isUnionTypeNode(type)) {
    for (const member of type.types) {
      if (member.kind !== ts.SyntaxKind.UndefinedKeyword) {
        collectTypePaths(member, path, declarations, paths, stack);
      }
    }
    return;
  }
  if (ts.isArrayTypeNode(type)) {
    collectTypePaths(type.elementType, `${path}[]`, declarations, paths, stack);
    return;
  }
  if (ts.isTypeLiteralNode(type)) {
    collectMembers(type.members, path, declarations, paths, stack);
    return;
  }
  if (!ts.isTypeReferenceNode(type)) return;

  const name = type.typeName.getText();
  const args = type.typeArguments ?? [];
  if (name === "Readonly" || name === "Partial") {
    if (args[0]) collectTypePaths(args[0], path, declarations, paths, stack);
    return;
  }
  if (name === "ReadonlyArray" || name === "Array") {
    if (args[0]) collectTypePaths(args[0], `${path}[]`, declarations, paths, stack);
    return;
  }
  if (name === "Record") {
    const wildcardPath = `${path}.${recordSegment(path)}`;
    paths.add(wildcardPath);
    if (args[1]) collectTypePaths(args[1], wildcardPath, declarations, paths, stack);
    return;
  }

  const declaration = declarations.get(name);
  if (!declaration || stack.has(name)) return;
  const nextStack = new Set(stack).add(name);
  if (ts.isInterfaceDeclaration(declaration)) {
    collectMembers(declaration.members, path, declarations, paths, nextStack);
  } else {
    collectTypePaths(declaration.type, path, declarations, paths, nextStack);
  }
}

function collectMembers(
  members: ts.NodeArray<ts.TypeElement>,
  parent: string,
  declarations: ReadonlyMap<string, NamedDeclaration>,
  paths: Set<string>,
  stack: ReadonlySet<string>,
): void {
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const name = propertyName(member.name);
    if (name === null) continue;
    const diskName = parent.length === 0 && name === "configVersion"
      ? "config_version"
      : name;
    if (parent.length === 0 && diskName === "_unknown") continue;
    const path = parent.length === 0 ? diskName : `${parent}.${diskName}`;
    paths.add(path);
    collectTypePaths(member.type, path, declarations, paths, stack);
  }
}

function canonicalConfigPaths(): readonly string[] {
  const declarations = declarationMap();
  const root = declarations.get("AgenCConfig");
  if (!root || !ts.isInterfaceDeclaration(root)) {
    throw new Error("AgenCConfig interface not found");
  }
  const paths = new Set<string>();
  collectMembers(root.members, "", declarations, paths, new Set(["AgenCConfig"]));
  return [...paths].sort();
}

describe("config reference coverage", () => {
  test("documents every canonical schema-v2 path", () => {
    const reference = readFileSync(REFERENCE_PATH, "utf8");
    const missing = canonicalConfigPaths().filter(
      (path) => !reference.includes(`\`${path}\``),
    );
    expect(missing, `undocumented canonical config paths:\n${missing.join("\n")}`).toEqual([]);
  });

  test("labels the normalization side table as migration-only", () => {
    const reference = readFileSync(REFERENCE_PATH, "utf8");
    expect(reference).toMatch(/migration-only[^\n]*`_unknown`|`_unknown`[^\n]*migration-only/iu);
    expect(reference).toContain("Removed operator `settings.json` files are migration inputs only");
  });
});
