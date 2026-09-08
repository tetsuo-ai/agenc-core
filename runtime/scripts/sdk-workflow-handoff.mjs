import { readFile } from "node:fs/promises";
import ts from "typescript";

const metadataKeys = new Set(["$schema", "$id", "$comment", "title"]);
const constantBindings = [
  ["AGENC_WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION", "WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION", ["properties", "format_version", "const"]],
  ["AGENC_WORKFLOW_HANDOFF_ARTIFACT_KIND", "WORKFLOW_HANDOFF_ARTIFACT_KIND", ["properties", "kind", "const"]],
  ["AGENC_WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH", "WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH", ["properties", "compatibility_epoch", "const"]],
  ["AGENC_MAX_WORKFLOW_HANDOFF_ARTIFACT_BYTES", "MAX_WORKFLOW_ARTIFACT_BYTES", ["properties", "byte_length", "maximum"]],
  ["AGENC_MAX_WORKFLOW_STEP_RESULT_TOKENS", "MAX_WORKFLOW_STEP_RESULT_TOKENS", ["properties", "token_count", "maximum"]],
  ["AGENC_MAX_WORKFLOW_STEP_PREVIEW_BYTES", "MAX_WORKFLOW_STEP_PREVIEW_BYTES", ["x-agenc-post-validation", "previewMaxUtf8Bytes"]],
  ["AGENC_MAX_WORKFLOW_HANDOFF_OWNER_FIELD_UTF8_BYTES", "MAX_WORKFLOW_ARTIFACT_OWNER_FIELD_UTF8_BYTES", ["x-agenc-post-validation", "ownerFieldMaxUtf8Bytes"]],
];

function runtimeConstants(source) {
  const parsed = ts.createSourceFile("workflow-handoff-schema.ts", source, ts.ScriptTarget.Latest, true);
  if (parsed.parseDiagnostics.length > 0) throw new Error("invalid runtime handoff source");
  const declarations = new Map();
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration.initializer);
    }
  }
  const resolving = new Set();
  const resolve = (name) => {
    const initializer = declarations.get(name);
    if (initializer === undefined || resolving.has(name)) throw new Error(`unresolved handoff authority ${name}`);
    resolving.add(name);
    try {
      return constantValue(initializer, resolve);
    } finally {
      resolving.delete(name);
    }
  };
  return resolve;
}

function constantValue(node, resolve) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node)) return resolve(node.text);
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return constantValue(node.expression, resolve);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => constantValue(element, resolve));
  if (ts.isObjectLiteralExpression(node)) return constantObject(node, resolve);
  if (node.getText() === "Number.MAX_SAFE_INTEGER") return Number.MAX_SAFE_INTEGER;
  if (ts.isCallExpression(node) && node.expression.getText() === "Object.freeze" && node.arguments.length === 1) {
    return constantValue(node.arguments[0], resolve);
  }
  throw new Error(`unsupported handoff authority expression ${node.getText()}`);
}

function constantObject(node, resolve) {
  return Object.fromEntries(node.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
      throw new Error("unsupported handoff authority property");
    }
    return [property.name.text, constantValue(property.initializer, resolve)];
  }));
}

function orderedValue(value) {
  if (Array.isArray(value)) return value.map(orderedValue);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((left, right) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    });
    return Object.fromEntries(keys.map((key) => [key, orderedValue(value[key])]));
  }
  return value;
}

function withoutMetadata(schema) {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !metadataKeys.has(key)));
}

