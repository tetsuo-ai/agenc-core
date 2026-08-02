/**
 * Bounded wire protocols and argv accounting for AgenC's pinned ripgrep.
 *
 * Ripgrep deliberately exposes different machine-readable protocols for
 * detailed matches and summary modes. Keeping the parsers here byte-oriented
 * prevents filenames from being mistaken for delimiters after UTF-8 decoding.
 */

import { windowsCommandLineUtf16CodeUnits } from "../../utils/supervisedProcess.js";

export { quoteWindowsCommandLineArgument } from "../../utils/supervisedProcess.js";

export const MAX_GREP_PATTERN_UTF8_BYTES = 65_536;
export const MAX_GREP_RAW_GLOB_UTF8_BYTES = 65_536;
export const MAX_GREP_GLOBS = 256;
export const MAX_GREP_GLOB_UTF8_BYTES = 16_384;
export const MAX_GREP_TYPE_UTF8_BYTES = 256;
export const MAX_GREP_RAW_PATH_UTF8_BYTES = 16_384;
export const MAX_GREP_CONTEXT_LINES = 10_000;
export const MAX_GREP_HEAD_LIMIT = 100_000;
export const MAX_GREP_OFFSET = 1_000_000;
export const MAX_GREP_ARGV_UTF8_BYTES = 262_144;
export const MAX_GREP_WINDOWS_COMMAND_LINE_UTF16_CODE_UNITS = 30_000;

export const MAX_GREP_WALL_MS = 120_000;
export const MAX_GREP_RECORD_BYTES = 4_194_304;
export const MAX_GREP_DECODED_BYTES = 33_554_432;
export const MAX_GREP_RENDERED_BYTES = MAX_GREP_DECODED_BYTES;
export const MAX_GREP_RESULTS = 100_000;
export const MAX_GREP_CONTEXT_RECORDS = 100_000;
export const MAX_GREP_AGGREGATE_MATCH_COUNT = Number.MAX_SAFE_INTEGER;
export const MAX_GREP_DIAGNOSTIC_BYTES = 131_072;

export type GrepBoundaryReason =
  | "ARGUMENT_NUL"
  | "ARGUMENT_LONE_SURROGATE"
  | "ARGV_UTF8_LIMIT"
  | "WINDOWS_COMMAND_LINE_LIMIT"
  | "MALFORMED_JSON"
  | "INVALID_JSON_RECORD"
  | "INVALID_JSON_RECORD_ORDER"
  | "INVALID_WIRE_TEXT"
  | "INVALID_WIRE_BASE64"
  | "RECORD_LIMIT"
  | "DECODED_OUTPUT_LIMIT"
  | "RENDERED_OUTPUT_LIMIT"
  | "DIAGNOSTIC_LIMIT"
  | "RESULT_LIMIT"
  | "CONTEXT_LIMIT"
  | "MISSING_NUL"
  | "UNTERMINATED_RECORD"
  | "INVALID_COUNT"
  | "COUNT_OVERFLOW";

export class GrepBoundaryError extends Error {
  readonly reason: GrepBoundaryReason;

  constructor(reason: GrepBoundaryReason, message: string) {
    super(message);
    this.name = "GrepBoundaryError";
    this.reason = reason;
  }
}

export interface RipgrepSubmatch {
  readonly bytes: Buffer;
  readonly start: number;
  readonly end: number;
}

export interface RipgrepContentRecord {
  readonly kind: "content";
  readonly recordType: "match" | "context";
  readonly path: Buffer;
  readonly lines: Buffer;
  readonly lineNumber: number | null;
  readonly absoluteOffset: number;
  readonly submatches: readonly RipgrepSubmatch[];
}

export interface RipgrepFileRecord {
  readonly kind: "file";
  readonly path: Buffer;
}

export interface RipgrepCountRecord {
  readonly kind: "count";
  readonly path: Buffer;
  readonly count: number;
}

export type RipgrepOutputRecord =
  RipgrepContentRecord | RipgrepFileRecord | RipgrepCountRecord;

export interface RipgrepParserLimits {
  readonly maxRecordBytes: number;
  readonly maxDecodedBytes: number;
  readonly maxResults: number;
  readonly maxContextRecords: number;
  readonly maxAggregateMatchCount: number;
}

