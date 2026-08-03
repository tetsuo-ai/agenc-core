/** Frozen, bounded Draft-07 subset for CSV job result validation. */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import {
  CSV_COMPILED_SCHEMA_CACHE_TTL_MS,
  CSV_MAX_COMPILED_SCHEMA_CACHE_BYTES,
  CSV_MAX_COMPILED_SCHEMA_CACHE_ENTRIES,
  CSV_MAX_OUTPUT_SCHEMA_BYTES,
  CSV_MAX_OUTPUT_SCHEMA_DEPTH,
  CSV_MAX_OUTPUT_SCHEMA_ENUM_MEMBERS,
  CSV_MAX_OUTPUT_SCHEMA_NODES,
  CSV_MAX_OUTPUT_SCHEMA_REF_EXPANSIONS,
  CSV_MAX_RESULT_BYTES,
  CSV_MAX_RESULT_DEPTH,
  CSV_MAX_RESULT_NODES,
  CSV_MAX_RESULT_VALIDATION_MS,
  CSV_MAX_RESULT_VALIDATION_CPU_MS_PER_JOB,
  CSV_MAX_SCHEMA_COMPILE_MS,
  CSV_MAX_VALIDATION_QUEUE,
  CSV_MAX_VALIDATION_QUEUE_BYTES,
  CSV_MAX_VALIDATION_WORKERS,
  CSV_OUTPUT_SCHEMA_CONTRACT_VERSION,
} from "../../contracts/csv-job-contract.js";

const AJV_RUNTIME_VERSION = "8.20.0";
const DRAFT_07_META_SCHEMA_URI = "http://json-schema.org/draft-07/schema#";
const MAX_VALIDATION_ERRORS = 10;
const MAX_VALIDATION_DIAGNOSTIC_BYTES = 4_096;

const ALLOWED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "definitions",
  "$ref",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);

interface JsonCloneLimits {
  readonly label: string;
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly requireObjectRoot: boolean;
}

interface JsonContainerFrame {
  readonly source: Readonly<Record<string, unknown>> | ReadonlyArray<unknown>;
  readonly target: Record<string, unknown> | unknown[];
  readonly depth: number;
}

interface SchemaDependency {
  readonly target: string;
  readonly reference: boolean;
}

interface CachedSchema {
  readonly compiled: CompiledCsvOutputSchema;
  readonly accountedBytes: number;
  lastUsedAt: number;
}

export interface CompiledCsvOutputSchema {
  readonly contractVersion: typeof CSV_OUTPUT_SCHEMA_CONTRACT_VERSION;
  readonly digest: string;
  readonly canonicalJson: string;
  readonly schema: Readonly<Record<string, unknown>>;
  validate(value: unknown): string | null;
}

export interface CanonicalCsvResult {
  readonly value: Readonly<Record<string, unknown>>;
  readonly json: string;
  readonly bytes: number;
  readonly digest: string;
}

const VALIDATED_CSV_RESULT_SECRET = Symbol("validated-csv-result");

export class ValidatedCsvResult {
  private consumed = false;

  constructor(
    secret: symbol,
    private readonly jobId: string,
    private readonly itemId: string,
    private readonly schemaDigest: string | undefined,
    private readonly canonical: CanonicalCsvResult,
  ) {
    if (secret !== VALIDATED_CSV_RESULT_SECRET) {
      throw new Error("ValidatedCsvResult cannot be constructed externally");
    }
  }

  consumeFor(
    expectedJobId: string,
    expectedItemId: string,
    expectedSchemaDigest: string | undefined,
  ): CanonicalCsvResult {
    const canonical = this.assertFor(
      expectedJobId,
      expectedItemId,
      expectedSchemaDigest,
    );
    this.consumed = true;
    return canonical;
  }

  assertFor(
    expectedJobId: string,
    expectedItemId: string,
    expectedSchemaDigest: string | undefined,
  ): CanonicalCsvResult {
    if (this.consumed)
      throw new Error("validated CSV result was already consumed");
    if (
      this.jobId !== expectedJobId ||
      this.itemId !== expectedItemId ||
      this.schemaDigest !== expectedSchemaDigest
    ) {
      throw new Error(
        "validated CSV result is bound to another job/item/schema",
      );
    }
    return this.canonical;
  }
}

interface ValidationPoolTask {
  readonly id: number;
  readonly kind: "compile" | "validate";
  readonly jobId: string;
  readonly schemaDigest: string;
  readonly schemaJson: string;
  readonly resultJson?: string;
  readonly accountedBytes: number;
  readonly resolve: (violation: string | null) => void;
  readonly reject: (error: Error) => void;
}

interface ValidationWorkerMessage {
  readonly taskId: number;
  readonly phase: "compiled" | "done" | "error";
  readonly validationMs?: number;
  readonly errors?: ReadonlyArray<{
    readonly instancePath?: string;
    readonly message?: string;
    readonly keyword?: string;
  }>;
  readonly message?: string;
}

interface ValidationWorkerSlot {
  readonly worker: Worker;
  task?: ValidationPoolTask;
  timer?: NodeJS.Timeout;
}

interface ValidationJobQueue {
  readonly tasks: ValidationPoolTask[];
  head: number;
  enqueued: boolean;
}

