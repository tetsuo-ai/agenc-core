import type { WorkspaceBoundReadCapability } from "./file-mutation-transaction.js";

export type StructuredRipgrepLimit = NonNullable<Parameters<WorkspaceBoundReadCapability["runRipgrep"]>[0]["structuredLineLimit"]>;
export interface StructuredRipgrepLimiter {
  readonly processedLines: number;
  readonly workUnits: number;
  consume(chunk: Buffer): { readonly captureParts: readonly Buffer[]; readonly reached: boolean };
  finish(options?: { readonly allowPartial?: boolean }): void;
}

// Keep the local helper and controller parser on the same implementation. This
// literal is repository-owned code; task bytes are passed only to consume().
export const STRUCTURED_RIPGREP_LIMITER_SOURCE = String.raw`
const createStructuredRipgrepLimiter = (value) => {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    !["content", "files_with_matches", "count"].includes(value.outputMode) ||
    !Number.isSafeInteger(value.maximumLines) ||
    value.maximumLines < 1 ||
    !Number.isSafeInteger(value.maximumRecordBytes) ||
    value.maximumRecordBytes < 1 ||
    (value.maximumWorkUnits !== undefined &&
      (!Number.isSafeInteger(value.maximumWorkUnits) ||
        value.maximumWorkUnits < 0)) ||
    (value.skipLines !== undefined &&
      (!Number.isSafeInteger(value.skipLines) || value.skipLines < 0)) ||
    (value.excludedPaths !== undefined &&
      (!Array.isArray(value.excludedPaths) ||
        !value.excludedPaths.every((path) => typeof path === "string")))
  ) {
    throw Object.assign(new Error("invalid structured ripgrep line limit"), {
      code: "INVALID_COMMAND",
    });
  }

  const outputMode = value.outputMode;
  const maximumLines = value.maximumLines;
  const skipLines = value.skipLines ?? 0;
  const maximumRecordBytes = value.maximumRecordBytes;
  const maximumWorkUnits = value.maximumWorkUnits ?? Number.MAX_SAFE_INTEGER;
  const BYTE_NUL = 0;
  const BYTE_LINE_FEED = 10;
  const BYTE_CARRIAGE_RETURN = 13;
  const boundary = (reason, message) => {
    throw new Error("[" + reason + "] " + message);
  };
  const requireObject = (candidate, label) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      boundary("INVALID_JSON_RECORD", label + " must be an object");
    }
    return candidate;
  };
  const assertWireText = (text, label) => {
    for (let index = 0; index < text.length; index += 1) {
      const codeUnit = text.charCodeAt(index);
      if (codeUnit === BYTE_NUL) {
        boundary("INVALID_WIRE_TEXT", label + " contains an embedded NUL");
      }
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const following = text.charCodeAt(index + 1);
        if (following < 0xdc00 || following > 0xdfff) {
          boundary(
            "INVALID_WIRE_TEXT",
            label + " contains a lone UTF-16 high surrogate",
          );
        }
        index += 1;
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        boundary(
          "INVALID_WIRE_TEXT",
          label + " contains a lone UTF-16 low surrogate",
        );
      }
    }
  };
  const decodeUtf8Strict = (bytes, label) => {
    try {
      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      boundary("INVALID_WIRE_TEXT", label + " is not valid UTF-8");
    }
  };
  const decodeCanonicalBase64 = (text, label) => {
    if (
      typeof text !== "string" ||
      text.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        text,
      )
    ) {
      boundary(
        "INVALID_WIRE_BASE64",
        label + ".bytes is not canonical base64",
      );
    }
    const decoded = Buffer.from(text, "base64");
    if (decoded.toString("base64") !== text) {
      boundary(
        "INVALID_WIRE_BASE64",
        label + ".bytes is not canonical base64",
      );
    }
    return decoded;
  };
  const decodeWireData = (candidate, label) => {
    const data = requireObject(candidate, label);
    const hasText = Object.prototype.hasOwnProperty.call(data, "text");
    const hasBytes = Object.prototype.hasOwnProperty.call(data, "bytes");
    if (hasText === hasBytes) {
      boundary(
        "INVALID_JSON_RECORD",
        label + " must contain exactly one of text or bytes",
      );
    }
    if (hasText) {
      if (typeof data.text !== "string") {
        boundary("INVALID_JSON_RECORD", label + ".text must be a string");
      }
      assertWireText(data.text, label + ".text");
      return Buffer.from(data.text, "utf8");
    }
    return decodeCanonicalBase64(data.bytes, label);
  };
  const decodeWirePath = (candidate, label) => {
    const path = decodeWireData(candidate, label);
    if (path.length === 0) {
      boundary("INVALID_JSON_RECORD", label + " must not be empty");
    }
    return path;
  };
  const parseNonNegativeSafeInteger = (candidate, label) => {
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      boundary(
        "INVALID_JSON_RECORD",
        label + " must be a non-negative safe integer",
      );
    }
    return candidate;
  };
  const parseNullablePositiveInteger = (candidate, label) => {
    if (candidate === null) return null;
    const parsed = parseNonNegativeSafeInteger(candidate, label);
    if (parsed === 0) {
      boundary(
        "INVALID_JSON_RECORD",
        label + " must be positive or null",
      );
    }
    return parsed;
  };
  const validateSubmatches = (candidate, lines) => {
    if (!Array.isArray(candidate)) {
      boundary("INVALID_JSON_RECORD", "ripgrep submatches must be an array");
    }
    let previousEnd = 0;
    for (let index = 0; index < candidate.length; index += 1) {
      const entry = requireObject(candidate[index], "submatch " + index);
      const start = parseNonNegativeSafeInteger(
        entry.start,
        "submatch " + index + " start",
      );
      const end = parseNonNegativeSafeInteger(
        entry.end,
        "submatch " + index + " end",
      );
      if (start > end || end > lines.length || start < previousEnd) {
        boundary(
          "INVALID_JSON_RECORD",
          "ripgrep submatch " + index + " has impossible offsets",
        );
      }
      const match = decodeWireData(
        entry.match,
        "submatch " + index + " match",
      );
      if (
        match.length !== end - start ||
        !match.equals(lines.subarray(start, end))
      ) {
        boundary(
          "INVALID_JSON_RECORD",
          "ripgrep submatch " + index + " disagrees with its line slice",
        );
      }
      previousEnd = end;
    }
  };
  const parseStrictDecimalCount = (bytes) => {
    if (bytes.length === 0) {
      boundary("INVALID_COUNT", "ripgrep emitted an empty match count");
    }
    let count = 0;
    for (const byte of bytes) {
      if (byte < 0x30 || byte > 0x39) {
        boundary(
          "INVALID_COUNT",
          "ripgrep emitted a non-decimal match count",
        );
      }
      const digit = byte - 0x30;
      if (count > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 10)) {
        boundary(
          "COUNT_OVERFLOW",
          "ripgrep match count exceeds Number.MAX_SAFE_INTEGER",
        );
      }
      count = count * 10 + digit;
    }
    return count;
  };
  const normalizedPathByteKey = (path) => {
    if (process.platform === "win32") {
      const normalized = decodeUtf8Strict(
        path,
        "ripgrep Windows path",
      )
        .replace(/\\/gu, "/")
        .replace(/^\.\/+/u, "")
        .toLowerCase();
      return "win32:" + Buffer.from(normalized, "utf8").toString("hex");
    }
    let start = 0;
    if (path.length >= 2 && path[0] === 0x2e && path[1] === 0x2f) {
      start = 1;
      while (start < path.length && path[start] === 0x2f) start += 1;
    }
    return "posix:" + path.subarray(start).toString("hex");
  };
  const excludedPathByteKeys = new Set(
    (value.excludedPaths ?? []).map((path) => {
      assertWireText(path, "excluded ripgrep path");
      return normalizedPathByteKey(Buffer.from(path, "utf8"));
    }),
  );
  let processedLines = 0;
  let workUnits = 0;
  let retainedLines = 0;
  let reached = false;
  let delimitedRecordBytes = 0;
  let delimitedRecordParts = [];
  let countState = "path";
  let countPath = null;
  let countRecordExcluded = false;
  let aggregateCount = 0;
  let pendingJsonParts = [];
  let pendingJsonBytes = 0;
  let pendingBegin = null;
  let capturingJsonFile = false;
  let openJsonPath = null;
  let openJsonExcluded = false;
  let sawJsonSummary = false;

  const addWorkUnits = (count) => {
    if (count > maximumWorkUnits - workUnits) {
      boundary(
        "RESULT_LIMIT",
        "structured ripgrep work exceeds " + maximumWorkUnits + " units",
      );
    }
    workUnits += count;
  };

  const addDelimitedRecordBytes = (byteLength) => {
    delimitedRecordBytes += byteLength;
    if (delimitedRecordBytes > maximumRecordBytes) {
      boundary(
        "RECORD_LIMIT",
        "structured ripgrep record exceeds " + maximumRecordBytes + " bytes",
      );
    }
  };

  const addDelimitedPart = (part) => {
    if (part.length === 0) return;
    addDelimitedRecordBytes(part.length);
    delimitedRecordParts.push(part);
  };

  const takeDelimitedRecord = () => {
    const record = Buffer.concat(delimitedRecordParts, delimitedRecordBytes);
    delimitedRecordBytes = 0;
    delimitedRecordParts = [];
    return record;
  };

  const addPendingJson = (part) => {
    if (part.length === 0) return;
    pendingJsonBytes += part.length;
    if (pendingJsonBytes > maximumRecordBytes) {
      boundary(
        "RECORD_LIMIT",
        "structured ripgrep record exceeds " + maximumRecordBytes + " bytes",
      );
    }
    pendingJsonParts.push(part);
  };

  const contentLineCount = (lines) => {
    let contentEnd = lines.length;
    if (contentEnd > 0 && lines[contentEnd - 1] === 10) {
      contentEnd -= 1;
      if (contentEnd > 0 && lines[contentEnd - 1] === 13) contentEnd -= 1;
    }
    let count = 1;
    for (let index = 0; index < contentEnd; index += 1) {
      if (lines[index] === 10) count += 1;
    }
    return count;
  };

  const takeLineWindow = (lineCount) => {
    const skip = Math.min(
      lineCount,
      Math.max(0, skipLines - processedLines),
    );
    const take = reached
      ? 0
      : Math.min(
          lineCount - skip,
          Math.max(0, maximumLines - retainedLines),
        );
    processedLines += lineCount;
    retainedLines += take;
    if (retainedLines >= maximumLines) reached = true;
    return { skip, take };
  };

  const lineSliceOffset = (content, lineCount) => {
    if (lineCount <= 0) return 0;
    let remaining = lineCount;
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] !== 10) continue;
      remaining -= 1;
      if (remaining === 0) return index + 1;
    }
    return content.length;
  };

  const decodeJsonLines = (lines) => {
    const data = requireObject(lines, "ripgrep JSON lines");
    const encoding = Object.prototype.hasOwnProperty.call(data, "text")
      ? "text"
      : "bytes";
    return { bytes: decodeWireData(data, "ripgrep JSON lines"), encoding };
  };

  const validateJsonRecord = (record) => {
    if (record.length === 0) {
      boundary("MALFORMED_JSON", "ripgrep JSON output contains an empty record");
    }
    if (record[record.length - 1] === BYTE_CARRIAGE_RETURN) {
      boundary(
        "MALFORMED_JSON",
        "ripgrep JSON output contains a non-canonical CRLF record",
      );
    }
    const decoded = decodeUtf8Strict(record, "ripgrep JSON record");
    let parsed;
    try {
      parsed = JSON.parse(decoded);
    } catch (error) {
      boundary(
        "MALFORMED_JSON",
        "ripgrep emitted malformed JSON: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    const json = requireObject(parsed, "JSON record");
    const data = requireObject(json.data, "JSON record data");
    if (typeof json.type !== "string") {
      boundary("INVALID_JSON_RECORD", "ripgrep JSON record has no string type");
    }
    if (sawJsonSummary) {
      boundary(
        "INVALID_JSON_RECORD_ORDER",
        "ripgrep emitted a record after its summary",
      );
    }
    if (json.type === "begin") {
      if (openJsonPath !== null) {
        boundary(
          "INVALID_JSON_RECORD_ORDER",
          "ripgrep emitted nested begin records",
        );
      }
      const path = decodeWirePath(data.path, "begin path");
      openJsonPath = path;
      openJsonExcluded = excludedPathByteKeys.has(normalizedPathByteKey(path));
      return { json, data, type: json.type, path };
    }
    if (json.type === "match" || json.type === "context") {
      if (openJsonPath === null) {
        boundary(
          "INVALID_JSON_RECORD_ORDER",
          "ripgrep emitted " + json.type + " before begin",
        );
      }
      const path = decodeWirePath(data.path, json.type + " path");
      if (!path.equals(openJsonPath)) {
        boundary(
          "INVALID_JSON_RECORD_ORDER",
          "ripgrep " + json.type + " path differs from its open file",
        );
      }
      const lines = decodeJsonLines(data.lines);
      parseNullablePositiveInteger(
        data.line_number,
        json.type + " line_number",
      );
      parseNonNegativeSafeInteger(
        data.absolute_offset,
        json.type + " absolute_offset",
      );
      validateSubmatches(data.submatches, lines.bytes);
      return { json, data, type: json.type, path, lines };
    }
    if (json.type === "end") {
      if (openJsonPath === null) {
        boundary(
          "INVALID_JSON_RECORD_ORDER",
          "ripgrep emitted end before begin",
        );
      }
      const path = decodeWirePath(data.path, "end path");
      if (!path.equals(openJsonPath)) {
        boundary(
          "INVALID_JSON_RECORD_ORDER",
          "ripgrep end path differs from its open file",
        );
      }
      openJsonPath = null;
      return { json, data, type: json.type, path };
    }
    if (json.type === "summary") {
      if (openJsonPath !== null) {
        boundary(
          "INVALID_JSON_RECORD_ORDER",
          "ripgrep emitted summary before closing its file",
        );
      }
      sawJsonSummary = true;
      return { json, data, type: json.type };
    }
    boundary(
      "INVALID_JSON_RECORD",
      "ripgrep emitted unsupported JSON record type '" + json.type + "'",
    );
  };

  return {
    get processedLines() {
      return processedLines;
    },
    get workUnits() {
      return workUnits;
    },
    consume(chunk) {
      if (outputMode === "files_with_matches") {
        const captureParts = [];
        let start = 0;
        for (;;) {
          const index = chunk.indexOf(BYTE_NUL, start);
          if (index < 0) {
            addDelimitedPart(chunk.subarray(start));
            return { captureParts, reached };
          }
          addDelimitedPart(chunk.subarray(start, index));
          const path = takeDelimitedRecord();
          if (path.length === 0) {
            boundary("INVALID_WIRE_TEXT", "ripgrep emitted an empty path");
          }
          addWorkUnits(1);
          const excluded = excludedPathByteKeys.has(normalizedPathByteKey(path));
          if (!excluded) {
            const window = takeLineWindow(1);
            if (window.take === 1) {
              captureParts.push(path, Buffer.from([BYTE_NUL]));
            }
          }
          start = index + 1;
        }
      }

      if (outputMode === "count") {
        const captureParts = [];
        let start = 0;
        for (;;) {
          const delimiter = countState === "path" ? BYTE_NUL : BYTE_LINE_FEED;
          const index = chunk.indexOf(delimiter, start);
          if (index < 0) {
            addDelimitedPart(chunk.subarray(start));
            return { captureParts, reached };
          }
          addDelimitedPart(chunk.subarray(start, index));
          if (countState === "path") {
            countPath = takeDelimitedRecord();
            if (countPath.length === 0) {
              boundary(
                "INVALID_WIRE_TEXT",
                "ripgrep emitted an empty count path",
              );
            }
            countRecordExcluded = excludedPathByteKeys.has(
              normalizedPathByteKey(countPath),
            );
            countState = "count";
            start = index + 1;
            continue;
          }
          const countBytes = takeDelimitedRecord();
          if (countPath.length + countBytes.length > maximumRecordBytes) {
            boundary(
              "RECORD_LIMIT",
              "structured ripgrep record exceeds " +
                maximumRecordBytes +
                " bytes",
            );
          }
          const count = parseStrictDecimalCount(countBytes);
          addWorkUnits(1);
          if (aggregateCount > Number.MAX_SAFE_INTEGER - count) {
            boundary(
              "COUNT_OVERFLOW",
              "ripgrep aggregate match count exceeds Number.MAX_SAFE_INTEGER",
            );
          }
          aggregateCount += count;
          countState = "path";
          if (!countRecordExcluded) {
            const window = takeLineWindow(1);
            if (window.take === 1) {
              captureParts.push(
                countPath,
                Buffer.from([BYTE_NUL]),
                countBytes,
                Buffer.from([BYTE_LINE_FEED]),
              );
            }
          }
          countPath = null;
          countRecordExcluded = false;
          start = index + 1;
        }
      }

      const captureParts = [];
      let start = 0;
      for (;;) {
        const lineFeed = chunk.indexOf(BYTE_LINE_FEED, start);
        if (lineFeed < 0) {
          addPendingJson(chunk.subarray(start));
          return { captureParts, reached };
        }
        addPendingJson(chunk.subarray(start, lineFeed));
        const record = Buffer.concat(pendingJsonParts, pendingJsonBytes);
        pendingJsonParts = [];
        pendingJsonBytes = 0;
        const validated = validateJsonRecord(record);
        addWorkUnits(1);
        const parsed = validated.json;
        if (validated.type === "begin") {
          pendingBegin = record;
          capturingJsonFile = false;
        } else if (
          validated.type === "match" ||
          validated.type === "context"
        ) {
          const lines = validated.lines;
          const lineCount = contentLineCount(lines.bytes);
          addWorkUnits(Math.max(0, lineCount - 1));
          if (openJsonExcluded) {
            start = lineFeed + 1;
            continue;
          }
          const window = takeLineWindow(lineCount);
          if (window.take > 0) {
            if (!capturingJsonFile && pendingBegin !== null) {
              captureParts.push(pendingBegin, Buffer.from([10]));
            }
            capturingJsonFile = true;
            if (window.skip === 0 && window.take === lineCount) {
              captureParts.push(record, Buffer.from([10]));
            } else {
              const sliceStart = lineSliceOffset(lines.bytes, window.skip);
              const sliceEnd =
                sliceStart +
                lineSliceOffset(lines.bytes.subarray(sliceStart), window.take);
              const sliced = lines.bytes.subarray(sliceStart, sliceEnd);
              validated.data.lines =
                lines.encoding === "text"
                  ? { text: sliced.toString("utf8") }
                  : { bytes: sliced.toString("base64") };
              if (typeof validated.data.line_number === "number") {
                validated.data.line_number += window.skip;
              }
              if (typeof validated.data.absolute_offset === "number") {
                validated.data.absolute_offset += sliceStart;
              }
              validated.data.submatches = [];
              captureParts.push(
                Buffer.from(JSON.stringify(parsed), "utf8"),
                Buffer.from([BYTE_LINE_FEED]),
              );
            }
          }
        } else if (validated.type === "end") {
          if (capturingJsonFile && !reached) {
            captureParts.push(record, Buffer.from([BYTE_LINE_FEED]));
          }
          pendingBegin = null;
          capturingJsonFile = false;
          openJsonExcluded = false;
        } else if (validated.type === "summary" && !reached) {
          captureParts.push(record, Buffer.from([BYTE_LINE_FEED]));
        }
        start = lineFeed + 1;
      }
    },
    finish(options = {}) {
      if (options.allowPartial === true) return;
      if (outputMode === "files_with_matches") {
        if (delimitedRecordBytes > 0) {
          boundary(
            "MISSING_NUL",
            "ripgrep files-with-matches output is missing a terminating NUL",
          );
        }
        return;
      }
      if (outputMode === "count") {
        if (countState === "count") {
          boundary(
            "UNTERMINATED_RECORD",
            "ripgrep count output is missing a terminating newline",
          );
        }
        if (delimitedRecordBytes > 0) {
          boundary(
            "MISSING_NUL",
            "ripgrep count output is missing a path NUL delimiter",
          );
        }
        return;
      }
      if (pendingJsonBytes > 0) {
        boundary(
          "UNTERMINATED_RECORD",
          "ripgrep JSON output is missing a terminating newline",
        );
      }
      if (openJsonPath !== null) {
        boundary(
          "INVALID_JSON_RECORD_ORDER",
          "ripgrep JSON output ended before its file end record",
        );
      }
      if (!sawJsonSummary) {
        boundary(
          "INVALID_JSON_RECORD_ORDER",
          "ripgrep JSON output ended without a summary record",
        );
      }
    },
  };
};
`;

type Factory = (value: StructuredRipgrepLimit | undefined) => StructuredRipgrepLimiter | null;
// Compile only this fixed shipped literal, never task output, configuration or
// a workspace module. Keeping the source literal intact also prevents bundler
// helpers from becoming missing dependencies inside the local worker's script.
const loadFactory = new Function("Buffer", "TextDecoder", "process",
  STRUCTURED_RIPGREP_LIMITER_SOURCE + "\nreturn createStructuredRipgrepLimiter;") as
  (buffer: typeof Buffer, decoder: typeof TextDecoder, platform: { platform: NodeJS.Platform }) => Factory;

export function createStructuredRipgrepLimiter(
  value: StructuredRipgrepLimit | undefined,
  platform: NodeJS.Platform,
): StructuredRipgrepLimiter | null {
  return loadFactory(Buffer, TextDecoder, { platform })(value);
}
