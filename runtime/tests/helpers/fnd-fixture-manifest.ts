import { types as nodeUtilTypes } from "node:util";

import { decodeFatalUtf8 } from "./bounded-file-io.js";
import {
  FND_FIXTURE_EXPECTED_CONTROL_FILES,
  FND_FIXTURE_EXPECTED_DATA_CLASSIFICATION,
  FND_FIXTURE_EXPECTED_PUBLICATION,
  FND_FIXTURE_MANIFEST_SCHEMA_VERSION,
  MAX_FND_FIXTURE_BYTES,
  MAX_FND_FIXTURE_CORPUS_BYTES,
  MAX_FND_FIXTURE_COUNT,
  MAX_FND_FIXTURE_MANIFEST_BYTES,
} from "./fnd-fixture-policy.js";
import {
  isWellFormedUnicode,
  portablePathIdentity,
  validatePortableRepositoryPath,
} from "./portable-repository-path.js";

const MAX_JSON_DEPTH = 128;
const MAX_JSON_NODES = 100_000;
const MAX_PARAMETER_DEPTH = 32;
const MAX_PARAMETER_NODES = 4_096;
const MAX_PARAMETER_ARRAY_ITEMS = 4_096;
const MAX_PARAMETER_OBJECT_KEYS = 4_096;
const MAX_PARAMETER_STRING_UTF8_BYTES = 65_536;
const MAX_TASKS_PER_FIXTURE = 64;
const MAX_METADATA_STRING_UTF8_BYTES = 65_536;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = typedArrayByteLengthGetter();
const FIXTURE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const TASK_ID_PATTERN = /^[A-Z][0-9]+[a-z]?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ROOT_MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "auditSha",
  "auditDate",
  "publication",
  "dataClassification",
  "controlFiles",
  "fixtureCount",
  "fixtures",
]);
const FIXTURE_KEYS = Object.freeze([
  "id",
  "tasks",
  "path",
  "mediaType",
  "format",
  "parameters",
  "byteLength",
  "sha256",
  "auditedObservation",
  "targetContract",
]);
const REQUIRED_FIXTURE_KEYS = Object.freeze(
  FIXTURE_KEYS.filter((key) => key !== "parameters"),
);

export interface FndFixtureEntry {
  readonly id: string;
  readonly tasks: readonly string[];
  readonly path: string;
  readonly mediaType: string;
  readonly format: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly byteLength: number;
  readonly sha256: string;
  readonly auditedObservation: string;
  readonly targetContract: string;
}

export interface FndFixtureManifest {
  readonly schemaVersion: number;
  readonly auditSha: string;
  readonly auditDate: string;
  readonly publication: string;
  readonly dataClassification: string;
  readonly controlFiles: readonly string[];
  readonly fixtureCount: number;
  readonly fixtures: readonly FndFixtureEntry[];
}

interface JsonCloneBudget {
  nodes: number;
}

export function parseFndFixtureManifest(
  bytes: Buffer,
  expectedAuditSha: string,
): FndFixtureManifest {
  assertManifestByteLimit(bytes);
  assertNoDuplicateObjectKeys(bytes, "FND fixture manifest");
  const parsed = JSON.parse(
    decodeFatalUtf8(bytes, "FND fixture manifest"),
  ) as unknown;
  const manifest = validateManifest(parsed, expectedAuditSha);
  let corpusBytes = 0;
  for (const entry of manifest.fixtures) {
    if (corpusBytes > MAX_FND_FIXTURE_CORPUS_BYTES - entry.byteLength) {
      throw new Error("FND fixture corpus exceeds its aggregate byte limit");
    }
    corpusBytes += entry.byteLength;
  }
  return manifest;
}

function assertManifestByteLimit(bytes: Buffer): void {
  if (!nodeUtilTypes.isUint8Array(bytes) || nodeUtilTypes.isProxy(bytes)) {
    throw new TypeError(
      "FND fixture manifest bytes must be a non-proxy Uint8Array",
    );
  }
  let byteLength: unknown;
  try {
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, bytes, []);
  } catch (error) {
    throw new TypeError("FND fixture manifest byte length is unavailable", {
      cause: error,
    });
  }
  if (
    !Number.isSafeInteger(byteLength) ||
    (byteLength as number) < 0 ||
    (byteLength as number) > MAX_FND_FIXTURE_MANIFEST_BYTES
  ) {
    throw new Error(
      `FND fixture manifest exceeds its ${MAX_FND_FIXTURE_MANIFEST_BYTES}-byte limit`,
    );
  }
}

function typedArrayByteLengthGetter(): () => unknown {
  const getter = Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE,
    "byteLength",
  )?.get;
  if (getter === undefined) {
    throw new TypeError("missing intrinsic typed-array byteLength getter");
  }
  return getter;
}