export interface CsvValidationJobMetrics {
  readonly jobId: string;
  readonly queuedTasks: number;
  readonly activeTasks: number;
  readonly validationCpuMs: number;
}

export interface CsvValidationPoolMetrics {
  readonly workerCount: number;
  readonly activeTasks: number;
  readonly queuedTasks: number;
  readonly queuedBytes: number;
  readonly totalValidationCpuMs: number;
  readonly jobs: ReadonlyArray<CsvValidationJobMetrics>;
}

const compiledSchemaCache = new Map<string, CachedSchema>();
let compiledSchemaCacheBytes = 0;
let validationPool: CsvValidationWorkerPool | undefined;

function getValidationPool(): CsvValidationWorkerPool {
  validationPool ??= new CsvValidationWorkerPool();
  return validationPool;
}

export async function primeCsvOutputSchemaValidation(
  jobId: string,
  schema: CompiledCsvOutputSchema | undefined,
): Promise<void> {
  if (schema === undefined) return;
  const violation = await getValidationPool().submit({
    kind: "compile",
    jobId,
    schema,
  });
  if (violation !== null) throw new Error(violation);
}

export async function validateCsvResultInWorkerPool(
  jobId: string,
  schema: CompiledCsvOutputSchema | undefined,
  result: CanonicalCsvResult,
): Promise<string | null> {
  if (schema === undefined) return null;
  return getValidationPool().submit({
    kind: "validate",
    jobId,
    schema,
    resultJson: result.json,
  });
}

export async function validateCsvResultForPersistence(
  jobId: string,
  itemId: string,
  schema: CompiledCsvOutputSchema | undefined,
  result: CanonicalCsvResult,
): Promise<ValidatedCsvResult | string> {
  const violation = await validateCsvResultInWorkerPool(jobId, schema, result);
  return (
    violation ??
    new ValidatedCsvResult(
      VALIDATED_CSV_RESULT_SECRET,
      jobId,
      itemId,
      schema?.digest,
      result,
    )
  );
}

/** Read-only bounded-pool observability for diagnostics and tests. */
export function getCsvValidationPoolMetrics(): CsvValidationPoolMetrics {
  return (
    validationPool?.metrics() ?? {
      workerCount: 0,
      activeTasks: 0,
      queuedTasks: 0,
      queuedBytes: 0,
      totalValidationCpuMs: 0,
      jobs: [],
    }
  );
}

/** Release per-job accounting after all reports for the job have settled. */
export function releaseCsvOutputSchemaValidation(jobId: string): void {
  validationPool?.releaseJob(jobId);
}

export function compileCsvOutputSchema(
  schema: Record<string, unknown> | undefined,
): CompiledCsvOutputSchema | undefined {
  if (schema === undefined) return undefined;
  const canonical = cloneBoundedJson(schema, {
    label: "CSV output schema",
    maxBytes: CSV_MAX_OUTPUT_SCHEMA_BYTES,
    maxDepth: CSV_MAX_OUTPUT_SCHEMA_DEPTH,
    maxNodes: CSV_MAX_OUTPUT_SCHEMA_NODES,
    requireObjectRoot: true,
  });
  const canonicalJson = JSON.stringify(canonical);
  const digest = sha256(canonicalJson);
  const cacheKey = [
    CSV_OUTPUT_SCHEMA_CONTRACT_VERSION,
    AJV_RUNTIME_VERSION,
    digest,
  ].join(":");
  const now = Date.now();
  evictExpiredSchemas(now);
  const cached = compiledSchemaCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached.compiled.canonicalJson !== canonicalJson) {
      throw new Error("CSV output schema digest collision");
    }
    cached.lastUsedAt = now;
    compiledSchemaCache.delete(cacheKey);
    compiledSchemaCache.set(cacheKey, cached);
    return cached.compiled;
  }

  validateSchemaSubset(canonical as Readonly<Record<string, unknown>>);
  // Normal job creation calls primeCsvOutputSchemaValidation(), so Ajv code
  // generation happens only in the owned worker pool. Keep a lazy synchronous
  // validator solely for the legacy synchronous repository/test surface.
  let compatibilityValidator: ValidateFunction | undefined;
  const compiled: CompiledCsvOutputSchema = Object.freeze({
    contractVersion: CSV_OUTPUT_SCHEMA_CONTRACT_VERSION,
    digest,
    canonicalJson,
    schema: canonical as Readonly<Record<string, unknown>>,
    validate(value: unknown): string | null {
      compatibilityValidator ??= compileCompatibilityValidator(canonical);
      const validationStartedAt = performance.now();
      const valid = compatibilityValidator(value);
      const validationMs = performance.now() - validationStartedAt;
      if (validationMs > CSV_MAX_RESULT_VALIDATION_MS) {
        return `result validation exceeded ${CSV_MAX_RESULT_VALIDATION_MS} ms`;
      }
      return valid ? null : formatAjvErrors(compatibilityValidator.errors);
    },
  });
  cacheCompiledSchema(
    cacheKey,
    compiled,
    Buffer.byteLength(canonicalJson, "utf8") + 256,
  );
  return compiled;
}

/**
 * SQLite migrations are synchronous. Use this only while gating persisted
 * legacy schemas; live job creation compiles in the owned worker pool.
 */