export interface RipgrepWireParser {
  readonly records: readonly RipgrepOutputRecord[];
  readonly decodedBytes: number;
  push(chunk: Buffer): void;
  finish(options?: { readonly allowPartial?: boolean }): void;
}

const DEFAULT_PARSER_LIMITS: RipgrepParserLimits = Object.freeze({
  maxRecordBytes: MAX_GREP_RECORD_BYTES,
  maxDecodedBytes: MAX_GREP_DECODED_BYTES,
  maxResults: MAX_GREP_RESULTS,
  maxContextRecords: MAX_GREP_CONTEXT_RECORDS,
  maxAggregateMatchCount: MAX_GREP_AGGREGATE_MATCH_COUNT,
});

const BYTE_NUL = 0x00;
const BYTE_LF = 0x0a;
const BYTE_CR = 0x0d;
const BYTE_BACKSLASH = 0x5c;
const UTF16_HIGH_SURROGATE_START = 0xd800;
const UTF16_HIGH_SURROGATE_END = 0xdbff;
const UTF16_LOW_SURROGATE_START = 0xdc00;
const UTF16_LOW_SURROGATE_END = 0xdfff;

function parserLimits(
  overrides?: Partial<RipgrepParserLimits>,
): RipgrepParserLimits {
  const limits = { ...DEFAULT_PARSER_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return limits;
}

export function assertGrepArgumentEncoding(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === BYTE_NUL) {
      throw new GrepBoundaryError(
        "ARGUMENT_NUL",
        `${label} contains an embedded NUL`,
      );
    }
    if (
      codeUnit >= UTF16_HIGH_SURROGATE_START &&
      codeUnit <= UTF16_HIGH_SURROGATE_END
    ) {
      const following = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        following < UTF16_LOW_SURROGATE_START ||
        following > UTF16_LOW_SURROGATE_END
      ) {
        throw new GrepBoundaryError(
          "ARGUMENT_LONE_SURROGATE",
          `${label} contains a lone UTF-16 high surrogate`,
        );
      }
      index += 1;
      continue;
    }
    if (
      codeUnit >= UTF16_LOW_SURROGATE_START &&
      codeUnit <= UTF16_LOW_SURROGATE_END
    ) {
      throw new GrepBoundaryError(
        "ARGUMENT_LONE_SURROGATE",
        `${label} contains a lone UTF-16 low surrogate`,
      );
    }
  }
}

export function grepArgvUtf8Bytes(
  executable: string,
  args: readonly string[],
): number {
  let total = 0;
  for (const [index, argument] of [executable, ...args].entries()) {
    assertGrepArgumentEncoding(
      argument,
      index === 0 ? "ripgrep executable" : `ripgrep argument ${index}`,
    );
    total += Buffer.byteLength(argument, "utf8") + 1;
    if (!Number.isSafeInteger(total)) {
      throw new GrepBoundaryError(
        "ARGV_UTF8_LIMIT",
        "ripgrep argv byte accounting overflowed",
      );
    }
  }
  return total;
}

export function grepWindowsCommandLineUtf16CodeUnits(
  executable: string,
  args: readonly string[],
): number {
  for (const [index, argument] of [executable, ...args].entries()) {
    assertGrepArgumentEncoding(
      argument,
      index === 0 ? "ripgrep executable" : `ripgrep argument ${index}`,
    );
  }
  return windowsCommandLineUtf16CodeUnits(executable, args);
}

export function assertGrepArgvWithinLimits(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  const utf8Bytes = grepArgvUtf8Bytes(executable, args);
  if (utf8Bytes > MAX_GREP_ARGV_UTF8_BYTES) {
    throw new GrepBoundaryError(
      "ARGV_UTF8_LIMIT",
      `ripgrep argv is ${utf8Bytes} UTF-8 bytes; maximum is ${MAX_GREP_ARGV_UTF8_BYTES}`,
    );
  }
  if (platform !== "win32") return;
  const utf16CodeUnits = grepWindowsCommandLineUtf16CodeUnits(executable, args);
  if (utf16CodeUnits > MAX_GREP_WINDOWS_COMMAND_LINE_UTF16_CODE_UNITS) {
    throw new GrepBoundaryError(
      "WINDOWS_COMMAND_LINE_LIMIT",
      `ripgrep command line is ${utf16CodeUnits} UTF-16 code units; Windows maximum is ${MAX_GREP_WINDOWS_COMMAND_LINE_UTF16_CODE_UNITS}`,
    );
  }
}

