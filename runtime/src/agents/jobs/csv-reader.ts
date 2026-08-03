/** Strict, bounded CSV streaming and runtime-owned row identity. */

import { createHash, type Hash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  CSV_MAX_COLUMNS,
  CSV_MAX_FIELD_BYTES,
  CSV_MAX_HEADER_BYTES,
  CSV_MAX_INPUT_BYTES,
  CSV_MAX_RECORD_BYTES,
  CSV_MAX_ROWS,
  CSV_RESERVED_OUTPUT_HEADERS,
} from "../../contracts/csv-job-contract.js";

export interface CsvRow {
  readonly [column: string]: string;
}

export interface CsvDocument {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<CsvRow>;
  readonly inputBytes: number;
  readonly inputSha256: string;
}

export interface CsvScanResult {
  readonly headers: ReadonlyArray<string>;
  readonly rowCount: number;
  readonly inputBytes: number;
  readonly inputSha256: string;
}

export interface CsvScanCallbacks {
  readonly onHeaders?: (headers: ReadonlyArray<string>) => void;
  readonly onRow?: (row: CsvRow, rowIndex: number) => void;
}

export interface CsvReadOptions {
  readonly idColumn?: string;
  readonly maxInputBytes?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
  readonly maxFieldBytes?: number;
  readonly maxHeaderBytes?: number;
  readonly maxRecordBytes?: number;
  /** Repository imports enforce source-ID uniqueness with their indexed table. */
  readonly validateSourceIdUniqueness?: boolean;
  readonly inputRootCapability?: CsvInputRootCapability;
  readonly signal?: AbortSignal;
}

export interface CsvItemIdentity {
  readonly itemId: string;
  readonly contentSha256: string;
  readonly workerName: string;
}

interface ResolvedCsvLimits {
  readonly maxInputBytes: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxFieldBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxRecordBytes: number;
}

interface CsvParserPosition {
  readonly line: number;
  readonly column: number;
  readonly byteOffset: number;
}

interface BigIntFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface CsvInputRootIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const CSV_READ_CHUNK_BYTES = 64 * 1_024;
const CSV_ITEM_HASH_DOMAIN = "agenc.csv.item.v1";
const CSV_CONTENT_HASH_DOMAIN = "agenc.csv.content.v1";
const CSV_WORKER_HASH_CHARACTERS = 16;
const CSV_INPUT_CAPABILITY_SECRET = Symbol("csv-input-root-capability");

/** Authority to import one regular CSV file beneath an authenticated root. */
export class CsvInputRootCapability {
  constructor(
    secret: symbol,
    readonly canonicalRoot: string,
    private readonly rootIdentity: CsvInputRootIdentity,
  ) {
    if (secret !== CSV_INPUT_CAPABILITY_SECRET) {
      throw new Error(
        "CsvInputRootCapability cannot be constructed externally",
      );
    }
  }

  assertRootIdentity(): void {
    const current = lstatSync(this.canonicalRoot, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== this.rootIdentity.dev ||
      current.ino !== this.rootIdentity.ino
    ) {
      throw new Error("CSV input root identity changed");
    }
  }
}

export function createCsvInputRootCapability(
  readableRoot: string,
): CsvInputRootCapability {
  const canonicalRoot = realpathSync(readableRoot);
  const root = lstatSync(canonicalRoot, { bigint: true });
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("CSV input capability root must be a real directory");
  }
  return new CsvInputRootCapability(
    CSV_INPUT_CAPABILITY_SECRET,
    canonicalRoot,
    { dev: root.dev, ino: root.ino },
  );
}

export function resolveCsvInputPath(
  capability: CsvInputRootCapability,
  requestedPath: string,
): string {
  capability.assertRootIdentity();
  if (requestedPath.trim().length === 0 || requestedPath.includes("\0")) {
    throw new Error("CSV input path must be a non-empty filesystem path");
  }
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(capability.canonicalRoot, requestedPath);
  assertCsvInputBeneathRoot(capability.canonicalRoot, candidate);
  return candidate;
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column = 1,
    readonly byteOffset = 0,
  ) {
    super(`${message} (line ${line}, column ${column}, byte ${byteOffset})`);
    this.name = "CsvParseError";
  }
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > fallback) {
    throw new Error(`${label} must be an integer between 1 and ${fallback}`);
  }
  return resolved;
}