export function assertCsvOutputSchemaMigrationCompatible(
  schema: CompiledCsvOutputSchema,
): void {
  compileCompatibilityValidator(schema.schema);
}

function compileCompatibilityValidator(schema: unknown): ValidateFunction {
  const startedAt = performance.now();
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    strictSchema: true,
    validateSchema: true,
    allowUnionTypes: false,
    inlineRefs: false,
    messages: true,
  });
  let validator: ValidateFunction;
  try {
    validator = ajv.compile(schema as Record<string, unknown>);
  } catch (error) {
    throw new Error(
      truncateDiagnostic(
        `CSV output schema is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
  const compileMs = performance.now() - startedAt;
  if (compileMs > CSV_MAX_SCHEMA_COMPILE_MS) {
    throw new Error(
      `CSV output schema compilation exceeded ${CSV_MAX_SCHEMA_COMPILE_MS} ms`,
    );
  }
  return validator;
}

export function canonicalizeCsvResult(value: unknown): CanonicalCsvResult {
  const cloned = cloneBoundedJson(value, {
    label: "CSV result",
    maxBytes: CSV_MAX_RESULT_BYTES,
    maxDepth: CSV_MAX_RESULT_DEPTH,
    maxNodes: CSV_MAX_RESULT_NODES,
    requireObjectRoot: true,
  }) as Readonly<Record<string, unknown>>;
  const json = JSON.stringify(cloned);
  const bytes = Buffer.byteLength(json, "utf8");
  return Object.freeze({ value: cloned, json, bytes, digest: sha256(json) });
}

function cloneBoundedJson(value: unknown, limits: JsonCloneLimits): unknown {
  const root = cloneJsonValue(value, 0, limits);
  let nodes = 1;
  let estimatedBytes = estimatePrimitiveBytes(value);
  if (!isJsonContainer(value)) {
    if (limits.requireObjectRoot) {
      throw new Error(`${limits.label} must be a JSON object`);
    }
    assertEncodedBound(root, limits);
    return root;
  }
  if (limits.requireObjectRoot && Array.isArray(value)) {
    throw new Error(`${limits.label} must be a JSON object`);
  }
  const frames: JsonContainerFrame[] = [
    {
      source: value,
      target: root as Record<string, unknown> | unknown[],
      depth: 0,
    },
  ];
  while (frames.length > 0) {
    const frame = frames.pop()!;
    if (frame.depth > limits.maxDepth) {
      throw new Error(
        `${limits.label} exceeds maximum depth ${limits.maxDepth}`,
      );
    }
    if (Array.isArray(frame.source)) {
      const descriptors = Object.getOwnPropertyDescriptors(frame.source);
      for (const symbol of Object.getOwnPropertySymbols(frame.source)) {
        if (Object.getOwnPropertyDescriptor(frame.source, symbol)?.enumerable) {
          throw new Error(`${limits.label} contains an enumerable symbol key`);
        }
      }
      for (let index = 0; index < frame.source.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new Error(
            `${limits.label} contains a sparse or accessor array`,
          );
        }
        const child = descriptor.value;
        nodes += 1;
        if (nodes > limits.maxNodes) {
          throw new Error(
            `${limits.label} exceeds ${limits.maxNodes} JSON nodes`,
          );
        }
        estimatedBytes += estimatePrimitiveBytes(child) + 1;
        assertEstimateBound(estimatedBytes, limits);
        const clone = cloneJsonValue(child, frame.depth + 1, limits);
        (frame.target as unknown[])[index] = clone;
        if (isJsonContainer(child)) {
          frames.push({
            source: child,
            target: clone as Record<string, unknown> | unknown[],
            depth: frame.depth + 1,
          });
        }
      }
      const unexpected = Object.keys(descriptors).filter(
        (key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key),
      );
      if (unexpected.length > 0) {
        throw new Error(`${limits.label} contains non-JSON array properties`);
      }
      continue;
    }

    const descriptors = Object.getOwnPropertyDescriptors(frame.source);
    for (const symbol of Object.getOwnPropertySymbols(frame.source)) {
      if (Object.getOwnPropertyDescriptor(frame.source, symbol)?.enumerable) {
        throw new Error(`${limits.label} contains an enumerable symbol key`);
      }
    }
    const keys = Object.keys(descriptors)
      .filter((key) => descriptors[key]!.enumerable)
      .sort();
    for (const key of keys) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) {
        throw new Error(`${limits.label} contains accessor property ${key}`);
      }
      const child = descriptor.value;
      nodes += 1;
      if (nodes > limits.maxNodes) {
        throw new Error(
          `${limits.label} exceeds ${limits.maxNodes} JSON nodes`,
        );
      }
      estimatedBytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
      estimatedBytes += estimatePrimitiveBytes(child) + 1;
      assertEstimateBound(estimatedBytes, limits);
      const clone = cloneJsonValue(child, frame.depth + 1, limits);
      Object.defineProperty(frame.target, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: clone,
      });
      if (isJsonContainer(child)) {
        frames.push({
          source: child,
          target: clone as Record<string, unknown> | unknown[],
          depth: frame.depth + 1,
        });
      }
    }
  }
  deepFreezeContainers(root);
  assertEncodedBound(root, limits);
  return root;
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  limits: JsonCloneLimits,
): unknown {
  if (depth > limits.maxDepth) {
    throw new Error(`${limits.label} exceeds maximum depth ${limits.maxDepth}`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${limits.label} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) return [];
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${limits.label} contains a non-JSON object`);
    }
    return Object.create(null) as Record<string, unknown>;
  }
  throw new Error(`${limits.label} contains a non-JSON value`);
}

