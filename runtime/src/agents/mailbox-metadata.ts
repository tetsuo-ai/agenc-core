/**
 * Bounded construction for metadata that may later cross an agent mailbox.
 *
 * The only supported inputs are incremental UTF-8 JSON bytes and explicit
 * builder operations. Arbitrary objects are never enumerated or cloned.
 */

export const MAX_MAILBOX_METADATA_DEPTH = 64;
export const MAX_MAILBOX_METADATA_NODES = 10_000;
export const MAX_MAILBOX_METADATA_UTF8_BYTES = 1_048_576;

export const MAILBOX_METADATA_REJECTION_REASONS = Object.freeze([
  "unbranded",
  "syntax",
  "utf8",
  "duplicate_key",
  "depth",
  "nodes",
  "bytes",
  "non_json",
] as const);

export type MailboxMetadataRejectionReason =
  (typeof MAILBOX_METADATA_REJECTION_REASONS)[number];

export interface MailboxMetadataRejection {
  readonly ok: false;
  readonly reason: MailboxMetadataRejectionReason;
}

export interface MailboxMetadataOperationAccepted {
  readonly ok: true;
}

export type MailboxMetadataOperationResult =
  MailboxMetadataOperationAccepted | MailboxMetadataRejection;

export type MailboxMetadataScalar = null | string | boolean | number;

export type MailboxMetadataValue =
  MailboxMetadataScalar | MailboxMetadataObject | MailboxMetadataArray;

export interface MailboxMetadataObject {
  readonly [key: string]: MailboxMetadataValue;
}

/**
 * The owned arrays intentionally have null prototypes, so inherited Array
 * methods and iteration are not part of their public runtime surface.
 */
export interface MailboxMetadataArray {
  readonly length: number;
  readonly [index: number]: MailboxMetadataValue;
}

declare const validatedMailboxMetadataBrand: unique symbol;

/**
 * An opaque handle authenticated by this module's private WeakMap.
 *
 * A type assertion or copied property cannot manufacture the runtime brand.
 */
export interface ValidatedMailboxMetadata {
  readonly [validatedMailboxMetadataBrand]: "ValidatedMailboxMetadata";
}

export interface MailboxMetadataMetrics {
  readonly depth: number;
  readonly nodes: number;
  readonly utf8Bytes: number;
}

export interface MailboxMetadataAccepted {
  readonly ok: true;
  readonly metadata: ValidatedMailboxMetadata;
}

export type MailboxMetadataResult =
  MailboxMetadataAccepted | MailboxMetadataRejection;

export type MailboxMetadataAuthenticationResult = MailboxMetadataResult;

export interface MailboxMetadataDecoderOptions {
  readonly signal?: AbortSignal;
}

/** Abort is control flow, not a validation/capacity rejection reason. */
export class MailboxMetadataAbortedError extends Error {
  readonly code = "MAILBOX_METADATA_ABORTED" as const;

  constructor() {
    super("mailbox metadata construction was aborted");
    this.name = "MailboxMetadataAbortedError";
  }
}

interface AuthenticatedMetadataRecord {
  readonly bytes: Uint8Array;
  readonly metrics: MailboxMetadataMetrics;
  readonly value: MailboxMetadataObject;
}

const AUTHENTICATED_METADATA = new WeakMap<
  object,
  AuthenticatedMetadataRecord
>();
const OPERATION_ACCEPTED: MailboxMetadataOperationAccepted = Object.freeze({
  ok: true,
});
const JSON_STRING_OUTPUT_BLOCK_CODE_UNITS = 8_192;
const JSON_HEX_DIGITS = "0123456789abcdef";
const MAX_ECMA_ARRAY_INDEX = 4_294_967_294;
const UINT32_BITS = 32;
const ARRAY_INDEX_RADIX_BITS = 8;
const ARRAY_INDEX_RADIX_SIZE = 1 << ARRAY_INDEX_RADIX_BITS;
const ARRAY_INDEX_RADIX_MASK = ARRAY_INDEX_RADIX_SIZE - 1;
const ASCII_ZERO_CODE_UNIT = 0x30;

/** O(1), non-reflective runtime brand check for the E3b mailbox cutover. */
export function isValidatedMailboxMetadata(
  value: unknown,
): value is ValidatedMailboxMetadata {
  return isObjectIdentity(value) && AUTHENTICATED_METADATA.has(value);
}

/** Return a typed diagnostic instead of reflecting over an unbranded value. */
export function authenticateMailboxMetadata(
  value: unknown,
): MailboxMetadataAuthenticationResult {
  if (!isValidatedMailboxMetadata(value)) return rejection("unbranded");
  return acceptedMetadata(value);
}

/** Read the immutable, null-prototype metadata graph owned by this module. */
export function getMailboxMetadataValue(
  metadata: ValidatedMailboxMetadata,
): MailboxMetadataObject {
  return authenticatedRecord(metadata).value;
}

/** Return a defensive copy of the retained canonical serialized bytes. */
export function getMailboxMetadataBytes(
  metadata: ValidatedMailboxMetadata,
): Uint8Array {
  return authenticatedRecord(metadata).bytes.slice();
}