class RecordAccumulator {
  private readonly parts: Buffer[] = [];
  private length = 0;

  constructor(private readonly maximum: number) {}

  append(part: Buffer): void {
    if (part.byteLength === 0) return;
    const nextLength = this.length + part.byteLength;
    if (nextLength > this.maximum) {
      throw new GrepBoundaryError(
        "RECORD_LIMIT",
        `ripgrep record exceeds ${this.maximum} bytes`,
      );
    }
    this.parts.push(part);
    this.length = nextLength;
  }

  take(): Buffer {
    const record = Buffer.concat(this.parts, this.length);
    this.parts.length = 0;
    this.length = 0;
    return record;
  }

  get byteLength(): number {
    return this.length;
  }
}

abstract class DelimitedRipgrepParser implements RipgrepWireParser {
  protected readonly output: RipgrepOutputRecord[] = [];
  protected totalDecodedBytes = 0;
  protected resultCount = 0;
  protected contextCount = 0;
  protected readonly limits: RipgrepParserLimits;
  private readonly accumulator: RecordAccumulator;

  constructor(
    private readonly delimiter: number,
    limits?: Partial<RipgrepParserLimits>,
    protected readonly retainRecords = true,
  ) {
    this.limits = parserLimits(limits);
    this.accumulator = new RecordAccumulator(this.limits.maxRecordBytes);
  }

  get records(): readonly RipgrepOutputRecord[] {
    return this.output;
  }

  get decodedBytes(): number {
    return this.totalDecodedBytes;
  }

  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const delimiterIndex = chunk.indexOf(this.delimiter, start);
      if (delimiterIndex < 0) {
        this.accumulator.append(chunk.subarray(start));
        return;
      }
      this.accumulator.append(chunk.subarray(start, delimiterIndex));
      this.consumeRecord(this.accumulator.take());
      start = delimiterIndex + 1;
    }
  }

  finish(options?: { readonly allowPartial?: boolean }): void {
    if (options?.allowPartial === true) return;
    if (this.accumulator.byteLength > 0) this.unterminatedRecord();
    this.finishProtocol();
  }

  protected addDecodedBytes(byteLength: number): void {
    const next = this.totalDecodedBytes + byteLength;
    if (!Number.isSafeInteger(next) || next > this.limits.maxDecodedBytes) {
      throw new GrepBoundaryError(
        "DECODED_OUTPUT_LIMIT",
        `ripgrep decoded output exceeds ${this.limits.maxDecodedBytes} bytes`,
      );
    }
    this.totalDecodedBytes = next;
  }

  protected addResult(): void {
    this.resultCount += 1;
    if (this.resultCount > this.limits.maxResults) {
      throw new GrepBoundaryError(
        "RESULT_LIMIT",
        `ripgrep results exceed ${this.limits.maxResults} records`,
      );
    }
  }

  protected addContext(): void {
    this.contextCount += 1;
    if (this.contextCount > this.limits.maxContextRecords) {
      throw new GrepBoundaryError(
        "CONTEXT_LIMIT",
        `ripgrep context exceeds ${this.limits.maxContextRecords} records`,
      );
    }
  }

  protected abstract consumeRecord(record: Buffer): void;
  protected abstract unterminatedRecord(): never;
  protected finishProtocol(): void {}
}

class RipgrepFilesParser extends DelimitedRipgrepParser {
  constructor(limits?: Partial<RipgrepParserLimits>, retainRecords = true) {
    super(BYTE_NUL, limits, retainRecords);
  }

  protected consumeRecord(path: Buffer): void {
    if (path.byteLength === 0) {
      throw new GrepBoundaryError(
        "INVALID_WIRE_TEXT",
        "ripgrep emitted an empty path",
      );
    }
    this.addDecodedBytes(path.byteLength);
    this.addResult();
    if (this.retainRecords) this.output.push({ kind: "file", path });
  }

