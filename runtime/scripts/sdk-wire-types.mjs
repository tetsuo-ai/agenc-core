import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const PUBLIC_WIRE_ROOTS = [
  "JSON_RPC_VERSION",
  "AGENC_DAEMON_PROTOCOL_VERSION",
  "AGENC_DAEMON_METHODS",
  "AGENC_DAEMON_NOTIFICATION_METHODS",
  "AgenCDaemonRequest",
  "AgenCDaemonResultByMethod",
  "AgenCDaemonNotificationParamsByMethod",
  "AgenCDaemonErrorResponse",
  // The SDK retains an explicit compatibility adapter for old admission logs.
  "RunAdmissionJournalEvent",
];

/** Copy the public declaration closure without bundling runtime imports. */
export async function renderSdkWireTypes(
  protocolPath,
  { sourceOverrides = new Map() } = {},
) {
  const modules = new Map();
  const included = new Map();
  const names = new Map();
  const declarations = [];

  async function loadModule(filePath) {
    const cached = modules.get(filePath);
    if (cached !== undefined) return cached;
    const source = ts.createSourceFile(
      filePath,
      (
        sourceOverrides.get(filePath) ?? (await readFile(filePath, "utf8"))
      ).replace(/\r\n?/g, "\n"),
      ts.ScriptTarget.Latest,
      true,
    );
    const module = indexModuleBindings(source);
    modules.set(filePath, module);
    return module;
  }

  async function include(filePath, name) {
    const module = await loadModule(filePath);
    const imported = module.imports.get(name);
    if (imported !== undefined) {
      if (!imported.specifier.startsWith(".") || imported.name !== name) {
        throw new Error(
          `Unsupported wire type import ${name} from ${imported.specifier}`,
        );
      }
      return include(
        path.resolve(
          path.dirname(filePath),
          imported.specifier.replace(/\.js$/, ".ts"),
        ),
        imported.name,
      );
    }
    const node = module.local.get(name);
    if (node === undefined)
      throw new Error(
        `Missing canonical wire declaration ${name} in ${filePath}`,
      );
    const key = `${filePath}:${name}`;
    if (included.has(key)) return;
    const owner = names.get(name);
    if (owner !== undefined && owner !== key) {
      throw new Error(`Conflicting canonical wire declarations named ${name}`);
    }
    names.set(name, key);
    included.set(key, node);
    validateWireConstant(node, name);
    const dependencies = new Set();
    function visit(child) {
      if (
        ts.isIdentifier(child) &&
        child.text !== name &&
        (module.local.has(child.text) || module.imports.has(child.text))
      )
        dependencies.add(child.text);
      ts.forEachChild(child, visit);
    }
    ts.forEachChild(node, visit);
    for (const dependency of dependencies) await include(filePath, dependency);
    declarations.push({ node, source: module.source });
  }

  for (const name of PUBLIC_WIRE_ROOTS)
    await include(path.resolve(protocolPath), name);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const emitted = new Set();
  const body = declarations.flatMap(({ node, source }) => {
    if (emitted.has(node)) return [];
    emitted.add(node);
    return [printer.printNode(ts.EmitHint.Unspecified, node, source)];
  });
  return (
    [
      "// @generated from the daemon protocol and its referenced declarations. Do not edit.",
      "// Regenerate: npm --workspace=@tetsuo-ai/runtime run check:sdk-generated-types -- --write",
      "// Public wire types only; this module has no runtime-internal imports.",
      "",
      ...body,
      "",
      [
        "type PublicRequestForMethod<Method, Request = AgenCDaemonRequest> =",
        "  Request extends { readonly method: infer Names }",
        "    ? Method extends Names",
        '      ? { [Key in keyof Request]: Key extends "method" ? Method : Request[Key] }',
        "      : never",
        "    : never;",
        "",
        "export type AgenCDaemonRequestByMethod = {",
        "  readonly [Method in AgenCDaemonMethod]: PublicRequestForMethod<Method>;",
        "};",
      ].join("\n"),
      [
        "export type AgenCDaemonParamsByMethod = {",
        "  readonly [Method in AgenCDaemonMethod]: NonNullable<",
        '    AgenCDaemonRequestByMethod[Method]["params"]',
        "  >;",
        "};",
      ].join("\n"),
      "",
    ]
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

function indexModuleBindings(source) {
  const local = new Map();
  const imports = new Map();
  for (const node of source.statements) {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      local.set(node.name.text, node);
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          local.set(declaration.name.text, node);
      }
    } else if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const binding of node.importClause.namedBindings.elements) {
        imports.set(binding.name.text, {
          specifier: node.moduleSpecifier.text,
          name: binding.propertyName?.text ?? binding.name.text,
        });
      }
    }
  }
  return { source, local, imports };
}

function validateWireConstant(node, name) {
  if (!ts.isVariableStatement(node)) return;
  const constFlag = node.declarationList.flags & ts.NodeFlags.Const;
  if (constFlag === 0) {
    throw new Error(`Wire value ${name} must be const`);
  }
  for (const declaration of node.declarationList.declarations) {
    if (
      declaration.initializer === undefined ||
      !isStaticWireValue(declaration.initializer)
    ) {
      throw new Error(`Wire value ${name} contains executable code`);
    }
  }
}

function isStaticWireValue(node) {
  if (ts.isLiteralExpression(node) || ts.isIdentifier(node)) return true;
  if (
    [
      ts.SyntaxKind.TrueKeyword,
      ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword,
    ].includes(node.kind)
  )
    return true;
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return isStaticWireValue(node.expression);
  if (ts.isPrefixUnaryExpression(node))
    return (
      [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(
        node.operator,
      ) && isStaticWireValue(node.operand)
    );
  if (ts.isArrayLiteralExpression(node))
    return node.elements.every(isStaticWireValue);
  if (ts.isSpreadElement(node)) return isStaticWireValue(node.expression);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        isStaticWireValue(property.initializer),
    );
  }
  return false;
}