export function getMailboxMetadataMetrics(
  metadata: ValidatedMailboxMetadata,
): MailboxMetadataMetrics {
  return authenticatedRecord(metadata).metrics;
}

/**
 * Trusted TypeScript callers construct metadata one operation at a time.
 * Prebuilt objects and containers are intentionally not accepted.
 */
export class MailboxMetadataBuilder {
  readonly #machine = new MetadataConstructionMachine();

  beginObject(): MailboxMetadataOperationResult {
    return this.#machine.beginObject();
  }

  beginArray(): MailboxMetadataOperationResult {
    return this.#machine.beginArray();
  }

  key(value: unknown): MailboxMetadataOperationResult {
    return this.#machine.key(value);
  }

  scalar(value: unknown): MailboxMetadataOperationResult {
    return this.#machine.scalar(value);
  }

  endObject(): MailboxMetadataOperationResult {
    return this.#machine.endObject();
  }

  endArray(): MailboxMetadataOperationResult {
    return this.#machine.endArray();
  }

  finish(): MailboxMetadataResult {
    return this.#machine.finish();
  }
}

/** Incremental duplicate-key-aware decoder for untrusted UTF-8 JSON bytes. */
export class MailboxMetadataDecoder {
  readonly #signal: AbortSignal | undefined;
  readonly #textDecoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  readonly #parser = new IncrementalMetadataJsonParser();
  #rawBytes = 0;
  #failure: MailboxMetadataRejection | undefined;
  #finished: MailboxMetadataResult | undefined;

  constructor(options: MailboxMetadataDecoderOptions = {}) {
    this.#signal = options.signal;
  }