  protected unterminatedRecord(): never {
    throw new GrepBoundaryError(
      "MISSING_NUL",
      "ripgrep files-with-matches output is missing a terminating NUL",
    );
  }
}

class RipgrepCountParser implements RipgrepWireParser {
  private readonly output: RipgrepOutputRecord[] = [];
  private readonly limits: RipgrepParserLimits;
  private readonly path: RecordAccumulator;
  private readonly count: RecordAccumulator;
  private state: "path" | "count" = "path";
  private totalDecodedBytes = 0;
  private aggregateCount = 0;
  private resultCount = 0;

  constructor(
    limits?: Partial<RipgrepParserLimits>,
    private readonly retainRecords = true,
  ) {
    this.limits = parserLimits(limits);
    this.path = new RecordAccumulator(this.limits.maxRecordBytes);
    this.count = new RecordAccumulator(this.limits.maxRecordBytes);
  }

  get records(): readonly RipgrepOutputRecord[] {
    return this.output;
  }

  get decodedBytes(): number {
    return this.totalDecodedBytes;
  }

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.byteLength) {
      const delimiter = this.state === "path" ? BYTE_NUL : BYTE_LF;
      const delimiterIndex = chunk.indexOf(delimiter, start);
      if (delimiterIndex < 0) {
        this.currentAccumulator().append(chunk.subarray(start));
        return;
      }
      this.currentAccumulator().append(chunk.subarray(start, delimiterIndex));
      if (this.state === "path") {
        if (this.path.byteLength === 0) {
          throw new GrepBoundaryError(
            "INVALID_WIRE_TEXT",
            "ripgrep emitted an empty count path",
          );
        }
        this.state = "count";
      } else {
        this.emitCountRecord();
        this.state = "path";
      }
      start = delimiterIndex + 1;
    }
  }

  finish(options?: { readonly allowPartial?: boolean }): void {
    if (options?.allowPartial === true) return;
    if (this.state === "count") {
      throw new GrepBoundaryError(
        "UNTERMINATED_RECORD",
        "ripgrep count output is missing a terminating newline",
      );
    }
    if (this.path.byteLength > 0) {
      throw new GrepBoundaryError(
        "MISSING_NUL",
        "ripgrep count output is missing a path NUL delimiter",
      );
    }
  }

  private currentAccumulator(): RecordAccumulator {
    return this.state === "path" ? this.path : this.count;
  }

  private emitCountRecord(): void {
    const path = this.path.take();
    const countBytes = this.count.take();
    if (path.byteLength + countBytes.byteLength > this.limits.maxRecordBytes) {
      throw new GrepBoundaryError(
        "RECORD_LIMIT",
        `ripgrep count record exceeds ${this.limits.maxRecordBytes} bytes`,
      );
    }
    const count = parseStrictDecimalCount(
      countBytes,
      this.limits.maxAggregateMatchCount,
    );
    const aggregate = this.aggregateCount + count;
    if (
      !Number.isSafeInteger(aggregate) ||
      aggregate > this.limits.maxAggregateMatchCount
    ) {
      throw new GrepBoundaryError(
        "COUNT_OVERFLOW",
        `ripgrep aggregate match count exceeds ${this.limits.maxAggregateMatchCount}`,
      );
    }
    this.resultCount += 1;
    if (this.resultCount > this.limits.maxResults) {
      throw new GrepBoundaryError(
        "RESULT_LIMIT",
        `ripgrep results exceed ${this.limits.maxResults} records`,
      );
    }
    const decoded = this.totalDecodedBytes + path.byteLength;
    if (
      !Number.isSafeInteger(decoded) ||
      decoded > this.limits.maxDecodedBytes
    ) {
      throw new GrepBoundaryError(
        "DECODED_OUTPUT_LIMIT",
        `ripgrep decoded output exceeds ${this.limits.maxDecodedBytes} bytes`,
      );
    }
    this.aggregateCount = aggregate;
    this.totalDecodedBytes = decoded;
    if (this.retainRecords) this.output.push({ kind: "count", path, count });
  }
}

class RipgrepJsonParser extends DelimitedRipgrepParser {
  private openPath: Buffer | undefined;
  private sawSummary = false;