function isJsonContainer(
  value: unknown,
): value is Readonly<Record<string, unknown>> | ReadonlyArray<unknown> {
  return typeof value === "object" && value !== null;
}

function estimatePrimitiveBytes(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }
  if (typeof value === "number") return 24;
  if (typeof value === "boolean") return 5;
  if (value === null) return 4;
  return 2;
}

function assertEstimateBound(estimated: number, limits: JsonCloneLimits): void {
  if (estimated > limits.maxBytes) {
    throw new Error(`${limits.label} exceeds ${limits.maxBytes} UTF-8 bytes`);
  }
}

function assertEncodedBound(value: unknown, limits: JsonCloneLimits): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > limits.maxBytes) {
    throw new Error(
      `${limits.label} is ${bytes} bytes; limit is ${limits.maxBytes}`,
    );
  }
}

function deepFreezeContainers(root: unknown): void {
  if (!isJsonContainer(root)) return;
  const stack: Array<
    Readonly<Record<string, unknown>> | ReadonlyArray<unknown>
  > = [root];
  const ordered: Array<
    Readonly<Record<string, unknown>> | ReadonlyArray<unknown>
  > = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    ordered.push(current);
    for (const value of Object.values(current)) {
      if (isJsonContainer(value)) stack.push(value);
    }
  }
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    Object.freeze(ordered[index]);
  }
}