function assertKeys(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unsupported ${label} constraint ${key}`);
  }
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
}

function validateStringSchema(schema) {
  assertKeys(schema, ["type", "pattern", "minLength", "maxLength"], "string");
  for (const key of ["minLength", "maxLength"]) {
    if (schema[key] !== undefined) safeInteger(schema[key], key);
  }
  if (schema.pattern === undefined) return undefined;
  if (typeof schema.pattern !== "string") throw new Error("string pattern must be a string");
  return new RegExp(schema.pattern, "u");
}

function validateObjectSchema(schema, depth) {
  assertKeys(schema, ["type", "properties", "required", "additionalProperties"], "object");
  if (schema.additionalProperties !== false || !Array.isArray(schema.required)) {
    throw new Error("handoff objects require explicit keys and required fields");
  }
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) throw new Error("invalid handoff properties");
  if (new Set(schema.required).size !== schema.required.length) throw new Error("duplicate required handoff field");
  for (const name of schema.required) {
    if (typeof name !== "string" || !Object.hasOwn(properties, name)) throw new Error("unknown required handoff field");
  }
  for (const [name, field] of Object.entries(properties)) {
    if (!/^[A-Za-z_]\w*$/u.test(name) || name === "__proto__") throw new Error(`unsupported handoff field ${name}`);
    validateSchema(field, depth + 1);
  }
}

function validateSchema(schema, depth = 0) {
  if (depth > 8 || schema === null || typeof schema !== "object") throw new Error("invalid handoff schema");
  if (Object.hasOwn(schema, "const")) {
    assertKeys(schema, ["const"], "literal");
    if (!["string", "boolean", "number"].includes(typeof schema.const)) throw new Error("unsupported handoff literal");
    if (typeof schema.const === "number") safeInteger(schema.const, "literal");
    return;
  }
  switch (schema.type) {
    case "object": return validateObjectSchema(schema, depth);
    case "string": return validateStringSchema(schema);
    case "boolean": return assertKeys(schema, ["type"], "boolean");
    case "integer":
      assertKeys(schema, ["type", "minimum", "maximum"], "integer");
      for (const key of ["minimum", "maximum"]) {
        if (schema[key] !== undefined) safeInteger(schema[key], key);
      }
      return;
    default: throw new Error(`unsupported handoff type ${schema.type}`);
  }
}

function validatePostValidation(post) {
  const flags = ["requireWellFormedUnicode", "storageRefMustMatchArtifactId", "committedAtMustNotPrecedeCreatedAt", "previewBytesMustMatchByteLengthAndTruncation"];
  assertKeys(post, ["ownerFieldMaxUtf8Bytes", "previewMaxUtf8Bytes", ...flags], "post-validation");
  safeInteger(post.ownerFieldMaxUtf8Bytes, "ownerFieldMaxUtf8Bytes");
  safeInteger(post.previewMaxUtf8Bytes, "previewMaxUtf8Bytes");
  for (const flag of flags) {
    if (post[flag] !== true) throw new Error(`unsupported post-validation constraint ${flag}`);
  }
}

function validateRelationshipShape(schema) {
  const dependentTypes = {
    owner: "object",
    artifact_id: "string",
    storage_ref: "string",
    created_at_ms: "integer",
    committed_at_ms: "integer",
    byte_length: "integer",
    preview: "string",
    preview_truncated: "boolean",
  };
  for (const [name, type] of Object.entries(dependentTypes)) {
    if (!schema.required.includes(name) || schema.properties[name]?.type !== type) throw new Error(`unsupported relationship field ${name}`);
  }
  if (!schema.properties.storage_ref.pattern?.startsWith("^workflow-handoff:")) throw new Error("unsupported storage reference relationship");
  for (const field of Object.values(schema.properties.owner.properties)) {
    if (field.type !== "string") throw new Error("unsupported owner field relationship");
  }
}

function renderType(schema, name) {
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.type === "integer") return "number";
  if (schema.type === "object") {
    if (name === "owner") return "WorkflowHandoffOwner";
    return `{ ${renderFields(schema).join(" ")} }`;
  }
  if (name === "digest" && schema.type === "string") {
    const prefix = schema.pattern?.match(/^\^([a-z][a-z0-9_-]*:)/u)?.[1];
    if (prefix !== undefined) return "`" + prefix + "${string}`";
  }
  return schema.type;
}

function renderFields(schema) {
  return Object.entries(schema.properties).map(([name, field]) =>
    `readonly ${name}${schema.required.includes(name) ? "" : "?"}: ${renderType(field, name)};`,
  );
}

export function renderWorkflowHandoffGenerated(schema, runtimeSource) {
  const resolve = runtimeConstants(runtimeSource);
  const authority = withoutMetadata(schema);
  if (JSON.stringify(orderedValue(authority)) !== JSON.stringify(orderedValue(withoutMetadata(resolve("WORKFLOW_HANDOFF_ARTIFACT_SCHEMA"))))) {
    throw new Error("runtime and JSON workflow handoff schemas disagree");
  }
  const { "x-agenc-post-validation": post, ...structural } = authority;
  validateSchema(structural);
  validatePostValidation(post);
  if (structural.type !== "object" || structural.properties.owner?.type !== "object") throw new Error("handoff artifact and owner must be objects");
  validateRelationshipShape(structural);
  const constants = constantBindings.map(([publicName, runtimeName, selectors]) => {
    const value = selectors.reduce((current, key) => current?.[key], schema);
    if (value === undefined || value !== resolve(runtimeName)) throw new Error(`handoff constant ${runtimeName} disagrees with JSON schema`);
    return `export const ${publicName} = ${JSON.stringify(value)} as const;`;
  });
  return [
    'import { validateHandoffStructure, validateHandoffRelationships } from "./workflow-handoff-validation.js";',
    'export { WorkflowHandoffArtifactValidationError } from "./workflow-handoff-validation.js";',
    "",
    ...constants,
    "",
    "export interface WorkflowHandoffOwner {",
    ...renderFields(structural.properties.owner).map((line) => `  ${line}`),
    "}",
    "",
    "export interface WorkflowHandoffArtifact {",
    ...renderFields(structural).map((line) => `  ${line}`),
    "}",
    "",
    `const artifactSchema = ${JSON.stringify(structural, null, 2)} as const;`,
    `const postValidation = ${JSON.stringify(post, null, 2)} as const;`,
    "",
    "export function validateWorkflowHandoffArtifact(value: unknown): WorkflowHandoffArtifact {",
    '  validateHandoffStructure(value, artifactSchema, "workflow handoff artifact");',
    "  const artifact = value as WorkflowHandoffArtifact;",
    "  validateHandoffRelationships(artifact, postValidation);",
    "  return artifact;",
    "}",
    "",
  ].join("\n");
}

export async function readWorkflowHandoffGenerated({ schemaPath, runtimeSourcePath }) {
  const [schema, runtimeSource] = await Promise.all([readFile(schemaPath, "utf8"), readFile(runtimeSourcePath, "utf8")]);
  return renderWorkflowHandoffGenerated(JSON.parse(schema), runtimeSource);
}
