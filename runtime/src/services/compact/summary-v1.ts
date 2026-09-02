import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  COMPACTION_SUMMARY_DIGEST_DOMAIN,
  COMPACTION_SUMMARY_KIND,
  COMPACTION_SUMMARY_VERSION,
  MAX_COMPACTION_FACTS_PER_OUTPUT,
  MAX_COMPACTION_NARRATIVE_UTF8_BYTES,
  MAX_COMPACTION_OPEN_ACTIONS_PER_OUTPUT,
  MAX_COMPACTION_OUTPUT_DEPTH,
  MAX_COMPACTION_OUTPUT_NODES_PER_CALL,
  MAX_COMPACTION_OUTPUT_UTF8_BYTES_PER_CALL,
  MAX_COMPACTION_PROVENANCE_REFERENCES_PER_OUTPUT,
  MAX_COMPACTION_RECORD_ID_UTF8_BYTES,
  MAX_COMPACTION_RECORD_TEXT_UTF8_BYTES,
  MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT,
  MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES,
  MAX_COMPACTION_TOOL_PAIRS_PER_OUTPUT,
  type CompactionBodyRecordV1,
  type CompactionSourceRefV1,
  type CompactionStage,
  type CompactionSummaryBodyV1,
  type CompactionSummaryV1,
  type CompactionToolPairV1,
  CompactionTransactionError,
} from "./transaction-types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const HEX_DIGIT_PATTERN = /^[0-9a-fA-F]$/u;
const INJECTION_CONTROL_MARKERS = Object.freeze([
  "\u0000agenc.compaction-policy",
  "<compaction_policy>",
  "</compaction_policy>",
  "<trusted_schema>",
  "</trusted_schema>",
]);

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

interface JsonObjectFrame {
  readonly kind: "object";
  readonly value: JsonObject;
  readonly keys: Set<string>;
  state: "key_or_end" | "colon" | "value" | "comma_or_end";
  afterComma: boolean;
  pendingKey?: string;
}

interface JsonArrayFrame {
  readonly kind: "array";
  readonly value: JsonValue[];
  state: "value_or_end" | "comma_or_end";
  afterComma: boolean;
}

type JsonFrame = JsonObjectFrame | JsonArrayFrame;

export interface CompactionOutputBudget {
  readonly bytes: number;
  readonly nodes: number;
  readonly workUnits: number;
  readonly provenanceReferences: number;
}

export interface ValidatedCompactionBody {
  readonly body: CompactionSummaryBodyV1;
  readonly budget: CompactionOutputBudget;
}

