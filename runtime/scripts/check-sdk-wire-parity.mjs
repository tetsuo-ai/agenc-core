import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Compile every public mapping, envelope and generic client call signature. */
export function checkSdkWireParity({
  root = repositoryRoot,
  sourceOverrides = new Map(),
  consumerSource = "",
} = {}) {
  const runtimeRoot = path.join(root, "runtime");
  const configFile = path.join(runtimeRoot, "tsconfig.json");
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  if (config.error !== undefined)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    runtimeRoot,
  );
  if (parsed.errors.length > 0)
    throw new Error(
      ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"),
    );
  const virtualPath = path.join(runtimeRoot, "sdk-wire-parity.check.ts");
  const protocolPath = path.join(
    runtimeRoot,
    "src/app-server/protocol/index.ts",
  );
  const protocol = ts.createSourceFile(
    protocolPath,
    sourceOverrides.get(protocolPath) ?? ts.sys.readFile(protocolPath),
    ts.ScriptTarget.Latest,
    true,
  );
  const registry = protocol.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find(
      (declaration) =>
        declaration.name.getText(protocol) === "AGENC_DAEMON_METHODS",
    );
  const array = registry?.initializer;
  if (
    array === undefined ||
    !ts.isAsExpression(array) ||
    !ts.isArrayLiteralExpression(array.expression) ||
    !array.expression.elements.every(ts.isStringLiteral)
  ) {
    throw new Error(
      "SDK wire parity requires the canonical public method registry",
    );
  }
  const methods = array.expression.elements.map((element) => element.text);
  const exact = (name, left, right) =>
    `type ${name} = {\n${methods
      .map((method) => {
        const literal = JSON.stringify(method);
        return `${literal}: Equal<${left(literal)}, ${right(literal)}>;`;
      })
      .join("\n")}\n};`;
  const source = `
import type { AgenCDaemonRequest, AgenCDaemonResultByMethod, AgenCDaemonMethod } from "./src/app-server/protocol/index.js";
import type { AgencParamsByMethod, AgencResultByMethod, AgencDaemonRequest } from "../packages/agenc-sdk/src/protocol.js";
import type { AgencClient } from "../packages/agenc-sdk/src/client.js";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false)
    : false;
type WireRequest<M extends AgenCDaemonMethod, Request = AgenCDaemonRequest> =
  Request extends { readonly method: infer Names }
    ? M extends Names
      ? { [Key in keyof Request]: Key extends "method" ? M : Request[Key] }
      : never
    : never;
type WireParams<M extends AgenCDaemonMethod> = NonNullable<WireRequest<M>["params"]>;
${exact(
  "RequestExact",
  (method) => `WireParams<${method}>`,
  (method) => `AgencParamsByMethod[${method}]`,
)}
${exact(
  "ResultExact",
  (method) => `AgenCDaemonResultByMethod[${method}]`,
  (method) => `AgencResultByMethod[${method}]`,
)}
${exact(
  "EnvelopeExact",
  (method) => `WireRequest<${method}>`,
  (method) => `AgencDaemonRequest<${method}>`,
)}
declare const client: AgencClient;
type WireArguments<M extends AgenCDaemonMethod> = WireRequest<M> extends { readonly params: unknown }
  ? [method: M, params: WireParams<M>]
  : [method: M, params?: WireParams<M>];
${exact(
  "ClientArgumentsExact",
  (method) => `WireArguments<${method}>`,
  (method) => `Parameters<typeof client.request<${method}>>`,
)}
type RequireTrue<T extends true> = T;
type RequestKeysMatch = RequireTrue<Equal<keyof AgencParamsByMethod, AgenCDaemonMethod>>;
type ResultKeysMatch = RequireTrue<Equal<keyof AgencResultByMethod, AgenCDaemonMethod>>;
type RequireAll<T extends { [M in AgenCDaemonMethod]: true }> = T;
type RequestsCovered = RequireAll<{ [M in AgenCDaemonMethod]: [WireRequest<M>] extends [never] ? false : true }>;
type RequestsMatch = RequireAll<RequestExact>;
type ResultsMatch = RequireAll<ResultExact>;
type EnvelopesMatch = RequireAll<EnvelopeExact>;
type ClientArgumentsMatch = RequireAll<ClientArgumentsExact>;
${consumerSource}
`;
  const options = {
    ...parsed.options,
    noEmit: true,
    rootDir: undefined,
    noUnusedLocals: false,
    noUnusedParameters: false,
    typeRoots: [
      path.join(root, "node_modules/@types"),
      path.join(runtimeRoot, "node_modules/@types"),
    ],
  };
  const host = ts.createCompilerHost(options);
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (filePath) => {
    if (path.resolve(filePath) === virtualPath) return source;
    return (
      sourceOverrides.get(path.resolve(filePath)) ?? originalReadFile(filePath)
    );
  };
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (filePath) =>
    path.resolve(filePath) === virtualPath || originalFileExists(filePath);
  const program = ts.createProgram(
    [
      virtualPath,
      ...parsed.fileNames.filter((fileName) => fileName.endsWith(".d.ts")),
    ],
    options,
    host,
  );
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(virtualPath);
  if (sourceFile === undefined)
    throw new Error("SDK wire parity compiler did not load its assertions");
  const mismatches = {};
  for (const name of [
    "RequestExact",
    "ResultExact",
    "EnvelopeExact",
    "ClientArgumentsExact",
  ]) {
    const declaration = sourceFile.statements.find(
      (node) => ts.isTypeAliasDeclaration(node) && node.name.text === name,
    );
    const properties = checker.getTypeAtLocation(declaration).getProperties();
    if (properties.length === 0)
      throw new Error(`SDK wire parity found no methods for ${name}`);
    mismatches[name] = properties
      .filter(
        (property) =>
          checker.typeToString(
            checker.getTypeOfSymbolAtLocation(property, declaration),
          ) !== "true",
      )
      .map((property) => property.name);
  }
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ({
      file:
        diagnostic.file === undefined
          ? null
          : path
              .relative(root, diagnostic.file.fileName)
              .split(path.sep)
              .join("/"),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
  return {
    matches:
      diagnostics.length === 0 &&
      Object.values(mismatches).every((list) => list.length === 0),
    mismatches,
    diagnostics,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = checkSdkWireParity();
  if (!result.matches) {
    for (const [surface, methods] of Object.entries(result.mismatches)) {
      if (methods.length > 0)
        process.stderr.write(
          `[sdk wire parity] ${surface}: ${methods.join(", ")}\n`,
        );
    }
    for (const diagnostic of result.diagnostics.slice(0, 10)) {
      process.stderr.write(
        `[sdk wire parity] ${diagnostic.file ?? "compiler"}: ${diagnostic.message}\n`,
      );
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(
      "[sdk wire parity] all public request, result, envelope and client argument types match\n",
    );
  }
}
