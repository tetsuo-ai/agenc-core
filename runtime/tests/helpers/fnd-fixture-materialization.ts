import { types as nodeUtilTypes } from "node:util";

import { MAX_FND_FIXTURE_COUNT } from "./fnd-fixture-policy.js";
import { validatePortableRepositoryPath } from "./portable-repository-path.js";

const MATERIALIZATION_KEYS = Object.freeze(["fixtureId", "destination"]);
const MAX_MATERIALIZATION_STRING_UTF8_BYTES = 65_536;
const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;

export interface FixtureMaterialization {
  readonly fixtureId: string;
  readonly destination: string;
}

export function snapshotFixtureMaterializations(
  input: readonly FixtureMaterialization[],
  maximum: number,
): readonly FixtureMaterialization[] {
  validateMaterializationMaximum(maximum);
  if (
    !Array.isArray(input) ||
    nodeUtilTypes.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  ) {
    throw new TypeError(
      "fixture materializations must be a non-proxy ordinary array",
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    (lengthDescriptor.value as number) < 0 ||
    (lengthDescriptor.value as number) > maximum
  ) {
    throw new Error("fixture materialization request exceeds catalog size");
  }
  const length = lengthDescriptor.value as number;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !isArrayIndex(key, length)) {
      throw new TypeError(
        "fixture materializations contain an unsupported property",
      );
    }
  }
  const result = new Array<FixtureMaterialization>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `fixture materializations are sparse at index ${index}`,
      );
    }
    result[index] = snapshotMaterialization(descriptor.value, index);
  }
  return Object.freeze(result);
}

function validateMaterializationMaximum(maximum: number): void {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    maximum > MAX_FND_FIXTURE_COUNT
  ) {
    throw new RangeError(
      `fixture materialization maximum must be a safe integer in [0, ${MAX_FND_FIXTURE_COUNT}]`,
    );
  }
}

function snapshotMaterialization(
  value: unknown,
  index: number,
): FixtureMaterialization {
  const label = `fixture materialization ${index}`;
  const record = requirePlainDataRecord(value, label);
  assertExactKeys(record, label);
  const fixtureId = requireBoundedString(
    record.fixtureId,
    `${label}.fixtureId`,
  );
  const destination = requireBoundedString(
    record.destination,
    `${label}.destination`,
  );
  validatePortableRepositoryPath(destination);
  return Object.freeze({ fixtureId, destination });
}

function requirePlainDataRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    throw new TypeError(`${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} contains a symbol property`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label}.${key} must be a data property`);
    }
    record[key] = descriptor.value as unknown;
  }
  return record;
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const keys = Object.keys(record);
  if (
    keys.length !== MATERIALIZATION_KEYS.length ||
    keys.some((key) => !MATERIALIZATION_KEYS.includes(key))
  ) {
    throw new TypeError(
      `${label} must contain exactly fixtureId and destination`,
    );
  }
}

function requireBoundedString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MATERIALIZATION_STRING_UTF8_BYTES ||
    Buffer.byteLength(value, "utf8") > MAX_MATERIALIZATION_STRING_UTF8_BYTES
  ) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function isArrayIndex(key: string, length: number): boolean {
  if (!CANONICAL_ARRAY_INDEX.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}
