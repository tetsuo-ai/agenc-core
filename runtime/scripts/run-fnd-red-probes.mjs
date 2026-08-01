#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { getNodeValue, parseTree, printParseErrorCode } from "jsonc-parser";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNamedImports,
  isPropertyAccessExpression,
  isStringLiteralLike,
  ScriptTarget,
  SyntaxKind,
} from "typescript";

import { runSupervisedProcess } from "../src/utils/supervisedProcess.ts";

import {
  createHermeticLaunchEnv,
  createHermeticRunRoot,
  sanitizeHermeticEnv,
} from "../tests/helpers/hermetic-env.mjs";

export const RED_PROBE_PROTOCOL_VERSION = 1;
export const RED_PROBE_EXPECTED_EXIT_CODE = 86;
export const RED_PROBE_PROTOCOL_PREFIX = "AGENC_RED_PROBE_V1 ";
export const RED_PROBE_HEARTBEAT_PREFIX = "AGENC_RED_PROBE_HEARTBEAT_V1 ";

const MANIFEST_SCHEMA_VERSION = 1;
const AUDIT_SHA = "d2b228e87ea63bd6a5d93e6f599f36bce88d672b";
const MANIFEST_FILENAME = "manifest.json";
const RED_PROBE_SUFFIX = ".red-probe.ts";
const RED_PROBE_DIRECTORY = "tests/fnd/red-probes";
const MINIMUM_TIMEOUT_MS = 100;
const MAXIMUM_TIMEOUT_MS = 30_000;
const MAXIMUM_MANIFEST_BYTES = 65_536;
const MAXIMUM_PROBE_BYTES = 65_536;
const MAXIMUM_BOOTSTRAP_BYTES = 65_536;
const MAXIMUM_HELPER_BYTES = 65_536;
const MAXIMUM_CHILD_OUTPUT_BYTES = 16_384;
const RED_PROBE_AUTHENTICATION_SECRET_BYTES = 32;
const RED_PROBE_HANDOFF_MAGIC = Buffer.from(
  "AGENC_RED_PROBE_HANDOFF_V1\0",
  "ascii",
);
const MAXIMUM_HANDOFF_BYTES =
  RED_PROBE_HANDOFF_MAGIC.byteLength +
  RED_PROBE_AUTHENTICATION_SECRET_BYTES +
  MAXIMUM_PROBE_BYTES;
const MAXIMUM_ID_CHARACTERS = 64;
const MAXIMUM_PROBE_COUNT = 256;
const MAXIMUM_INVENTORY_DIRECTORIES = 64;
const MAXIMUM_INVENTORY_DEPTH = 16;
const MAXIMUM_INVENTORY_ENTRIES =
  MAXIMUM_PROBE_COUNT + MAXIMUM_INVENTORY_DIRECTORIES + 1;
const MAXIMUM_INVENTORY_PATH_BYTES = 64 * 1024;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 16_384;
const MAXIMUM_SOURCE_AST_DEPTH = 128;
const MAXIMUM_SOURCE_AST_NODES = 32_768;
const WINDOWS_CREATE_PROCESS_MAXIMUM_CODE_UNITS = 32_767;
const WINDOWS_LAUNCH_HEADROOM_CODE_UNITS = 8_192;
export const WINDOWS_PORTABLE_LAUNCH_MAXIMUM_CODE_UNITS =
  WINDOWS_CREATE_PROCESS_MAXIMUM_CODE_UNITS -
  WINDOWS_LAUNCH_HEADROOM_CODE_UNITS;
const WINDOWS_COMMAND_LINE_TERMINATOR_CODE_UNITS = 1;
const WINDOWS_ENVIRONMENT_BLOCK_FINAL_TERMINATOR_CODE_UNITS = 1;
const SUPPORT_SOURCE_COMPRESSION_LEVEL = 9;
const STDIN_MODULE_FILENAME = "[eval1].ts";
const RED_PROBE_HEARTBEAT_INTERVAL_MS = 1_000;
const RED_PROBE_HEARTBEAT_SILENCE_MS = 5_000;
const SUPERVISOR_SETTLEMENT_KEEPALIVE_INTERVAL_MS = 1_000;
const MINIMUM_TEST_HEARTBEAT_SILENCE_MS = 50;
const TERMINATE_GRACE_MS = 500;
const SETTLE_BACKSTOP_MS = 2_000;
const PROTOCOL_OUTCOME = "expected-red";
const HEARTBEAT_PROTOCOL_OUTCOME = "heartbeat";
const FINAL_AUTHENTICATION_DOMAIN = "AGENC_RED_PROBE_FINAL_V1\0";
const BOOTSTRAP_ENVIRONMENT_VARIABLE = "AGENC_RED_PROBE_BOOTSTRAP_V1";
const FINGERPRINT_PATTERN = /^[A-Z0-9][A-Z0-9._:/-]{0,127}$/u;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SOURCE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RED_PROBE_AUTHENTICATION_TAG_PATTERN = /^[0-9a-f]{64}$/u;
export const RED_PROBE_TASK_IDS = Object.freeze([
  "FND-001",
  "A1",
  "A2a",
  "A2b",
  "A3",
  "A4",
  "B1",
  "B2",
  "B3a",
  "B3b",
  "C1",
  "C2",
  "C3a",
  "C3b",
  "D1",
  "D2",
  "D3",
  "E1a",
  "E1b",
  "E2",
  "E3",
]);
const RED_PROBE_TASK_ID_SET = new Set(RED_PROBE_TASK_IDS);
const ALLOWED_CLASSIFICATIONS = new Set(["harness-self-test", "defect"]);
const MANIFEST_KEYS = Object.freeze([
  "auditSha",
  "probeCount",
  "probes",
  "schemaVersion",
]);
const PROBE_KEYS = Object.freeze([
  "classification",
  "file",
  "fingerprint",
  "id",
  "sourceSha256",
  "task",
  "timeoutMs",
]);
const FORBIDDEN_TEST_METHODS = new Set([
  "fails",
  "only",
  "runIf",
  "skip",
  "skipIf",
  "todo",
]);
const FORBIDDEN_GLOBAL_IDENTIFIERS = new Set([
  "Function",
  "arguments",
  "console",
  "eval",
  "global",
  "globalThis",
  "process",
  "require",
]);
const RED_PROBE_HELPER_PATH = "tests/helpers/red-probe.js";
const RED_PROBE_HELPER_SOURCE_PATH = "tests/helpers/red-probe.ts";
const RED_PROBE_BOOTSTRAP_PATH = "tests/helpers/red-probe-bootstrap.mjs";
const RED_PROBE_HELPER_FUNCTION = "expectDeepStrictEqualRedProbe";
const RED_PROBE_HELPER_TYPE = "RedProbeAssertion";
const RED_PROBE_RUNNER_FUNCTION = "runRedProbe";
const RED_PROBE_BOOTSTRAP_SHA256 =
  "7b386f69325f0c8d80c5667663bad34a74d9e18fad80ad355ac17a4a4323cd54";