  write(chunk: Uint8Array): MailboxMetadataOperationResult {
    if (this.#finished !== undefined) return rejection("non_json");
    if (this.#failure !== undefined) return this.#failure;
    throwIfAborted(this.#signal);

    if (!(chunk instanceof Uint8Array)) {
      return this.#rememberFailure(rejection("non_json"));
    }
    const nextRawBytes = this.#rawBytes + chunk.byteLength;
    if (nextRawBytes > MAX_MAILBOX_METADATA_UTF8_BYTES) {
      return this.#rememberFailure(rejection("bytes"));
    }

    let decoded: string;
    try {
      decoded = this.#textDecoder.decode(chunk, { stream: true });
    } catch {
      return this.#rememberFailure(rejection("utf8"));
    }
    this.#rawBytes = nextRawBytes;
    throwIfAborted(this.#signal);
    const parsed = this.#parser.write(decoded);
    if (!parsed.ok) return this.#rememberFailure(parsed);
    return OPERATION_ACCEPTED;
  }

  finish(): MailboxMetadataResult {
    if (this.#finished !== undefined) return this.#finished;
    if (this.#failure !== undefined) return this.#failure;
    throwIfAborted(this.#signal);

    let decoded: string;
    try {
      decoded = this.#textDecoder.decode();
    } catch {
      return this.#rememberFailure(rejection("utf8"));
    }
    const parsed = this.#parser.write(decoded);
    if (!parsed.ok) return this.#rememberFailure(parsed);
    throwIfAborted(this.#signal);
    this.#finished = this.#parser.finish();
    return this.#finished;
  }

  #rememberFailure(
    failure: MailboxMetadataRejection,
  ): MailboxMetadataRejection {
    this.#failure = failure;
    return failure;
  }
}

export function decodeMailboxMetadata(
  bytes: Uint8Array,
  options: MailboxMetadataDecoderOptions = {},
): MailboxMetadataResult {
  const decoder = new MailboxMetadataDecoder(options);
  const written = decoder.write(bytes);
  return written.ok ? decoder.finish() : written;
}

interface MutableObjectFrame {
  readonly indexedKeys: IndexedObjectKey[];
  readonly kind: "object";
  readonly namedKeys: string[];
  readonly keys: Set<string>;
  readonly value: Record<string, MailboxMetadataValue>;
  entries: number;
  pendingKey?: string;
}

interface MutableArrayFrame {
  readonly kind: "array";
  readonly value: MailboxMetadataValue[];
  entries: number;
}

type MutableFrame = MutableObjectFrame | MutableArrayFrame;

interface IndexedObjectKey {
  readonly index: number;
  readonly key: string;
}

interface ObjectKeyOrder {
  readonly indexedKeys: readonly IndexedObjectKey[];
  readonly namedKeys: readonly string[];
}

class MetadataConstructionMachine {
  readonly #objectKeyOrders = new WeakMap<object, ObjectKeyOrder>();
  readonly #writer = new BoundedCanonicalJsonWriter();
  readonly #stack: MutableFrame[] = [];
  #failure: MailboxMetadataRejection | undefined;
  #finished: ValidatedMailboxMetadata | undefined;
  #root: Record<string, MailboxMetadataValue> | undefined;
  #rootComplete = false;
  #rootStarted = false;
  #maxDepth = 0;
  #nodes = 0;

  beginObject(): MailboxMetadataOperationResult {
    return this.#beginContainer("object");
  }

  beginArray(): MailboxMetadataOperationResult {
    return this.#beginContainer("array");
  }

  key(value: unknown): MailboxMetadataOperationResult {
    const unavailable = this.#unavailableOperation();
    if (unavailable !== undefined) return unavailable;
    const frame = this.#topFrame();
    if (
      frame?.kind !== "object" ||
      frame.pendingKey !== undefined ||
      typeof value !== "string"
    ) {
      return this.#fail("non_json");
    }
    if (frame.keys.has(value)) return this.#fail("duplicate_key");

    if (frame.entries > 0 && !this.#writer.appendAscii(",")) {
      return this.#fail("bytes");
    }
    if (!this.#writer.appendString(value) || !this.#writer.appendAscii(":")) {
      return this.#fail("bytes");
    }
    frame.keys.add(value);
    const arrayIndex = ecmaArrayIndex(value);
    if (arrayIndex === undefined) {
      frame.namedKeys.push(value);
    } else {
      frame.indexedKeys.push({ index: arrayIndex, key: value });
    }
    frame.pendingKey = value;
    return OPERATION_ACCEPTED;
  }

  scalar(value: unknown): MailboxMetadataOperationResult {
    const unavailable = this.#unavailableOperation();
    if (unavailable !== undefined) return unavailable;
    if (!isJsonScalar(value)) return this.#fail("non_json");
    if (this.#stack.length === 0) return this.#fail("non_json");
    if (!this.#canAddNode()) return this.#fail("nodes");
    if (!this.#appendArrayValuePrefix()) return this.#fail("bytes");
    if (!this.#appendScalar(value)) return this.#fail("bytes");

    this.#nodes += 1;
    this.#attachValue(value);
    return OPERATION_ACCEPTED;
  }

  endObject(): MailboxMetadataOperationResult {
    return this.#endContainer("object");
  }

  endArray(): MailboxMetadataOperationResult {
    return this.#endContainer("array");
  }

  finish(): MailboxMetadataResult {
    if (this.#failure !== undefined) return this.#failure;
    if (this.#finished !== undefined) return acceptedMetadata(this.#finished);
    if (
      !this.#rootComplete ||
      this.#root === undefined ||
      this.#stack.length !== 0
    ) {
      return this.#fail("non_json");
    }

    const accountedBytes = this.#writer.finish();
    const bytes = serializeCanonicalMetadata(this.#root, this.#objectKeyOrders);
    if (bytes.byteLength !== accountedBytes.byteLength) {
      throw new Error("mailbox metadata byte accounting invariant failed");
    }
    const metrics: MailboxMetadataMetrics = Object.freeze({
      depth: this.#maxDepth,
      nodes: this.#nodes,
      utf8Bytes: bytes.byteLength,
    });
    const handle = Object.freeze(
      Object.create(null) as ValidatedMailboxMetadata,
    );
    AUTHENTICATED_METADATA.set(handle, {
      bytes,
      metrics,
      value: this.#root,
    });
    this.#finished = handle;
    return acceptedMetadata(handle);
  }

  #beginContainer(kind: "object" | "array"): MailboxMetadataOperationResult {
    const unavailable = this.#unavailableOperation();
    if (unavailable !== undefined) return unavailable;
    const isRoot = this.#stack.length === 0;
    if (isRoot && (this.#rootStarted || kind !== "object")) {
      return this.#fail("non_json");
    }
    if (!isRoot && !this.#parentAcceptsValue()) {
      return this.#fail("non_json");
    }

    const depth = this.#stack.length + 1;
    if (depth > MAX_MAILBOX_METADATA_DEPTH) return this.#fail("depth");
    if (!this.#canAddNode()) return this.#fail("nodes");
    if (!this.#appendArrayValuePrefix()) return this.#fail("bytes");
    if (!this.#writer.appendAscii(kind === "object" ? "{" : "[")) {
      return this.#fail("bytes");
    }

    const frame = createMutableFrame(kind);
    this.#nodes += 1;
    this.#maxDepth = Math.max(this.#maxDepth, depth);
    this.#attachValue(frame.value);
    this.#stack.push(frame);
    if (isRoot) {
      this.#rootStarted = true;
      this.#root = frame.value as Record<string, MailboxMetadataValue>;
    }
    return OPERATION_ACCEPTED;
  }

  #endContainer(kind: MutableFrame["kind"]): MailboxMetadataOperationResult {
    const unavailable = this.#unavailableOperation();
    if (unavailable !== undefined) return unavailable;
    const frame = this.#topFrame();
    if (
      frame === undefined ||
      frame.kind !== kind ||
      (frame.kind === "object" && frame.pendingKey !== undefined)
    ) {
      return this.#fail("non_json");
    }
    if (!this.#writer.appendAscii(kind === "object" ? "}" : "]")) {
      return this.#fail("bytes");
    }

    if (frame.kind === "object") {
      sortIndexedObjectKeys(frame.indexedKeys);
      Object.freeze(frame.indexedKeys);
      Object.freeze(frame.namedKeys);
      this.#objectKeyOrders.set(
        frame.value,
        Object.freeze({
          indexedKeys: frame.indexedKeys,
          namedKeys: frame.namedKeys,
        }),
      );
    }
    Object.freeze(frame.value);
    this.#stack.pop();
    if (this.#stack.length === 0) this.#rootComplete = true;
    return OPERATION_ACCEPTED;
  }

  #appendScalar(value: MailboxMetadataScalar): boolean {
    if (value === null) return this.#writer.appendAscii("null");
    if (typeof value === "string") return this.#writer.appendString(value);
    if (typeof value === "boolean") {
      return this.#writer.appendAscii(value ? "true" : "false");
    }
    return this.#writer.appendAscii(canonicalNumber(value));
  }

  #appendArrayValuePrefix(): boolean {
    const frame = this.#topFrame();
    return frame?.kind !== "array" || frame.entries === 0
      ? true
      : this.#writer.appendAscii(",");
  }

  #attachValue(value: MailboxMetadataValue): void {
    const parent = this.#topFrame();
    if (parent === undefined) return;
    if (parent.kind === "array") {
      Object.defineProperty(parent.value, String(parent.entries), {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      parent.entries += 1;
      return;
    }

    const key = parent.pendingKey;
    if (key === undefined)
      throw new Error("mailbox metadata key invariant failed");
    Object.defineProperty(parent.value, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    parent.entries += 1;
    parent.pendingKey = undefined;
  }

  #parentAcceptsValue(): boolean {
    const parent = this.#topFrame();
    return parent?.kind === "array" || parent?.pendingKey !== undefined;
  }

  #canAddNode(): boolean {
    return this.#nodes < MAX_MAILBOX_METADATA_NODES;
  }

  #topFrame(): MutableFrame | undefined {
    return this.#stack[this.#stack.length - 1];
  }

  #unavailableOperation(): MailboxMetadataRejection | undefined {
    if (this.#failure !== undefined) return this.#failure;
    return this.#finished === undefined ? undefined : rejection("non_json");
  }

  #fail(reason: MailboxMetadataRejectionReason): MailboxMetadataRejection {
    this.#failure ??= rejection(reason);
    return this.#failure;
  }
}

class BoundedCanonicalJsonWriter {
  readonly #parts: string[] = [];
  #utf8Bytes = 0;

  appendAscii(value: string): boolean {
    if (this.#utf8Bytes + value.length > MAX_MAILBOX_METADATA_UTF8_BYTES) {
      return false;
    }
    this.#parts.push(value);
    this.#utf8Bytes += value.length;
    return true;
  }

  appendString(value: string): boolean {
    const encoded = encodeJsonString(
      value,
      MAX_MAILBOX_METADATA_UTF8_BYTES - this.#utf8Bytes,
    );
    if (encoded === null) return false;
    this.#parts.push(encoded.text);
    this.#utf8Bytes += encoded.utf8Bytes;
    return true;
  }

  finish(): Uint8Array {
    const bytes = new TextEncoder().encode(this.#parts.join(""));
    if (bytes.byteLength !== this.#utf8Bytes) {
      throw new Error("mailbox metadata UTF-8 accounting invariant failed");
    }
    return bytes;
  }
}

interface ObjectSerializationFrame {
  entriesWritten: number;
  indexedKeyPosition: number;
  readonly kind: "object";
  namedKeyPosition: number;
  readonly order: ObjectKeyOrder;
  readonly value: MailboxMetadataObject;
}

interface ArraySerializationFrame {
  index: number;
  readonly kind: "array";
  readonly value: readonly MailboxMetadataValue[];
}

type SerializationFrame = ObjectSerializationFrame | ArraySerializationFrame;

function serializeCanonicalMetadata(
  root: MailboxMetadataObject,
  objectKeyOrders: WeakMap<object, ObjectKeyOrder>,
): Uint8Array {
  const writer = new BoundedCanonicalJsonWriter();
  const stack: SerializationFrame[] = [];
  appendCanonicalValue(root, writer, stack, objectKeyOrders);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        requireCanonicalAppend(writer.appendAscii("]"));
        stack.pop();
        continue;
      }
      if (frame.index > 0) requireCanonicalAppend(writer.appendAscii(","));
      const value = frame.value[frame.index]!;
      frame.index += 1;
      appendCanonicalValue(value, writer, stack, objectKeyOrders);
      continue;
    }

    const key = nextCanonicalObjectKey(frame);
    if (key === undefined) {
      requireCanonicalAppend(writer.appendAscii("}"));
      stack.pop();
      continue;
    }
    if (frame.entriesWritten > 0) {
      requireCanonicalAppend(writer.appendAscii(","));
    }
    frame.entriesWritten += 1;
    requireCanonicalAppend(writer.appendString(key));
    requireCanonicalAppend(writer.appendAscii(":"));
    appendCanonicalValue(frame.value[key]!, writer, stack, objectKeyOrders);
  }

  return writer.finish();
}

function appendCanonicalValue(
  value: MailboxMetadataValue,
  writer: BoundedCanonicalJsonWriter,
  stack: SerializationFrame[],
  objectKeyOrders: WeakMap<object, ObjectKeyOrder>,
): void {
  if (value === null) {
    requireCanonicalAppend(writer.appendAscii("null"));
    return;
  }
  if (typeof value === "string") {
    requireCanonicalAppend(writer.appendString(value));
    return;
  }
  if (typeof value === "boolean") {
    requireCanonicalAppend(writer.appendAscii(value ? "true" : "false"));
    return;
  }
  if (typeof value === "number") {
    requireCanonicalAppend(writer.appendAscii(canonicalNumber(value)));
    return;
  }
  if (Array.isArray(value)) {
    requireCanonicalAppend(writer.appendAscii("["));
    stack.push({
      index: 0,
      kind: "array",
      value: value as readonly MailboxMetadataValue[],
    });
    return;
  }

  const objectValue = value as MailboxMetadataObject;
  const order = objectKeyOrders.get(objectValue);
  if (order === undefined) {
    throw new Error("mailbox metadata object-order invariant failed");
  }
  requireCanonicalAppend(writer.appendAscii("{"));
  stack.push({
    entriesWritten: 0,
    indexedKeyPosition: 0,
    kind: "object",
    namedKeyPosition: 0,
    order,
    value: objectValue,
  });
}

function nextCanonicalObjectKey(
  frame: ObjectSerializationFrame,
): string | undefined {
  const indexed = frame.order.indexedKeys[frame.indexedKeyPosition];
  if (indexed !== undefined) {
    frame.indexedKeyPosition += 1;
    return indexed.key;
  }
  const named = frame.order.namedKeys[frame.namedKeyPosition];
  if (named !== undefined) frame.namedKeyPosition += 1;
  return named;
}

function requireCanonicalAppend(appended: boolean): void {
  if (!appended) {
    throw new Error("mailbox metadata canonical serialization overflowed");
  }
}

interface EncodedJsonString {
  readonly text: string;
  readonly utf8Bytes: number;
}

function encodeJsonString(
  value: string,
  maximumBytes: number,
): EncodedJsonString | null {
  if (maximumBytes < 2) return null;
  const output = new BoundedStringBlocks();
  output.append('"');
  let utf8Bytes = 2;
  let rawStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const escape = jsonEscapeForCodeUnit(codeUnit);
    if (escape !== undefined) {
      if (rawStart < index) output.append(value.slice(rawStart, index));
      utf8Bytes += escape.length;
      if (utf8Bytes > maximumBytes) return null;
      output.append(escape);
      rawStart = index + 1;
      continue;
    }

    if (isHighSurrogate(codeUnit)) {
      const trailing = value.charCodeAt(index + 1);
      if (isLowSurrogate(trailing)) {
        utf8Bytes += 4;
        index += 1;
        continue;
      }
      if (rawStart < index) output.append(value.slice(rawStart, index));
      const surrogateEscape = unicodeEscape(codeUnit);
      utf8Bytes += surrogateEscape.length;
      if (utf8Bytes > maximumBytes) return null;
      output.append(surrogateEscape);
      rawStart = index + 1;
      continue;
    }
    if (isLowSurrogate(codeUnit)) {
      if (rawStart < index) output.append(value.slice(rawStart, index));
      const surrogateEscape = unicodeEscape(codeUnit);
      utf8Bytes += surrogateEscape.length;
      if (utf8Bytes > maximumBytes) return null;
      output.append(surrogateEscape);
      rawStart = index + 1;
      continue;
    }

    utf8Bytes += utf8BytesForCodeUnit(codeUnit);
    if (utf8Bytes > maximumBytes) return null;
  }

  if (rawStart < value.length) output.append(value.slice(rawStart));
  output.append('"');
  return { text: output.finish(), utf8Bytes };
}

class BoundedStringBlocks {
  readonly #blocks: string[] = [];
  #pending: string[] = [];
  #pendingCodeUnits = 0;

  append(value: string): void {
    if (value.length === 0) return;
    this.#pending.push(value);
    this.#pendingCodeUnits += value.length;
    if (this.#pendingCodeUnits >= JSON_STRING_OUTPUT_BLOCK_CODE_UNITS) {
      this.#flush();
    }
  }

  finish(): string {
    this.#flush();
    return this.#blocks.join("");
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    this.#blocks.push(this.#pending.join(""));
    this.#pending = [];
    this.#pendingCodeUnits = 0;
  }
}

type LexerState =
  "default" | "string" | "escape" | "unicode" | "number" | "literal";

type NumberLexerState =
  | "minus"
  | "zero"
  | "integer"
  | "fraction_start"
  | "fraction"
  | "exponent_start"
  | "exponent_sign"
  | "exponent";

interface ObjectGrammarFrame {
  readonly kind: "object";
  state: "first_key_or_end" | "key" | "colon" | "value" | "comma_or_end";
}

interface ArrayGrammarFrame {
  readonly kind: "array";
  state: "first_value_or_end" | "value" | "comma_or_end";
}

type GrammarFrame = ObjectGrammarFrame | ArrayGrammarFrame;

class IncrementalMetadataJsonParser {
  readonly #machine = new MetadataConstructionMachine();
  readonly #grammar: GrammarFrame[] = [];
  readonly #tokenText = new TextAccumulator();
  #failure: MailboxMetadataRejection | undefined;
  #lexerState: LexerState = "default";
  #numberState: NumberLexerState | undefined;
  #literalExpected = "";
  #literalIndex = 0;
  #unicodeDigits = "";
  #rootState: "value" | "end" = "value";

  write(text: string): MailboxMetadataOperationResult {
    if (this.#failure !== undefined) return this.#failure;
    let index = 0;
    while (index < text.length && this.#failure === undefined) {
      switch (this.#lexerState) {
        case "default":
          index = this.#consumeDefault(text, index);
          break;
        case "string":
          index = this.#consumeString(text, index);
          break;
        case "escape":
          index = this.#consumeEscape(text, index);
          break;
        case "unicode":
          index = this.#consumeUnicode(text, index);
          break;
        case "number":
          index = this.#consumeNumber(text, index);
          break;
        case "literal":
          index = this.#consumeLiteral(text, index);
          break;
      }
    }
    return this.#failure ?? OPERATION_ACCEPTED;
  }

  finish(): MailboxMetadataResult {
    if (this.#failure !== undefined) return this.#failure;
    if (this.#lexerState === "number") this.#finishNumber();
    if (this.#failure !== undefined) return this.#failure;
    if (
      this.#lexerState !== "default" ||
      this.#grammar.length !== 0 ||
      this.#rootState !== "end"
    ) {
      return this.#fail("syntax");
    }
    const result = this.#machine.finish();
    if (!result.ok && result.reason === "non_json") return this.#fail("syntax");
    return result;
  }

  #consumeDefault(text: string, index: number): number {
    const character = text[index]!;
    if (isJsonWhitespace(character)) return index + 1;
    if (character === '"') {
      this.#tokenText.reset();
      this.#lexerState = "string";
      return index + 1;
    }
    if (character === "{" || character === "[") {
      this.#beginContainer(character === "{" ? "object" : "array");
      return index + 1;
    }
    if (character === "}" || character === "]") {
      this.#endContainer(character === "}" ? "object" : "array");
      return index + 1;
    }
    if (character === ":") {
      this.#consumeColon();
      return index + 1;
    }
    if (character === ",") {
      this.#consumeComma();
      return index + 1;
    }
    if (character === "-" || isAsciiDigit(character)) {
      this.#startNumber(character);
      return index + 1;
    }
    if (character === "t" || character === "f" || character === "n") {
      this.#startLiteral(character);
      return index + 1;
    }
    this.#fail("syntax");
    return text.length;
  }

  #consumeString(text: string, index: number): number {
    const rawStart = index;
    while (index < text.length) {
      const codeUnit = text.charCodeAt(index);
      if (codeUnit === 0x22 || codeUnit === 0x5c || codeUnit < 0x20) break;
      index += 1;
    }
    if (rawStart < index) this.#tokenText.append(text.slice(rawStart, index));
    if (index === text.length) return index;

    const codeUnit = text.charCodeAt(index);
    if (codeUnit < 0x20) {
      this.#fail("syntax");
      return text.length;
    }
    if (codeUnit === 0x5c) {
      this.#lexerState = "escape";
      return index + 1;
    }

    const value = this.#tokenText.take();
    this.#lexerState = "default";
    this.#emitString(value);
    return index + 1;
  }

  #consumeEscape(text: string, index: number): number {
    const character = text[index]!;
    const escaped = decodedSimpleJsonEscape(character);
    if (escaped !== undefined) {
      this.#tokenText.append(escaped);
      this.#lexerState = "string";
      return index + 1;
    }
    if (character === "u") {
      this.#unicodeDigits = "";
      this.#lexerState = "unicode";
      return index + 1;
    }
    this.#fail("syntax");
    return text.length;
  }

  #consumeUnicode(text: string, index: number): number {
    const character = text[index]!;
    if (!isHexDigit(character)) {
      this.#fail("syntax");
      return text.length;
    }
    this.#unicodeDigits += character;
    if (this.#unicodeDigits.length === 4) {
      this.#tokenText.append(
        String.fromCharCode(Number.parseInt(this.#unicodeDigits, 16)),
      );
      this.#unicodeDigits = "";
      this.#lexerState = "string";
    }
    return index + 1;
  }

  #consumeNumber(text: string, index: number): number {
    const character = text[index]!;
    const next = nextNumberState(this.#numberState, character);
    if (next !== undefined) {
      this.#numberState = next;
      this.#tokenText.append(character);
      return index + 1;
    }
    this.#finishNumber();
    return index;
  }

  #consumeLiteral(text: string, index: number): number {
    const character = text[index]!;
    if (character !== this.#literalExpected[this.#literalIndex]) {
      this.#fail("syntax");
      return text.length;
    }
    this.#literalIndex += 1;
    if (this.#literalIndex === this.#literalExpected.length) {
      const value = literalValue(this.#literalExpected);
      this.#lexerState = "default";
      this.#literalExpected = "";
      this.#literalIndex = 0;
      this.#emitScalar(value);
    }
    return index + 1;
  }

  #startNumber(character: string): void {
    this.#tokenText.reset();
    this.#tokenText.append(character);
    this.#numberState = initialNumberState(character);
    this.#lexerState = "number";
  }

  #finishNumber(): void {
    const state = this.#numberState;
    if (state === undefined || !isAcceptingNumberState(state)) {
      this.#fail("syntax");
      return;
    }
    const token = this.#tokenText.take();
    const value = Number(token);
    this.#numberState = undefined;
    this.#lexerState = "default";
    if (!Number.isFinite(value)) {
      this.#fail("syntax");
      return;
    }
    this.#emitScalar(value);
  }

  #startLiteral(character: "t" | "f" | "n"): void {
    this.#literalExpected =
      character === "t" ? "true" : character === "f" ? "false" : "null";
    this.#literalIndex = 1;
    this.#lexerState = "literal";
  }

  #emitString(value: string): void {
    const frame = this.#topGrammarFrame();
    if (
      frame?.kind === "object" &&
      (frame.state === "first_key_or_end" || frame.state === "key")
    ) {
      const result = this.#machine.key(value);
      if (!result.ok) {
        this.#failure = result;
        return;
      }
      frame.state = "colon";
      return;
    }
    this.#emitScalar(value);
  }

  #emitScalar(value: MailboxMetadataScalar): void {
    if (!this.#expectsValue()) {
      this.#fail("syntax");
      return;
    }
    const result = this.#machine.scalar(value);
    if (!result.ok) {
      this.#failure = result;
      return;
    }
    this.#completeValue();
  }

  #beginContainer(kind: "object" | "array"): void {
    if (!this.#expectsValue()) {
      this.#fail("syntax");
      return;
    }
    const result =
      kind === "object"
        ? this.#machine.beginObject()
        : this.#machine.beginArray();
    if (!result.ok) {
      this.#failure = result;
      return;
    }
    this.#completeValue();
    this.#grammar.push(
      kind === "object"
        ? { kind, state: "first_key_or_end" }
        : { kind, state: "first_value_or_end" },
    );
  }

  #endContainer(kind: "object" | "array"): void {
    const frame = this.#topGrammarFrame();
    const grammarAllowsEnd =
      frame?.kind === kind &&
      (frame.state === "comma_or_end" ||
        (kind === "object" && frame.state === "first_key_or_end") ||
        (kind === "array" && frame.state === "first_value_or_end"));
    if (!grammarAllowsEnd) {
      this.#fail("syntax");
      return;
    }
    const result =
      kind === "object" ? this.#machine.endObject() : this.#machine.endArray();
    if (!result.ok) {
      this.#failure = result;
      return;
    }
    this.#grammar.pop();
  }

  #consumeColon(): void {
    const frame = this.#topGrammarFrame();
    if (frame?.kind !== "object" || frame.state !== "colon") {
      this.#fail("syntax");
      return;
    }
    frame.state = "value";
  }