function validateSchemaSubset(root: Readonly<Record<string, unknown>>): void {
  const schemas = new Map<
    string,
    Readonly<Record<string, unknown>> | boolean
  >();
  const dependencies = new Map<string, SchemaDependency[]>();
  let enumMembers = 0;
  const stack: Array<{
    readonly schema: unknown;
    readonly path: string;
    readonly depth: number;
  }> = [{ schema: root, path: "#", depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current.schema === "boolean") {
      schemas.set(current.path, current.schema);
      dependencies.set(current.path, []);
      continue;
    }
    if (!isPlainRecord(current.schema)) {
      throw new Error(
        `CSV output schema node ${current.path} must be an object or boolean`,
      );
    }
    if (current.depth > CSV_MAX_OUTPUT_SCHEMA_DEPTH) {
      throw new Error(
        `CSV output schema exceeds maximum depth ${CSV_MAX_OUTPUT_SCHEMA_DEPTH}`,
      );
    }
    schemas.set(current.path, current.schema);
    const nodeDependencies: SchemaDependency[] = [];
    dependencies.set(current.path, nodeDependencies);
    for (const keyword of Object.keys(current.schema)) {
      if (!ALLOWED_SCHEMA_KEYWORDS.has(keyword)) {
        throw new Error(
          `CSV output schema keyword ${keyword} is not supported`,
        );
      }
    }
    const declaredMetaSchema = current.schema.$schema;
    if (declaredMetaSchema !== undefined) {
      if (
        current.path !== "#" ||
        declaredMetaSchema !== DRAFT_07_META_SCHEMA_URI
      ) {
        throw new Error(
          `CSV output schema $schema must be exactly ${DRAFT_07_META_SCHEMA_URI} at the root`,
        );
      }
    }
    const type = current.schema.type;
    if (
      type !== undefined &&
      (typeof type !== "string" || !ALLOWED_TYPES.has(type))
    ) {
      throw new Error("CSV output schema type must be one supported JSON type");
    }
    validateStringArray(current.schema.required, `${current.path}/required`);
    validateNonnegativeInteger(current.schema.minLength, "minLength");
    validateNonnegativeInteger(current.schema.maxLength, "maxLength");
    validateNonnegativeInteger(current.schema.minItems, "minItems");
    validateNonnegativeInteger(current.schema.maxItems, "maxItems");
    validateNonnegativeInteger(current.schema.minProperties, "minProperties");
    validateNonnegativeInteger(current.schema.maxProperties, "maxProperties");
    validateFiniteNumber(current.schema.minimum, "minimum");
    validateFiniteNumber(current.schema.maximum, "maximum");
    validateFiniteNumber(current.schema.exclusiveMinimum, "exclusiveMinimum");
    validateFiniteNumber(current.schema.exclusiveMaximum, "exclusiveMaximum");
    validateFiniteNumber(current.schema.multipleOf, "multipleOf", true);
    if (current.schema.enum !== undefined) {
      if (
        !Array.isArray(current.schema.enum) ||
        current.schema.enum.length === 0
      ) {
        throw new Error("CSV output schema enum must be a non-empty array");
      }
      enumMembers += current.schema.enum.length;
      if (enumMembers > CSV_MAX_OUTPUT_SCHEMA_ENUM_MEMBERS) {
        throw new Error(
          `CSV output schema exceeds ${CSV_MAX_OUTPUT_SCHEMA_ENUM_MEMBERS} enum members`,
        );
      }
    }
    if (current.schema.$ref !== undefined) {
      if (
        typeof current.schema.$ref !== "string" ||
        !current.schema.$ref.startsWith("#/definitions/")
      ) {
        throw new Error(
          "CSV output schema permits only local definitions $ref values",
        );
      }
      nodeDependencies.push({
        target: pointerToSchemaPath(current.schema.$ref),
        reference: true,
      });
    }
    pushSchemaMap(
      stack,
      nodeDependencies,
      current.schema.definitions,
      `${current.path}/definitions`,
      current.depth,
    );
    pushSchemaMap(
      stack,
      nodeDependencies,
      current.schema.properties,
      `${current.path}/properties`,
      current.depth,
    );
    pushChildSchema(
      stack,
      nodeDependencies,
      current.schema.additionalProperties,
      `${current.path}/additionalProperties`,
      current.depth,
    );
    pushChildSchema(
      stack,
      nodeDependencies,
      current.schema.items,
      `${current.path}/items`,
      current.depth,
    );
  }

  for (const nodeDependencies of dependencies.values()) {
    for (const dependency of nodeDependencies) {
      if (schemas.has(dependency.target)) continue;
      throw new Error(
        `CSV output schema $ref does not resolve: ${dependency.target}`,
      );
    }
  }
  assertAcyclicReferences(dependencies);
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateStringArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`CSV output schema ${label} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`CSV output schema ${label} contains duplicates`);
  }
}

function validateNonnegativeInteger(value: unknown, keyword: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `CSV output schema ${keyword} must be a non-negative integer`,
    );
  }
}

function validateFiniteNumber(
  value: unknown,
  keyword: string,
  positive = false,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (positive && value <= 0)
  ) {
    throw new Error(
      `CSV output schema ${keyword} must be a ${positive ? "positive " : ""}finite number`,
    );
  }
}

function pushSchemaMap(
  stack: Array<{
    readonly schema: unknown;
    readonly path: string;
    readonly depth: number;
  }>,
  dependencies: SchemaDependency[],
  value: unknown,
  path: string,
  depth: number,
): void {
  if (value === undefined) return;
  if (!isPlainRecord(value)) {
    throw new Error(`CSV output schema ${path} must be an object`);
  }
  for (const [key, schema] of Object.entries(value)) {
    const childPath = `${path}/${escapeJsonPointer(key)}`;
    dependencies.push({ target: childPath, reference: false });
    stack.push({
      schema,
      path: childPath,
      depth: depth + 1,
    });
  }
}

function pushChildSchema(
  stack: Array<{
    readonly schema: unknown;
    readonly path: string;
    readonly depth: number;
  }>,
  dependencies: SchemaDependency[],
  value: unknown,
  path: string,
  depth: number,
): void {
  if (value === undefined) return;
  dependencies.push({ target: path, reference: false });
  stack.push({ schema: value, path, depth: depth + 1 });
}

function pointerToSchemaPath(reference: string): string {
  const segments = reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  return `#/${segments.map(escapeJsonPointer).join("/")}`;
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function assertAcyclicReferences(
  graph: ReadonlyMap<string, ReadonlyArray<SchemaDependency>>,
): void {
  const state = new Map<string, "visiting" | "visited">();
  let expansions = 0;
  for (const start of graph.keys()) {
    if (state.has(start)) continue;
    const stack: Array<{ readonly path: string; nextTarget: number }> = [
      { path: start, nextTarget: 0 },
    ];
    state.set(start, "visiting");
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const dependencies = graph.get(frame.path) ?? [];
      if (frame.nextTarget >= dependencies.length) {
        state.set(frame.path, "visited");
        stack.pop();
        continue;
      }
      const dependency = dependencies[frame.nextTarget]!;
      frame.nextTarget += 1;
      if (dependency.reference) {
        expansions += 1;
        if (expansions > CSV_MAX_OUTPUT_SCHEMA_REF_EXPANSIONS) {
          throw new Error(
            `CSV output schema exceeds ${CSV_MAX_OUTPUT_SCHEMA_REF_EXPANSIONS} $ref expansions`,
          );
        }
      }
      const target = dependency.target;
      const targetState = state.get(target);
      if (targetState === "visiting") {
        throw new Error(
          `CSV output schema contains a cyclic $ref at ${target}`,
        );
      }
      if (targetState === "visited") continue;
      state.set(target, "visiting");
      stack.push({ path: target, nextTarget: 0 });
    }
  }
}