const RED_PROBE_HELPER_SHA256 =
  "289471c65f3852d56e5c40ed95883697f8145b2e471b3eb0aab06660d1c1232a";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRuntimeRoot = resolve(moduleDirectory, "..");
const tsxLoader = resolve(
  defaultRuntimeRoot,
  "../node_modules/tsx/dist/loader.mjs",
);
const networkTripwire = resolve(
  defaultRuntimeRoot,
  "tests/helpers/network-tripwire.cjs",
);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
}

function isContainedPath(parent, child) {
  const childRelative = relative(parent, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith("..") && !isAbsolute(childRelative))
  );
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileMetadata(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertSingleRegularFile(metadata, label) {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1n
  ) {
    throw new Error(`${label} is not one single-link regular file`);
  }
}

function readBoundedRegularFile(path, maximumBytes, label, afterOpenForTest) {
  const beforePath = lstatSync(path, { bigint: true });
  assertSingleRegularFile(beforePath, label);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error(`${label} could not be opened without following links`, {
      cause: error,
    });
  }

  try {
    const beforeDescriptor = fstatSync(descriptor, { bigint: true });
    assertSingleRegularFile(beforeDescriptor, label);
    if (!sameFileIdentity(beforePath, beforeDescriptor)) {
      throw new Error(`${label} changed identity while it was opened`);
    }
    if (beforeDescriptor.size > BigInt(maximumBytes)) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    }

    afterOpenForTest?.(Object.freeze({ label, path }));

    const bytes = Buffer.allocUnsafe(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    }

    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    assertSingleRegularFile(afterDescriptor, label);
    assertSingleRegularFile(afterPath, label);
    if (
      !sameStableFileMetadata(beforeDescriptor, afterDescriptor) ||
      !sameStableFileMetadata(afterDescriptor, afterPath) ||
      afterDescriptor.size !== BigInt(bytesRead)
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function readVerifiedSupportFile(
  runtimeRoot,
  relativePath,
  maximumBytes,
  expectedDigest,
  label,
) {
  const path = resolve(runtimeRoot, relativePath);
  const bytes = readBoundedRegularFile(path, maximumBytes, label);
  if (sha256(bytes) !== expectedDigest) {
    throw new Error(`${label} digest does not match the reviewed source`);
  }
  return bytes;
}

function encodeDeflatedSource(bytes) {
  return deflateRawSync(bytes, {
    level: SUPPORT_SOURCE_COMPRESSION_LEVEL,
  }).toString("base64");
}

function createVerifiedBootstrapImportUrl(bytes, expectedDigest) {
  const deflatedSource = encodeDeflatedSource(bytes);
  const wrapper = [
    'import { Buffer as B } from "node:buffer";',
    'import { createHash as H } from "node:crypto";',
    'import { inflateRawSync as I } from "node:zlib";',
    `const s=I(B.from(${JSON.stringify(deflatedSource)},"base64"),{maxOutputLength:${MAXIMUM_BOOTSTRAP_BYTES}});`,
    `if(H("sha256").update(s).digest("hex")!==${JSON.stringify(expectedDigest)})throw new Error("red-probe bootstrap transport digest does not match");`,
    'await import("data:text/javascript;base64,"+s.toString("base64"));',
  ].join("");
  return `data:text/javascript;base64,${Buffer.from(wrapper, "utf8").toString("base64")}`;
}

function loadRedProbeSupportGraph(runtimeRoot) {
  const bootstrapBytes = readVerifiedSupportFile(
    runtimeRoot,
    RED_PROBE_BOOTSTRAP_PATH,
    MAXIMUM_BOOTSTRAP_BYTES,
    RED_PROBE_BOOTSTRAP_SHA256,
    "red-probe bootstrap",
  );
  const helperBytes = readVerifiedSupportFile(
    runtimeRoot,
    RED_PROBE_HELPER_SOURCE_PATH,
    MAXIMUM_HELPER_BYTES,
    RED_PROBE_HELPER_SHA256,
    "red-probe helper",
  );
  return Object.freeze({
    bootstrapImportUrl: createVerifiedBootstrapImportUrl(
      bootstrapBytes,
      RED_PROBE_BOOTSTRAP_SHA256,
    ),
    helperRequestUrl: pathToFileURL(resolve(runtimeRoot, RED_PROBE_HELPER_PATH))
      .href,
    helperSourceDeflateBase64: encodeDeflatedSource(helperBytes),
    helperSourceSha256: RED_PROBE_HELPER_SHA256,
    helperSourceUrl: pathToFileURL(
      resolve(runtimeRoot, RED_PROBE_HELPER_SOURCE_PATH),
    ).href,
    networkTripwireUrl: pathToFileURL(networkTripwire).href,
    tsxLoaderUrl: pathToFileURL(tsxLoader).href,
  });
}

function assertBoundedJsonTree(root, label) {
  const pending = [{ depth: 1, node: root }];
  let visitedNodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visitedNodes += 1;
    if (visitedNodes > MAXIMUM_JSON_NODES) {
      throw new Error(`${label} exceeds the ${MAXIMUM_JSON_NODES}-node limit`);
    }
    if (current.depth > MAXIMUM_JSON_DEPTH) {
      throw new Error(`${label} exceeds the ${MAXIMUM_JSON_DEPTH}-level limit`);
    }

    const children = current.node.children ?? [];
    if (current.node.type === "object") {
      const keys = new Set();
      for (const property of children) {
        const keyNode = property.children?.[0];
        const key = keyNode?.value;
        if (typeof key !== "string") {
          throw new Error(`${label} contains a malformed object key`);
        }
        if (keys.has(key)) {
          throw new Error(
            `${label} contains duplicate object key ${JSON.stringify(key)}`,
          );
        }
        keys.add(key);
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ depth: current.depth + 1, node: children[index] });
    }
  }
}