  #consumeComma(): void {
    const frame = this.#topGrammarFrame();
    if (frame?.state !== "comma_or_end") {
      this.#fail("syntax");
      return;
    }
    frame.state = frame.kind === "object" ? "key" : "value";
  }

  #expectsValue(): boolean {
    const frame = this.#topGrammarFrame();
    if (frame === undefined) return this.#rootState === "value";
    return frame.kind === "object"
      ? frame.state === "value"
      : frame.state === "first_value_or_end" || frame.state === "value";
  }

  #completeValue(): void {
    const frame = this.#topGrammarFrame();
    if (frame === undefined) {
      this.#rootState = "end";
      return;
    }
    frame.state = "comma_or_end";
  }

  #topGrammarFrame(): GrammarFrame | undefined {
    return this.#grammar[this.#grammar.length - 1];
  }

  #fail(reason: MailboxMetadataRejectionReason): MailboxMetadataRejection {
    this.#failure ??= rejection(reason);
    return this.#failure;
  }
}

class TextAccumulator {
  readonly #blocks: string[] = [];
  #pending: string[] = [];
  #pendingCodeUnits = 0;

  append(value: string): void {
    if (value.length === 0) return;
    this.#pending.push(value);
    this.#pendingCodeUnits += value.length;
    if (this.#pendingCodeUnits >= JSON_STRING_OUTPUT_BLOCK_CODE_UNITS) {
      this.#flush();
    }
  }