function formatAjvErrors(
  errors: ReadonlyArray<ErrorObject> | null | undefined,
): string {
  const diagnostic = (errors ?? [])
    .slice(0, MAX_VALIDATION_ERRORS)
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? error.keyword}`,
    )
    .join("; ");
  const prefix = "result does not match the CSV output schema";
  const message = diagnostic.length === 0 ? prefix : `${prefix}: ${diagnostic}`;
  const bytes = Buffer.from(message, "utf8");
  return bytes.byteLength <= MAX_VALIDATION_DIAGNOSTIC_BYTES
    ? message
    : bytes.subarray(0, MAX_VALIDATION_DIAGNOSTIC_BYTES).toString("utf8");
}

function cacheCompiledSchema(
  key: string,
  compiled: CompiledCsvOutputSchema,
  accountedBytes: number,
): void {
  while (
    compiledSchemaCache.size >= CSV_MAX_COMPILED_SCHEMA_CACHE_ENTRIES ||
    compiledSchemaCacheBytes + accountedBytes >
      CSV_MAX_COMPILED_SCHEMA_CACHE_BYTES
  ) {
    const oldest = compiledSchemaCache.entries().next().value as
      [string, CachedSchema] | undefined;
    if (oldest === undefined) break;
    compiledSchemaCache.delete(oldest[0]);
    compiledSchemaCacheBytes -= oldest[1].accountedBytes;
  }
  if (accountedBytes > CSV_MAX_COMPILED_SCHEMA_CACHE_BYTES) return;
  compiledSchemaCache.set(key, {
    compiled,
    accountedBytes,
    lastUsedAt: Date.now(),
  });
  compiledSchemaCacheBytes += accountedBytes;
}

function evictExpiredSchemas(now: number): void {
  for (const [key, entry] of compiledSchemaCache) {
    if (now - entry.lastUsedAt <= CSV_COMPILED_SCHEMA_CACHE_TTL_MS) continue;
    compiledSchemaCache.delete(key);
    compiledSchemaCacheBytes -= entry.accountedBytes;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class CsvValidationWorkerPool {
  private readonly queuesByJob = new Map<string, ValidationJobQueue>();
  private readonly readyJobs: string[] = [];
  private readonly slots = new Set<ValidationWorkerSlot>();
  private readonly validationCpuMsByJob = new Map<string, number>();
  private readonly releaseWhenIdle = new Set<string>();
  private readyHead = 0;
  private queuedTasks = 0;
  private queuedBytes = 0;
  private totalValidationCpuMs = 0;
  private nextTaskId = 1;

  submit(options: {
    readonly kind: "compile" | "validate";
    readonly jobId: string;
    readonly schema: CompiledCsvOutputSchema;
    readonly resultJson?: string;
  }): Promise<string | null> {
    if (
      options.kind === "validate" &&
      (this.validationCpuMsByJob.get(options.jobId) ?? 0) >=
        CSV_MAX_RESULT_VALIDATION_CPU_MS_PER_JOB
    ) {
      return Promise.resolve(
        `CSV result validation CPU budget exceeded ${CSV_MAX_RESULT_VALIDATION_CPU_MS_PER_JOB} ms`,
      );
    }
    const accountedBytes =
      Buffer.byteLength(options.schema.canonicalJson, "utf8") +
      Buffer.byteLength(options.resultJson ?? "", "utf8") +
      Buffer.byteLength(options.jobId, "utf8") +
      256;
    if (
      this.queuedTasks >= CSV_MAX_VALIDATION_QUEUE ||
      this.queuedBytes + accountedBytes > CSV_MAX_VALIDATION_QUEUE_BYTES
    ) {
      return Promise.reject(
        new Error("CSV validation queue is full; report remains uncommitted"),
      );
    }
    return new Promise<string | null>((resolve, reject) => {
      const task: ValidationPoolTask = {
        id: this.nextTaskId,
        kind: options.kind,
        jobId: options.jobId,
        schemaDigest: options.schema.digest,
        schemaJson: options.schema.canonicalJson,
        ...(options.resultJson !== undefined
          ? { resultJson: options.resultJson }
          : {}),
        accountedBytes,
        resolve,
        reject,
      };
      this.nextTaskId += 1;
      let queue = this.queuesByJob.get(task.jobId);
      if (queue === undefined) {
        queue = { tasks: [], head: 0, enqueued: false };
        this.queuesByJob.set(task.jobId, queue);
      }
      queue.tasks.push(task);
      if (!queue.enqueued) {
        queue.enqueued = true;
        this.readyJobs.push(task.jobId);
      }
      this.queuedTasks += 1;
      this.queuedBytes += accountedBytes;
      this.drain();
    });
  }

  metrics(): CsvValidationPoolMetrics {
    const jobIds = new Set<string>([
      ...this.queuesByJob.keys(),
      ...this.validationCpuMsByJob.keys(),
    ]);
    for (const slot of this.slots) {
      if (slot.task !== undefined) jobIds.add(slot.task.jobId);
    }
    const jobs = [...jobIds].sort().map((jobId): CsvValidationJobMetrics => {
      const queue = this.queuesByJob.get(jobId);
      return {
        jobId,
        queuedTasks: queue === undefined ? 0 : queue.tasks.length - queue.head,
        activeTasks: [...this.slots].filter(
          (slot) => slot.task?.jobId === jobId,
        ).length,
        validationCpuMs: this.validationCpuMsByJob.get(jobId) ?? 0,
      };
    });
    return {
      workerCount: this.slots.size,
      activeTasks: [...this.slots].filter((slot) => slot.task !== undefined)
        .length,
      queuedTasks: this.queuedTasks,
      queuedBytes: this.queuedBytes,
      totalValidationCpuMs: this.totalValidationCpuMs,
      jobs,
    };
  }

  releaseJob(jobId: string): void {
    if (this.hasJobWork(jobId)) {
      this.releaseWhenIdle.add(jobId);
      return;
    }
    this.validationCpuMsByJob.delete(jobId);
    this.releaseWhenIdle.delete(jobId);
  }

  private drain(): void {
    while (this.queuedTasks > 0) {
      let slot = [...this.slots].find(
        (candidate) => candidate.task === undefined,
      );
      if (slot === undefined) {
        if (this.slots.size >= CSV_MAX_VALIDATION_WORKERS) return;
        slot = this.createSlot();
      }
      const task = this.dequeueTask();
      if (task === undefined) return;
      slot.task = task;
      this.armTimer(
        slot,
        CSV_MAX_SCHEMA_COMPILE_MS,
        "schema compilation",
        false,
      );
      slot.worker.postMessage({
        taskId: task.id,
        kind: task.kind,
        schemaDigest: task.schemaDigest,
        schemaJson: task.schemaJson,
        resultJson: task.resultJson,
      });
    }
  }

  private dequeueTask(): ValidationPoolTask | undefined {
    while (this.readyHead < this.readyJobs.length) {
      const jobId = this.readyJobs[this.readyHead]!;
      this.readyHead += 1;
      const queue = this.queuesByJob.get(jobId);
      if (queue === undefined) continue;
      queue.enqueued = false;
      const task = queue.tasks[queue.head];
      if (task === undefined) {
        this.queuesByJob.delete(jobId);
        continue;
      }
      queue.head += 1;
      this.queuedTasks -= 1;
      this.queuedBytes = Math.max(0, this.queuedBytes - task.accountedBytes);
      if (queue.head < queue.tasks.length) {
        queue.enqueued = true;
        this.readyJobs.push(jobId);
      } else {
        this.queuesByJob.delete(jobId);
      }
      this.compactReadyJobs();
      return task;
    }
    this.compactReadyJobs(true);
    return undefined;
  }

  private compactReadyJobs(force = false): void {
    if (
      this.readyHead === 0 ||
      (!force &&
        (this.readyHead < 4_096 || this.readyHead * 2 < this.readyJobs.length))
    ) {
      return;
    }
    this.readyJobs.splice(0, this.readyHead);
    this.readyHead = 0;
  }

  private createSlot(): ValidationWorkerSlot {
    const require = createRequire(import.meta.url);
    const worker = new Worker(CSV_VALIDATION_WORKER_SOURCE, {
      eval: true,
      workerData: {
        ajvModulePath: require.resolve("ajv"),
        ajvVersion: AJV_RUNTIME_VERSION,
        contractVersion: CSV_OUTPUT_SCHEMA_CONTRACT_VERSION,
        maxCacheEntries: Math.max(
          1,
          Math.floor(
            CSV_MAX_COMPILED_SCHEMA_CACHE_ENTRIES / CSV_MAX_VALIDATION_WORKERS,
          ),
        ),
        maxCacheBytes: Math.max(
          1,
          Math.floor(
            CSV_MAX_COMPILED_SCHEMA_CACHE_BYTES / CSV_MAX_VALIDATION_WORKERS,
          ),
        ),
        cacheTtlMs: CSV_COMPILED_SCHEMA_CACHE_TTL_MS,
      },
    });
    worker.unref();
    const slot: ValidationWorkerSlot = { worker };
    this.slots.add(slot);
    worker.on("message", (message: ValidationWorkerMessage) => {
      this.handleMessage(slot, message);
    });
    worker.on("error", (error) => {
      this.failSlot(
        slot,
        new Error(
          truncateDiagnostic(
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    });
    worker.on("exit", (code) => {
      if (this.slots.has(slot)) {
        this.failSlot(
          slot,
          new Error(
            `CSV validation worker exited unexpectedly with code ${code}`,
          ),
        );
      }
    });
    return slot;
  }

  private handleMessage(
    slot: ValidationWorkerSlot,
    message: ValidationWorkerMessage,
  ): void {
    const task = slot.task;
    if (task === undefined || message.taskId !== task.id) return;
    if (message.phase === "compiled") {
      if (task.kind === "validate") {
        this.armTimer(
          slot,
          CSV_MAX_RESULT_VALIDATION_MS,
          "result validation",
          true,
        );
      }
      return;
    }
    this.clearTimer(slot);
    slot.task = undefined;
    if (message.phase === "error") {
      task.reject(
        new Error(
          truncateDiagnostic(message.message ?? "CSV validation worker failed"),
        ),
      );
      this.cleanupReleasedJob(task.jobId);
      this.drain();
      return;
    }
    const validationMs =
      task.kind === "validate" &&
      typeof message.validationMs === "number" &&
      Number.isFinite(message.validationMs) &&
      message.validationMs >= 0
        ? message.validationMs
        : 0;
    const used = this.chargeValidationCpu(task, validationMs);
    if (task.kind === "compile") {
      task.resolve(null);
    } else if (used > CSV_MAX_RESULT_VALIDATION_CPU_MS_PER_JOB) {
      task.resolve(
        `CSV result validation CPU budget exceeded ${CSV_MAX_RESULT_VALIDATION_CPU_MS_PER_JOB} ms`,
      );
    } else {
      task.resolve(formatWorkerValidationErrors(message.errors));
    }
    this.cleanupReleasedJob(task.jobId);
    this.drain();
  }

  private armTimer(
    slot: ValidationWorkerSlot,
    milliseconds: number,
    phase: string,
    chargeTimeoutToJob: boolean,
  ): void {
    this.clearTimer(slot);
    slot.timer = setTimeout(() => {
      if (chargeTimeoutToJob && slot.task !== undefined) {
        this.chargeValidationCpu(slot.task, milliseconds);
      }
      this.failSlot(
        slot,
        new Error(`CSV ${phase} exceeded ${milliseconds} ms`),
      );
    }, milliseconds);
    slot.timer.unref?.();
  }

  private clearTimer(slot: ValidationWorkerSlot): void {
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    delete slot.timer;
  }

  private failSlot(slot: ValidationWorkerSlot, error: Error): void {
    if (!this.slots.delete(slot)) return;
    this.clearTimer(slot);
    const task = slot.task;
    delete slot.task;
    void slot.worker.terminate().catch(() => {});
    task?.reject(new Error(truncateDiagnostic(error.message)));
    if (task !== undefined) this.cleanupReleasedJob(task.jobId);
    this.drain();
  }

  private chargeValidationCpu(
    task: ValidationPoolTask,
    milliseconds: number,
  ): number {
    const previous = this.validationCpuMsByJob.get(task.jobId) ?? 0;
    if (task.kind !== "validate") return previous;
    const bounded = Math.max(
      0,
      Math.min(milliseconds, CSV_MAX_RESULT_VALIDATION_MS),
    );
    const used = previous + bounded;
    this.validationCpuMsByJob.set(task.jobId, used);
    this.totalValidationCpuMs += bounded;
    return used;
  }

  private hasJobWork(jobId: string): boolean {
    if (this.queuesByJob.has(jobId)) return true;
    return [...this.slots].some((slot) => slot.task?.jobId === jobId);
  }

  private cleanupReleasedJob(jobId: string): void {
    if (!this.releaseWhenIdle.has(jobId) || this.hasJobWork(jobId)) return;
    this.releaseWhenIdle.delete(jobId);
    this.validationCpuMsByJob.delete(jobId);
  }
}

function formatWorkerValidationErrors(
  errors: ValidationWorkerMessage["errors"],
): string | null {
  if (errors === undefined || errors.length === 0) return null;
  const diagnostic = errors
    .slice(0, MAX_VALIDATION_ERRORS)
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? error.keyword ?? "invalid"}`,
    )
    .join("; ");
  return truncateDiagnostic(
    `result does not match the CSV output schema: ${diagnostic}`,
  );
}