function parseStrictJson(bytes, label) {
  const source = decodeUtf8(bytes, label);
  const errors = [];
  const tree = parseTree(source, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (tree === undefined || errors.length > 0) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)}@${error.offset}`)
      .join(", ");
    throw new Error(
      `${label} is not strict JSON${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  assertBoundedJsonTree(tree, label);
  return getNodeValue(tree);
}

function validateProbeEntry(value, index) {
  const label = `red-probe manifest entry ${index}`;
  if (!hasExactKeys(value, PROBE_KEYS)) {
    throw new Error(`${label} does not match the exact schema`);
  }
  if (
    typeof value.id !== "string" ||
    value.id.length > MAXIMUM_ID_CHARACTERS ||
    !ID_PATTERN.test(value.id)
  ) {
    throw new Error(`${label} has a noncanonical id`);
  }
  if (!ALLOWED_CLASSIFICATIONS.has(value.classification)) {
    throw new Error(`${label} has an unsupported classification`);
  }
  if (
    typeof value.task !== "string" ||
    !RED_PROBE_TASK_ID_SET.has(value.task)
  ) {
    throw new Error(`${label} has a noncanonical task`);
  }
  if (
    typeof value.sourceSha256 !== "string" ||
    !SOURCE_SHA256_PATTERN.test(value.sourceSha256)
  ) {
    throw new Error(`${label} has a noncanonical sourceSha256`);
  }
  if (
    typeof value.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(value.fingerprint)
  ) {
    throw new Error(`${label} has a noncanonical fingerprint`);
  }
  if (
    typeof value.timeoutMs !== "number" ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < MINIMUM_TIMEOUT_MS ||
    value.timeoutMs > MAXIMUM_TIMEOUT_MS
  ) {
    throw new Error(`${label} has an invalid timeoutMs`);
  }
  if (typeof value.file !== "string" || value.file.includes("\\")) {
    throw new Error(`${label} has a noncanonical file path`);
  }
  if (
    value.file !== posix.normalize(value.file) ||
    !value.file.startsWith(`${RED_PROBE_DIRECTORY}/`) ||
    !value.file.endsWith(RED_PROBE_SUFFIX)
  ) {
    throw new Error(`${label} has a noncanonical file path`);
  }
  return Object.freeze({ ...value });
}

export function loadRedProbeManifest(runtimeRoot = defaultRuntimeRoot) {
  const manifestPath = resolve(
    runtimeRoot,
    RED_PROBE_DIRECTORY,
    MANIFEST_FILENAME,
  );
  const bytes = readBoundedRegularFile(
    manifestPath,
    MAXIMUM_MANIFEST_BYTES,
    "red-probe manifest",
  );
  const parsed = parseStrictJson(bytes, "red-probe manifest");
  if (!hasExactKeys(parsed, MANIFEST_KEYS)) {
    throw new Error("red-probe manifest does not match the exact schema");
  }
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `unsupported red-probe manifest schema ${String(parsed.schemaVersion)}`,
    );
  }
  if (parsed.auditSha !== AUDIT_SHA) {
    throw new Error(`red-probe manifest auditSha must equal ${AUDIT_SHA}`);
  }
  if (
    !Number.isSafeInteger(parsed.probeCount) ||
    parsed.probeCount < 1 ||
    parsed.probeCount > MAXIMUM_PROBE_COUNT ||
    !Array.isArray(parsed.probes) ||
    parsed.probes.length !== parsed.probeCount
  ) {
    throw new Error(
      "red-probe manifest must declare a nonempty exact probe count",
    );
  }

  const probes = parsed.probes.map(validateProbeEntry);
  for (const [field, values] of [
    ["id", probes.map((probe) => probe.id)],
    ["file", probes.map((probe) => probe.file)],
    ["fingerprint", probes.map((probe) => probe.fingerprint)],
  ]) {
    if (new Set(values).size !== values.length) {
      throw new Error(`red-probe manifest contains duplicate ${field}`);
    }
  }
  const canonicalIds = probes.map((probe) => probe.id).sort();
  if (probes.some((probe, index) => probe.id !== canonicalIds[index])) {
    throw new Error("red-probe manifest entries are not in canonical id order");
  }
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    auditSha: AUDIT_SHA,
    probeCount: probes.length,
    probes: Object.freeze(probes),
  });
}

function walkProbeDirectory(probeRoot, runtimeRoot) {
  const discovered = [];
  const pendingDirectories = [{ depth: 0, path: probeRoot }];
  let directoryCount = 1;
  let entryCount = 0;
  let pathBytes = 0;

  while (pendingDirectories.length > 0) {
    const current = pendingDirectories.pop();
    const directory = opendirSync(current.path);
    try {
      for (
        let entry = directory.readSync();
        entry;
        entry = directory.readSync()
      ) {
        entryCount += 1;
        if (entryCount > MAXIMUM_INVENTORY_ENTRIES) {
          throw new Error(
            `red-probe inventory exceeds the ${MAXIMUM_INVENTORY_ENTRIES}-entry limit`,
          );
        }

        const path = resolve(current.path, entry.name);
        const file = relative(runtimeRoot, path).split("\\").join("/");
        pathBytes += Buffer.byteLength(file, "utf8");
        if (pathBytes > MAXIMUM_INVENTORY_PATH_BYTES) {
          throw new Error(
            `red-probe inventory exceeds the ${MAXIMUM_INVENTORY_PATH_BYTES}-byte path limit`,
          );
        }
        if (entry.isSymbolicLink()) {
          throw new Error(
            `red-probe inventory contains a symbolic link: ${file}`,
          );
        }
        if (entry.isDirectory()) {
          const depth = current.depth + 1;
          directoryCount += 1;
          if (depth > MAXIMUM_INVENTORY_DEPTH) {
            throw new Error(
              `red-probe inventory exceeds the ${MAXIMUM_INVENTORY_DEPTH}-level directory limit`,
            );
          }
          if (directoryCount > MAXIMUM_INVENTORY_DIRECTORIES) {
            throw new Error(
              `red-probe inventory exceeds the ${MAXIMUM_INVENTORY_DIRECTORIES}-directory limit`,
            );
          }
          pendingDirectories.push({ depth, path });
          continue;
        }
        if (!entry.isFile()) {
          throw new Error(`red-probe inventory contains a non-file: ${file}`);
        }
        if (file === `${RED_PROBE_DIRECTORY}/${MANIFEST_FILENAME}`) continue;
        if (!file.endsWith(RED_PROBE_SUFFIX)) {
          throw new Error(
            `red-probe inventory contains an unsupported file: ${file}`,
          );
        }
        discovered.push(file);
      }
    } finally {
      directory.closeSync();
    }
  }
  return discovered;
}