function validateManifest(
  value: unknown,
  expectedAuditSha: string,
): FndFixtureManifest {
  const manifest = requireRecord(value, "FND fixture manifest");
  assertExactKeys(manifest, ROOT_MANIFEST_KEYS, ROOT_MANIFEST_KEYS, "manifest");
  if (manifest.schemaVersion !== FND_FIXTURE_MANIFEST_SCHEMA_VERSION) {
    throw new Error("unsupported FND fixture manifest schema");
  }
  if (manifest.auditSha !== expectedAuditSha) {
    throw new Error("FND fixture manifest audit SHA does not match");
  }
  const auditDate = requireString(manifest.auditDate, "auditDate");
  if (!isCanonicalIsoDate(auditDate)) {
    throw new Error("FND fixture manifest auditDate is invalid");
  }
  if (manifest.publication !== FND_FIXTURE_EXPECTED_PUBLICATION) {
    throw new Error("FND fixture publication classification changed");
  }
  if (
    manifest.dataClassification !== FND_FIXTURE_EXPECTED_DATA_CLASSIFICATION
  ) {
    throw new Error("FND fixture data classification changed");
  }
  const controlFiles = requireStringArray(
    manifest.controlFiles,
    "controlFiles",
    FND_FIXTURE_EXPECTED_CONTROL_FILES.length,
  );
  if (!equalStringArrays(controlFiles, FND_FIXTURE_EXPECTED_CONTROL_FILES)) {
    throw new Error("FND fixture control file list changed");
  }
  if (
    !Number.isSafeInteger(manifest.fixtureCount) ||
    (manifest.fixtureCount as number) < 0 ||
    (manifest.fixtureCount as number) > MAX_FND_FIXTURE_COUNT
  ) {
    throw new Error("FND fixtureCount is invalid");
  }
  if (!Array.isArray(manifest.fixtures)) {
    throw new Error("FND manifest fixtures must be an array");
  }
  if (manifest.fixtures.length !== manifest.fixtureCount) {
    throw new Error("FND fixtureCount does not match fixtures");
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  const fixtures = new Array<FndFixtureEntry>(manifest.fixtures.length);
  let previousId: string | undefined;
  for (let index = 0; index < manifest.fixtures.length; index += 1) {
    const entry = validateEntry(manifest.fixtures[index], index);
    if (ids.has(entry.id))
      throw new Error(`duplicate FND fixture ID: ${entry.id}`);
    const pathIdentity = portablePathIdentity(entry.path);
    if (paths.has(pathIdentity)) {
      throw new Error(`duplicate portable FND fixture path: ${entry.path}`);
    }
    if (
      previousId !== undefined &&
      compareCodePoints(previousId, entry.id) >= 0
    ) {
      throw new Error("FND fixtures are not in canonical ID order");
    }
    ids.add(entry.id);
    paths.add(pathIdentity);
    fixtures[index] = entry;
    previousId = entry.id;
  }

  return Object.freeze({
    schemaVersion: FND_FIXTURE_MANIFEST_SCHEMA_VERSION,
    auditSha: expectedAuditSha,
    auditDate,
    publication: FND_FIXTURE_EXPECTED_PUBLICATION,
    dataClassification: FND_FIXTURE_EXPECTED_DATA_CLASSIFICATION,
    controlFiles,
    fixtureCount: fixtures.length,
    fixtures: Object.freeze(fixtures),
  });
}

function validateEntry(value: unknown, index: number): FndFixtureEntry {
  const label = `fixture entry ${index}`;
  const entry = requireRecord(value, label);
  assertExactKeys(entry, FIXTURE_KEYS, REQUIRED_FIXTURE_KEYS, label);
  const id = requireString(entry.id, `${label}.id`);
  if (!FIXTURE_ID_PATTERN.test(id)) throw new Error(`${label}.id is invalid`);
  const tasks = requireStringArray(
    entry.tasks,
    `${label}.tasks`,
    MAX_TASKS_PER_FIXTURE,
  );
  if (tasks.length === 0 || tasks.some((task) => !TASK_ID_PATTERN.test(task))) {
    throw new Error(`${label}.tasks is invalid`);
  }
  const path = requireString(entry.path, `${label}.path`);
  validatePortableRepositoryPath(path);
  const mediaType = requireNonemptyString(
    entry.mediaType,
    `${label}.mediaType`,
  );
  const format = requireNonemptyString(entry.format, `${label}.format`);
  const auditedObservation = requireNonemptyString(
    entry.auditedObservation,
    `${label}.auditedObservation`,
  );
  const targetContract = requireNonemptyString(
    entry.targetContract,
    `${label}.targetContract`,
  );
  if (
    !Number.isSafeInteger(entry.byteLength) ||
    (entry.byteLength as number) < 0 ||
    (entry.byteLength as number) > MAX_FND_FIXTURE_BYTES
  ) {
    throw new Error(`${label}.byteLength is invalid`);
  }
  const sha256 = requireString(entry.sha256, `${label}.sha256`);
  if (!SHA256_PATTERN.test(sha256))
    throw new Error(`${label}.sha256 is invalid`);
  const parameters =
    entry.parameters === undefined
      ? undefined
      : cloneParameterRecord(entry.parameters, `${label}.parameters`);
  return Object.freeze({
    id,
    tasks,
    path,
    mediaType,
    format,
    ...(parameters === undefined ? {} : { parameters }),
    byteLength: entry.byteLength as number,
    sha256,
    auditedObservation,
    targetContract,
  });
}

function cloneParameterRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  const budget: JsonCloneBudget = { nodes: 0 };
  const cloned = cloneJsonValue(value, label, 1, budget);
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return cloned as Readonly<Record<string, unknown>>;
}