export interface CreateCompactionSummaryInput {
  readonly stage: CompactionStage;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly accountingRef: string;
  readonly sourceRefs: readonly CompactionSourceRefV1[];
  readonly body: CompactionSummaryBodyV1;
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestWithDomain(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalizeJson(value)}`);
}

/**
 * RFC 8785 JSON Canonicalization Scheme for the JSON-compatible values used by
 * compaction. Traversal is iterative so hostile depth cannot consume the JS
 * call stack. Object keys use ECMAScript UTF-16 code-unit order as required by
 * JCS; number and string rendering use the ECMAScript JSON serializer.
 */
export function canonicalizeJson(value: unknown): string {
  assertSafeProgrammaticJson(value);
  type RenderFrame =
    | { readonly kind: "value"; readonly value: JsonValue }
    | { readonly kind: "literal"; readonly value: string };
  const frames: RenderFrame[] = [{ kind: "value", value: value as JsonValue }];
  const output: string[] = [];
  while (frames.length > 0) {
    const frame = frames.pop()!;
    if (frame.kind === "literal") {
      output.push(frame.value);
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current !== "object") {
      const rendered = JSON.stringify(current);
      if (rendered === undefined) throw invalid("value is not canonical JSON");
      output.push(rendered);
      continue;
    }
    if (Array.isArray(current)) {
      frames.push({ kind: "literal", value: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        frames.push({ kind: "value", value: current[index]! });
        if (index > 0) frames.push({ kind: "literal", value: "," });
      }
      frames.push({ kind: "literal", value: "[" });
      continue;
    }
    const keys = Object.keys(current).sort();
    frames.push({ kind: "literal", value: "}" });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      frames.push({ kind: "value", value: current[key]! });
      frames.push({ kind: "literal", value: ":" });
      frames.push({ kind: "literal", value: JSON.stringify(key) });
      if (index > 0) frames.push({ kind: "literal", value: "," });
    }
    frames.push({ kind: "literal", value: "{" });
  }
  return output.join("");
}

export function createCompactionSummaryV1(
  input: CreateCompactionSummaryInput,
): CompactionSummaryV1 {
  assertDigest(input.policyDigest, "policy_digest");
  assertBoundedText(input.attemptId, MAX_COMPACTION_RECORD_ID_UTF8_BYTES, "attempt_id");
  assertBoundedText(
    input.accountingRef,
    MAX_COMPACTION_RECORD_ID_UTF8_BYTES,
    "accounting_ref",
  );
  validateSourceRefs(input.sourceRefs);
  const withoutDigest = {
    version: COMPACTION_SUMMARY_VERSION,
    kind: COMPACTION_SUMMARY_KIND,
    stage: input.stage,
    attempt_id: input.attemptId,
    policy_digest: input.policyDigest,
    accounting_ref: input.accountingRef,
    source_refs: input.sourceRefs,
    body: input.body,
  } as const;
  return {
    ...withoutDigest,
    summary_sha256: sha256Hex(
      `${COMPACTION_SUMMARY_DIGEST_DOMAIN}${canonicalizeJson(withoutDigest)}`,
    ),
  };
}

export function verifyCompactionSummaryDigest(summary: CompactionSummaryV1): void {
  const withoutDigest = {
    version: summary.version,
    kind: summary.kind,
    stage: summary.stage,
    attempt_id: summary.attempt_id,
    policy_digest: summary.policy_digest,
    accounting_ref: summary.accounting_ref,
    source_refs: summary.source_refs,
    body: summary.body,
  };
  const expected = sha256Hex(
    `${COMPACTION_SUMMARY_DIGEST_DOMAIN}${canonicalizeJson(withoutDigest)}`,
  );
  if (summary.summary_sha256 !== expected) {
    throw new CompactionTransactionError(
      "digest_invalid",
      "compaction summary digest does not match its RFC 8785 preimage",
    );
  }
}

/** Parse JSON without losing duplicate-key evidence, then validate exact V1 body. */
export function parseCompactionBodyV1(
  json: string,
  allowedSourceRefIds: ReadonlySet<string>,
): ValidatedCompactionBody {
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes === 0) throw invalid("provider returned an empty compaction body");
  if (bytes > MAX_COMPACTION_OUTPUT_UTF8_BYTES_PER_CALL) {
    throw limit("provider output exceeds the per-call byte limit");
  }
  const parsed = parseJsonIteratively(json);
  const cloned = cloneAndValidateProgrammaticJson(parsed.value);
  const body = validateBody(cloned, allowedSourceRefIds, parsed.workUnits);
  return {
    body,
    budget: {
      bytes,
      nodes: parsed.nodes,
      workUnits: parsed.workUnits,
      provenanceReferences: countProvenanceReferences(body),
    },
  };
}

/** Validate a programmatic provider body while rejecting proxies/getters/cycles. */
export function validateProgrammaticCompactionBodyV1(
  value: unknown,
  allowedSourceRefIds: ReadonlySet<string>,
): ValidatedCompactionBody {
  const cloned = cloneAndValidateProgrammaticJson(value);
  const encoded = canonicalizeJson(cloned);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_COMPACTION_OUTPUT_UTF8_BYTES_PER_CALL) {
    throw limit("provider output exceeds the per-call byte limit");
  }
  const measured = measureJsonValue(cloned);
  const body = validateBody(cloned, allowedSourceRefIds, measured.workUnits);
  return {
    body,
    budget: {
      bytes,
      nodes: measured.nodes,
      workUnits: measured.workUnits,
      provenanceReferences: countProvenanceReferences(body),
    },
  };
}

/**
 * Expand summary references without recursion and prove the final ordered leaf
 * sequence equals the preflight plan exactly once.
 */
export function validateCompactionProvenance(params: {
  readonly final: CompactionSummaryV1;
  readonly summariesById: ReadonlyMap<string, CompactionSummaryV1>;
  readonly plannedLeaves: readonly CompactionSourceRefV1[];
  readonly allowedChildrenBySummaryId?: ReadonlyMap<string, ReadonlySet<string>>;
}): void {
  const plannedLeafIds = params.plannedLeaves.map((leaf) => leaf.ref_id);
  const leafById = new Map(params.plannedLeaves.map((leaf) => [leaf.ref_id, leaf]));
  const expanded: string[] = [];
  const active = new Set<string>();
  const completed = new Set<string>();
  type Frame =
    | { readonly kind: "visit"; readonly ref: CompactionSourceRefV1; readonly parent?: string }
    | { readonly kind: "leave"; readonly id: string };
  const frames: Frame[] = [];
  for (let index = params.final.source_refs.length - 1; index >= 0; index -= 1) {
    frames.push({ kind: "visit", ref: params.final.source_refs[index]! });
  }
  let work = 0;
  while (frames.length > 0) {
    work += 1;
    if (work > MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT) {
      throw limit("provenance expansion exceeds its work limit");
    }
    const frame = frames.pop()!;
    if (frame.kind === "leave") {
      active.delete(frame.id);
      completed.add(frame.id);
      continue;
    }
    if (frame.ref.kind === "rollout_span") {
      const planned = leafById.get(frame.ref.ref_id);
      if (planned === undefined || canonicalizeJson(planned) !== canonicalizeJson(frame.ref)) {
        throw provenance("summary references an unplanned or mutated rollout span");
      }
      expanded.push(frame.ref.ref_id);
      continue;
    }
    const id = frame.ref.ref_id;
    if (active.has(id)) throw provenance("compaction provenance contains a cycle");
    if (completed.has(id)) {
      throw provenance("compaction provenance references a summary more than once");
    }
    const child = params.summariesById.get(id);
    if (child === undefined || child.summary_sha256 !== frame.ref.sha256) {
      throw provenance("compaction provenance references an unknown summary digest");
    }
    verifyCompactionSummaryDigest(child);
    const allowedChildren = params.allowedChildrenBySummaryId?.get(id);
    if (
      allowedChildren !== undefined &&
      child.source_refs.some((ref) => !allowedChildren.has(ref.ref_id))
    ) {
      throw provenance("intermediate summary references an unplanned child");
    }
    active.add(id);
    frames.push({ kind: "leave", id });
    for (let index = child.source_refs.length - 1; index >= 0; index -= 1) {
      frames.push({ kind: "visit", ref: child.source_refs[index]!, parent: id });
    }
  }
  if (
    expanded.length !== plannedLeafIds.length ||
    expanded.some((id, index) => id !== plannedLeafIds[index])
  ) {
    throw provenance(
      "final provenance must cover every planned rollout span exactly once and in order",
    );
  }
}

function parseJsonIteratively(text: string): {
  readonly value: JsonValue;
  readonly nodes: number;
  readonly workUnits: number;
} {
  let index = 0;
  let nodes = 0;
  let workUnits = 0;
  let root: JsonValue | undefined;
  let rootSet = false;
  const stack: JsonFrame[] = [];

  const spend = (units = 1): void => {
    workUnits += units;
    if (workUnits > MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT) {
      throw limit("JSON decoding exceeds its work limit");
    }
  };
  const skipWhitespace = (): void => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      index += 1;
      spend();
    }
  };
  const addNode = (): void => {
    nodes += 1;
    if (nodes > MAX_COMPACTION_OUTPUT_NODES_PER_CALL) {
      throw limit("JSON output exceeds its node limit");
    }
  };
  const attachValue = (value: JsonValue): void => {
    addNode();
    const parent = stack.at(-1);
    if (parent === undefined) {
      if (rootSet) throw invalid("provider output contains multiple JSON values");
      root = value;
      rootSet = true;
      return;
    }
    if (parent.kind === "array") {
      if (parent.state !== "value_or_end") throw invalid("unexpected JSON value");
      parent.value.push(value);
      parent.state = "comma_or_end";
      parent.afterComma = false;
      return;
    }
    if (parent.state !== "value" || parent.pendingKey === undefined) {
      throw invalid("unexpected JSON object value");
    }
    parent.value[parent.pendingKey] = value;
    delete parent.pendingKey;
    parent.state = "comma_or_end";
    parent.afterComma = false;
  };
  const parseString = (): string => {
    if (text[index] !== '"') throw invalid("expected JSON string");
    index += 1;
    spend();
    let output = "";
    while (index < text.length) {
      const char = text[index]!;
      index += 1;
      spend();
      if (char === '"') {
        assertUnicodeScalarString(output, "JSON string");
        return output;
      }
      if (char === "\\") {
        const escaped = text[index];
        if (escaped === undefined) throw invalid("unterminated JSON escape");
        index += 1;
        spend();
        if (escaped === '"' || escaped === "\\" || escaped === "/") output += escaped;
        else if (escaped === "b") output += "\b";
        else if (escaped === "f") output += "\f";
        else if (escaped === "n") output += "\n";
        else if (escaped === "r") output += "\r";
        else if (escaped === "t") output += "\t";
        else if (escaped === "u") {
          const digits = text.slice(index, index + 4);
          if (digits.length !== 4 || [...digits].some((digit) => !HEX_DIGIT_PATTERN.test(digit))) {
            throw invalid("invalid JSON Unicode escape");
          }
          output += String.fromCharCode(Number.parseInt(digits, 16));
          index += 4;
          spend(4);
        } else throw invalid("invalid JSON escape");
        continue;
      }
      if (char.charCodeAt(0) < 0x20) throw invalid("JSON string contains a control byte");
      output += char;
    }
    throw invalid("unterminated JSON string");
  };
  const parseValue = (): void => {
    skipWhitespace();
    const char = text[index];
    if (char === "{") {
      const value = Object.create(null) as JsonObject;
      attachValue(value);
      index += 1;
      spend();
      if (stack.length + 1 > MAX_COMPACTION_OUTPUT_DEPTH) {
        throw limit("JSON output exceeds its depth limit");
      }
      stack.push({
        kind: "object",
        value,
        keys: new Set(),
        state: "key_or_end",
        afterComma: false,
      });
      return;
    }
    if (char === "[") {
      const value: JsonValue[] = [];
      attachValue(value);
      index += 1;
      spend();
      if (stack.length + 1 > MAX_COMPACTION_OUTPUT_DEPTH) {
        throw limit("JSON output exceeds its depth limit");
      }
      stack.push({
        kind: "array",
        value,
        state: "value_or_end",
        afterComma: false,
      });
      return;
    }
    if (char === '"') {
      attachValue(parseString());
      return;
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        spend(literal.length);
        attachValue(value);
        return;
      }
    }
    const numberEnd = scanJsonNumber(text, index);
    if (numberEnd !== undefined) {
      const token = text.substring(index, numberEnd);
      index += token.length;
      spend(token.length);
      const number = Number(token);
      if (!Number.isFinite(number)) throw invalid("JSON number is not finite");
      attachValue(number);
      return;
    }
    throw invalid("provider output is not valid JSON");
  };

  while (true) {
    skipWhitespace();
    const frame = stack.at(-1);
    if (frame === undefined) {
      if (!rootSet) {
        parseValue();
        continue;
      }
      skipWhitespace();
      if (index !== text.length) throw invalid("provider output has trailing JSON bytes");
      break;
    }
    if (frame.kind === "array") {
      if (frame.state === "value_or_end") {
        if (text[index] === "]") {
          if (frame.afterComma) throw invalid("JSON array has a trailing comma");
          index += 1;
          spend();
          stack.pop();
          continue;
        }
        parseValue();
        continue;
      }
      if (text[index] === ",") {
        index += 1;
        spend();
        frame.state = "value_or_end";
        frame.afterComma = true;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        spend();
        stack.pop();
        continue;
      }
      throw invalid("expected comma or end of JSON array");
    }
    if (frame.state === "key_or_end") {
      if (text[index] === "}") {
        if (frame.afterComma) throw invalid("JSON object has a trailing comma");
        index += 1;
        spend();
        stack.pop();
        continue;
      }
      const key = parseString();
      if (frame.keys.has(key)) throw invalid(`duplicate JSON object key: ${key}`);
      frame.keys.add(key);
      frame.pendingKey = key;
      frame.state = "colon";
      frame.afterComma = false;
      continue;
    }
    if (frame.state === "colon") {
      skipWhitespace();
      if (text[index] !== ":") throw invalid("expected JSON object colon");
      index += 1;
      spend();
      frame.state = "value";
      continue;
    }
    if (frame.state === "value") {
      parseValue();
      continue;
    }
    if (text[index] === ",") {
      index += 1;
      spend();
      frame.state = "key_or_end";
      frame.afterComma = true;
      continue;
    }
    if (text[index] === "}") {
      index += 1;
      spend();
      stack.pop();
      continue;
    }
    throw invalid("expected comma or end of JSON object");
  }
  if (root === undefined) throw invalid("provider output contains no JSON value");
  return { value: root, nodes, workUnits };
}

function cloneAndValidateProgrammaticJson(value: unknown): JsonValue {
  if (value === null || typeof value !== "object") {
    return clonePrimitive(value);
  }
  type CloneFrame = {
    readonly input: object;
    readonly output: JsonObject | JsonValue[];
    readonly depth: number;
    readonly parent?: CloneFrame;
  };
  const makeContainer = (input: object): JsonObject | JsonValue[] => {
    if (utilTypes.isProxy(input)) throw invalid("provider output contains a proxy");
    if (Array.isArray(input)) return [];
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid("provider output contains an exotic object");
    }
    return Object.create(null) as JsonObject;
  };
  const root = makeContainer(value);
  const stack: CloneFrame[] = [{ input: value, output: root, depth: 1 }];
  let nodes = 1;
  let work = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.depth > MAX_COMPACTION_OUTPUT_DEPTH) {
      throw limit("provider output exceeds its depth limit");
    }
    const descriptors = Object.getOwnPropertyDescriptors(frame.input);
    const keys = Reflect.ownKeys(descriptors);
    for (const key of keys) {
      work += 1;
      if (work > MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT) {
        throw limit("provider output exceeds its clone work limit");
      }
      if (typeof key !== "string") throw invalid("provider output contains a symbol key");
      const descriptor = descriptors[key]!;
      if (Array.isArray(frame.input) && key === "length") continue;
      if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw invalid("provider output contains a getter or hidden property");
      }
      const child = descriptor.value as unknown;
      const cloned =
        child !== null && typeof child === "object"
          ? makeContainer(child)
          : clonePrimitive(child);
      if (Array.isArray(frame.output)) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) {
          throw invalid("provider output array contains a named property");
        }
        const itemIndex = Number(key);
        if (itemIndex !== frame.output.length) {
          throw invalid("provider output contains a sparse array");
        }
        frame.output.push(cloned);
      } else {
        frame.output[key] = cloned;
      }
      nodes += 1;
      if (nodes > MAX_COMPACTION_OUTPUT_NODES_PER_CALL) {
        throw limit("provider output exceeds its node limit");
      }
      if (child !== null && typeof child === "object") {
        for (let ancestor: CloneFrame | undefined = frame; ancestor !== undefined; ancestor = ancestor.parent) {
          if (ancestor.input === child) {
            throw invalid("provider output contains a cycle");
          }
        }
        stack.push({
          input: child,
          output: cloned as JsonObject | JsonValue[],
          depth: frame.depth + 1,
          parent: frame,
        });
      }
    }
  }
  return root;
}

function assertSafeProgrammaticJson(value: unknown): void {
  cloneAndValidateProgrammaticJson(value);
}

function clonePrimitive(value: unknown): JsonPrimitive {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    assertUnicodeScalarString(value, "JSON string");
    return value;
  }
  throw invalid("provider output contains a non-JSON scalar");
}

function measureJsonValue(value: JsonValue): { readonly nodes: number; readonly workUnits: number } {
  const stack: Array<{ readonly value: JsonValue; readonly depth: number }> = [
    { value, depth: 1 },
  ];
  let nodes = 0;
  let workUnits = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    workUnits += 1;
    if (nodes > MAX_COMPACTION_OUTPUT_NODES_PER_CALL) throw limit("output node limit exceeded");
    if (workUnits > MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT) throw limit("output work limit exceeded");
    if (current.depth > MAX_COMPACTION_OUTPUT_DEPTH) throw limit("output depth limit exceeded");
    if (current.value === null || typeof current.value !== "object") continue;
    const container = current.value;
    const children = Array.isArray(container)
      ? container
      : Object.keys(container).map((key) => container[key]!);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index]!, depth: current.depth + 1 });
    }
  }
  return { nodes, workUnits };
}

function validateBody(
  value: JsonValue,
  allowedSourceRefIds: ReadonlySet<string>,
  initialWork: number,
): CompactionSummaryBodyV1 {
  let work = initialWork;
  const spend = (units = 1): void => {
    work += units;
    if (work > MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT) {
      throw limit("compaction schema validation exceeds its work limit");
    }
  };
  // tool_pairs is optional: the runtime records every tool call/result pair
  // itself from the source history. A model that still echoes them must
  // echo them exactly (checked by the transaction), but a body without
  // them is complete. Echoing 200+ sha256 digests used to cost more output
  // than the intermediate-token reserve allowed, and no long session
  // could ever compact.
  const hasToolPairs =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "tool_pairs");
  const body = requireExactObject(
    value,
    hasToolPairs
      ? ["narrative", "facts", "open_actions", "tool_pairs"]
      : ["narrative", "facts", "open_actions"],
    "compaction body",
  );
  spend(4);
  const narrative = requireBoundedString(
    body.narrative,
    MAX_COMPACTION_NARRATIVE_UTF8_BYTES,
    "narrative",
  );
  const recordIds = new Set<string>();
  const facts = validateRecords(
    body.facts,
    MAX_COMPACTION_FACTS_PER_OUTPUT,
    "facts",
    allowedSourceRefIds,
    recordIds,
    spend,
  );
  const openActions = validateRecords(
    body.open_actions,
    MAX_COMPACTION_OPEN_ACTIONS_PER_OUTPUT,
    "open_actions",
    allowedSourceRefIds,
    recordIds,
    spend,
  );
  const toolPairs = validateToolPairs(body.tool_pairs, spend);
  const provenanceReferences =
    facts.reduce((total, record) => total + record.source_ref_ids.length, 0) +
    openActions.reduce((total, record) => total + record.source_ref_ids.length, 0);
  if (provenanceReferences > MAX_COMPACTION_PROVENANCE_REFERENCES_PER_OUTPUT) {
    throw limit("compaction body exceeds its provenance-reference limit");
  }
  if (narrative.length === 0 && facts.length === 0 && openActions.length === 0) {
    throw invalid("compaction body is empty");
  }
  return {
    narrative,
    facts,
    open_actions: openActions,
    tool_pairs: toolPairs,
  };
}

function validateRecords(
  value: JsonValue | undefined,
  maximum: number,
  label: string,
  allowedSourceRefIds: ReadonlySet<string>,
  ids: Set<string>,
  spend: (units?: number) => void,
): readonly CompactionBodyRecordV1[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  if (value.length > maximum) throw limit(`${label} exceeds its record limit`);
  return value.map((candidate, index) => {
    spend(1);
    // With a single allowed source ref every record cites the same 50-odd
    // characters; the model may leave source_ref_ids out and the runtime
    // fills in the one ref there is. With several refs the citation stays
    // mandatory.
    const citesExplicitly =
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      Object.hasOwn(candidate, "source_ref_ids");
    const impliedRef =
      !citesExplicitly && allowedSourceRefIds.size === 1
        ? [...allowedSourceRefIds]
        : undefined;
    const record = requireExactObject(
      candidate,
      impliedRef === undefined ? ["id", "text", "source_ref_ids"] : ["id", "text"],
      `${label}[${index}]`,
    );
    const id = requireBoundedString(
      record.id,
      MAX_COMPACTION_RECORD_ID_UTF8_BYTES,
      `${label}[${index}].id`,
    );
    if (ids.has(id)) throw invalid(`${label} contains duplicate id ${id}`);
    ids.add(id);
    const text = requireBoundedString(
      record.text,
      MAX_COMPACTION_RECORD_TEXT_UTF8_BYTES,
      `${label}[${index}].text`,
    );
    const citedRefs = impliedRef ?? record.source_ref_ids;
    if (!Array.isArray(citedRefs) || citedRefs.length === 0) {
      throw provenance(`${label}[${index}] must cite at least one source ref`);
    }
    const sourceIds = new Set<string>();
    const sourceRefIds = citedRefs.map((sourceId, sourceIndex) => {
      spend(1);
      const validated = requireBoundedString(
        sourceId,
        MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES,
        `${label}[${index}].source_ref_ids[${sourceIndex}]`,
      );
      if (!allowedSourceRefIds.has(validated)) {
        throw provenance(`${label}[${index}] cites an unplanned source ref`);
      }
      if (sourceIds.has(validated)) {
        throw provenance(`${label}[${index}] contains a duplicate source ref`);
      }
      sourceIds.add(validated);
      return validated;
    });
    return { id, text, source_ref_ids: sourceRefIds };
  });
}

function validateToolPairs(
  value: JsonValue | undefined,
  spend: (units?: number) => void,
): readonly CompactionToolPairV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("tool_pairs must be an array");
  if (value.length > MAX_COMPACTION_TOOL_PAIRS_PER_OUTPUT) {
    throw limit("tool_pairs exceeds its record limit");
  }
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    spend(1);
    const pair = requireExactObject(
      candidate,
      ["tool_call_id", "result_sha256"],
      `tool_pairs[${index}]`,
    );
    const toolCallId = requireBoundedString(
      pair.tool_call_id,
      MAX_COMPACTION_RECORD_ID_UTF8_BYTES,
      `tool_pairs[${index}].tool_call_id`,
    );
    if (ids.has(toolCallId)) throw invalid("tool_pairs contains a duplicate tool call id");
    ids.add(toolCallId);
    const resultSha256 = requireBoundedString(
      pair.result_sha256,
      MAX_COMPACTION_RECORD_ID_UTF8_BYTES,
      `tool_pairs[${index}].result_sha256`,
    );
    assertDigest(resultSha256, `tool_pairs[${index}].result_sha256`);
    return { tool_call_id: toolCallId, result_sha256: resultSha256 };
  });
}

function validateSourceRefs(refs: readonly CompactionSourceRefV1[]): void {
  if (refs.length === 0 || refs.length > MAX_COMPACTION_PROVENANCE_REFERENCES_PER_OUTPUT) {
    throw provenance("summary source_refs count is outside its bound");
  }
  const ids = new Set<string>();
  for (const ref of refs) {
    assertBoundedText(ref.ref_id, MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES, "source ref id");
    if (ids.has(ref.ref_id)) throw provenance("summary contains duplicate source refs");
    ids.add(ref.ref_id);
    assertDigest(ref.sha256, "source ref sha256");
    if (ref.kind === "rollout_span") {
      assertBoundedText(
        ref.source_binding,
        MAX_COMPACTION_SOURCE_REF_ID_UTF8_BYTES,
        "source binding",
      );
      if (
        !Number.isSafeInteger(ref.first_sequence) ||
        !Number.isSafeInteger(ref.last_sequence) ||
        ref.first_sequence <= 0 ||
        ref.last_sequence < ref.first_sequence
      ) {
        throw provenance("rollout span sequence bounds are invalid");
      }
    }
  }
}

function countProvenanceReferences(body: CompactionSummaryBodyV1): number {
  return [...body.facts, ...body.open_actions].reduce(
    (total, record) => total + record.source_ref_ids.length,
    0,
  );
}

function requireExactObject(
  value: JsonValue | undefined,
  expectedKeys: readonly string[],
  label: string,
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw invalid(`${label} has unknown or missing fields`);
  }
  return value;
}

function requireBoundedString(
  value: JsonValue | undefined,
  maximumBytes: number,
  label: string,
): string {
  if (typeof value !== "string") throw invalid(`${label} must be a string`);
  assertBoundedText(value, maximumBytes, label);
  assertNoReservedControlMarker(value);
  return value;
}

function assertNoReservedControlMarker(value: string): void {
  for (const marker of INJECTION_CONTROL_MARKERS) {
    if (value.includes(marker)) {
      throw new CompactionTransactionError(
        "injection_marker_leakage",
        "compaction body leaked a reserved trusted-control marker",
      );
    }
  }
}

/** Manual bounded JSON-number scanner. It never allocates a suffix string. */
function scanJsonNumber(text: string, start: number): number | undefined {
  let cursor = start;
  if (text.charCodeAt(cursor) === 0x2d) cursor += 1;
  const first = text.charCodeAt(cursor);
  if (first === 0x30) {
    cursor += 1;
    const next = text.charCodeAt(cursor);
    if (next >= 0x30 && next <= 0x39) return undefined;
  } else if (first >= 0x31 && first <= 0x39) {
    cursor += 1;
    while (true) {
      const code = text.charCodeAt(cursor);
      if (code < 0x30 || code > 0x39) break;
      cursor += 1;
    }
  } else {
    return undefined;
  }
  if (text.charCodeAt(cursor) === 0x2e) {
    cursor += 1;
    const fractionStart = cursor;
    while (true) {
      const code = text.charCodeAt(cursor);
      if (code < 0x30 || code > 0x39) break;
      cursor += 1;
    }
    if (cursor === fractionStart) return undefined;
  }
  const exponent = text.charCodeAt(cursor);
  if (exponent === 0x45 || exponent === 0x65) {
    cursor += 1;
    const sign = text.charCodeAt(cursor);
    if (sign === 0x2b || sign === 0x2d) cursor += 1;
    const exponentStart = cursor;
    while (true) {
      const code = text.charCodeAt(cursor);
      if (code < 0x30 || code > 0x39) break;
      cursor += 1;
    }
    if (cursor === exponentStart) return undefined;
  }
  return cursor;
}

function assertBoundedText(value: string, maximumBytes: number, label: string): void {
  assertUnicodeScalarString(value, label);
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw limit(`${label} is empty or exceeds its byte limit`);
  }
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code >= 0xdc00) throw invalid(`${label} contains an unpaired surrogate`);
    const next = value.charCodeAt(index + 1);
    if (next < 0xdc00 || next > 0xdfff) {
      throw invalid(`${label} contains an unpaired surrogate`);
    }
    index += 1;
  }
}

function assertDigest(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw invalid(`${label} must be lowercase SHA-256`);
}

function invalid(message: string): CompactionTransactionError {
  return new CompactionTransactionError("output_schema_invalid", message);
}

function limit(message: string): CompactionTransactionError {
  return new CompactionTransactionError("output_limit_exceeded", message);
}

function provenance(message: string): CompactionTransactionError {
  return new CompactionTransactionError("provenance_invalid", message);
}