export function discoverRedProbeFiles(runtimeRoot = defaultRuntimeRoot) {
  const probeRoot = resolve(runtimeRoot, RED_PROBE_DIRECTORY);
  const probeRootStat = lstatSync(probeRoot);
  if (probeRootStat.isSymbolicLink() || !probeRootStat.isDirectory()) {
    throw new Error("red-probe root is not a regular directory");
  }
  return walkProbeDirectory(probeRoot, runtimeRoot).sort();
}

function assertExactInventory(manifest, discovered) {
  if (discovered.length < 1) {
    throw new Error("red-probe discovery was empty");
  }
  const registered = manifest.probes.map((probe) => probe.file).sort();
  if (JSON.stringify(discovered) !== JSON.stringify(registered)) {
    throw new Error(
      `red-probe inventory mismatch: discovered=${JSON.stringify(discovered)} registered=${JSON.stringify(registered)}`,
    );
  }
}

function assertProbePath(runtimeRoot, file) {
  const probeRoot = resolve(runtimeRoot, RED_PROBE_DIRECTORY);
  const path = resolve(runtimeRoot, file);
  if (!isContainedPath(probeRoot, path)) {
    throw new Error(`red-probe path escapes its root: ${file}`);
  }
  const realProbeRoot = realpathSync(probeRoot);
  const realPath = realpathSync(path);
  if (!isContainedPath(realProbeRoot, realPath)) {
    throw new Error(`red-probe real path escapes its root: ${file}`);
  }
  return path;
}

function isForbiddenTestModule(moduleName) {
  return (
    moduleName === "bun:test" ||
    moduleName === "jest" ||
    moduleName === "node:test" ||
    moduleName.startsWith("node:test/") ||
    moduleName === "vitest" ||
    moduleName.startsWith("vitest/") ||
    moduleName === "@jest/globals" ||
    moduleName.startsWith("@vitest/")
  );
}

function isProcessModule(moduleName) {
  return moduleName === "node:process" || moduleName === "process";
}

function canonicalHelperSpecifier(file) {
  const helper = posix.relative(posix.dirname(file), RED_PROBE_HELPER_PATH);
  return helper.startsWith(".") ? helper : `./${helper}`;
}