function cloneJsonValue(
  value: unknown,
  label: string,
  depth: number,
  budget: JsonCloneBudget,
): unknown {
  budget.nodes += 1;
  if (depth > MAX_PARAMETER_DEPTH || budget.nodes > MAX_PARAMETER_NODES) {
    throw new Error(`${label} exceeds its bounded JSON structure`);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (
      value.length > MAX_PARAMETER_STRING_UTF8_BYTES ||
      !isWellFormedUnicode(value) ||
      Buffer.byteLength(value, "utf8") > MAX_PARAMETER_STRING_UTF8_BYTES
    ) {
      throw new Error(`${label} string is malformed or exceeds its byte limit`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PARAMETER_ARRAY_ITEMS) {
      throw new Error(`${label} array exceeds its item limit`);
    }
    const copy = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      copy[index] = cloneJsonValue(
        value[index],
        `${label}[${index}]`,
        depth + 1,
        budget,
      );
    }
    return Object.freeze(copy);
  }
  const record = requireRecord(value, label);
  const keys = Object.keys(record);
  if (keys.length > MAX_PARAMETER_OBJECT_KEYS) {
    throw new Error(`${label} object exceeds its key limit`);
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    Object.defineProperty(copy, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: cloneJsonValue(record[key], `${label}.${key}`, depth + 1, budget),
    });
  }
  return Object.freeze(copy);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (
    value.length > MAX_METADATA_STRING_UTF8_BYTES ||
    !isWellFormedUnicode(value) ||
    Buffer.byteLength(value, "utf8") > MAX_METADATA_STRING_UTF8_BYTES
  ) {
    throw new Error(`${label} is malformed or exceeds its byte limit`);
  }
  return value;
}

function requireNonemptyString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function requireStringArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded string array`);
  }
  const result = new Array<string>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    result[index] = requireString(value[index], `${label}[${index}]`);
  }
  return Object.freeze(result);
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      throw new Error(`${label} contains unexpected key ${key}`);
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${label} is missing required key ${key}`);
    }
  }
}

function equalStringArrays(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function assertNoDuplicateObjectKeys(bytes: Buffer, label: string): void {
  const source = decodeFatalUtf8(bytes, label);
  let offset = 0;
  let nodes = 0;

  const skipWhitespace = (): void => {
    while (/^[\t\n\r ]$/u.test(source[offset] ?? "")) offset += 1;
  };
  const parseString = (): string => {
    if (source[offset] !== '"') {
      throw new Error(`${label} expected a JSON string at offset ${offset}`);
    }
    const start = offset++;
    while (offset < source.length) {
      const character = source[offset]!;
      if (character === "\\") {
        offset += 2;
        continue;
      }
      if (character === '"') {
        offset += 1;
        const parsed = JSON.parse(source.slice(start, offset)) as unknown;
        if (typeof parsed !== "string") {
          throw new Error(`${label} contains an invalid JSON string`);
        }
        return parsed;
      }
      if (character.charCodeAt(0) < 0x20) {
        throw new Error(`${label} contains an unescaped control character`);
      }
      offset += 1;
    }
    throw new Error(`${label} contains an unterminated JSON string`);
  };
  const parseScalar = (): void => {
    const start = offset;
    while (
      offset < source.length &&
      !/^[,\]}\t\n\r ]$/u.test(source[offset]!)
    ) {
      offset += 1;
    }
    if (start === offset) throw new Error(`${label} expected a JSON value`);
    JSON.parse(source.slice(start, offset)) as unknown;
  };
  const parseValue = (depth: number): void => {
    nodes += 1;
    if (depth > MAX_JSON_DEPTH)
      throw new Error(`${label} exceeds its JSON depth limit`);
    if (nodes > MAX_JSON_NODES)
      throw new Error(`${label} exceeds its JSON node limit`);
    skipWhitespace();
    if (source[offset] === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) {
          throw new Error(`${label} contains duplicate object key ${key}`);
        }
        keys.add(key);
        skipWhitespace();
        if (source[offset] !== ":") {
          throw new Error(`${label} expected ':' at offset ${offset}`);
        }
        offset += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") {
          throw new Error(`${label} expected ',' at offset ${offset}`);
        }
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON object`);
    }
    if (source[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") {
          throw new Error(`${label} expected ',' at offset ${offset}`);
        }
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON array`);
    }
    if (source[offset] === '"') parseString();
    else parseScalar();
  };

  parseValue(1);
  skipWhitespace();
  if (offset !== source.length) {
    throw new Error(`${label} contains trailing JSON data`);
  }
}