function truncateDiagnostic(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  if (bytes.byteLength <= MAX_VALIDATION_DIAGNOSTIC_BYTES) return message;
  let end = MAX_VALIDATION_DIAGNOSTIC_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

const CSV_VALIDATION_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const AjvModule = require(workerData.ajvModulePath);
const Ajv = AjvModule.Ajv || AjvModule.default || AjvModule;
const cache = new Map();
let cacheBytes = 0;

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.byteLength <= maxBytes) return bytes.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function safeErrors(errors) {
  return (errors || []).slice(0, 10).map((error) => ({
    instancePath: truncateUtf8(error.instancePath || "", 1_024),
    keyword: truncateUtf8(error.keyword || "invalid", 128),
    message: truncateUtf8(error.message || "invalid", 1_024),
  }));
}

function validatorFor(digest, schemaJson) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.usedAt > workerData.cacheTtlMs) {
      cache.delete(key);
      cacheBytes -= entry.bytes;
    }
  }
  const cacheKey = [workerData.contractVersion, workerData.ajvVersion, digest].join(":");
  const cached = cache.get(cacheKey);
  if (cached) {
    if (cached.schemaJson !== schemaJson) {
      throw new Error("CSV output schema digest collision");
    }
    cached.usedAt = now;
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached.validator;
  }
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    strictSchema: true,
    validateSchema: true,
    allowUnionTypes: false,
    inlineRefs: false,
    messages: true,
  });
  const validator = ajv.compile(JSON.parse(schemaJson));
  const bytes =
    Buffer.byteLength(schemaJson, "utf8") +
    Buffer.byteLength(String(validator), "utf8") +
    256;
  while (
    cache.size > 0 &&
    (cache.size >= workerData.maxCacheEntries ||
      cacheBytes + bytes > workerData.maxCacheBytes)
  ) {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheBytes -= oldest.bytes;
  }
  if (bytes <= workerData.maxCacheBytes) {
    cache.set(cacheKey, { validator, usedAt: now, bytes, schemaJson });
    cacheBytes += bytes;
  }
  return validator;
}

parentPort.on("message", (task) => {
  try {
    const validator = validatorFor(task.schemaDigest, task.schemaJson);
    parentPort.postMessage({ taskId: task.taskId, phase: "compiled" });
    if (task.kind === "compile") {
      parentPort.postMessage({ taskId: task.taskId, phase: "done", validationMs: 0 });
      return;
    }
    const started = performance.now();
    const value = JSON.parse(task.resultJson);
    const valid = validator(value);
    const validationMs = performance.now() - started;
    parentPort.postMessage({
      taskId: task.taskId,
      phase: "done",
      validationMs,
      errors: valid ? [] : safeErrors(validator.errors),
    });
  } catch (error) {
    parentPort.postMessage({
      taskId: task.taskId,
      phase: "error",
      message: truncateUtf8(
        error instanceof Error ? error.message : String(error),
        4_096,
      ),
    });
  }
});
`;