function importModuleName(node) {
  return isStringLiteralLike(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : undefined;
}

function assertCanonicalHelperTypeImport(node, expectedSpecifier, file) {
  const clause = node.importClause;
  const bindings = clause?.namedBindings;
  if (
    clause === undefined ||
    !clause.isTypeOnly ||
    clause.name !== undefined ||
    !isNamedImports(bindings) ||
    bindings.elements.length !== 1
  ) {
    throw new Error(`${file} has a noncanonical red-probe helper import`);
  }
  const [specifier] = bindings.elements;
  if (
    specifier.isTypeOnly ||
    specifier.propertyName !== undefined ||
    specifier.name.text !== RED_PROBE_HELPER_TYPE ||
    importModuleName(node) !== expectedSpecifier
  ) {
    throw new Error(`${file} has a noncanonical red-probe helper import`);
  }
}

function importedBindingName(specifier) {
  return specifier.propertyName?.text ?? specifier.name.text;
}

function assertProbeSourcePolicy(source, file) {
  const sourceFile = createSourceFile(file, source, ScriptTarget.Latest, true);
  if ((sourceFile.parseDiagnostics ?? []).length > 0) {
    throw new Error(`${file} contains invalid TypeScript syntax`);
  }

  const expectedHelperSpecifier = canonicalHelperSpecifier(file);
  const rootRunners = sourceFile.statements.filter(
    (statement) =>
      isFunctionDeclaration(statement) &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === SyntaxKind.ExportKeyword,
      ) === true &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === SyntaxKind.DefaultKeyword,
      ) === true,
  );
  if (rootRunners.length !== 1) {
    throw new Error(`${file} must export one canonical root runner`);
  }
  const [rootRunner] = rootRunners;
  const runnerModifiers = rootRunner.modifiers?.map(
    (modifier) => modifier.kind,
  );
  const expectedRunnerModifiers = [
    SyntaxKind.ExportKeyword,
    SyntaxKind.DefaultKeyword,
    SyntaxKind.AsyncKeyword,
  ];
  const [runnerParameter] = rootRunner.parameters;
  if (
    rootRunner.name?.text !== RED_PROBE_RUNNER_FUNCTION ||
    JSON.stringify(runnerModifiers) !==
      JSON.stringify(expectedRunnerModifiers) ||
    rootRunner.parameters.length !== 1 ||
    runnerParameter === undefined ||
    !isIdentifier(runnerParameter.name) ||
    runnerParameter.name.text !== RED_PROBE_HELPER_FUNCTION ||
    runnerParameter.dotDotDotToken !== undefined ||
    runnerParameter.questionToken !== undefined ||
    runnerParameter.initializer !== undefined ||
    rootRunner.body === undefined
  ) {
    throw new Error(`${file} has a noncanonical root runner`);
  }

  let canonicalHelperTypeImports = 0;
  let helperAssertionCalls = 0;
  let rootHelperAssertionCalls = 0;

  const inspectNode = (node) => {
    if (isImportEqualsDeclaration(node)) {
      throw new Error(`${file} uses forbidden import-equals loading`);
    }
    if (isImportDeclaration(node)) {
      const moduleName = importModuleName(node);
      if (moduleName !== undefined && isForbiddenTestModule(moduleName)) {
        throw new Error(`${file} imports a test framework`);
      }
      if (moduleName !== undefined && isProcessModule(moduleName)) {
        throw new Error(`${file} imports process access`);
      }
      if (moduleName === expectedHelperSpecifier) {
        assertCanonicalHelperTypeImport(node, expectedHelperSpecifier, file);
        canonicalHelperTypeImports += 1;
      } else if (
        node.importClause?.namedBindings !== undefined &&
        isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(
          (specifier) =>
            importedBindingName(specifier) === RED_PROBE_HELPER_FUNCTION ||
            importedBindingName(specifier) === RED_PROBE_HELPER_TYPE,
        )
      ) {
        throw new Error(`${file} imports the red-probe helper noncanonically`);
      }
    }

    if (isIdentifier(node)) {
      if (FORBIDDEN_GLOBAL_IDENTIFIERS.has(node.text)) {
        throw new Error(`${file} uses forbidden global access ${node.text}`);
      }
      if (FORBIDDEN_TEST_METHODS.has(node.text)) {
        throw new Error(`${file} uses forbidden test control ${node.text}`);
      }
      if (node.text === RED_PROBE_HELPER_FUNCTION) {
        if (
          node.parent?.kind === SyntaxKind.ImportSpecifier ||
          (node.parent?.kind === SyntaxKind.Parameter &&
            runnerParameter.name === node) ||
          (isCallExpression(node.parent) && node.parent.expression === node)
        ) {
          // The exact import and direct call are validated separately.
        } else {
          throw new Error(`${file} aliases the red-probe assertion helper`);
        }
      }
    }

    if (
      isStringLiteralLike(node) &&
      isElementAccessExpression(node.parent) &&
      node.parent.argumentExpression === node &&
      FORBIDDEN_TEST_METHODS.has(node.text)
    ) {
      throw new Error(`${file} uses forbidden test control ${node.text}`);
    }

    if (isCallExpression(node)) {
      const expression = node.expression;
      if (expression.kind === SyntaxKind.ImportKeyword) {
        throw new Error(`${file} uses forbidden dynamic import`);
      }
      if (isIdentifier(expression) && expression.text === "require") {
        throw new Error(`${file} uses forbidden require loading`);
      }
      if (
        isPropertyAccessExpression(expression) &&
        FORBIDDEN_TEST_METHODS.has(expression.name.text)
      ) {
        throw new Error(
          `${file} uses forbidden test control ${expression.name.text}`,
        );
      }
      if (
        isElementAccessExpression(expression) &&
        isStringLiteralLike(expression.argumentExpression) &&
        FORBIDDEN_TEST_METHODS.has(expression.argumentExpression.text)
      ) {
        throw new Error(
          `${file} uses forbidden test control ${expression.argumentExpression.text}`,
        );
      }
      if (
        isIdentifier(expression) &&
        expression.text === RED_PROBE_HELPER_FUNCTION
      ) {
        helperAssertionCalls += 1;
        if (
          node.arguments.length !== 3 ||
          !isExpressionStatement(node.parent) ||
          node.parent.parent !== rootRunner.body
        ) {
          throw new Error(
            `${file} must make one direct root-runner red-probe assertion`,
          );
        }
        rootHelperAssertionCalls += 1;
      }
    }
  };

  const pending = [{ depth: 1, node: sourceFile }];
  let visitedNodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visitedNodes += 1;
    if (visitedNodes > MAXIMUM_SOURCE_AST_NODES) {
      throw new Error(
        `${file} exceeds the ${MAXIMUM_SOURCE_AST_NODES}-node source-policy limit`,
      );
    }
    if (current.depth > MAXIMUM_SOURCE_AST_DEPTH) {
      throw new Error(
        `${file} exceeds the ${MAXIMUM_SOURCE_AST_DEPTH}-level source-policy limit`,
      );
    }
    inspectNode(current.node);
    const children = [];
    forEachChild(current.node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ depth: current.depth + 1, node: children[index] });
    }
  }

  if (canonicalHelperTypeImports !== 1) {
    throw new Error(
      `${file} must import the canonical red-probe helper type exactly once`,
    );
  }
  if (helperAssertionCalls !== 1 || rootHelperAssertionCalls !== 1) {
    throw new Error(
      `${file} must make one direct root-runner red-probe assertion`,
    );
  }
}

function assertAuthenticationSecret(authenticationSecret) {
  if (
    !Buffer.isBuffer(authenticationSecret) ||
    authenticationSecret.byteLength !== RED_PROBE_AUTHENTICATION_SECRET_BYTES
  ) {
    throw new Error(
      `red-probe authentication secret must contain exactly ${RED_PROBE_AUTHENTICATION_SECRET_BYTES} bytes`,
    );
  }
}

function canonicalFinalEvidence(entry) {
  return {
    protocolVersion: RED_PROBE_PROTOCOL_VERSION,
    outcome: PROTOCOL_OUTCOME,
    id: entry.id,
    task: entry.task,
    fingerprint: entry.fingerprint,
    assertions: 1,
    skipped: 0,
    todos: 0,
  };
}

function finalAuthenticationTag(entry, authenticationSecret) {
  assertAuthenticationSecret(authenticationSecret);
  return createHmac("sha256", authenticationSecret)
    .update(FINAL_AUTHENTICATION_DOMAIN, "utf8")
    .update(JSON.stringify(canonicalFinalEvidence(entry)), "utf8")
    .digest("hex");
}

function expectedProtocolLine(entry, authenticationSecret) {
  const evidence = canonicalFinalEvidence(entry);
  return `${RED_PROBE_PROTOCOL_PREFIX}${JSON.stringify({
    ...evidence,
    authenticationTag: finalAuthenticationTag(entry, authenticationSecret),
  })}\n`;
}

function isExpectedProtocolLine(entry, authenticationSecret, line) {
  if (!line.startsWith(RED_PROBE_PROTOCOL_PREFIX) || !line.endsWith("\n")) {
    return false;
  }
  let record;
  try {
    record = JSON.parse(line.slice(RED_PROBE_PROTOCOL_PREFIX.length, -1));
  } catch {
    return false;
  }
  const actualTag = record?.authenticationTag;
  if (
    typeof actualTag !== "string" ||
    !RED_PROBE_AUTHENTICATION_TAG_PATTERN.test(actualTag)
  ) {
    return false;
  }
  const expectedTag = finalAuthenticationTag(entry, authenticationSecret);
  if (
    !timingSafeEqual(
      Buffer.from(actualTag, "hex"),
      Buffer.from(expectedTag, "hex"),
    )
  ) {
    return false;
  }
  return line === expectedProtocolLine(entry, authenticationSecret);
}