  constructor(limits?: Partial<RipgrepParserLimits>, retainRecords = true) {
    super(BYTE_LF, limits, retainRecords);
  }

  protected consumeRecord(record: Buffer): void {
    if (record.byteLength === 0) {
      throw new GrepBoundaryError(
        "MALFORMED_JSON",
        "ripgrep JSON output contains an empty record",
      );
    }
    if (record[record.byteLength - 1] === BYTE_CR) {
      throw new GrepBoundaryError(
        "MALFORMED_JSON",
        "ripgrep JSON output contains a non-canonical CRLF record",
      );
    }
    const decoded = decodeUtf8Strict(record, "ripgrep JSON record");
    let value: unknown;
    try {
      value = JSON.parse(decoded);
    } catch (error) {
      throw new GrepBoundaryError(
        "MALFORMED_JSON",
        `ripgrep emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.consumeJsonValue(value);
  }

  protected unterminatedRecord(): never {
    throw new GrepBoundaryError(
      "UNTERMINATED_RECORD",
      "ripgrep JSON output is missing a terminating newline",
    );
  }

  protected finishProtocol(): void {
    if (this.openPath !== undefined) {
      throw new GrepBoundaryError(
        "INVALID_JSON_RECORD_ORDER",
        "ripgrep JSON output ended before its file end record",
      );
    }
    if (!this.sawSummary) {
      throw new GrepBoundaryError(
        "INVALID_JSON_RECORD_ORDER",
        "ripgrep JSON output ended without a summary record",
      );
    }
  }

  private consumeJsonValue(value: unknown): void {
    const record = requireObject(value, "JSON record");
    const type = record.type;
    const data = requireObject(record.data, "JSON record data");
    if (typeof type !== "string") {
      invalidJsonRecord("ripgrep JSON record has no string type");
    }
    if (this.sawSummary) {
      invalidJsonOrder("ripgrep emitted a record after its summary");
    }
    if (type === "begin") {
      if (this.openPath !== undefined) {
        invalidJsonOrder("ripgrep emitted nested begin records");
      }
      this.openPath = decodeWirePath(data.path, "begin path");
      this.addDecodedBytes(this.openPath.byteLength);
      return;
    }
    if (type === "match" || type === "context") {
      if (this.openPath === undefined) {
        invalidJsonOrder(`ripgrep emitted ${type} before begin`);
      }
      const path = decodeWirePath(data.path, `${type} path`);
      if (!path.equals(this.openPath)) {
        invalidJsonOrder(`ripgrep ${type} path differs from its open file`);
      }
      const lines = decodeWireData(data.lines, `${type} lines`);
      const lineNumber = parseNullablePositiveInteger(
        data.line_number,
        `${type} line_number`,
      );
      const absoluteOffset = parseNonNegativeSafeInteger(
        data.absolute_offset,
        `${type} absolute_offset`,
      );
      const submatches = parseSubmatches(data.submatches, lines);
      this.addDecodedBytes(path.byteLength + lines.byteLength);
      if (type === "match") this.addResult();
      else this.addContext();
      if (this.retainRecords) {
        this.output.push({
          kind: "content",
          recordType: type,
          path,
          lines,
          lineNumber,
          absoluteOffset,
          submatches,
        });
      }
      return;
    }
    if (type === "end") {
      if (this.openPath === undefined) {
        invalidJsonOrder("ripgrep emitted end before begin");
      }
      const path = decodeWirePath(data.path, "end path");
      if (!path.equals(this.openPath)) {
        invalidJsonOrder("ripgrep end path differs from its open file");
      }
      this.addDecodedBytes(path.byteLength);
      this.openPath = undefined;
      return;
    }
    if (type === "summary") {
      if (this.openPath !== undefined) {
        invalidJsonOrder("ripgrep emitted summary before closing its file");
      }
      this.sawSummary = true;
      return;
    }
    invalidJsonRecord(`ripgrep emitted unsupported JSON record type '${type}'`);
  }
}

export function createRipgrepWireParser(
  mode: "content" | "files_with_matches" | "count",
  limits?: Partial<RipgrepParserLimits>,
): RipgrepWireParser {
  if (mode === "content") return new RipgrepJsonParser(limits);
  if (mode === "files_with_matches") return new RipgrepFilesParser(limits);
  return new RipgrepCountParser(limits);
}

/**
 * Validate every wire record without retaining it. Streaming pagination uses
 * this in parallel with its bounded output window so skipped records cannot
 * hide malformed paths, counts, JSON, or begin/match/end ordering.
 */
export function createRipgrepWireValidator(
  mode: "content" | "files_with_matches" | "count",
  limits?: Pick<RipgrepParserLimits, "maxRecordBytes">,
): RipgrepWireParser {
  const validatorLimits: Partial<RipgrepParserLimits> = {
    maxRecordBytes: limits?.maxRecordBytes ?? MAX_GREP_RECORD_BYTES,
    maxDecodedBytes: Number.MAX_SAFE_INTEGER,
    maxResults: Number.MAX_SAFE_INTEGER,
    maxContextRecords: Number.MAX_SAFE_INTEGER,
    maxAggregateMatchCount: Number.MAX_SAFE_INTEGER,
  };
  if (mode === "content") return new RipgrepJsonParser(validatorLimits, false);
  if (mode === "files_with_matches") {
    return new RipgrepFilesParser(validatorLimits, false);
  }
  return new RipgrepCountParser(validatorLimits, false);
}

export function renderRipgrepPathBytes(path: Buffer): string {
  try {
    return escapePathText(decodeUtf8Strict(path, "ripgrep path"));
  } catch (error) {
    if (
      !(error instanceof GrepBoundaryError) ||
      error.reason !== "INVALID_WIRE_TEXT"
    ) {
      throw error;
    }
    return `${escapeRawBytes(path)} [path-encoding=bytes]`;
  }
}

export function renderRipgrepContentBytes(content: Buffer): string {
  const withoutTerminator = stripOneLineTerminator(content);
  try {
    return decodeUtf8Strict(withoutTerminator, "ripgrep content");
  } catch (error) {
    if (
      !(error instanceof GrepBoundaryError) ||
      error.reason !== "INVALID_WIRE_TEXT"
    ) {
      throw error;
    }
    return `${escapeRawBytes(withoutTerminator)} [content-encoding=bytes]`;
  }
}

export function decodeRipgrepPathBytes(path: Buffer): string | undefined {
  try {
    return decodeUtf8Strict(path, "ripgrep path");
  } catch (error) {
    if (
      error instanceof GrepBoundaryError &&
      error.reason === "INVALID_WIRE_TEXT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function stripOneLineTerminator(content: Buffer): Buffer {
  if (content.byteLength === 0 || content[content.byteLength - 1] !== BYTE_LF) {
    return content;
  }
  const beforeLf = content.byteLength - 1;
  const end =
    beforeLf > 0 && content[beforeLf - 1] === BYTE_CR ? beforeLf - 1 : beforeLf;
  return content.subarray(0, end);
}

function escapePathText(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (character === "\\") escaped += "\\\\";
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (codePoint < 0x20 || codePoint === 0x7f) {
      escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else if (codePoint === 0x2028 || codePoint === 0x2029) {
      escaped += `\\u${codePoint.toString(16)}`;
    } else escaped += character;
  }
  return escaped;
}

function escapeRawBytes(value: Buffer): string {
  let escaped = "";
  for (const byte of value) {
    if (byte >= 0x20 && byte <= 0x7e && byte !== BYTE_BACKSLASH) {
      escaped += String.fromCharCode(byte);
    } else {
      escaped += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return escaped;
}

function decodeUtf8Strict(value: Buffer, label: string): string {
  try {
    // A leading EF BB BF is a valid part of a Unix filename or matched line,
    // not a transport marker owned by this protocol. Preserve it so rendering
    // remains byte-faithful instead of silently changing the record.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      value,
    );
  } catch {
    throw new GrepBoundaryError(
      "INVALID_WIRE_TEXT",
      `${label} is not valid UTF-8`,
    );
  }
}

function decodeWireData(value: unknown, label: string): Buffer {
  const data = requireObject(value, label);
  const hasText = Object.prototype.hasOwnProperty.call(data, "text");
  const hasBytes = Object.prototype.hasOwnProperty.call(data, "bytes");
  if (hasText === hasBytes) {
    invalidJsonRecord(`${label} must contain exactly one of text or bytes`);
  }
  if (hasText) {
    if (typeof data.text !== "string") {
      invalidJsonRecord(`${label}.text must be a string`);
    }
    try {
      assertGrepArgumentEncoding(data.text, `${label}.text`);
    } catch (error) {
      throw new GrepBoundaryError(
        "INVALID_WIRE_TEXT",
        error instanceof Error ? error.message : String(error),
      );
    }
    return Buffer.from(data.text, "utf8");
  }
  if (typeof data.bytes !== "string") {
    invalidJsonRecord(`${label}.bytes must be a string`);
  }
  return decodeCanonicalBase64(data.bytes, label);
}

function decodeWirePath(value: unknown, label: string): Buffer {
  const path = decodeWireData(value, label);
  if (path.byteLength === 0) {
    invalidJsonRecord(`${label} must not be empty`);
  }
  return path;
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (value.length % 4 !== 0) {
    invalidBase64(label);
  }
  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphaNumeric =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39);
    if (isAlphaNumeric || code === 0x2b || code === 0x2f) {
      if (padding > 0) invalidBase64(label);
      continue;
    }
    if (code === 0x3d && index >= value.length - 2) {
      padding += 1;
      if (padding > 2) invalidBase64(label);
      continue;
    }
    invalidBase64(label);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) invalidBase64(label);
  return decoded;
}

function invalidBase64(label: string): never {
  throw new GrepBoundaryError(
    "INVALID_WIRE_BASE64",
    `${label}.bytes is not canonical base64`,
  );
}

function parseSubmatches(value: unknown, lines: Buffer): RipgrepSubmatch[] {
  if (!Array.isArray(value)) {
    invalidJsonRecord("ripgrep submatches must be an array");
  }
  const parsed: RipgrepSubmatch[] = [];
  let previousEnd = 0;
  for (const [index, entryValue] of value.entries()) {
    const entry = requireObject(entryValue, `submatch ${index}`);
    const start = parseNonNegativeSafeInteger(
      entry.start,
      `submatch ${index} start`,
    );
    const end = parseNonNegativeSafeInteger(entry.end, `submatch ${index} end`);
    if (start > end || end > lines.byteLength || start < previousEnd) {
      invalidJsonRecord(`ripgrep submatch ${index} has impossible offsets`);
    }
    const bytes = decodeWireData(entry.match, `submatch ${index} match`);
    if (bytes.byteLength !== end - start) {
      invalidJsonRecord(
        `ripgrep submatch ${index} length disagrees with offsets`,
      );
    }
    if (!bytes.equals(lines.subarray(start, end))) {
      invalidJsonRecord(
        `ripgrep submatch ${index} bytes disagree with its line slice`,
      );
    }
    parsed.push({ bytes, start, end });
    previousEnd = end;
  }
  return parsed;
}

function parseStrictDecimalCount(value: Buffer, maximum: number): number {
  if (value.byteLength === 0) {
    throw new GrepBoundaryError(
      "INVALID_COUNT",
      "ripgrep emitted an empty match count",
    );
  }
  let count = 0;
  for (const byte of value) {
    if (byte < 0x30 || byte > 0x39) {
      throw new GrepBoundaryError(
        "INVALID_COUNT",
        "ripgrep emitted a non-decimal match count",
      );
    }
    const digit = byte - 0x30;
    if (count > Math.floor((maximum - digit) / 10)) {
      throw new GrepBoundaryError(
        "COUNT_OVERFLOW",
        `ripgrep match count exceeds ${maximum}`,
      );
    }
    count = count * 10 + digit;
  }
  return count;
}

function parseNullablePositiveInteger(
  value: unknown,
  label: string,
): number | null {
  if (value === null) return null;
  const parsed = parseNonNegativeSafeInteger(value, label);
  if (parsed === 0) invalidJsonRecord(`${label} must be positive or null`);
  return parsed;
}

function parseNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidJsonRecord(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidJsonRecord(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalidJsonRecord(message: string): never {
  throw new GrepBoundaryError("INVALID_JSON_RECORD", message);
}

function invalidJsonOrder(message: string): never {
  throw new GrepBoundaryError("INVALID_JSON_RECORD_ORDER", message);
}