function resolveLimits(options: CsvReadOptions): ResolvedCsvLimits {
  return {
    maxInputBytes: positiveBound(
      options.maxInputBytes,
      CSV_MAX_INPUT_BYTES,
      "CSV maxInputBytes",
    ),
    maxRows: positiveBound(options.maxRows, CSV_MAX_ROWS, "CSV maxRows"),
    maxColumns: positiveBound(
      options.maxColumns,
      CSV_MAX_COLUMNS,
      "CSV maxColumns",
    ),
    maxFieldBytes: positiveBound(
      options.maxFieldBytes,
      CSV_MAX_FIELD_BYTES,
      "CSV maxFieldBytes",
    ),
    maxHeaderBytes: positiveBound(
      options.maxHeaderBytes,
      CSV_MAX_HEADER_BYTES,
      "CSV maxHeaderBytes",
    ),
    maxRecordBytes: positiveBound(
      options.maxRecordBytes,
      CSV_MAX_RECORD_BYTES,
      "CSV maxRecordBytes",
    ),
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function isSameFileIdentity(
  before: BigIntFileIdentity,
  after: BigIntFileIdentity,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

/**
 * Read one regular file through its already-open descriptor, decode UTF-8
 * fatally, and feed records incrementally without materializing raw bytes or a
 * second full decoded string.
 */
export async function scanCsvFile(
  path: string,
  options: CsvReadOptions = {},
  callbacks: CsvScanCallbacks = {},
): Promise<CsvScanResult> {
  const limits = resolveLimits(options);
  assertNotAborted(options.signal);
  const admittedPath =
    options.inputRootCapability === undefined
      ? path
      : resolveCsvInputPath(options.inputRootCapability, path);
  const handle = await open(admittedPath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error(`CSV source is not a regular file: ${admittedPath}`);
    }
    const admittedCanonicalPath = await authenticateCsvInputPath(
      options.inputRootCapability,
      admittedPath,
      before,
    );
    if (before.size > BigInt(limits.maxInputBytes)) {
      throw new Error(
        `CSV source is ${before.size.toString()} bytes; limit is ${limits.maxInputBytes}`,
      );
    }

    const parser = new IncrementalCsvParser(options, limits, callbacks);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const digest: Hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(
      Math.min(CSV_READ_CHUNK_BYTES, limits.maxInputBytes),
    );
    let inputBytes = 0;
    for (;;) {
      assertNotAborted(options.signal);
      const read = await handle.read(buffer, 0, buffer.byteLength, inputBytes);
      if (read.bytesRead === 0) break;
      inputBytes += read.bytesRead;
      if (inputBytes > limits.maxInputBytes) {
        throw new CsvParseError(
          `CSV input is ${inputBytes} bytes; limit is ${limits.maxInputBytes}`,
          parser.position.line,
          parser.position.column,
          inputBytes,
        );
      }
      const chunk = buffer.subarray(0, read.bytesRead);
      digest.update(chunk);
      let decoded: string;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch {
        throw new CsvParseError(
          "CSV source is not valid UTF-8",
          parser.position.line,
          parser.position.column,
          parser.position.byteOffset,
        );
      }
      parser.write(decoded);
    }
    try {
      parser.write(decoder.decode());
    } catch (error) {
      if (error instanceof CsvParseError) throw error;
      throw new CsvParseError(
        "CSV source is not valid UTF-8",
        parser.position.line,
        parser.position.column,
        parser.position.byteOffset,
      );
    }
    const parsed = parser.finish();
    const after = await handle.stat({ bigint: true });
    assertNotAborted(options.signal);
    if (
      BigInt(inputBytes) !== before.size ||
      !isSameFileIdentity(before, after)
    ) {
      throw new Error("CSV source changed while it was being imported");
    }
    await revalidateCsvInputPath(
      options.inputRootCapability,
      admittedPath,
      admittedCanonicalPath,
      after,
    );
    return Object.freeze({
      ...parsed,
      inputBytes,
      inputSha256: digest.digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function authenticateCsvInputPath(
  capability: CsvInputRootCapability | undefined,
  admittedPath: string,
  openedIdentity: BigIntFileIdentity,
): Promise<string | undefined> {
  if (capability === undefined) return undefined;
  capability.assertRootIdentity();
  const canonicalPath = await realpath(admittedPath);
  assertCsvInputBeneathRoot(capability.canonicalRoot, canonicalPath);
  const current = await lstat(canonicalPath, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !isSameFileIdentity(openedIdentity, current)
  ) {
    throw new Error(
      "CSV input path identity changed while it was being opened",
    );
  }
  return canonicalPath;
}

async function revalidateCsvInputPath(
  capability: CsvInputRootCapability | undefined,
  admittedPath: string,
  admittedCanonicalPath: string | undefined,
  openedIdentity: BigIntFileIdentity,
): Promise<void> {
  if (capability === undefined || admittedCanonicalPath === undefined) return;
  capability.assertRootIdentity();
  const canonicalPath = await realpath(admittedPath);
  if (canonicalPath !== admittedCanonicalPath) {
    throw new Error("CSV input path changed while it was being imported");
  }
  assertCsvInputBeneathRoot(capability.canonicalRoot, canonicalPath);
  const current = await lstat(canonicalPath, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !isSameFileIdentity(openedIdentity, current)
  ) {
    throw new Error(
      "CSV input path identity changed while it was being imported",
    );
  }
}

function assertCsvInputBeneathRoot(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("CSV input path is outside the authorized input root");
  }
}

export async function readCsvFile(
  path: string,
  options: CsvReadOptions = {},
): Promise<CsvDocument> {
  const rows: CsvRow[] = [];
  const scanned = await scanCsvFile(path, options, {
    onRow: (row) => rows.push(row),
  });
  return Object.freeze({
    headers: scanned.headers,
    rows: Object.freeze(rows),
    inputBytes: scanned.inputBytes,
    inputSha256: scanned.inputSha256,
  });
}

export function parseCsv(
  text: string,
  options: CsvReadOptions = {},
): CsvDocument {
  assertNotAborted(options.signal);
  const limits = resolveLimits(options);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > limits.maxInputBytes) {
    throw new CsvParseError(
      `CSV input is ${bytes.byteLength} bytes; limit is ${limits.maxInputBytes}`,
      1,
    );
  }
  const rows: CsvRow[] = [];
  const parser = new IncrementalCsvParser(options, limits, {
    onRow: (row) => rows.push(row),
  });
  parser.write(text);
  const parsed = parser.finish();
  return Object.freeze({
    headers: parsed.headers,
    rows: Object.freeze(rows),
    inputBytes: bytes.byteLength,
    inputSha256: sha256(bytes),
  });
}

class IncrementalCsvParser {
  private readonly sourceIds = new Map<string, number>();
  private readonly fields: string[] = [];
  private field = "";
  private fieldBytes = 0;
  private recordBytes = 0;
  private headers: ReadonlyArray<string> | undefined;
  private rowCount = 0;
  private inQuotes = false;
  private quotedQuotePending = false;
  private afterQuote = false;
  private structuralCrPending = false;
  private sawAnyCharacter = false;
  private recordLine = 1;
  private line = 1;
  private column = 1;
  private byteOffset = 0;

  constructor(
    private readonly options: CsvReadOptions,
    private readonly limits: ResolvedCsvLimits,
    private readonly callbacks: CsvScanCallbacks,
  ) {}

  get position(): CsvParserPosition {
    return {
      line: this.line,
      column: this.column,
      byteOffset: this.byteOffset,
    };
  }

  write(text: string): void {
    for (const character of text) {
      assertNotAborted(this.options.signal);
      this.sawAnyCharacter = true;
      const characterBytes = Buffer.byteLength(character, "utf8");
      this.recordBytes += characterBytes;
      if (this.recordBytes > this.limits.maxRecordBytes) {
        this.fail(
          `CSV record is more than ${this.limits.maxRecordBytes} bytes`,
        );
      }
      if (
        this.headers === undefined &&
        this.recordBytes > this.limits.maxHeaderBytes + 2
      ) {
        this.fail(
          `CSV header is more than ${this.limits.maxHeaderBytes} bytes`,
        );
      }
      this.processCharacter(character, characterBytes);
      this.byteOffset += characterBytes;
      if (character === "\n") {
        this.line += 1;
        this.column = 1;
      } else {
        this.column += 1;
      }
    }
  }

  finish(): Pick<CsvScanResult, "headers" | "rowCount"> {
    assertNotAborted(this.options.signal);
    if (this.structuralCrPending) {
      this.fail("bare CR outside a quoted field is not valid CSV");
    }
    if (this.quotedQuotePending) {
      this.quotedQuotePending = false;
      this.inQuotes = false;
      this.afterQuote = true;
    }
    if (this.inQuotes) this.fail("unterminated quoted field");
    if (this.field.length > 0 || this.fields.length > 0 || this.afterQuote) {
      this.finishRecord(0);
    }
    if (!this.sawAnyCharacter || this.headers === undefined) {
      this.fail("CSV header is empty");
    }
    const headers = this.headers;
    return { headers, rowCount: this.rowCount };
  }

  private processCharacter(character: string, characterBytes: number): void {
    if (character === "\0") {
      this.fail("NUL is not valid in CSV input");
    }
    if (character === "\uFEFF" && this.byteOffset !== 0) {
      this.fail("UTF-8 BOM is permitted only at the start of the first header");
    }
    if (this.structuralCrPending) {
      this.structuralCrPending = false;
      if (character !== "\n") {
        this.fail("bare CR outside a quoted field is not valid CSV");
      }
      this.finishRecord(2);
      return;
    }

    if (this.quotedQuotePending) {
      this.quotedQuotePending = false;
      if (character === '"') {
        this.appendField('"', characterBytes);
        return;
      }
      this.inQuotes = false;
      this.afterQuote = true;
      this.processOutsideQuotes(character);
      return;
    }

    if (this.inQuotes) {
      if (character === '"') {
        this.quotedQuotePending = true;
      } else {
        this.appendField(character, characterBytes);
      }
      return;
    }
    this.processOutsideQuotes(character);
  }

  private processOutsideQuotes(character: string): void {
    if (
      this.afterQuote &&
      character !== "," &&
      character !== "\r" &&
      character !== "\n"
    ) {
      this.fail("unexpected data after closing quote");
    }
    if (character === '"') {
      if (this.fieldBytes !== 0 || this.afterQuote) {
        this.fail("unexpected quote in unquoted field");
      }
      this.inQuotes = true;
      return;
    }
    if (character === ",") {
      this.finishField();
      return;
    }
    if (character === "\r") {
      this.structuralCrPending = true;
      return;
    }
    if (character === "\n") {
      this.finishRecord(1);
      return;
    }
    this.appendField(character, Buffer.byteLength(character, "utf8"));
  }

  private appendField(character: string, characterBytes: number): void {
    this.fieldBytes += characterBytes;
    if (this.fieldBytes > this.limits.maxFieldBytes) {
      this.fail(
        `CSV field is ${this.fieldBytes} bytes; limit is ${this.limits.maxFieldBytes}`,
      );
    }
    this.field += character;
  }

  private finishField(): void {
    this.fields.push(this.field);
    if (this.fields.length > this.limits.maxColumns) {
      this.fail(`CSV row has more than ${this.limits.maxColumns} fields`);
    }
    this.field = "";
    this.fieldBytes = 0;
    this.afterQuote = false;
  }

  private finishRecord(terminatorBytes: 0 | 1 | 2): void {
    this.finishField();
    const fields = this.fields.splice(0, this.fields.length);
    if (this.headers === undefined) {
      const rawHeaderBytes = this.recordBytes - terminatorBytes;
      if (rawHeaderBytes > this.limits.maxHeaderBytes) {
        this.fail(
          `CSV header is ${rawHeaderBytes} bytes; limit is ${this.limits.maxHeaderBytes}`,
        );
      }
      if (fields.length > 0) fields[0] = fields[0]!.replace(/^\uFEFF/u, "");
      validateHeaders(
        fields,
        this.recordLine,
        this.limits,
        this.options.idColumn,
        this.byteOffset,
      );
      this.headers = Object.freeze(fields);
      this.callbacks.onHeaders?.(this.headers);
    } else if (!fields.every((cell) => cell.length === 0)) {
      if (this.rowCount >= this.limits.maxRows) {
        this.fail(`CSV has more than ${this.limits.maxRows} data rows`);
      }
      if (fields.length > this.headers.length) {
        this.fail(
          `CSV row has ${fields.length} fields; header has ${this.headers.length}`,
        );
      }
      const row = inertRow(this.headers, fields);
      this.validateSourceId(row);
      this.callbacks.onRow?.(row, this.rowCount);
      this.rowCount += 1;
    }
    this.recordBytes = 0;
    this.recordLine = this.line + 1;
  }

  private validateSourceId(row: CsvRow): void {
    const idColumn = this.options.idColumn;
    if (idColumn === undefined) return;
    const sourceId = row[idColumn]!;
    if (sourceId.trim().length === 0) {
      this.fail(
        `id_column ${JSON.stringify(idColumn)} is blank at CSV data row ${this.rowCount + 1}`,
      );
    }
    const first = this.sourceIds.get(sourceId);
    if (
      this.options.validateSourceIdUniqueness !== false &&
      first !== undefined
    ) {
      this.fail(
        `duplicate id_column value ${JSON.stringify(sourceId)} at CSV data rows ${first + 1} and ${this.rowCount + 1}`,
      );
    }
    if (this.options.validateSourceIdUniqueness !== false) {
      this.sourceIds.set(sourceId, this.rowCount);
    }
  }

  private fail(message: string): never {
    throw new CsvParseError(message, this.line, this.column, this.byteOffset);
  }
}

function validateHeaders(
  headers: ReadonlyArray<string>,
  line: number,
  limits: ResolvedCsvLimits,
  idColumn: string | undefined,
  byteOffset: number,
): void {
  if (headers.length === 0) {
    throw new CsvParseError("CSV header is empty", line, 1, byteOffset);
  }
  if (headers.length > limits.maxColumns) {
    throw new CsvParseError(
      `CSV has ${headers.length} columns; limit is ${limits.maxColumns}`,
      line,
      1,
      byteOffset,
    );
  }
  const encodedHeaderBytes = Buffer.byteLength(headers.join(","), "utf8");
  if (encodedHeaderBytes > limits.maxHeaderBytes) {
    throw new CsvParseError(
      `CSV header is ${encodedHeaderBytes} bytes; limit is ${limits.maxHeaderBytes}`,
      line,
      1,
      byteOffset,
    );
  }
  const seen = new Map<string, number>();
  headers.forEach((header, index) => {
    if (header.trim().length === 0) {
      throw new CsvParseError(
        "CSV header is blank",
        line,
        index + 1,
        byteOffset,
      );
    }
    const first = seen.get(header);
    if (first !== undefined) {
      throw new CsvParseError(
        `duplicate CSV header ${JSON.stringify(header)} at columns ${first + 1} and ${index + 1}`,
        line,
        index + 1,
        byteOffset,
      );
    }
    seen.set(header, index);
  });
  for (const header of headers) {
    const configuredSourceId =
      header === "source_id" && idColumn === "source_id";
    if (CSV_RESERVED_OUTPUT_HEADERS.has(header) && !configuredSourceId) {
      throw new CsvParseError(
        `CSV header ${JSON.stringify(header)} is reserved for job output`,
        line,
        1,
        byteOffset,
      );
    }
  }
  if (idColumn !== undefined && !headers.includes(idColumn)) {
    throw new CsvParseError(
      `id_column ${JSON.stringify(idColumn)} is not in the CSV header`,
      line,
      1,
      byteOffset,
    );
  }
}

function inertRow(
  headers: ReadonlyArray<string>,
  fields: ReadonlyArray<string>,
): CsvRow {
  const row = Object.create(null) as Record<string, string>;
  for (let index = 0; index < headers.length; index += 1) {
    Object.defineProperty(row, headers[index]!, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: fields[index] ?? "",
    });
  }
  return Object.freeze(row);
}

export function deriveCsvItemIdentity(
  jobId: string,
  rowIndex: number,
  headers: ReadonlyArray<string>,
  row: CsvRow,
): CsvItemIdentity {
  const orderedFields = headers.map(
    (header) => [header, row[header] ?? ""] as const,
  );
  const contentSha256 = sha256(
    `${CSV_CONTENT_HASH_DOMAIN}\0${JSON.stringify(orderedFields)}`,
  );
  const itemDigest = sha256(
    `${CSV_ITEM_HASH_DOMAIN}\0${jobId.length}:${jobId}\0${rowIndex}\0${contentSha256}`,
  );
  return {
    itemId: `csv_item_${itemDigest}`,
    contentSha256,
    workerName: `csv_row_${rowIndex}_${contentSha256.slice(0, CSV_WORKER_HASH_CHARACTERS)}`,
  };
}

export function writeCsv(
  document: Pick<CsvDocument, "headers" | "rows">,
): string {
  const lines = [document.headers.map(escapeCsvCell).join(",")];
  for (const row of document.rows) {
    lines.push(
      document.headers
        .map((header) => escapeCsvCell(row[header] ?? ""))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function escapeCsvCell(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/gu, '""')}"`;
  }
  return value;
}