function expectedHeartbeatLine(entry, sequence) {
  return `${RED_PROBE_HEARTBEAT_PREFIX}${JSON.stringify({
    protocolVersion: RED_PROBE_PROTOCOL_VERSION,
    outcome: HEARTBEAT_PROTOCOL_OUTCOME,
    id: entry.id,
    task: entry.task,
    fingerprint: entry.fingerprint,
    sequence,
  })}\n`;
}

function isInitialHeartbeat(entry, line) {
  return line === expectedHeartbeatLine(entry, 1);
}

export function createRedProbeProtocolState() {
  return Object.freeze({
    expectedSequence: 1,
    finalRecordObserved: false,
    protocolInvalid: false,
    recordsObserved: 0,
  });
}

export function observeRedProbeProtocolLine(
  entry,
  state,
  line,
  authenticationSecret,
) {
  const recordsObserved = state.recordsObserved + 1;
  if (state.protocolInvalid) {
    return Object.freeze({ ...state, recordsObserved });
  }
  if (state.finalRecordObserved) {
    return Object.freeze({
      ...state,
      protocolInvalid: true,
      recordsObserved,
    });
  }
  if (state.expectedSequence === 1) {
    if (recordsObserved !== 1 || !isInitialHeartbeat(entry, line)) {
      return Object.freeze({
        ...state,
        protocolInvalid: true,
        recordsObserved,
      });
    }
    return Object.freeze({
      ...state,
      expectedSequence: state.expectedSequence + 1,
      recordsObserved,
    });
  }
  if (line === expectedHeartbeatLine(entry, state.expectedSequence)) {
    return Object.freeze({
      ...state,
      expectedSequence: state.expectedSequence + 1,
      recordsObserved,
    });
  }
  if (isExpectedProtocolLine(entry, authenticationSecret, line)) {
    return Object.freeze({
      ...state,
      finalRecordObserved: true,
      recordsObserved,
    });
  }
  return Object.freeze({
    ...state,
    protocolInvalid: true,
    recordsObserved,
  });
}

function createHeartbeatMonitor(entry, authenticationSecret, silenceMs) {
  const abortController = new AbortController();
  let bufferedOutput = Buffer.alloc(0);
  let expired = false;
  let protocolState = createRedProbeProtocolState();
  let silenceTimer;

  const disarm = () => {
    if (silenceTimer === undefined) return;
    clearTimeout(silenceTimer);
    silenceTimer = undefined;
  };
  const arm = () => {
    disarm();
    if (abortController.signal.aborted || protocolState.finalRecordObserved) {
      return;
    }
    silenceTimer = setTimeout(() => {
      expired = true;
      abortController.abort();
    }, silenceMs);
    silenceTimer.unref?.();
  };
  const observe = (chunk) => {
    bufferedOutput = Buffer.concat([bufferedOutput, chunk]);
    for (
      let newline = bufferedOutput.indexOf(0x0a);
      newline >= 0;
      newline = bufferedOutput.indexOf(0x0a)
    ) {
      const line = bufferedOutput.subarray(0, newline + 1).toString("utf8");
      bufferedOutput = bufferedOutput.subarray(newline + 1);
      const previousState = protocolState;
      protocolState = observeRedProbeProtocolLine(
        entry,
        protocolState,
        line,
        authenticationSecret,
      );
      if (protocolState.protocolInvalid) continue;
      if (
        protocolState.expectedSequence ===
        previousState.expectedSequence + 1
      ) {
        arm();
      } else if (protocolState.finalRecordObserved) {
        disarm();
      }
    }
  };

  arm();
  return Object.freeze({
    close: disarm,
    observe,
    signal: abortController.signal,
    snapshot() {
      return Object.freeze({
        expired,
        finalRecordObserved: protocolState.finalRecordObserved,
        observedHeartbeats: protocolState.expectedSequence - 1,
        protocolInvalid: protocolState.protocolInvalid,
        recordsObserved: protocolState.recordsObserved,
        silenceMs,
      });
    },
  });
}

function isCanonicalProbeOutput(entry, bytes, heartbeat, authenticationSecret) {
  if (heartbeat.protocolInvalid || heartbeat.recordsObserved < 2) {
    return false;
  }
  const output = bytes.toString("utf8");
  if (!output.endsWith("\n")) return false;
  const records = output.slice(0, -1).split("\n");
  if (records.length < 2) return false;

  const finalRecord = records.at(-1);
  if (
    !isExpectedProtocolLine(entry, authenticationSecret, `${finalRecord}\n`)
  ) {
    return false;
  }
  const heartbeatRecords = records.slice(0, -1);
  if (
    !heartbeat.finalRecordObserved ||
    heartbeat.expired ||
    heartbeat.recordsObserved !== records.length ||
    heartbeat.observedHeartbeats !== heartbeatRecords.length
  ) {
    return false;
  }
  return heartbeatRecords.every(
    (record, index) =>
      `${record}\n` === expectedHeartbeatLine(entry, index + 1),
  );
}

function quoteWindowsCommandLineArgument(value) {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    backslashes = 0;
    quoted += character;
  }
  quoted += "\\".repeat(backslashes * 2);
  return `${quoted}"`;
}

function windowsEnvironmentBlockCodeUnits(env) {
  let codeUnits = WINDOWS_ENVIRONMENT_BLOCK_FINAL_TERMINATOR_CODE_UNITS;
  for (const [name, value] of Object.entries(env)) {
    codeUnits += name.length + 1 + value.length + 1;
  }
  return codeUnits;
}