  take(): string {
    this.#flush();
    const value = this.#blocks.join("");
    this.reset();
    return value;
  }

  reset(): void {
    this.#blocks.length = 0;
    this.#pending = [];
    this.#pendingCodeUnits = 0;
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    this.#blocks.push(this.#pending.join(""));
    this.#pending = [];
    this.#pendingCodeUnits = 0;
  }
}

function createMutableFrame(kind: "object" | "array"): MutableFrame {
  if (kind === "object") {
    return {
      entries: 0,
      indexedKeys: [],
      keys: new Set<string>(),
      kind,
      namedKeys: [],
      value: Object.create(null) as Record<string, MailboxMetadataValue>,
    };
  }
  const value: MailboxMetadataValue[] = [];
  Object.setPrototypeOf(value, null);
  return { entries: 0, kind, value };
}

function sortIndexedObjectKeys(keys: IndexedObjectKey[]): void {
  if (keys.length < 2) return;
  let source = keys;
  let target = new Array<IndexedObjectKey>(keys.length);

  for (let shift = 0; shift < UINT32_BITS; shift += ARRAY_INDEX_RADIX_BITS) {
    const counts = new Uint32Array(ARRAY_INDEX_RADIX_SIZE);
    for (const entry of source) {
      counts[(entry.index >>> shift) & ARRAY_INDEX_RADIX_MASK] += 1;
    }
    let offset = 0;
    for (let bucket = 0; bucket < counts.length; bucket += 1) {
      const count = counts[bucket]!;
      counts[bucket] = offset;
      offset += count;
    }
    for (const entry of source) {
      const bucket = (entry.index >>> shift) & ARRAY_INDEX_RADIX_MASK;
      target[counts[bucket]!] = entry;
      counts[bucket] += 1;
    }
    const previousSource = source;
    source = target;
    target = previousSource;
  }

  if (source !== keys) {
    for (let index = 0; index < source.length; index += 1) {
      keys[index] = source[index]!;
    }
  }
}