export function measurePortableWindowsLaunch(program, args, env) {
  const commandLine = [program, ...args]
    .map(quoteWindowsCommandLineArgument)
    .join(" ");
  const brokerEnvironment = {
    ...env,
    AGENC_PROCESS_JOB_PROGRAM: Buffer.from(program, "utf8").toString("base64"),
    AGENC_PROCESS_JOB_COMMAND_LINE: Buffer.from(commandLine, "utf8").toString(
      "base64",
    ),
    AGENC_PROCESS_JOB_OWNER_PID: String(process.pid),
  };
  return Object.freeze({
    brokerEnvironmentCodeUnits:
      windowsEnvironmentBlockCodeUnits(brokerEnvironment),
    headroomCodeUnits: WINDOWS_LAUNCH_HEADROOM_CODE_UNITS,
    maximumCodeUnits: WINDOWS_PORTABLE_LAUNCH_MAXIMUM_CODE_UNITS,
    targetCommandLineCodeUnits:
      commandLine.length + WINDOWS_COMMAND_LINE_TERMINATOR_CODE_UNITS,
    targetEnvironmentCodeUnits: windowsEnvironmentBlockCodeUnits(env),
  });
}

export function assertPortableWindowsLaunch(program, args, env) {
  const measurement = measurePortableWindowsLaunch(program, args, env);
  for (const [label, codeUnits] of [
    ["target command line", measurement.targetCommandLineCodeUnits],
    ["target environment", measurement.targetEnvironmentCodeUnits],
    ["broker environment", measurement.brokerEnvironmentCodeUnits],
  ]) {
    if (codeUnits > measurement.maximumCodeUnits) {
      throw new Error(
        `red-probe ${label} needs ${codeUnits} UTF-16 code units; portable Windows launches reserve ${measurement.headroomCodeUnits} of ${WINDOWS_CREATE_PROCESS_MAXIMUM_CODE_UNITS} code units`,
      );
    }
  }
  return measurement;
}

function stdinModuleUrl(path) {
  const directoryUrl = pathToFileURL(`${dirname(path)}${sep}`);
  return new URL(STDIN_MODULE_FILENAME, directoryUrl).href;
}

function probeCommandArgs(bootstrapImportUrl) {
  return Object.freeze([
    "--import",
    bootstrapImportUrl,
    "--input-type=module",
    "--experimental-strip-types",
    "--eval",
    "",
  ]);
}

function createProbeEnvironment(runRoot, entry, supportGraph, probeSourceUrl) {
  const home = resolve(runRoot, "home");
  const attemptLedger = resolve(runRoot, "network-attempts");
  mkdirSync(home, { mode: 0o700, recursive: true });
  mkdirSync(attemptLedger, { mode: 0o700, recursive: true });
  const env = createHermeticLaunchEnv(process.env, runRoot);
  sanitizeHermeticEnv(env, home);
  env.AGENC_TEST_HERMETIC_RUN_ROOT = runRoot;
  env.AGENC_TEST_NETWORK_ATTEMPT_LEDGER = attemptLedger;
  const bootstrapConfiguration = Object.freeze({
    fingerprint: entry.fingerprint,
    heartbeatIntervalMs: RED_PROBE_HEARTBEAT_INTERVAL_MS,
    helperRequestUrl: supportGraph.helperRequestUrl,
    helperSourceDeflateBase64: supportGraph.helperSourceDeflateBase64,
    helperSourceSha256: supportGraph.helperSourceSha256,
    helperSourceUrl: supportGraph.helperSourceUrl,
    id: entry.id,
    networkTripwireUrl: supportGraph.networkTripwireUrl,
    probeSourceSha256: entry.sourceSha256,
    probeSourceUrl,
    task: entry.task,
    tsxLoaderUrl: supportGraph.tsxLoaderUrl,
  });
  env[BOOTSTRAP_ENVIRONMENT_VARIABLE] = JSON.stringify(bootstrapConfiguration);
  return { attemptLedger, bootstrapConfiguration, env };
}

function createProbeAuthenticationSecret() {
  const authenticationSecret = randomBytes(
    RED_PROBE_AUTHENTICATION_SECRET_BYTES,
  );
  assertAuthenticationSecret(authenticationSecret);
  return authenticationSecret;
}

function createProbeHandoff(sourceBytes, authenticationSecret) {
  assertAuthenticationSecret(authenticationSecret);
  if (
    !Buffer.isBuffer(sourceBytes) ||
    sourceBytes.byteLength < 1 ||
    sourceBytes.byteLength > MAXIMUM_PROBE_BYTES
  ) {
    throw new Error("red-probe source exceeds its handoff bound");
  }
  const handoff = Buffer.concat([
    RED_PROBE_HANDOFF_MAGIC,
    authenticationSecret,
    sourceBytes,
  ]);
  if (handoff.byteLength > MAXIMUM_HANDOFF_BYTES) {
    throw new Error("red-probe bootstrap handoff exceeds its bound");
  }
  return handoff;
}

function spawnProbe(
  handoffBytes,
  path,
  entry,
  env,
  maximumOutputBytes,
  bootstrapImportUrl,
  authenticationSecret,
  heartbeatSilenceMs,
) {
  const heartbeat = createHeartbeatMonitor(
    entry,
    authenticationSecret,
    heartbeatSilenceMs,
  );
  const args = probeCommandArgs(bootstrapImportUrl);
  assertPortableWindowsLaunch(process.execPath, args, env);
  let supervised;
  try {
    supervised = runSupervisedProcess(
      {
        program: process.execPath,
        args,
        cwd: dirname(path),
        env,
      },
      {
        timeoutMs: entry.timeoutMs,
        maxOutputBytes: maximumOutputBytes,
        stdin: handoffBytes,
        signal: heartbeat.signal,
        terminateGraceMs: TERMINATE_GRACE_MS,
        settleBackstopMs: SETTLE_BACKSTOP_MS,
        onStdout: heartbeat.observe,
      },
    );
  } catch (error) {
    heartbeat.close();
    throw error;
  }
  // The supervisor's timeout, termination grace, and settlement backstop bound
  // this promise, but its internal cleanup timers are deliberately unref'd for
  // library callers. Keep the standalone audit referenced until physical
  // process-tree settlement completes; clearing earlier can abandon this
  // top-level await with Node's exit status 13.
  const settlementKeepalive = setInterval(
    () => undefined,
    SUPERVISOR_SETTLEMENT_KEEPALIVE_INTERVAL_MS,
  );
  const physicallySettled = supervised.finally(() => {
    clearInterval(settlementKeepalive);
  });
  return physicallySettled.then(
    (result) => {
      const heartbeatEvidence = heartbeat.snapshot();
      heartbeat.close();
      return Object.freeze({ heartbeat: heartbeatEvidence, result });
    },
    (error) => {
      heartbeat.close();
      throw error;
    },
  );
}

function formatChildEvidence(result) {
  return [
    `exit=${String(result.exitCode)} signal=${String(result.signal)}`,
    `stop=${String(result.stopReason)}`,
    `stdout=${JSON.stringify(result.stdout.toString("utf8"))}`,
    `stderr=${JSON.stringify(result.stderr.toString("utf8"))}`,
  ].join(" ");
}

function assertExpectedRedResult(
  entry,
  result,
  heartbeat,
  authenticationSecret,
) {
  if (heartbeat.expired && result.stopReason === "aborted") {
    throw new Error(
      `${entry.id} missed a trusted heartbeat for ${heartbeat.silenceMs}ms`,
    );
  }
  if (result.stopReason === "timeout") {
    throw new Error(`${entry.id} timed out after ${entry.timeoutMs}ms`);
  }
  if (result.stopReason === "output_limit") {
    throw new Error(`${entry.id} exceeded the child-output limit`);
  }
  if (
    result.stopReason !== undefined ||
    result.error !== undefined ||
    result.backstopExpired ||
    result.forced
  ) {
    throw new Error(
      `${entry.id} had a supervisor or containment failure: ${formatChildEvidence(result)}`,
    );
  }
  if (result.signal !== null) {
    throw new Error(`${entry.id} exited on signal ${result.signal}`);
  }
  if (result.exitCode !== RED_PROBE_EXPECTED_EXIT_CODE) {
    throw new Error(
      `${entry.id} did not exit expected-red: ${formatChildEvidence(result)}`,
    );
  }
  if (
    !isCanonicalProbeOutput(
      entry,
      result.stdout,
      heartbeat,
      authenticationSecret,
    ) ||
    result.stderr.byteLength !== 0
  ) {
    throw new Error(
      `${entry.id} emitted unrelated or noncanonical output: ${formatChildEvidence(result)}`,
    );
  }
}

function assertNoNetworkAttempts(attemptLedger) {
  const directory = opendirSync(attemptLedger);
  try {
    if (directory.readSync() !== null) {
      throw new Error("red probes attempted public network access");
    }
  } finally {
    directory.closeSync();
  }
}

export async function auditRedProbes(options = {}) {
  const runtimeRoot = resolve(options.runtimeRoot ?? defaultRuntimeRoot);
  const maximumOutputBytes =
    options.maximumOutputBytes ?? MAXIMUM_CHILD_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1 ||
    maximumOutputBytes > MAXIMUM_CHILD_OUTPUT_BYTES
  ) {
    throw new Error(
      `maximumOutputBytes must be a safe integer in [1, ${MAXIMUM_CHILD_OUTPUT_BYTES}]`,
    );
  }
  const heartbeatSilenceMs =
    options.testing?.heartbeatSilenceMs ?? RED_PROBE_HEARTBEAT_SILENCE_MS;
  if (
    !Number.isSafeInteger(heartbeatSilenceMs) ||
    heartbeatSilenceMs < MINIMUM_TEST_HEARTBEAT_SILENCE_MS ||
    heartbeatSilenceMs > RED_PROBE_HEARTBEAT_SILENCE_MS
  ) {
    throw new Error(
      `testing.heartbeatSilenceMs must be a safe integer in [${MINIMUM_TEST_HEARTBEAT_SILENCE_MS}, ${RED_PROBE_HEARTBEAT_SILENCE_MS}]`,
    );
  }

  const manifest = loadRedProbeManifest(runtimeRoot);
  const discovered = discoverRedProbeFiles(runtimeRoot);
  assertExactInventory(manifest, discovered);
  const supportGraph = loadRedProbeSupportGraph(runtimeRoot);

  const runRoot = createHermeticRunRoot("agr-", options.testing?.runBase);
  try {
    await options.testing?.afterRunRootCreated?.(Object.freeze({ runRoot }));
    for (const entry of manifest.probes) {
      const probeRunRoot = resolve(runRoot, entry.id);
      const path = assertProbePath(runtimeRoot, entry.file);
      const probeSourceUrl = stdinModuleUrl(path);
      const { attemptLedger, bootstrapConfiguration, env } =
        createProbeEnvironment(
          probeRunRoot,
          entry,
          supportGraph,
          probeSourceUrl,
        );
      await options.testing?.afterProbeEnvironmentCreated?.(
        Object.freeze({ bootstrapConfiguration, entry }),
      );
      const sourceBytes = readBoundedRegularFile(
        path,
        MAXIMUM_PROBE_BYTES,
        entry.file,
        options.testing?.afterProbeFileOpened,
      );
      if (sha256(sourceBytes) !== entry.sourceSha256) {
        throw new Error(
          `${entry.id} source digest does not match its manifest`,
        );
      }
      const source = decodeUtf8(sourceBytes, entry.file);
      assertProbeSourcePolicy(source, entry.file);
      await options.testing?.afterProbeVerified?.(
        Object.freeze({ entry, path }),
      );
      const authenticationSecret = createProbeAuthenticationSecret();
      const handoffBytes = createProbeHandoff(
        sourceBytes,
        authenticationSecret,
      );
      const execution = await spawnProbe(
        handoffBytes,
        path,
        entry,
        env,
        maximumOutputBytes,
        supportGraph.bootstrapImportUrl,
        authenticationSecret,
        heartbeatSilenceMs,
      );
      assertNoNetworkAttempts(attemptLedger);
      assertExpectedRedResult(
        entry,
        execution.result,
        execution.heartbeat,
        authenticationSecret,
      );
    }
    return Object.freeze({
      files: manifest.probeCount,
      expectedRed: manifest.probeCount,
      assertions: manifest.probeCount,
      skipped: 0,
      todos: 0,
    });
  } finally {
    rmSync(runRoot, { force: true, recursive: true });
  }
}

export async function runRedProbeCli(auditOptions = {}) {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: node scripts/run-fnd-red-probes.mjs\n");
    return 2;
  }
  try {
    const result = await auditRedProbes(auditOptions);
    process.stdout.write(
      `red probes: files=${result.files} expected-red=${result.expectedRed} assertions=${result.assertions} skipped=${result.skipped} todo=${result.todos}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`red-probe audit failed: ${message}\n`);
    return 1;
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) process.exitCode = await runRedProbeCli();