function ecmaArrayIndex(value: string): number | undefined {
  if (value === "0") return 0;
  if (value.length === 0 || !isNonZeroAsciiDigit(value[0]!)) {
    return undefined;
  }

  let index = 0;
  for (let position = 0; position < value.length; position += 1) {
    const character = value[position]!;
    if (!isAsciiDigit(character)) return undefined;
    index = index * 10 + character.charCodeAt(0) - ASCII_ZERO_CODE_UNIT;
    if (index > MAX_ECMA_ARRAY_INDEX) return undefined;
  }
  return index;
}

function rejection(
  reason: MailboxMetadataRejectionReason,
): MailboxMetadataRejection {
  return Object.freeze({ ok: false, reason });
}

function acceptedMetadata(
  metadata: ValidatedMailboxMetadata,
): MailboxMetadataAccepted {
  return Object.freeze({ metadata, ok: true });
}

function authenticatedRecord(
  metadata: ValidatedMailboxMetadata,
): AuthenticatedMetadataRecord {
  if (!isObjectIdentity(metadata)) {
    throw new TypeError("unbranded mailbox metadata");
  }
  const record = AUTHENTICATED_METADATA.get(metadata);
  if (record === undefined) throw new TypeError("unbranded mailbox metadata");
  return record;
}

function isObjectIdentity(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function isJsonScalar(value: unknown): value is MailboxMetadataScalar {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}

function canonicalNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function jsonEscapeForCodeUnit(codeUnit: number): string | undefined {
  switch (codeUnit) {
    case 0x08:
      return "\\b";
    case 0x09:
      return "\\t";
    case 0x0a:
      return "\\n";
    case 0x0c:
      return "\\f";
    case 0x0d:
      return "\\r";
    case 0x22:
      return '\\"';
    case 0x5c:
      return "\\\\";
    default:
      return codeUnit < 0x20 ? unicodeEscape(codeUnit) : undefined;
  }
}

function decodedSimpleJsonEscape(character: string): string | undefined {
  switch (character) {
    case '"':
    case "\\":
    case "/":
      return character;
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return undefined;
  }
}

function unicodeEscape(codeUnit: number): string {
  return `\\u${
    JSON_HEX_DIGITS[(codeUnit >>> 12) & 0x0f]
  }${JSON_HEX_DIGITS[(codeUnit >>> 8) & 0x0f]}${
    JSON_HEX_DIGITS[(codeUnit >>> 4) & 0x0f]
  }${JSON_HEX_DIGITS[codeUnit & 0x0f]}`;
}

function utf8BytesForCodeUnit(codeUnit: number): number {
  if (codeUnit <= 0x7f) return 1;
  return codeUnit <= 0x7ff ? 2 : 3;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function isJsonWhitespace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r"
  );
}

function isAsciiDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isNonZeroAsciiDigit(character: string): boolean {
  return character >= "1" && character <= "9";
}

function isHexDigit(character: string): boolean {
  return (
    (character >= "0" && character <= "9") ||
    (character >= "a" && character <= "f") ||
    (character >= "A" && character <= "F")
  );
}

function initialNumberState(character: string): NumberLexerState {
  if (character === "-") return "minus";
  return character === "0" ? "zero" : "integer";
}

function nextNumberState(
  state: NumberLexerState | undefined,
  character: string,
): NumberLexerState | undefined {
  switch (state) {
    case "minus":
      if (character === "0") return "zero";
      return isNonZeroAsciiDigit(character) ? "integer" : undefined;
    case "zero":
    case "integer":
      if (state === "integer" && isAsciiDigit(character)) return "integer";
      if (character === ".") return "fraction_start";
      return character === "e" || character === "E"
        ? "exponent_start"
        : undefined;
    case "fraction_start":
      return isAsciiDigit(character) ? "fraction" : undefined;
    case "fraction":
      if (isAsciiDigit(character)) return "fraction";
      return character === "e" || character === "E"
        ? "exponent_start"
        : undefined;
    case "exponent_start":
      if (character === "+" || character === "-") return "exponent_sign";
      return isAsciiDigit(character) ? "exponent" : undefined;
    case "exponent_sign":
      return isAsciiDigit(character) ? "exponent" : undefined;
    case "exponent":
      return isAsciiDigit(character) ? "exponent" : undefined;
    default:
      return undefined;
  }
}

function isAcceptingNumberState(state: NumberLexerState): boolean {
  return (
    state === "zero" ||
    state === "integer" ||
    state === "fraction" ||
    state === "exponent"
  );
}

function literalValue(literal: string): null | boolean {
  if (literal === "true") return true;
  if (literal === "false") return false;
  return null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MailboxMetadataAbortedError();
}
